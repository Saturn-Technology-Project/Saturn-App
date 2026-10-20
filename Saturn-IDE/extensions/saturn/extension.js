// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { registerEditorAi } = require('./editor-ai');
const { registerGitAi } = require('./git-ai');
const { registerIdeBridge } = require('./ide-bridge');
const agentTools = require('./agent-tools');
const { registerAgentReview } = require('./agent-review');

/** Editor-side helpers shared by the sidebar panel and the Agent window: diff documents and the agent terminal. */
/** @type {{ content: agentTools.DiffContent, terminal: agentTools.AgentTerminal, review: any }} */
const shared = { content: new agentTools.DiffContent(), terminal: new agentTools.AgentTerminal(), review: null };

/** Talks to the local Saturn runtime (the same one the Saturn app uses). */
class Runtime {
	/** saturn.runtimeUrl when set; else the runtime that opened this IDE (SATURN_RUNTIME_PORT); else the default. */
	base() {
		const setting = vscode.workspace.getConfiguration('saturn').inspect('runtimeUrl');
		const chosen = setting && (setting.workspaceFolderValue || setting.workspaceValue || setting.globalValue);
		const port = process.env.SATURN_RUNTIME_PORT;
		return String(chosen || (port ? `http://127.0.0.1:${port}` : 'http://127.0.0.1:4700')).replace(/\/$/, '');
	}

	/** The runtime session token, from the 0600 token file; the runtime rejects requests without it. */
	token() {
		const dir = process.env.SATURN_DATA_DIR || nodePath.join(os.homedir(), '.saturn-app');
		try {
			return fs.readFileSync(nodePath.join(dir, 'runtime-token'), 'utf8').trim();
		} catch {
			return '';
		}
	}

	/**
	 * A streaming request: the runtime answers with one JSON object per line (NDJSON); each is yielded as it
	 * arrives. A line with `error` ends the stream with that error.
	 * @param {string} path @param {RequestInit} [init]
	 */
	async *stream(path, init) {
		const token = this.token();
		const response = await fetch(this.base() + path, {
			...init,
			headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init && init.headers) },
		});
		if (!response.ok || !response.body) {
			const text = await response.text().catch(() => '');
			let body;
			try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
			throw new Error((body && (body.error || body.message)) || `Saturn runtime returned ${response.status}`);
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffered = '';
		for (;;) {
			const { value, done } = await reader.read();
			buffered += decoder.decode(value || new Uint8Array(), { stream: !done });
			const lines = buffered.split('\n');
			buffered = lines.pop() || '';
			for (const line of lines) {
				if (!line.trim()) { continue; }
				const item = JSON.parse(line);
				if (item && item.error) { throw new Error(String(item.error)); }
				yield item;
			}
			if (done) { return; }
		}
	}

	/** @param {string} path @param {RequestInit} [init] */
	async request(path, init) {
		const token = this.token();
		const response = await fetch(this.base() + path, {
			...init,
			headers: {
				'content-type': 'application/json',
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...(init && init.headers),
			},
		});
		const text = await response.text();
		const body = text ? JSON.parse(text) : undefined;
		if (!response.ok) {
			throw new Error((body && (body.error || body.message)) || `Saturn runtime returned ${response.status}`);
		}
		return body;
	}
}

/** Opens a saturn:// link (the Agent App registers the scheme when installed) with the platform's opener. */
function openSaturnLink(url, failure) {
	const { execFile } = require('child_process');
	const [command, args] = process.platform === 'darwin'
		? ['open', [url]]
		: process.platform === 'win32'
			? ['cmd.exe', ['/c', 'start', '', url]]
			: ['xdg-open', [url]];
	execFile(command, args, (error) => {
		if (error) {
			void vscode.window.showWarningMessage(failure);
		}
	});
}

/** What the agent should know about the editor: the open file, the selection, and the workspace folder. */
function editorContext() {
	const editor = vscode.window.activeTextEditor;
	const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
	const lines = [];
	if (folder) {
		lines.push(`Workspace: ${folder.uri.fsPath}`);
	}
	if (editor) {
		const document = editor.document;
		lines.push(`Active file: ${document.uri.fsPath} (${document.languageId})`);
		if (!editor.selection.isEmpty) {
			const start = editor.selection.start.line + 1;
			const end = editor.selection.end.line + 1;
			const text = document.getText(editor.selection).slice(0, 12000);
			lines.push(`Selection (lines ${start}-${end}):\n\`\`\`${document.languageId}\n${text}\n\`\`\``);
		}
	}
	return lines.join('\n');
}

class AgentView {
	/** @param {vscode.ExtensionContext} context @param {Runtime} runtime */
	constructor(context, runtime) {
		this.context = context;
		this.runtime = runtime;
		/** @type {vscode.Webview | undefined} */
		this.webview = undefined;
		/** @type {NodeJS.Timeout | undefined} */
		this.poll = undefined;
		/** @type {vscode.Disposable[]} */
		this.disposables = [];
		/** The agent whose chats the panel shows. @type {string | undefined} */
		this.agentId = undefined;
		/** The open chat; created on the first message after New Chat. @type {string | undefined} */
		this.threadId = undefined;
		/**
		 * The Saturn project for the open workspace folder. Chats in it work in that folder once the user has
		 * allowed access; with no folder open they use Saturn's private sandbox.
		 * @type {{ id?: string; name: string; path: string; access: boolean } | null}
		 */
		this.project = null;
	}

	/** @param {vscode.WebviewView} view */
	resolveWebviewView(view) {
		this.attach(view.webview);
		view.onDidDispose(() => {
			this.stopPolling();
			this.dispose();
		});
	}

	dispose() {
		this.stopPolling();
		while (this.disposables.length) {
			const item = this.disposables.pop();
			if (item) item.dispose();
		}
	}

	sendActiveEditor() {
		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document) {
			const doc = editor.document;
			const fileName = doc.uri.fsPath.split('/').pop() || doc.uri.fsPath;
			this.post({
				type: 'activeEditor',
				fileName,
				fsPath: doc.uri.fsPath,
				languageId: doc.languageId,
			});
		} else {
			this.post({
				type: 'activeEditor',
				fileName: null,
			});
		}
	}

	/** Renders the chat into a sidebar view or the Agent window's panel. @param {vscode.Webview} webview */
	attach(webview) {
		this.webview = webview;
		webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
		webview.html = this.html(webview);
		this.disposables.push(
			webview.onDidReceiveMessage((message) => void this.handle(message)),
			vscode.window.onDidChangeActiveTextEditor(() => this.sendActiveEditor()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh()),
		);
	}

	/**
	 * Keeps the project's semantic index current: a (incremental) pass when the project is known, and the saved
	 * file after each save. Failures are the runtime's to log; the index is a help, not a requirement.
	 * @param {string[]} [paths]
	 */
	reindex(paths) {
		const projectId = this.projectId();
		if (!projectId || vscode.workspace.getConfiguration('saturn').get('codebase.index', true) === false) {
			return;
		}
		void this.runtime.request(`/projects/${encodeURIComponent(projectId)}/index`, { method: 'POST', body: JSON.stringify(paths ? { paths } : {}) }).catch(() => undefined);
	}

	/** The project id runs are sent with: only once the workspace folder is a Saturn project with access. */
	projectId() {
		return this.project && this.project.id && this.project.access ? this.project.id : undefined;
	}

	/** Finds the Saturn project for the workspace's first folder and tells the panel whether agents may work there. */
	async resolveProject() {
		const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
		if (!folder || folder.uri.scheme !== 'file') {
			this.project = null;
			this.post({ type: 'project', state: 'none' });
			return;
		}
		const folderPath = folder.uri.fsPath;
		const projects = await this.runtime.request('/projects');
		const match = (projects || []).find((/** @type {any} */ item) => item.path === folderPath || (item.folders || []).includes(folderPath));
		this.project = match
			? { id: match.id, name: match.name, path: match.path, access: Boolean(match.access) }
			: { name: folder.name, path: folderPath, access: false };
		this.post({ type: 'project', state: this.projectId() ? 'ready' : 'needs-access', name: this.project.name, path: this.project.path });
		this.reindex();
	}

	/** The user's consent, in a native modal, before agents may read, change or run anything in the folder. */
	async allowProject() {
		const project = this.project;
		if (!project) return;
		const choice = await vscode.window.showInformationMessage(`Allow Saturn agents to work in “${project.name}”?`, {
			modal: true,
			detail: `Agents in this workspace can read the files in ${project.path}, create, change and delete files there, and run commands with it as the working directory. You can revoke access from the project's menu in the Saturn app.`,
		}, 'Allow Access');
		if (choice !== 'Allow Access') return;
		if (project.id) {
			await this.runtime.request(`/projects/${encodeURIComponent(project.id)}/access`, { method: 'POST', body: JSON.stringify({ granted: true }) });
		} else {
			await this.runtime.request('/projects', { method: 'POST', body: JSON.stringify({ path: project.path, grant: true }) });
		}
		this.threadId = undefined;
		await this.refresh();
	}

	/** Reloads everything the panel shows: the project, the agents, and the selected agent's chats. */
	async refresh() {
		await this.resolveProject();
		await this.loadAgents();
		this.sendActiveEditor();
	}

	/** The agent's chats in this project (or, with no folder open, outside any project), newest first. */
	async loadThreads(agentId) {
		this.agentId = agentId;
		const projectId = this.projectId();
		const all = await this.runtime.request(`/agents/${encodeURIComponent(agentId)}/threads`);
		const threads = (all || []).filter((/** @type {any} */ thread) => (projectId ? thread.projectId === projectId : !thread.projectId));
		if (this.threadId && !threads.some((/** @type {any} */ thread) => thread.id === this.threadId)) this.threadId = undefined;
		if (this.threadId === undefined && threads[0]) this.threadId = threads[0].id;
		this.post({ type: 'threads', threads, current: this.threadId || null });
		await this.loadMessages();
	}

	async loadMessages() {
		if (!this.agentId || !this.threadId) {
			this.post({ type: 'history', runs: [] });
			return;
		}
		const runs = await this.runtime.request(`/agents/${encodeURIComponent(this.agentId)}/messages?threadId=${encodeURIComponent(this.threadId)}`);
		shared.terminal.markSeen(runs || []);
		this.post({ type: 'history', runs: runs || [] });
	}

	/** The open workspace folder: where codebase search and attached context come from. */
	workspaceFolder() {
		const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
		return folder ? folder.uri.fsPath : undefined;
	}

	/** Re-reads one run and shows it (after keeping or reverting its changes). @param {string} runId */
	async refreshRun(runId) {
		this.post({ type: 'run', run: await this.runtime.request(`/runs/${encodeURIComponent(runId)}`) });
	}

	/**
	 * The message as the agent receives it: the user's text, then (in one <saturn_context> block the chat hides)
	 * the editor context, the codebase search results and any attached files, folder, web page or git changes.
	 * @param {{ text: string; withContext?: boolean; codebase?: boolean; contextItems?: any[] }} message
	 */
	async buildInput(message) {
		const folder = this.workspaceFolder();
		const sections = [];
		const sources = [];
		if (message.withContext) {
			const editor = editorContext();
			if (editor) {
				sections.push(`<editor_context>\n${editor}\n</editor_context>`);
				sources.push('active file');
			}
		}
		const codebaseOn = vscode.workspace.getConfiguration('saturn').get('codebase.enabled', true) !== false;
		if (message.codebase !== false && codebaseOn && folder) {
			const projectId = this.projectId();
			// The project's semantic index, when the runtime has one (LM Studio with an embedding model).
			const semantic = projectId
				? (/** @param {string} query */ (query) => this.runtime.request(`/projects/${encodeURIComponent(projectId)}/index/search?q=${encodeURIComponent(query)}&limit=12`))
				: undefined;
			const found = await agentTools.retrieve(message.text, folder, undefined, semantic).catch(() => ({ text: '', files: [] }));
			if (found.text) {
				sections.push(`<codebase_context>\n${found.text}\n</codebase_context>`);
				sources.push(`codebase: ${found.files.length} file${found.files.length === 1 ? '' : 's'}`);
			}
		}
		const items = Array.isArray(message.contextItems) ? message.contextItems : [];
		if (items.length) {
			const attached = await agentTools.expandContext(items, folder);
			if (attached) {
				sections.push(`<attached_context>\n${attached}\n</attached_context>`);
				sources.push(...items.map((item) => String(item.label)));
			}
		}
		if (!sections.length) {
			return message.text;
		}
		const label = sources.join('; ').replace(/"/g, "'");
		return `${message.text}\n\n<saturn_context sources="${label}">\n${sections.join('\n')}\n</saturn_context>`;
	}

	/** @param {any} message */
	post(message) {
		void (this.webview && this.webview.postMessage(message));
	}

	/** @param {{ type: string; [key: string]: any }} message */
	async handle(message) {
		try {
			switch (message.type) {
				case 'ready':
				case 'refresh':
					await this.refresh();
					break;
				case 'allowProject':
					await this.allowProject();
					break;
				case 'newChat':
					this.newChat();
					break;
				case 'selectAgent':
					if (message.agentId !== this.agentId) this.threadId = undefined;
					await this.loadThreads(message.agentId);
					break;
				case 'openThread':
					this.stopPolling();
					this.threadId = message.threadId;
					await this.loadThreads(this.agentId || message.agentId);
					break;
				case 'renameThread':
					if (this.threadId && typeof message.title === 'string' && message.title.trim()) {
						await this.runtime.request(`/threads/${encodeURIComponent(this.threadId)}`, { method: 'PATCH', body: JSON.stringify({ title: message.title.trim() }) });
						await this.loadThreads(this.agentId || message.agentId);
					}
					break;
				case 'send': {
					if (this.project && !this.projectId()) {
						this.post({ type: 'error', message: `Allow Saturn agents to work in ${this.project.name} first.` });
						this.post({ type: 'project', state: 'needs-access', name: this.project.name, path: this.project.path });
						break;
					}
					const input = await this.buildInput(message);
					if (!this.threadId || this.agentId !== message.agentId) {
						// New Chat starts a real conversation on its first message, in this workspace's project.
						const thread = await this.runtime.request(`/agents/${encodeURIComponent(message.agentId)}/threads`, {
							method: 'POST',
							body: JSON.stringify({ title: message.text.split('\n')[0].slice(0, 45) || 'New Chat', projectId: this.projectId() }),
						});
						this.agentId = message.agentId;
						this.threadId = thread.id;
					}
					const run = await this.runtime.request(`/agents/${encodeURIComponent(message.agentId)}/runs`, {
						method: 'POST',
						body: JSON.stringify({ input, threadId: this.threadId }),
					});
					this.post({ type: 'run', run });
					this.watch(run.id);
					void this.loadThreadList();
					break;
				}
				case 'revise': {
					const input = await this.buildInput(message);
					const result = await this.runtime.request(`/runs/${encodeURIComponent(message.runId)}`, {
						method: 'PATCH',
						body: JSON.stringify({ input }),
					});
					this.post({ type: 'revised', run: result.run, removed: result.removed || [] });
					this.watch(result.run.id);
					break;
				}
				case 'stop':
					this.post({ type: 'run', run: await this.runtime.request(`/runs/${encodeURIComponent(message.runId)}/stop`, { method: 'POST' }) });
					break;
				case 'wake':
					this.post({ type: 'run', run: await this.runtime.request(`/runs/${encodeURIComponent(message.runId)}/wake`, { method: 'POST' }) });
					this.watch(message.runId);
					break;
				case 'wake-watch':
					this.watch(message.runId);
					break;
				case 'decide':
					await this.runtime.request(`/runs/${encodeURIComponent(message.runId)}/actions/${encodeURIComponent(message.actionId)}/decision`, {
						method: 'POST',
						body: JSON.stringify({ allow: message.allow === true }),
					});
					this.watch(message.runId);
					break;
				case 'reviewFile':
					await shared.review.open(message.runId, message.root, message.path);
					break;
				case 'openDiff':
					await agentTools.openRunDiff(this.runtime, shared.content, message.runId, message.root, message.path);
					break;
				case 'revertFile':
				case 'revertAll':
					await this.runtime.request(`/runs/${encodeURIComponent(message.runId)}/changes/revert`, {
						method: 'POST',
						body: JSON.stringify(message.type === 'revertFile' ? { path: message.path } : {}),
					});
					await this.refreshRun(message.runId);
					break;
				case 'keepAll':
					await this.runtime.request(`/runs/${encodeURIComponent(message.runId)}/changes/keep`, { method: 'POST' });
					await this.refreshRun(message.runId);
					break;
				case 'worktreeStart':
					try {
						const status = await this.runtime.request(`/threads/${encodeURIComponent(message.threadId)}/worktree`, { method: 'POST' });
						vscode.window.setStatusBarMessage(`Saturn: this chat now works on ${status.branch} in its own worktree.`, 6000);
					} catch (error) {
						void vscode.window.showErrorMessage(`Saturn: ${errorText(error)}`);
					}
					await this.loadThreads(this.agentId);
					break;
				case 'worktreeFinish': {
					const pick = await vscode.window.showQuickPick([
						{ label: '$(git-merge) Merge into the base branch', description: 'Uncommitted work is committed first', how: 'merge' },
						{ label: '$(git-pull-request) Keep the branch for a pull request', how: 'keep' },
						{ label: '$(trash) Discard the branch and its changes', how: 'discard' },
					], { placeHolder: 'Finish this chat\'s worktree' });
					if (!pick) break;
					try {
						const result = await this.runtime.request(`/threads/${encodeURIComponent(message.threadId)}/worktree/finish`, { method: 'POST', body: JSON.stringify({ how: pick.how }) });
						vscode.window.setStatusBarMessage(`Saturn: ${pick.how === 'merge' ? 'merged' : pick.how === 'keep' ? 'kept' : 'discarded'} ${result.branch}.`, 6000);
					} catch (error) {
						void vscode.window.showErrorMessage(`Saturn: ${errorText(error)}`);
					}
					await this.loadThreads(this.agentId);
					break;
				}
				case 'restore': {
					const answer = await vscode.window.showWarningMessage(
						'Restore the project files to how they were before this turn?',
						{ modal: true, detail: 'Every file the agent changed in this turn and in later turns of this chat goes back to its earlier version.' },
						'Restore',
					);
					if (answer !== 'Restore') {
						break;
					}
					const result = await this.runtime.request(`/runs/${encodeURIComponent(message.runId)}/restore`, { method: 'POST' });
					await this.loadMessages();
					const count = result && Array.isArray(result.reverted) ? result.reverted.length : 0;
					vscode.window.setStatusBarMessage(`$(history) Saturn restored ${count} file${count === 1 ? '' : 's'}`, 6000);
					break;
				}
				case 'apply':
					await agentTools.applyCode(this.runtime, shared.content, String(message.code || ''), String(message.lang || ''), this.workspaceFolder());
					break;
				case 'runInTerminal':
					shared.terminal.runInTerminal(String(message.command || ''), (this.project && this.project.path) || this.workspaceFolder());
					break;
				case 'showTerminal':
					shared.terminal.ensure().show(true);
					break;
				case 'pickContext': {
					const items = await agentTools.pickContext(this.workspaceFolder());
					if (items.length) {
						this.post({ type: 'contextItems', items });
					}
					break;
				}
				case 'openApp':
					await vscode.commands.executeCommand('saturn.openApp');
					break;
				case 'openAgentWindow':
					await vscode.commands.executeCommand('saturn.openAgentWindow');
					break;
				case 'openSettings':
					await vscode.commands.executeCommand('workbench.action.openSettings', 'saturn');
					break;
				case 'patchModel':
					if (message.modelId && message.patch) {
						await this.runtime.request(`/connections/models/${encodeURIComponent(message.modelId)}`, {
							method: 'PATCH',
							body: JSON.stringify(message.patch),
						});
						await this.loadAgents();
					}
					break;
				case 'patchAgent':
					if (message.agentId && message.patch) {
						await this.runtime.request(`/agents/${encodeURIComponent(message.agentId)}`, {
							method: 'PATCH',
							body: JSON.stringify(message.patch),
						});
						await this.loadAgents();
					}
					break;
			}
		} catch (error) {
			this.post({ type: 'error', message: error instanceof Error ? error.message : String(error), offline: message.type === 'ready' || message.type === 'refresh' });
		}
	}

	async loadAgents() {
		try {
			const [agents, models] = await Promise.all([
				this.runtime.request('/agents'),
				this.runtime.request('/connections/models'),
			]);
			this.post({
				type: 'agents',
				agents: (agents || []).filter((/** @type {any} */ agent) => agent.status !== 'paused'),
				models: models || [],
			});
		} catch (error) {
			this.post({ type: 'error', message: error instanceof Error ? error.message : String(error), offline: true });
		}
	}

	/** Polls a run until it settles; a sleeping run is checked slowly until it wakes. @param {string} runId */
	watch(runId) {
		this.stopPolling();
		const tick = async () => {
			try {
				const run = await this.runtime.request(`/runs/${encodeURIComponent(runId)}`);
				this.post({ type: 'run', run });
				shared.terminal.feed(run);
				if (run.status === 'running' || run.status === 'queued') {
					this.poll = setTimeout(tick, 400);
				} else if (run.status === 'sleeping') {
					this.poll = setTimeout(tick, 3000);
				} else if (run.status === 'waiting_approval') {
					// The card may also be answered in the Saturn app; keep checking so the panel follows.
					this.poll = setTimeout(tick, 1500);
				}
			} catch (error) {
				this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
			}
		};
		void tick();
	}

	stopPolling() {
		if (this.poll) {
			clearTimeout(this.poll);
		}
		this.poll = undefined;
	}

	/** Clears the panel; the chat itself is created with its first message. */
	newChat() {
		this.stopPolling();
		this.threadId = undefined;
		this.post({ type: 'clear' });
	}

	/** Refreshes only the chat list (titles change after the first message). */
	async loadThreadList() {
		if (!this.agentId) return;
		const projectId = this.projectId();
		const all = await this.runtime.request(`/agents/${encodeURIComponent(this.agentId)}/threads`).catch(() => []);
		const threads = (all || []).filter((/** @type {any} */ thread) => (projectId ? thread.projectId === projectId : !thread.projectId));
		this.post({ type: 'threads', threads, current: this.threadId || null });
	}

	focusInput() {
		this.post({ type: 'focus' });
	}

	/** @param {vscode.Webview} webview */
	html(webview) {
		const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
		const icon = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.png'));
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
	:root {
		color-scheme: light dark;
		--saturn-accent: #2563eb;
		--saturn-accent-hover: #1d4ed8;
		--saturn-accent-subtle: rgba(37, 99, 235, 0.1);
		--saturn-ring: rgba(37, 99, 235, 0.25);
	}
	@media (prefers-color-scheme: dark) {
		:root {
			--saturn-accent: #3b82f6;
			--saturn-accent-hover: #60a5fa;
			--saturn-accent-subtle: rgba(59, 130, 246, 0.15);
			--saturn-ring: rgba(59, 130, 246, 0.25);
		}
	}
	* { box-sizing: border-box; }
	#sessionTitleInput, #historyPopover, #slashPopup, #modelPopover {
		display: none;
	}

	/* The hidden attribute always wins, even over a rule that sets display. */
	[hidden] {
		display: none !important;
	}

	/* ─── Project access banner ─── */
	.project-banner {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 8px 12px 0;
		padding: 7px 10px;
		border-radius: 8px;
		font-size: 12px;
		color: var(--vscode-descriptionForeground);
		background: rgba(127, 127, 127, 0.08);
		flex-shrink: 0;
	}
	.project-banner.needs-access {
		color: var(--vscode-foreground);
		background: rgba(224, 164, 88, 0.12);
		border: 1px solid rgba(224, 164, 88, 0.35);
	}
	.project-banner-text {
		flex: 1;
		min-width: 0;
	}
	.project-banner-btn {
		border: 0;
		border-radius: 6px;
		padding: 3px 10px;
		font: inherit;
		font-weight: 600;
		cursor: pointer;
		color: var(--vscode-button-foreground);
		background: var(--vscode-button-background);
	}
	.history-item.active .hist-title {
		color: var(--vscode-foreground);
		font-weight: 600;
	}
	#agent,
	select#agent,
	.composer-sub-row select,
	[id="agent"] {
		display: none !important;
		visibility: hidden !important;
		position: absolute !important;
		pointer-events: none !important;
		width: 0 !important;
		height: 0 !important;
		opacity: 0 !important;
	}

	body {
		margin: 0;
		padding: 0;
		font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", "Segoe UI", sans-serif;
		color: var(--vscode-foreground);
		background: var(--vscode-sideBar-background);
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
		-webkit-font-smoothing: antialiased;
	}

	/* ─── Saturn Header ─── */
	.saturn-header {
		display: flex;
		flex-direction: column;
		border-bottom: 1px solid var(--vscode-sideBar-border, rgba(127,127,127,0.15));
		background: var(--vscode-sideBar-background);
		flex-shrink: 0;
		position: relative;
	}
	.header-top-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 7px 12px 3px;
	}
	.brand-badge {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.saturn-header-logo {
		width: 15px;
		height: 15px;
		border-radius: 4px;
		flex-shrink: 0;
	}
	.brand-title {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--vscode-foreground);
		letter-spacing: -0.01em;
	}
	.header-top-actions, .session-actions {
		display: flex;
		align-items: center;
		gap: 2px;
	}
	.worktree-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 20px;
		padding: 0 7px;
		border: 1px solid var(--vscode-input-border, #3c3c43);
		border-radius: 5px;
		background: transparent;
		color: var(--vscode-descriptionForeground);
		font: inherit;
		font-size: 11px;
		font-family: var(--vscode-editor-font-family);
		cursor: pointer;
		white-space: nowrap;
	}
	.worktree-btn:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.06)); }
	.worktree-btn.on { color: var(--vscode-foreground); }
	.hdr-btn {
		width: 26px;
		height: 26px;
		border: 0;
		background: transparent;
		color: var(--vscode-descriptionForeground);
		border-radius: 5px;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition: background-color 100ms ease, color 100ms ease;
		padding: 0;
	}
	.hdr-btn:hover {
		background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.12));
		color: var(--vscode-foreground);
	}
	.header-session-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 6px 12px 6px;
	}
	.session-title-wrap {
		flex: 1;
		min-width: 0;
		margin-right: 8px;
		display: flex;
		align-items: center;
		gap: 6px;
	}
	}
	.session-title {
		font-size: 14px;
		font-weight: 600;
		color: var(--vscode-foreground);
		cursor: pointer;
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		border-radius: 4px;
		padding: 1px 4px;
		margin-left: -4px;
		transition: background 120ms ease;
	}
	.session-title:hover {
		background: rgba(127,127,127,0.1);
	}
	.session-title-input {
		width: 100%;
		font-size: 14px;
		font-weight: 600;
		font-family: inherit;
		border: 1px solid var(--vscode-focusBorder);
		background: var(--vscode-input-background);
		color: var(--vscode-input-foreground);
		border-radius: 4px;
		padding: 1px 5px;
		outline: none;
	}

	/* ─── History Popover Drawer ─── */
	.history-popover {
		position: absolute;
		top: 100%;
		left: 8px;
		right: 8px;
		z-index: 50;
		background: var(--vscode-dropdown-background, var(--vscode-editor-background));
		border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border, rgba(127,127,127,0.25)));
		border-radius: 10px;
		box-shadow: 0 10px 28px rgba(0,0,0,0.22);
		padding: 8px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 260px;
		overflow-y: auto;
	}
	.history-popover-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 2px 6px 6px;
		font-size: 11px;
		font-weight: 600;
		color: var(--vscode-descriptionForeground);
		border-bottom: 1px solid rgba(127,127,127,0.12);
	}
	.history-close-btn {
		background: none;
		border: 0;
		color: var(--vscode-descriptionForeground);
		cursor: pointer;
		font-size: 12px;
		padding: 0 4px;
	}
	.history-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 6px 8px;
		border-radius: 6px;
		font-size: 12px;
		cursor: pointer;
		color: var(--vscode-foreground);
		transition: background 100ms ease;
	}
	.history-item:hover {
		background: var(--vscode-list-hoverBackground);
	}
	.history-item .hist-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
		font-weight: 500;
	}
	.history-item .hist-time {
		font-size: 10.5px;
		color: var(--vscode-descriptionForeground);
		margin-left: 8px;
		flex-shrink: 0;
	}

	/* ─── Scrollable Log Area ─── */
	#log {
		flex: 1;
		overflow-y: auto;
		padding: 14px 12px;
		display: flex;
		flex-direction: column;
		gap: 16px;
		min-height: 0;
	}

	/* ─── Saturn Empty State ─── */
	.saturn-empty-state {
		margin: auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		padding: 24px 16px;
		max-width: 360px;
		width: 100%;
		animation: fadeIn 200ms ease;
	}
	.saturn-hero {
		display: flex;
		flex-direction: column;
		align-items: center;
		margin-bottom: 22px;
	}
	.saturn-hero-logo {
		width: 48px;
		height: 48px;
		border-radius: 12px;
		margin-bottom: 12px;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.16);
		transition: transform 160ms ease;
	}
	.saturn-hero-logo:hover {
		transform: scale(1.05);
	}
	.saturn-hero-kicker {
		display: inline-flex;
		align-items: center;
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--saturn-accent);
		background: var(--saturn-accent-subtle);
		padding: 2px 8px;
		border-radius: 10px;
		margin-bottom: 8px;
	}
	.saturn-hero-title {
		margin: 0 0 6px 0;
		font-size: 16.5px;
		font-weight: 600;
		letter-spacing: -0.015em;
		color: var(--vscode-foreground);
		font-family: inherit;
	}
	.saturn-hero-subtitle {
		margin: 0;
		font-size: 12.5px;
		line-height: 1.45;
		color: var(--vscode-descriptionForeground);
	}
	.saturn-starter-cards {
		display: flex;
		flex-direction: column;
		gap: 7px;
		width: 100%;
	}
	.saturn-starter-card {
		background: var(--vscode-input-background);
		border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.18));
		border-radius: 10px;
		padding: 8px 12px;
		display: flex;
		align-items: center;
		gap: 10px;
		cursor: pointer;
		text-align: left;
		transition: border-color 140ms ease, background-color 140ms ease, transform 140ms ease;
		width: 100%;
		font-family: inherit;
	}
	.saturn-starter-card:hover {
		border-color: var(--saturn-accent);
		background: var(--saturn-accent-subtle);
		transform: translateY(-1px);
	}
	.starter-card-icon {
		font-size: 16px;
		line-height: 1;
		flex-shrink: 0;
	}
	.starter-card-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
		gap: 1px;
	}
	.starter-card-title {
		font-size: 12px;
		font-weight: 600;
		color: var(--vscode-foreground);
	}
	.starter-card-prompt {
		font-size: 11px;
		color: var(--vscode-descriptionForeground);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ─── Tip Banner (Above composer) ─── */
	@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

	/* ─── User Turn & Edit Bubble ─── */
	.user-turn {
		display: flex;
		justify-content: flex-end;
		width: 100%;
	}
	.user-block {
		position: relative;
		max-width: 90%;
		display: inline-flex;
	}
	.user {
		align-self: flex-end;
		max-width: 100%;
		background: var(--vscode-input-background);
		border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.2));
		border-radius: 12px 12px 3px 12px;
		padding: 8px 12px;
		white-space: pre-wrap;
		word-break: break-word;
		font-size: 13px;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
	}
	.user-edit-btn {
		position: absolute;
		top: 50%;
		right: calc(100% + 6px);
		transform: translateY(-50%);
		width: 24px;
		height: 24px;
		border: 1px solid transparent;
		border-radius: 6px;
		background: transparent;
		color: var(--vscode-descriptionForeground);
		display: flex;
		align-items: center;
		justify-content: center;
		opacity: 0;
		cursor: pointer;
		transition: opacity 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
		padding: 0;
		outline: none;
	}
	.user-block:hover .user-edit-btn,
	.user-edit-btn:focus-visible {
		opacity: 1;
		background: var(--vscode-editor-background);
		border-color: var(--vscode-widget-border, rgba(127,127,127,0.25));
		color: var(--vscode-foreground);
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
	}
	.edit-bubble {
		width: 100%;
		max-width: 95%;
		align-self: flex-end;
		display: flex;
		flex-direction: column;
		gap: 8px;
		background: var(--vscode-input-background);
		border: 1px solid var(--saturn-accent);
		border-radius: 12px;
		padding: 10px 12px;
		box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
	}
	.edit-bubble textarea {
		width: 100%;
		border: 0;
		padding: 0;
		background: transparent;
		color: var(--vscode-input-foreground);
		font-size: 13px;
		line-height: 1.5;
		resize: none;
		outline: none;
		font-family: inherit;
		min-height: 48px;
		max-height: 180px;
	}
	.edit-bubble .edit-hint {
		font-size: 11px;
		color: var(--vscode-descriptionForeground);
		line-height: 1.35;
	}
	.edit-actions {
		display: flex;
		justify-content: flex-end;
		gap: 6px;
	}
	.edit-actions button {
		font-size: 11.5px;
		font-family: inherit;
		padding: 3px 10px;
		border-radius: 6px;
		cursor: pointer;
		transition: all 120ms ease;
	}
	.edit-actions .btn-cancel {
		background: transparent;
		border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.2));
		color: var(--vscode-foreground);
	}
	.edit-actions .btn-cancel:hover {
		background: rgba(127, 127, 127, 0.15);
	}
	.edit-actions .btn-save {
		background: var(--saturn-accent);
		color: #ffffff;
		border: 0;
		font-weight: 500;
	}
	.edit-actions .btn-save:hover:not(:disabled) {
		background: var(--saturn-accent-hover);
	}
	.edit-actions .btn-save:disabled {
		opacity: 0.4;
		cursor: default;
	}

	/* ─── Assistant Turn & Reasoning Trace ─── */
	.assistant-turn {
		display: flex;
		flex-direction: column;
		gap: 8px;
		max-width: 100%;
	}
	.assistant {
		white-space: pre-wrap;
		word-break: break-word;
		line-height: 1.55;
		font-size: 13px;
	}
	.assistant code {
		background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15));
		padding: 1.5px 4.5px;
		border-radius: 4px;
		font-family: "SF Mono", "JetBrains Mono", Menlo, Monaco, monospace;
		font-size: 12px;
	}
	.code-block {
		margin: 8px 0;
		border-radius: 8px;
		background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.08));
		border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.15));
		overflow: hidden;
	}
	.code-block-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 4px 10px;
		background: rgba(127, 127, 127, 0.08);
		border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.12));
		font-size: 11px;
		color: var(--vscode-descriptionForeground);
	}
	.code-lang {
		font-family: "SF Mono", "JetBrains Mono", Menlo, Monaco, monospace;
		font-weight: 600;
		text-transform: uppercase;
		font-size: 10px;
		letter-spacing: 0.04em;
	}
	.code-copy {
		background: none;
		border: 0;
		color: var(--vscode-descriptionForeground);
		cursor: pointer;
		font-size: 11px;
		padding: 2px 6px;
		border-radius: 4px;
		transition: background 120ms ease, color 120ms ease;
		font-family: inherit;
	}
	.code-copy:hover {
		color: var(--vscode-foreground);
		background: rgba(127, 127, 127, 0.15);
	}
	.code-block pre {
		margin: 0;
		padding: 8px 10px;
		overflow-x: auto;
		font-family: "SF Mono", "JetBrains Mono", Menlo, Monaco, monospace;
		font-size: 12px;
		line-height: 1.5;
	}
	.code-block code {
		background: none;
		padding: 0;
	}

	/* Saturn Run Steps */
	.run-steps {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 2px 0 6px;
	}
	.run-steps-head {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		border-radius: 6px;
		background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.06));
		border: 1px solid var(--vscode-textBlockQuote-border, rgba(127,127,127,0.12));
		color: var(--vscode-descriptionForeground);
		cursor: pointer;
		font-size: 11.5px;
		width: fit-content;
		max-width: 100%;
		font-family: inherit;
		transition: background 120ms ease, color 120ms ease;
	}
	.run-steps-head:hover {
		color: var(--vscode-foreground);
		background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.14));
	}
	.run-steps-title {
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.run-steps-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding-left: 6px;
		border-left: 2px solid var(--vscode-textBlockQuote-border, rgba(127,127,127,0.15));
		margin: 3px 0 4px 6px;
	}
	.step-row-wrap {
		display: flex;
		flex-direction: column;
	}
	.step-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 6px;
		border-radius: 5px;
		background: none;
		border: 0;
		color: var(--vscode-descriptionForeground);
		cursor: pointer;
		font-size: 11.5px;
		text-align: left;
		transition: background 100ms ease, color 100ms ease;
		width: 100%;
		font-family: inherit;
	}
	.step-row:hover {
		color: var(--vscode-foreground);
		background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.08));
	}
	.step-row.step-thought {
		color: var(--vscode-descriptionForeground);
		font-weight: 500;
	}
	.step-row.step-thought:hover {
		color: var(--vscode-foreground);
	}
	.step-icon {
		font-size: 11px;
		color: var(--vscode-descriptionForeground);
		opacity: 0.7;
		flex-shrink: 0;
		width: 12px;
		text-align: center;
	}
	.step-verb {
		color: var(--vscode-descriptionForeground);
		opacity: 0.8;
		flex-shrink: 0;
	}
	.step-row:hover .step-verb { opacity: 1; }
	.step-target {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.step-file-badge {
		font-size: 9px;
		font-weight: 700;
		padding: 1px 4px;
		border-radius: 3px;
		background: var(--saturn-accent-subtle);
		color: var(--saturn-accent);
		font-family: "SF Mono", "JetBrains Mono", Menlo, Monaco, monospace;
		line-height: 1.1;
		flex-shrink: 0;
	}
	.step-target-text {
		color: var(--vscode-descriptionForeground);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.step-row:hover .step-target-text { color: var(--vscode-foreground); }
	.step-target-text.mono {
		font-family: "SF Mono", "JetBrains Mono", Menlo, Monaco, monospace;
		font-size: 11.5px;
	}
	.step-suffix {
		font-family: "SF Mono", "JetBrains Mono", Menlo, Monaco, monospace;
		font-size: 11px;
		opacity: 0.6;
		flex-shrink: 0;
	}
	.step-state {
		font-size: 10px;
		padding: 1px 5px;
		border-radius: 4px;
		font-weight: 600;
		flex-shrink: 0;
	}
	.step-state.failed {
		background: rgba(248, 113, 113, 0.15);
		color: var(--vscode-errorForeground, #f87171);
	}
	.step-state.waiting {
		background: rgba(251, 191, 36, 0.15);
		color: var(--vscode-editorWarning-foreground, #fbbf24);
	}
	.step-chevron {
		transition: transform 0.15s ease;
		color: var(--vscode-descriptionForeground);
		flex-shrink: 0;
	}
	.step-chevron.down { transform: rotate(90deg); }
	.step-chevron.subtle { opacity: 0.5; }
	.step-working {
		font-size: 12px;
		color: var(--vscode-descriptionForeground);
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 2px 4px;
		font-weight: 500;
		animation: pulse-working 2s ease-in-out infinite;
	}
	@keyframes pulse-working { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
	.step-thought-body {
		margin: 3px 0 6px 0;
		padding: 10px 14px;
		background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.06));
		border-radius: 8px;
		color: var(--vscode-descriptionForeground);
		font-family: inherit;
		font-size: 12px;
		line-height: 1.55;
		max-height: 320px;
		overflow-y: auto;
		border: 1px solid var(--vscode-textBlockQuote-border, rgba(127,127,127,0.15));
	}
	.step-thought-body p { margin: 0 0 8px 0; }
	.step-thought-body p:last-child { margin-bottom: 0; }
	.step-thought-body .thought-heading {
		font-weight: 600;
		color: var(--vscode-foreground);
		margin-top: 8px;
		margin-bottom: 3px;
		font-size: 12px;
	}
	.step-thought-body .thought-heading:first-child { margin-top: 0; }
	.step-thought-body strong { color: var(--vscode-foreground); font-weight: 600; }
	.step-thought-body code {
		background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12));
		padding: 1px 4px;
		border-radius: 3px;
		font-family: "SF Mono", "JetBrains Mono", Menlo, Monaco, monospace;
		font-size: 11px;
	}
	.step-details {
		margin: 3px 0 6px 0;
		padding: 8px 12px;
		background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.06));
		border-radius: 8px;
		font-size: 11.5px;
		border: 1px solid var(--vscode-textBlockQuote-border, rgba(127,127,127,0.15));
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.step-detail-label {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--vscode-descriptionForeground);
		font-weight: 600;
		margin-bottom: 4px;
	}
	.step-detail-block pre {
		margin: 0;
		padding: 6px 8px;
		background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12));
		border-radius: 5px;
		font-family: "SF Mono", "JetBrains Mono", Menlo, Monaco, monospace;
		font-size: 11px;
		overflow-x: auto;
		max-height: 200px;
		white-space: pre-wrap;
		word-break: break-all;
	}
	.step-screenshot-wrap {
		margin: 4px 0 6px 0;
		display: inline-block;
		max-width: 25%;
		border-radius: 6px;
		overflow: hidden;
		border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.2));
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
	}
	.step-screenshot-wrap img {
		display: block;
		width: 100%;
		height: auto;
		object-fit: contain;
	}

	.status {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--vscode-descriptionForeground);
		font-size: 12px;
		flex-wrap: wrap;
		padding: 3px 8px;
		border-radius: 6px;
		background: var(--vscode-badge-background, rgba(127,127,127,0.1));
		width: fit-content;
	}
	.status.failed {
		color: var(--vscode-errorForeground);
		background: rgba(248, 113, 113, 0.12);
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--saturn-accent);
		animation: pulse 1.2s infinite;
		flex-shrink: 0;
	}
	@keyframes pulse { 50% { opacity: .3; } }
	.link {
		background: none;
		border: 0;
		padding: 0;
		color: var(--vscode-textLink-foreground);
		cursor: pointer;
		font: inherit;
		text-decoration: underline;
	}

	/* ─── Footer & Composer Card (Red-boxed in screenshot) ─── */
	footer {
		padding: 4px 12px 12px;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
		position: relative;
	}
	.composer-card {
		border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.2));
		background: var(--vscode-input-background, #ffffff);
		border-radius: 14px;
		padding: 10px 12px 8px;
		box-shadow: 0 2px 10px rgba(0, 0, 0, 0.04);
		transition: border-color 140ms ease, box-shadow 140ms ease;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.composer-card:focus-within {
		border-color: var(--saturn-accent) !important;
		box-shadow: 0 0 0 1.5px var(--saturn-accent), 0 4px 18px var(--saturn-ring) !important;
	}
	.composer-input-row {
		display: flex;
		align-items: flex-start;
		gap: 6px;
	}
	textarea#input {
		width: 100%;
		resize: none;
		border: 0;
		outline: none;
		background: transparent;
		color: var(--vscode-input-foreground);
		font-family: inherit;
		font-size: 13.5px;
		line-height: 1.45;
		min-height: 38px;
		max-height: 180px;
		padding: 2px 0 0 0;
	}
	textarea#input::placeholder {
		color: var(--vscode-input-placeholderForeground, #a1a1aa);
	}
	.composer-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding-top: 4px;
	}
	.toolbar-left, .toolbar-right {
		display: flex;
		align-items: center;
		gap: 5px;
		min-width: 0;
	}
	.composer-btn {
		width: 24px;
		height: 24px;
		border: 0;
		background: transparent;
		color: var(--vscode-descriptionForeground);
		border-radius: 5px;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		transition: background 120ms ease, color 120ms ease;
		flex-shrink: 0;
	}
	.composer-btn:hover {
		background: rgba(127,127,127,0.12);
		color: var(--vscode-foreground);
	}
	.toolbar-divider {
		width: 1px;
		height: 14px;
		background: var(--vscode-widget-border, rgba(127,127,127,0.2));
		margin: 0 2px;
		flex-shrink: 0;
	}
	.context-pill {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		background: rgba(127, 127, 127, 0.08);
		border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.18));
		border-radius: 5px;
		padding: 2px 6px;
		font-size: 11px;
		font-weight: 600;
		font-family: "SF Mono", Menlo, Monaco, monospace;
		color: var(--vscode-foreground);
		max-width: 150px;
		min-width: 0;
		user-select: none;
	}
	.context-pill .file-icon {
		opacity: 0.7;
		flex-shrink: 0;
	}
	.context-pill .pill-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pill-remove {
		background: transparent;
		border: 0;
		color: var(--vscode-descriptionForeground);
		cursor: pointer;
		font-size: 10px;
		padding: 0 1px;
		line-height: 1;
		margin-left: 2px;
		opacity: 0.7;
		border-radius: 3px;
	}
	.pill-remove:hover {
		opacity: 1;
		color: var(--vscode-foreground);
	}
	.send-circle-btn {
		width: 28px;
		height: 28px;
		min-width: 28px;
		border-radius: 50%;
		border: 0;
		background: var(--saturn-accent);
		color: #ffffff;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		transition: transform 120ms ease, background-color 120ms ease, opacity 120ms ease;
		padding: 0;
		flex-shrink: 0;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
	}
	.send-circle-btn:hover:not(:disabled) {
		background: var(--saturn-accent-hover);
		transform: scale(1.06);
	}
	.send-circle-btn:active:not(:disabled) {
		transform: scale(0.94);
	}
	.send-circle-btn:disabled {
		opacity: 0.35;
		cursor: default;
		transform: none;
	}
	.send-circle-btn.stop {
		background: var(--vscode-foreground);
		color: var(--vscode-editor-background, var(--vscode-sideBar-background));
	}
	.send-circle-btn.stop:hover:not(:disabled) {
		background: var(--vscode-foreground);
		opacity: 0.85;
	}

	/* ─── Under-Composer Sub-Row (Model badge) ─── */
	.composer-sub-row {
		min-width: 0;
		display: flex;
		align-items: center;
		justify-content: flex-start;
		padding: 1px 4px 0;
	}
	.model-badge-btn {
		max-width: 100%;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		background: rgba(127, 127, 127, 0.08);
		border: 1px solid transparent;
		border-radius: 999px;
		padding: 3px 9px;
		font-size: 11px;
		font-weight: 500;
		color: var(--vscode-descriptionForeground);
		display: inline-flex;
		align-items: center;
		gap: 5px;
		cursor: pointer;
		font-family: inherit;
		transition: all 120ms ease;
	}
	.model-badge-btn:hover {
		color: var(--vscode-foreground);
		background: rgba(127, 127, 127, 0.14);
		border-color: var(--vscode-widget-border, rgba(127,127,127,0.2));
	}
	.model-badge-btn .model-name {
		font-weight: 600;
		color: var(--vscode-foreground);
	}
	.model-badge-btn .model-level {
		opacity: 0.75;
	}

	/* ─── Model Picker Popover ─── */
	.model-popover {
		position: absolute;
		bottom: 38px;
		left: 12px;
		z-index: 60;
		background: var(--vscode-dropdown-background, #1e1f23);
		border: 1px solid var(--vscode-dropdown-border, rgba(255, 255, 255, 0.12));
		border-radius: 12px;
		box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
		padding: 8px 6px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 250px;
		max-height: 320px;
		overflow-y: auto;
	}
	.model-popover-header {
		font-size: 11px;
		font-weight: 500;
		color: var(--vscode-descriptionForeground, #8a8f98);
		padding: 4px 10px 6px 10px;
		user-select: none;
	}
	.model-popover-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 7px 10px;
		border-radius: 8px;
		font-size: 12px;
		cursor: pointer;
		color: var(--vscode-foreground);
		transition: background 100ms ease;
	}
	.model-popover-item:hover {
		background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.08));
	}
	.model-popover-item.active {
		font-weight: 600;
	}
	.model-item-left {
		display: flex;
		align-items: center;
		gap: 6px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.model-item-right {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}
	.model-item-tier {
		font-size: 11px;
		color: var(--vscode-descriptionForeground, #8a8f98);
	}
	.model-item-warn {
		font-size: 11px;
	}
	.model-item-badge {
		font-size: 10px;
		font-weight: 500;
		padding: 2px 6px;
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.1);
		color: var(--vscode-foreground, #fff);
	}
	.model-item-arrow {
		opacity: 0.5;
		display: flex;
		align-items: center;
	}
	.model-item-check {
		color: var(--vscode-foreground, #fff);
		display: flex;
		align-items: center;
	}
	.model-popover-divider {
		height: 1px;
		background: var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
		margin: 6px 4px;
	}
	.model-popover-action {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 7px 10px;
		border-radius: 8px;
		font-size: 12px;
		cursor: pointer;
		color: var(--vscode-foreground);
		background: transparent;
		border: none;
		width: 100%;
		text-align: left;
		font-family: inherit;
	}
	.model-popover-action:hover {
		background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.08));
	}
	.model-action-left {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	/* ─── Slash Commands Popover ─── */
	.slash-popup {
		position: absolute;
		bottom: 74px;
		left: 14px;
		z-index: 60;
		background: var(--vscode-dropdown-background, var(--vscode-editor-background));
		border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border, rgba(127,127,127,0.25)));
		border-radius: 10px;
		box-shadow: 0 10px 30px rgba(0,0,0,0.25);
		padding: 6px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 220px;
	}
	.slash-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 6px 10px;
		border-radius: 6px;
		font-size: 12px;
		cursor: pointer;
		color: var(--vscode-foreground);
	}
	.slash-item:hover {
		background: var(--vscode-list-hoverBackground);
	}
	.slash-item strong {
		color: var(--saturn-accent);
		font-family: "SF Mono", Menlo, monospace;
	}
	.slash-item span {
		font-size: 11px;
		color: var(--vscode-descriptionForeground);
		margin-left: 10px;
	}

	.error {
		color: var(--vscode-errorForeground);
		font-size: 12px;
		padding: 0 12px 6px;
	}
	/* ─── Approvals, change review, context chips, code block actions ─── */
	.approval-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 8px;
		padding: 8px 10px;
		border: 1px solid var(--vscode-editorWarning-foreground, #d29922);
		border-radius: 8px;
		background: rgba(210, 153, 34, 0.08);
		font-size: 12px;
	}
	.approval-bar .approval-text { flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; }
	.approval-actions { display: inline-flex; gap: 6px; margin-left: auto; flex-shrink: 0; }
	.approval-bar code { font-family: var(--vscode-editor-font-family); font-size: 11.5px; }
	.btn-small {
		border: 1px solid var(--vscode-button-border, transparent);
		border-radius: 5px;
		padding: 3px 10px;
		font: inherit;
		font-size: 12px;
		cursor: pointer;
		background: var(--vscode-button-secondaryBackground, rgba(127, 127, 127, 0.18));
		color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
	}
	.btn-small.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	.btn-small:hover { filter: brightness(1.12); }
	.btn-small:disabled { opacity: 0.5; cursor: default; }
	.changes-card {
		margin-top: 8px;
		border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.3));
		border-radius: 8px;
		overflow: hidden;
		font-size: 12px;
	}
	.changes-head {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 10px;
		background: rgba(127, 127, 127, 0.08);
	}
	.changes-head .changes-title { flex: 1; font-weight: 600; }
	.change-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		border-top: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.18));
	}
	.change-row:hover { background: rgba(127, 127, 127, 0.08); }
	.change-kind { width: 14px; text-align: center; font-weight: 700; font-family: var(--vscode-editor-font-family); }
	.change-kind.added { color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); }
	.change-kind.modified { color: var(--vscode-gitDecoration-modifiedResourceForeground, #d29922); }
	.change-kind.deleted { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
	.change-path {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		cursor: pointer;
		font-family: var(--vscode-editor-font-family);
		font-size: 11.5px;
	}
	.change-path:hover { text-decoration: underline; }
	.change-state { color: var(--vscode-descriptionForeground); font-size: 11px; }
	.user-turn { flex-wrap: wrap; }
	.user-context {
		flex-basis: 100%;
		text-align: right;
		margin-top: 2px;
		font-size: 11px;
		color: var(--vscode-descriptionForeground);
		max-width: 90%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.user-restore-btn {
		background: none;
		border: 0;
		cursor: pointer;
		color: var(--vscode-descriptionForeground);
		font-size: 13px;
		padding: 2px 4px;
		border-radius: 4px;
		opacity: 0;
	}
	.user-block:hover .user-restore-btn { opacity: 1; }
	.user-restore-btn:hover { color: var(--vscode-foreground); background: rgba(127, 127, 127, 0.15); }
	.context-chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 10px 0; }
	.context-chips:empty { display: none; }
	.context-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		max-width: 220px;
		padding: 1px 4px 1px 7px;
		border-radius: 10px;
		font-size: 11px;
		background: rgba(127, 127, 127, 0.15);
	}
	.context-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.context-chip button { background: none; border: 0; color: inherit; cursor: pointer; padding: 0 2px; opacity: 0.7; }
	.codebase-toggle {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border: 1px solid transparent;
		border-radius: 10px;
		padding: 1px 8px;
		font: inherit;
		font-size: 11px;
		cursor: pointer;
		background: none;
		color: var(--vscode-descriptionForeground);
	}
	.codebase-toggle.on {
		color: var(--vscode-foreground);
		border-color: var(--saturn-ring);
		background: var(--saturn-accent-subtle);
	}
	.code-actions { display: inline-flex; gap: 2px; }
</style>
</head>
<body>

<!-- Saturn Header -->
<header class="saturn-header">
	<div class="header-session-row">
		<div class="session-title-wrap">
			<img class="saturn-header-logo" src="${icon}" alt="Saturn">
			<span class="session-title" id="sessionTitle" title="Click to rename session">Untitled</span>
			<input type="text" class="session-title-input" id="sessionTitleInput" value="Untitled">
			<button class="worktree-btn" id="worktreeBtn" type="button" hidden title="Work on an own git branch"></button>
		</div>
		<div class="session-actions">
			<button class="hdr-btn" id="historyBtn" title="Session history">
				<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
					<path fill-rule="evenodd" d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
					<path d="M8.5 3.5a.5.5 0 0 0-1 0v5a.5.5 0 0 0 .25.433l3.5 2a.5.5 0 1 0 .5-.866L8.5 8.21V3.5z"/>
				</svg>
			</button>
			<button class="hdr-btn" id="expandBtn" title="Open Agent in auxiliary window">
				<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
					<path d="M1.5 1a.5.5 0 0 0-.5.5v4a.5.5 0 0 0 1 0V2h3.5a.5.5 0 0 0 0-1h-4zm13 0h-4a.5.5 0 0 0 0 1H14v3.5a.5.5 0 0 0 1 0v-4a.5.5 0 0 0-.5-.5zM1 10.5a.5.5 0 0 0 .5.5H5a.5.5 0 0 0 0-1H2v-3.5a.5.5 0 0 0-1 0v4zm14 0a.5.5 0 0 0-1 0V14h-3.5a.5.5 0 0 0 0 1h4a.5.5 0 0 0 .5-.5v-4z"/>
				</svg>
			</button>
			<button class="hdr-btn" id="newChatBtn" title="New Chat">
				<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
					<path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zM4 7.5a.5.5 0 0 1 .5-.5h3V4a.5.5 0 0 1 1 0v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0V8h-3a.5.5 0 0 1-.5-.5z"/>
				</svg>
			</button>
		</div>
	</div>

	<!-- History Popover -->
	<div class="history-popover" id="historyPopover">
		<div class="history-popover-header">
			<span>Recent Chats</span>
			<button class="history-close-btn" id="closeHistoryBtn">✕</button>
		</div>
		<div class="history-list" id="historyList"></div>
	</div>
</header>

<!-- Project access: chats here work in the open folder only after the user allows it -->
<div class="project-banner" id="projectBanner" hidden></div>

<!-- Chat Log or Empty State -->
<div id="log"></div>

<div id="error" class="error" hidden></div>


<!-- Composer Card (Red-boxed in screenshot) -->
<footer>
	<form class="composer-card" id="form">
		<div class="context-chips" id="contextChips"></div>
		<div class="composer-input-row">
			<textarea id="input" rows="1" placeholder="Ask Saturn anything, / for commands..."></textarea>
		</div>

		<div class="composer-toolbar">
			<div class="toolbar-left">
				<button type="button" class="composer-btn" id="attachBtn" title="Attach file or context">
					<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
						<path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2z"/>
					</svg>
				</button>
				<button type="button" class="composer-btn" id="atBtn" title="Attach files, a folder, a web page or git changes (@)">
					<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
						<circle cx="8" cy="8" r="2.6"/>
						<path d="M10.6 8v1.1a1.9 1.9 0 0 0 3.8 0V8a6.4 6.4 0 1 0-2.5 5.1"/>
					</svg>
				</button>
				<button type="button" class="codebase-toggle on" id="codebaseBtn" title="Search the project for code related to your message and include it">Codebase</button>
				<button type="button" class="composer-btn" id="slashBtn" title="Slash commands (/help, /clear, /compact)">
					<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
						<rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/>
						<line x1="10.5" y1="4.5" x2="5.5" y2="11.5"/>
					</svg>
				</button>
				<span class="toolbar-divider"></span>
				<div class="context-pill" id="contextPill" title="Attached active editor file">
					<svg class="file-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
						<path d="M4 0h5.5v3.5A1.5 1.5 0 0 0 11 5h3.5v9.5A1.5 1.5 0 0 1 13 16H4a1.5 1.5 0 0 1-1.5-1.5v-13A1.5 1.5 0 0 1 4 0zm6 1.5V4a.5.5 0 0 0 .5.5H13L10 1.5z"/>
					</svg>
					<span class="pill-name" id="pillFileName">LICENSE</span>
					<button type="button" class="pill-remove" id="pillRemoveBtn" title="Remove context">✕</button>
				</div>
			</div>

			<div class="toolbar-right">
				<button type="submit" class="send-circle-btn" id="send" title="Send (Enter)">
					<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
						<path fill-rule="evenodd" d="M8 14a.75.75 0 0 1-.75-.75V3.56L4.03 6.78a.75.75 0 0 1-1.06-1.06l4.5-4.5a.75.75 0 0 1 1.06 0l4.5 4.5a.75.75 0 1 1-1.06 1.06L8.75 3.56v9.69A.75.75 0 0 1 8 14z" clip-rule="evenodd"/>
					</svg>
				</button>
			</div>
		</div>
	</form>

	<!-- Model / Agent Selector Sub-Row -->
	<div class="composer-sub-row">
		<button type="button" class="model-badge-btn" id="modelPickerBtn" title="Select agent / model">
			<span class="model-name" id="modelBadgeName">Opus 5.5</span>
			<span class="model-level" id="modelBadgeLevel">Medium</span>
			<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
				<path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/>
			</svg>
		</button>
	</div>
	<select id="agent" hidden aria-hidden="true" tabindex="-1"></select>

	<!-- Slash Commands Menu Popup -->
	<div class="slash-popup" id="slashPopup">
		<div class="slash-item" data-cmd="/clear">
			<strong>/clear</strong> <span>New chat / clear history</span>
		</div>
		<div class="slash-item" data-cmd="/model">
			<strong>/model</strong> <span>Switch agent or model tier</span>
		</div>
		<div class="slash-item" data-cmd="/help">
			<strong>/help</strong> <span>Show agent instructions & tools</span>
		</div>
	</div>

	<!-- Model Picker Popover -->
	<div class="model-popover" id="modelPopover"></div>
</footer>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const $ = (id) => document.getElementById(id);
	const log = $('log'), input = $('input'), agentSelect = $('agent'), send = $('send'), errorBox = $('error');
	const projectBanner = $('projectBanner');
	const sessionTitle = $('sessionTitle'), sessionTitleInput = $('sessionTitleInput');
	const contextPill = $('contextPill'), pillFileName = $('pillFileName'), pillRemoveBtn = $('pillRemoveBtn');
	const attachBtn = $('attachBtn'), slashBtn = $('slashBtn'), slashPopup = $('slashPopup');
	const atBtn = $('atBtn'), codebaseBtn = $('codebaseBtn'), contextChips = $('contextChips');
	/** Files, folders, pages and git changes attached to the next message. */
	let pendingContext = [];
	const modelPickerBtn = $('modelPickerBtn'), modelBadgeName = $('modelBadgeName'), modelBadgeLevel = $('modelBadgeLevel'), modelPopover = $('modelPopover');
	// The open/closed checks below read el.style.display, so start every toggled element at an explicit 'none'.
	for (const id of ['sessionTitleInput', 'historyPopover', 'slashPopup', 'modelPopover', 'agent']) {
		const el = document.getElementById(id);
		if (el) el.style.display = 'none';
	}
	const historyBtn = $('historyBtn'), historyPopover = $('historyPopover'), closeHistoryBtn = $('closeHistoryBtn'), historyList = $('historyList'), newChatBtn = $('newChatBtn'), expandBtn = $('expandBtn');

	const state = vscode.getState() || {};
	let runs = [];
	let current = null;
	let editingRunId = null;
	let editingDraft = '';
	let activeFileName = null;
	let contextAttached = true;
	let rawAgents = [];
	let rawModels = [];
	/** This agent's chats in the open project, newest first, and the one on screen (null until the first message). */
	let threads = [];
	let currentThreadId = null;
	let currentTitle = 'New Chat';

	function showTitle(title) {
		currentTitle = title || 'New Chat';
		sessionTitle.textContent = currentTitle;
		sessionTitleInput.value = currentTitle;
	}
	showTitle(currentTitle);

	const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' };
	/** The badge's second word: the model's real reasoning effort when it has one. */
	function effortLabel(model) {
		return model && model.effort ? EFFORT_LABELS[model.effort] || model.effort : '';
	}

	function relativeTime(iso) {
		const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
		if (!Number.isFinite(minutes)) return '';
		if (minutes < 1) return 'now';
		if (minutes < 60) return minutes + 'm';
		const hours = Math.round(minutes / 60);
		return hours < 24 ? hours + 'h' : Math.round(hours / 24) + 'd';
	}

	function updateModelBadge() {
		const agent = rawAgents.find((item) => item.id === agentSelect.value);
		const model = agent ? rawModels.find((item) => item.id === agent.modelConnectionId) : undefined;
		modelBadgeName.textContent = model ? model.name : agent ? agent.name : 'No agent';
		modelBadgeLevel.textContent = effortLabel(model);
		modelBadgeLevel.hidden = !modelBadgeLevel.textContent;
	}

	const busy = (run) => run && (run.status === 'running' || run.status === 'queued' || run.status === 'sleeping');
	const shown = (text) => String(text || '').replace(/\\n\\n<saturn_context[\\s\\S]*<\\/saturn_context>$/, '').replace(/\\n\\n<editor_context>[\\s\\S]*<\\/editor_context>$/, '');
	/** What was attached to a message (shown under it), from the hidden context block. */
	const contextSources = (text) => {
		const match = /<saturn_context sources="([^"]*)">/.exec(String(text || ''));
		return match ? match[1] : '';
	};
	/** Files this run changed that are still different from their originals. */
	const changedFiles = (run) => (run && run.checkpoint && Array.isArray(run.checkpoint.files) ? run.checkpoint.files.filter((file) => file.before !== file.after) : []);
	const SHELL_LANGS = ['sh', 'bash', 'zsh', 'shell', 'console', 'terminal', 'fish'];
	const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };

	function countdown(at) {
		const left = Math.max(0, Math.ceil((Date.parse(at) - Date.now()) / 1000));
		return left ? Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') : 'now';
	}

	const runStepsOpen = new Map();
	const itemDetailsOpen = new Set();

	function formatDuration(seconds) {
		const whole = Math.max(1, Math.round(seconds));
		if (whole < 60) return whole + 's';
		const minutes = Math.floor(whole / 60);
		const rest = whole % 60;
		return rest ? minutes + 'm ' + rest + 's' : minutes + 'm';
	}

	function fileBadge(filePath) {
		if (!filePath || typeof filePath !== 'string') return '';
		const name = filePath.split('/').pop() || '';
		const dot = name.lastIndexOf('.');
		if (dot <= 0 || dot === name.length - 1) return '';
		return name.slice(dot + 1).slice(0, 4).toUpperCase();
	}

	function shortUrl(url) {
		try {
			const parsed = new URL(url);
			const path = parsed.pathname === '/' ? '' : parsed.pathname;
			return parsed.host + path;
		} catch {
			return url || '';
		}
	}

	function readRange(action) {
		const result = action.result;
		const total = typeof result?.lines === 'number' ? result.lines : undefined;
		if (!total) return '';
		const args = action.arguments || {};
		const start = typeof result?.offset === 'number' ? result.offset : 1;
		const limit = typeof args.limit === 'number' ? args.limit : Number(args.limit);
		const end = Number.isFinite(limit) && limit > 0 ? Math.min(total, start + limit - 1) : total;
		return end > start ? '#L' + start + '-' + end : '#L' + start;
	}

	function actionLine(action) {
		const args = action.arguments || {};
		const str = (v) => (typeof v === 'string' ? v : '');
		if (action.toolId === 'files') {
			const mode = str(args.action) || 'list';
			const target = str(args.path);
			if (mode === 'read') return { verb: 'Analyzed', target: target || 'file', badge: fileBadge(target), suffix: readRange(action) };
			if (mode === 'write') return { verb: 'Edited', target: target || 'file', badge: fileBadge(target) };
			if (mode === 'patch') {
				const applied = (action.result && action.result.applied) || [];
				const first = (applied[0] && applied[0].path) || '';
				const more = applied.length > 1 ? ' +' + (applied.length - 1) : '';
				return { verb: 'Edited', target: first ? first + more : 'files', badge: fileBadge(first) };
			}
			return { verb: 'Listed', target: target || 'workspace' };
		}
		if (action.toolId === 'code') return { verb: 'Ran', target: str(args.command) || 'command', mono: true };
		if (action.toolId === 'web') return { verb: 'Read', target: shortUrl(str(args.url)) || 'web page' };
		if (action.toolId === 'multi_step') {
			const steps = Array.isArray(args.steps) ? args.steps.length : 0;
			return { verb: 'Updated plan', target: steps ? steps + (steps === 1 ? ' step' : ' steps') : '' };
		}
		if (action.toolId === 'mcp') return { verb: 'Called', target: str(args.tool) || str(args.toolId) || 'MCP tool', mono: true };
		if (action.toolId === 'computer_screenshot') return { verb: 'Captured', target: 'screenshot' };
		if (action.toolId === 'computer_click') return { verb: 'Clicked', target: '(' + (args.x ?? 0) + ', ' + (args.y ?? 0) + ')' };
		if (action.toolId === 'computer_type') return { verb: 'Typed', target: typeof args.text === 'string' ? '"' + args.text.slice(0, 30) + '"' : 'text' };
		return { verb: 'Called', target: action.toolId, mono: true };
	}

	function runSteps(run) {
		const thoughts = run.thoughts && run.thoughts.length
			? [...run.thoughts].sort((a, b) => a.at - b.at)
			: run.thinking && run.thinking.trim()
				? [{ text: run.thinking.trim(), seconds: 0, at: 0 }]
				: [];
		const steps = [];
		let next = 0;
		const flush = (upTo) => {
			while (next < thoughts.length && thoughts[next].at <= upTo) {
				steps.push({ kind: 'thought', thought: thoughts[next] });
				next += 1;
			}
		};
		(run.actions || []).forEach((action, index) => {
			flush(index);
			steps.push({ kind: 'action', action });
		});
		flush(Infinity);
		return steps;
	}

	function currentLabel(steps) {
		const last = steps[steps.length - 1];
		if (!last || last.kind === 'thought') return 'Thinking…';
		const line = actionLine(last.action);
		return [line.verb, line.target].filter(Boolean).join(' ');
	}

	function doneLabel(steps) {
		const thoughts = steps.filter((s) => s.kind === 'thought');
		const actions = steps.filter((s) => s.kind === 'action');
		const seconds = thoughts.reduce((sum, s) => sum + (s.thought.seconds || 0), 0);
		const parts = [];
		if (thoughts.length) parts.push(seconds > 0 ? 'Thought for ' + formatDuration(seconds) : 'Thought');
		if (actions.length) parts.push(actions.length + (actions.length === 1 ? ' tool call' : ' tool calls'));
		return parts.length ? parts.join(' · ') : 'Completed';
	}

	function formatPayload(value) {
		if (value === undefined || value === null) return '';
		if (typeof value === 'string') return value;
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	}

	function sanitizeResult(val) {
		if (!val || typeof val !== 'object') return val;
		const clone = { ...val };
		if (typeof clone.image === 'string' && clone.image.startsWith('data:image/')) clone.image = '[screenshot image]';
		if (typeof clone.screenshot === 'string' && clone.screenshot.startsWith('data:image/')) clone.screenshot = '[screenshot image]';
		if (typeof clone.base64 === 'string' && clone.base64.length > 80) clone.base64 = '[base64 data]';
		return clone;
	}

	function createChevron(down, subtle) {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', 'step-chevron' + (down ? ' down' : '') + (subtle ? ' subtle' : ''));
		svg.setAttribute('width', '12');
		svg.setAttribute('height', '12');
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('aria-hidden', 'true');
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', 'M6 4l4 4-4 4');
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', '1.6');
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		svg.append(path);
		return svg;
	}

	function createPencilIcon() {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('width', '13');
		svg.setAttribute('height', '13');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');
		const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		p1.setAttribute('d', 'M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z');
		const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		p2.setAttribute('d', 'm15 5 4 4');
		svg.append(p1, p2);
		return svg;
	}

	function renderInline(text, targetEl) {
		const parts = text.split(/(\\*\\*[^*]+\\*\\*|\x60[^\x60]+\x60)/g);
		for (const part of parts) {
			if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
				targetEl.append(el('strong', '', part.slice(2, -2)));
			} else if (part.startsWith('\x60') && part.endsWith('\x60') && part.length > 2) {
				targetEl.append(el('code', '', part.slice(1, -1)));
			} else if (part) {
				targetEl.append(document.createTextNode(part));
			}
		}
	}

	function renderThoughtText(text) {
		const container = el('div', 'step-thought-body');
		const paragraphs = text.split(/\\n{2,}/).map((p) => p.trim()).filter(Boolean);
		for (const para of paragraphs) {
			const heading = para.match(/^\\*\\*(.+?)\\*\\*$/);
			if (heading) {
				container.append(el('div', 'thought-heading', heading[1]));
				continue;
			}
			const p = el('p', '');
			renderInline(para, p);
			container.append(p);
		}
		return container;
	}

	function renderAssistant(text) {
		const container = el('div', 'assistant');
		if (!text) return container;
		const codeFenceRegex = /\x60\x60\x60([a-zA-Z0-9_-]*)\\n([\\s\\S]*?)\x60\x60\x60/g;
		let lastIndex = 0;
		let match;
		while ((match = codeFenceRegex.exec(text)) !== null) {
			const preText = text.slice(lastIndex, match.index);
			if (preText) {
				renderInline(preText, container);
			}
			const lang = match[1] || 'code';
			const code = match[2];
			const block = el('div', 'code-block');
			const head = el('div', 'code-block-header');
			head.append(el('span', 'code-lang', lang));
			const copyBtn = el('button', 'code-copy', 'Copy');
			copyBtn.type = 'button';
			copyBtn.onclick = () => {
				navigator.clipboard.writeText(code).then(() => {
					copyBtn.textContent = 'Copied!';
					setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1800);
				});
			};
			const actionsWrap = el('span', 'code-actions');
			if (SHELL_LANGS.includes(String(lang).toLowerCase())) {
				const runBtn = el('button', 'code-copy', 'Run');
				runBtn.type = 'button';
				runBtn.title = 'Open a terminal with this command typed in (you press Enter)';
				runBtn.onclick = () => vscode.postMessage({ type: 'runInTerminal', command: code.replace(/^\\$\\s+/gm, '') });
				actionsWrap.append(runBtn);
			} else {
				const applyBtn = el('button', 'code-copy', 'Apply');
				applyBtn.type = 'button';
				applyBtn.title = 'Merge this code into its file and review the diff';
				applyBtn.onclick = () => vscode.postMessage({ type: 'apply', code, lang });
				actionsWrap.append(applyBtn);
			}
			actionsWrap.append(copyBtn);
			head.append(actionsWrap);
			block.append(head);
			const pre = el('pre', '');
			pre.append(el('code', '', code));
			block.append(pre);
			container.append(block);
			lastIndex = match.index + match[0].length;
		}
		const postText = text.slice(lastIndex);
		if (postText) {
			renderInline(postText, container);
		}
		return container;
	}

	function renderRunSteps(run) {
		const steps = runSteps(run);
		const isBusy = busy(run);
		if (!steps.length && !isBusy) return null;

		const wrap = el('div', 'run-steps');
		const defaultOpen = isBusy || !run.output;
		const isOpen = runStepsOpen.has(run.id) ? runStepsOpen.get(run.id) : defaultOpen;

		const head = el('button', 'run-steps-head');
		head.type = 'button';
		head.setAttribute('aria-expanded', String(isOpen));

		if (isBusy) {
			head.append(el('span', 'dot'));
		}

		head.append(el('span', 'run-steps-title', isBusy ? currentLabel(steps) : doneLabel(steps)));
		head.append(createChevron(isOpen));

		head.onclick = (e) => {
			e.stopPropagation();
			runStepsOpen.set(run.id, !isOpen);
			render(false);
		};
		wrap.append(head);

		if (isOpen) {
			const list = el('div', 'run-steps-list');
			steps.forEach((step, idx) => {
				if (step.kind === 'thought') {
					const tKey = 't-' + run.id + '-' + idx;
					const isThoughtOpen = itemDetailsOpen.has(tKey);
					const rowWrap = el('div', 'step-row-wrap');
					const row = el('button', 'step-row step-thought');
					row.type = 'button';
					const label = step.thought.seconds > 0 ? 'Thought for ' + formatDuration(step.thought.seconds) : 'Thought';
					row.append(el('span', 'step-verb', label));
					row.append(createChevron(isThoughtOpen, true));
					row.onclick = () => {
						if (isThoughtOpen) itemDetailsOpen.delete(tKey);
						else itemDetailsOpen.add(tKey);
						render(false);
					};
					rowWrap.append(row);
					if (isThoughtOpen) {
						rowWrap.append(renderThoughtText(step.thought.text));
					}
					list.append(rowWrap);
				} else {
					const action = step.action;
					const aKey = 'a-' + run.id + '-' + (action.id || idx);
					const isActionOpen = itemDetailsOpen.has(aKey);
					const line = actionLine(action);
					const argsText = action.arguments && Object.keys(action.arguments).length > 0 ? formatPayload(action.arguments) : '';
					const resultText = action.reason || formatPayload(sanitizeResult(action.result));
					const hasDetails = Boolean(argsText || resultText);

					const rowWrap = el('div', 'step-row-wrap');
					let stateCls = '';
					let stateLabel = '';
					if (action.status === 'failed') { stateCls = 'failed'; stateLabel = 'Failed'; }
					else if (action.status === 'denied') { stateCls = 'failed'; stateLabel = 'Denied'; }
					else if (action.status === 'waiting_approval') { stateCls = 'waiting'; stateLabel = 'Waiting for approval'; }
					else if (action.status === 'sleeping') { stateCls = 'waiting'; stateLabel = 'Waiting'; }

					const row = el('button', 'step-row step-action' + (stateCls ? ' ' + stateCls : ''));
					row.type = 'button';
					row.title = action.toolId;

					row.append(el('span', 'step-icon', action.status === 'completed' ? '✓' : '•'));
					row.append(el('span', 'step-verb', line.verb));

					if (line.target) {
						const targetSpan = el('span', 'step-target');
						if (line.badge) targetSpan.append(el('span', 'step-file-badge', line.badge));
						targetSpan.append(el('span', 'step-target-text' + (line.mono ? ' mono' : ''), line.target));
						if (line.suffix) targetSpan.append(el('span', 'step-suffix', line.suffix));
						row.append(targetSpan);
					}

					if (stateLabel) {
						row.append(el('span', 'step-state ' + stateCls, stateLabel));
					}

					if (hasDetails) {
						row.append(createChevron(isActionOpen, true));
						row.onclick = () => {
							if (isActionOpen) itemDetailsOpen.delete(aKey);
							else itemDetailsOpen.add(aKey);
							render(false);
						};
					}

					rowWrap.append(row);

					if (action.toolId === 'computer_screenshot' || action.toolId.includes('screenshot')) {
						const res = action.result;
						const imgSrc = typeof res === 'string' && res.startsWith('data:image/') ? res : res && typeof res.image === 'string' && res.image.startsWith('data:image/') ? res.image : null;
						if (imgSrc) {
							const wrapImg = el('div', 'step-screenshot-wrap');
							const img = el('img', '');
							img.src = imgSrc;
							wrapImg.append(img);
							rowWrap.append(wrapImg);
						}
					}

					if (isActionOpen && hasDetails) {
						const details = el('div', 'step-details');
						if (argsText) {
							const block = el('div', 'step-detail-block');
							block.append(el('div', 'step-detail-label', 'Arguments'));
							block.append(el('pre', '', argsText));
							details.append(block);
						}
						if (resultText) {
							const block = el('div', 'step-detail-block');
							block.append(el('div', 'step-detail-label', action.reason ? 'Reason' : 'Result'));
							block.append(el('pre', '', resultText));
							details.append(block);
						}
						rowWrap.append(details);
					}

					list.append(rowWrap);
				}
			});

			if (isBusy) {
				list.append(el('div', 'step-working', 'Working…'));
			}

			wrap.append(list);
		}

		return wrap;
	}

	/** The tool call waiting for the user, with Approve and Deny. */
	function renderApproval(run) {
		const action = (run.actions || []).find((item) => item.status === 'waiting_approval');
		const bar = el('div', 'approval-bar');
		const text = el('span', 'approval-text');
		if (action) {
			const args = action.arguments || {};
			const target = typeof args.command === 'string' ? args.command : args.file_path || args.path || args.url || actionLine(action).target || '';
			text.append(document.createTextNode(typeof args.command === 'string' ? 'Run ' : 'Allow ' + action.toolId + (target ? ' on ' : '')));
			if (target) text.append(el('code', '', String(target).slice(0, 160)));
			text.append(document.createTextNode('?'));
		} else {
			text.append(document.createTextNode('Waiting for your approval'));
		}
		bar.append(text);
		if (action) {
			const deny = el('button', 'btn-small', 'Deny');
			deny.type = 'button';
			const allow = el('button', 'btn-small primary', 'Approve');
			allow.type = 'button';
			const answer = (value) => {
				allow.disabled = true;
				deny.disabled = true;
				vscode.postMessage({ type: 'decide', runId: run.id, actionId: action.id, allow: value });
			};
			deny.onclick = () => answer(false);
			allow.onclick = () => answer(true);
			const buttons = el('span', 'approval-actions');
			buttons.append(deny, allow);
			bar.append(buttons);
		}
		return bar;
	}

	/** The files a run changed: open a diff, revert one, or keep / revert them all. */
	function renderChanges(run) {
		const files = changedFiles(run);
		if (!files.length) return null;
		const root = run.checkpoint.root;
		const card = el('div', 'changes-card');
		const head = el('div', 'changes-head');
		head.append(el('span', 'changes-title', files.length + (files.length === 1 ? ' file changed' : ' files changed')));
		const pending = files.filter((file) => !file.review);
		if (pending.length) {
			const keep = el('button', 'btn-small', 'Keep All');
			keep.type = 'button';
			keep.onclick = () => vscode.postMessage({ type: 'keepAll', runId: run.id });
			const revert = el('button', 'btn-small', 'Revert All');
			revert.type = 'button';
			revert.onclick = () => vscode.postMessage({ type: 'revertAll', runId: run.id });
			head.append(keep, revert);
		}
		card.append(head);
		files.forEach((file) => {
			const kind = file.before === null ? 'added' : file.after === null ? 'deleted' : 'modified';
			const row = el('div', 'change-row');
			row.append(el('span', 'change-kind ' + kind, kind === 'added' ? 'A' : kind === 'deleted' ? 'D' : 'M'));
			const name = el('span', 'change-path', file.path);
			name.title = file.review ? 'Show the diff' : 'Review in the editor: keep or revert each change';
			name.onclick = () => vscode.postMessage({ type: file.review ? 'openDiff' : 'reviewFile', runId: run.id, root, path: file.path });
			row.append(name);
			if (!file.review) {
				const diff = el('button', 'code-copy', 'Diff');
				diff.type = 'button';
				diff.title = 'Side-by-side diff';
				diff.onclick = () => vscode.postMessage({ type: 'openDiff', runId: run.id, root, path: file.path });
				row.append(diff);
			}
			if (file.review) {
				row.append(el('span', 'change-state', file.review === 'kept' ? 'Kept' : 'Reverted'));
			} else {
				const revertOne = el('button', 'code-copy', 'Revert');
				revertOne.type = 'button';
				revertOne.onclick = () => vscode.postMessage({ type: 'revertFile', runId: run.id, path: file.path });
				row.append(revertOne);
			}
			card.append(row);
		});
		return card;
	}

	/** The attached-context chips above the input. */
	function renderChips() {
		contextChips.replaceChildren();
		pendingContext.forEach((item, index) => {
			const chip = el('span', 'context-chip');
			chip.title = item.path || item.url || item.label;
			chip.append(el('span', '', '@' + item.label));
			const remove = el('button', '', '✕');
			remove.type = 'button';
			remove.title = 'Remove';
			remove.onclick = () => {
				pendingContext.splice(index, 1);
				renderChips();
			};
			chip.append(remove);
			contextChips.append(chip);
		});
	}

	function setCodebase(on) {
		state.codebase = on;
		vscode.setState(state);
		codebaseBtn.classList.toggle('on', on);
		codebaseBtn.title = on
			? 'Codebase search is on: code related to your message is found and included. Click to turn off.'
			: 'Codebase search is off. Click to turn on.';
	}

	function renderSaturnEmptyState() {
		const empty = el('div', 'saturn-empty-state');
		empty.id = 'emptyState';

		const hero = el('div', 'saturn-hero');
		const logoImg = el('img', 'saturn-hero-logo');
		logoImg.src = '${icon}';
		logoImg.alt = 'Saturn';

		const kicker = el('div', 'saturn-hero-kicker', 'Saturn Agent');
		const title = el('h2', 'saturn-hero-title', 'What would you like to build?');
		const subtitle = el('p', 'saturn-hero-subtitle', 'Ask questions, edit code across files, or run project workflows.');
		hero.append(logoImg, kicker, title, subtitle);

		const quickCards = el('div', 'saturn-starter-cards');
		const starters = [
			{ icon: '🔍', title: 'Explore Architecture', prompt: "Explain this project's architecture and main entry points." },
			{ icon: '⚡', title: 'Review Active File', prompt: 'Review the current active file for bugs, performance, and best practices.' },
			{ icon: '🧪', title: 'Generate Test Suite', prompt: 'Write comprehensive unit tests for the active file.' },
			{ icon: '✨', title: 'Implement Feature', prompt: 'Plan and implement the next feature step-by-step.' }
		];

		starters.forEach(item => {
			const card = el('button', 'saturn-starter-card');
			card.type = 'button';
			const iconSpan = el('span', 'starter-card-icon', item.icon);
			const textWrap = el('div', 'starter-card-text');
			const titleSpan = el('span', 'starter-card-title', item.title);
			const promptSpan = el('span', 'starter-card-prompt', item.prompt);
			textWrap.append(titleSpan, promptSpan);
			card.append(iconSpan, textWrap);
			card.onclick = () => {
				input.value = item.prompt;
				input.focus();
				$('form').requestSubmit();
			};
			quickCards.append(card);
		});

		empty.append(hero, quickCards);
		return empty;
	}

	function render(autoScroll = true) {
		const wasAtBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
		log.replaceChildren();
		if (!runs.length) {
			log.append(renderSaturnEmptyState());
		}
		for (let runIdx = 0; runIdx < runs.length; runIdx++) {
			const run = runs[runIdx];
			if (editingRunId === run.id) {
				const form = el('form', 'edit-bubble');
				const textarea = el('textarea', '');
				textarea.setAttribute('aria-label', 'Edit message');
				textarea.value = editingDraft;
				textarea.rows = Math.min(8, Math.max(2, editingDraft.split('\\n').length));

				const hintText = runIdx < runs.length - 1
					? 'Sending reruns from this turn and drops subsequent turns.'
					: 'Sending reruns this turn.';
				const hint = el('div', 'edit-hint', hintText);

				const actions = el('div', 'edit-actions');
				const cancelBtn = el('button', 'btn-cancel', 'Cancel');
				cancelBtn.type = 'button';
				cancelBtn.onclick = () => {
					editingRunId = null;
					editingDraft = '';
					render(false);
				};

				const saveBtn = el('button', 'btn-save', 'Rerun');
				saveBtn.type = 'submit';
				saveBtn.disabled = !editingDraft.trim() || busy(current);

				textarea.addEventListener('input', () => {
					editingDraft = textarea.value;
					saveBtn.disabled = !editingDraft.trim() || busy(current);
					textarea.rows = Math.min(8, Math.max(2, editingDraft.split('\\n').length));
				});

				textarea.addEventListener('keydown', (event) => {
					if (event.key === 'Escape') {
						event.preventDefault();
						editingRunId = null;
						editingDraft = '';
						render(false);
					} else if (event.key === 'Enter' && !event.shiftKey) {
						event.preventDefault();
						const text = textarea.value.trim();
						if (text && !busy(current)) {
							saveBtn.disabled = true;
							cancelBtn.disabled = true;
							vscode.postMessage({ type: 'revise', runId: run.id, text, withContext: contextAttached, codebase: state.codebase !== false });
						}
					}
				});

				form.onsubmit = (event) => {
					event.preventDefault();
					const text = textarea.value.trim();
					if (text && !busy(current)) {
						saveBtn.disabled = true;
						cancelBtn.disabled = true;
						vscode.postMessage({ type: 'revise', runId: run.id, text, withContext: contextAttached, codebase: state.codebase !== false });
					}
				};

				actions.append(cancelBtn, saveBtn);
				form.append(textarea, hint, actions);
				log.append(form);

				setTimeout(() => {
					textarea.focus();
					textarea.setSelectionRange(textarea.value.length, textarea.value.length);
				}, 10);
			} else {
				const turnWrap = el('div', 'user-turn');
				const userBlock = el('div', 'user-block');
				userBlock.append(el('div', 'user', shown(run.input)));

				if (!busy(run)) {
					const editBtn = el('button', 'user-edit-btn');
					editBtn.type = 'button';
					editBtn.title = 'Edit and rerun from this turn';
					editBtn.setAttribute('aria-label', 'Edit message');
					editBtn.append(createPencilIcon());
					editBtn.onclick = () => {
						editingRunId = run.id;
						editingDraft = shown(run.input);
						render(false);
					};
					userBlock.append(editBtn);
				}

				const laterChanges = runs.slice(runIdx).some((item) => changedFiles(item).length > 0);
				if (!busy(run) && laterChanges && !runs.slice(runIdx).some((item) => busy(item))) {
					const restoreBtn = el('button', 'user-restore-btn', '↺');
					restoreBtn.type = 'button';
					restoreBtn.title = 'Restore files to before this turn';
					restoreBtn.setAttribute('aria-label', 'Restore files to before this turn');
					restoreBtn.onclick = () => vscode.postMessage({ type: 'restore', runId: run.id });
					userBlock.append(restoreBtn);
				}

				turnWrap.append(userBlock);
				const sources = contextSources(run.input);
				if (sources) {
					turnWrap.append(el('div', 'user-context', 'Context · ' + sources));
				}
				log.append(turnWrap);
			}

			const reply = el('div', 'assistant-turn');
			const stepsNode = renderRunSteps(run);
			if (stepsNode) reply.append(stepsNode);
			if (run.output) reply.append(renderAssistant(run.output));
			if (run.status === 'sleeping' && run.wake) {
				const status = el('div', 'status'); status.append(el('span', 'dot'), el('span', '', 'Waiting · resumes in ' + countdown(run.wake.at) + (run.wake.reason ? ' · ' + run.wake.reason : '')));
				const wake = el('button', 'link', 'Wake now'); wake.onclick = () => vscode.postMessage({ type: 'wake', runId: run.id });
				status.append(wake); reply.append(status);
			} else if (run.status === 'waiting_approval') {
				reply.append(renderApproval(run));
			} else if (run.status === 'failed') {
				const status = el('div', 'status failed'); status.append(document.createTextNode('Failed · ' + (run.error || 'unknown error')));
				reply.append(status);
			}
			const changesNode = !busy(run) && run.status !== 'waiting_approval' ? renderChanges(run) : null;
			if (changesNode) reply.append(changesNode);
			log.append(reply);
		}

		current = runs[runs.length - 1];
		updateSend();
		if (autoScroll && (wasAtBottom || runs.length <= 1)) {
			log.scrollTop = log.scrollHeight;
		}
	}

	function updateContextPill() {
		if (contextAttached && activeFileName) {
			contextPill.style.display = 'inline-flex';
			pillFileName.textContent = activeFileName;
			attachBtn.style.opacity = '1';
		} else {
			contextPill.style.display = 'none';
			attachBtn.style.opacity = '0.6';
		}
	}



	function updateHistoryPopover() {
		historyList.replaceChildren();
		if (!threads.length) {
			historyList.append(el('div', 'history-item', 'No chats yet'));
			return;
		}
		threads.forEach((thread) => {
			const item = el('div', 'history-item' + (thread.id === currentThreadId ? ' active' : ''));
			item.append(el('span', 'hist-title', thread.title || 'Untitled'), el('span', 'hist-time', relativeTime(thread.updatedAt || thread.createdAt)));
			item.onclick = () => {
				historyPopover.style.display = 'none';
				vscode.postMessage({ type: 'openThread', threadId: thread.id, agentId: agentSelect.value });
			};
			historyList.append(item);
		});
	}

	function showProject(data) {
		projectBanner.replaceChildren();
		if (data.state === 'needs-access') {
			projectBanner.className = 'project-banner needs-access';
			projectBanner.append(el('span', 'project-banner-text', "Agents can't work in " + data.name + " yet."));
			const allow = el('button', 'project-banner-btn', 'Allow Access');
			allow.type = 'button';
			allow.title = data.path;
			allow.onclick = () => vscode.postMessage({ type: 'allowProject' });
			projectBanner.append(allow);
			projectBanner.hidden = false;
		} else if (data.state === 'none') {
			projectBanner.className = 'project-banner';
			projectBanner.append(el('span', 'project-banner-text', "No folder open: chats use Saturn's private sandbox."));
			projectBanner.hidden = false;
		} else {
			projectBanner.hidden = true;
		}
	}

	// ─── Event Listeners ───
	window.addEventListener('message', (event) => {
		const data = event.data;
		if (data.type === 'activeEditor') {
			if (data.fileName) {
				activeFileName = data.fileName;
				contextAttached = true;
			}
			updateContextPill();
		} else if (data.type === 'agents') {
			rawAgents = data.agents || [];
			rawModels = data.models || [];
			agentSelect.replaceChildren();
			for (const agent of rawAgents) {
				const option = document.createElement('option');
				option.value = agent.id;
				option.textContent = agent.name;
				agentSelect.append(option);
			}
			if (state.agentId && rawAgents.some((agent) => agent.id === state.agentId)) {
				agentSelect.value = state.agentId;
			}
			updateModelBadge();
			if (agentSelect.value) vscode.postMessage({ type: 'selectAgent', agentId: agentSelect.value });
			render();
		} else if (data.type === 'project') {
			showProject(data);
		} else if (data.type === 'threads') {
			threads = data.threads || [];
			currentThreadId = data.current;
			const open = threads.find((thread) => thread.id === currentThreadId);
			showTitle(open ? open.title : 'New Chat');
			renderWorktree(open);
		} else if (data.type === 'history') {
			runs = data.runs || [];
			errorBox.hidden = true;
			render();
			if (busy(current)) vscode.postMessage({ type: 'wake-watch', runId: current.id });
		} else if (data.type === 'revised') {
			const removedSet = new Set(data.removed || []);
			runs = runs.filter((run) => !removedSet.has(run.id));
			const index = runs.findIndex((run) => run.id === data.run.id);
			if (index >= 0) runs[index] = data.run; else runs.push(data.run);
			editingRunId = null;
			editingDraft = '';
			render();
		} else if (data.type === 'run') {
			const index = runs.findIndex((run) => run.id === data.run.id);
			if (index >= 0) runs[index] = data.run; else runs.push(data.run);
			render();
		} else if (data.type === 'clear') {
			runs = []; editingRunId = null; editingDraft = '';
			currentThreadId = null;
			showTitle('New Chat');
			render();
			input.focus();
		} else if (data.type === 'contextItems') {
			for (const item of data.items || []) {
				const key = item.kind + ':' + (item.path || item.url || item.label);
				if (!pendingContext.some((existing) => existing.kind + ':' + (existing.path || existing.url || existing.label) === key)) {
					pendingContext.push(item);
				}
			}
			renderChips();
			input.focus();
		} else if (data.type === 'focus') {
			input.focus();
		} else if (data.type === 'error') {
			errorBox.hidden = false;
			errorBox.replaceChildren(document.createTextNode(data.offline ? 'Saturn runtime is not running. ' : data.message + ' '));
			if (data.offline) {
				const open = el('button', 'link', 'Open Saturn');
				open.onclick = () => vscode.postMessage({ type: 'openApp' });
				const retry = el('button', 'link', 'Retry');
				retry.onclick = () => vscode.postMessage({ type: 'refresh' });
				errorBox.append(open, document.createTextNode(' · '), retry);
			}
				updateSend();
		}
	});

	// Session title edit
	const worktreeBtn = $('worktreeBtn');
	/** The chat's worktree: a plain "Branch" button, or the branch name with a menu to finish it. */
	function renderWorktree(thread) {
		const project = state.project && state.project.state === 'ready';
		worktreeBtn.hidden = !thread || !project;
		if (worktreeBtn.hidden) return;
		const wt = thread.worktree;
		worktreeBtn.className = wt ? 'worktree-btn on' : 'worktree-btn';
		worktreeBtn.textContent = wt ? '⎇ ' + wt.branch.replace(/^saturn\\//, '') : '⎇ Branch';
		worktreeBtn.title = wt ? 'This chat works on ' + wt.branch + ' in its own worktree. Click to merge, keep or discard it.' : 'Work on an own git branch: the agent\\'s changes stay out of the project folder until you merge them';
		worktreeBtn.onclick = () => vscode.postMessage({ type: wt ? 'worktreeFinish' : 'worktreeStart', threadId: thread.id });
	}

	sessionTitle.onclick = () => {
		sessionTitle.style.display = 'none';
		sessionTitleInput.style.display = 'block';
		sessionTitleInput.focus();
		sessionTitleInput.select();
	};
	sessionTitleInput.onblur = () => {
		const val = sessionTitleInput.value.trim();
		sessionTitleInput.style.display = 'none';
		sessionTitle.style.display = 'block';
		// A chat exists once it has a message; until then the title follows the first message.
		if (val && val !== currentTitle && currentThreadId) {
			showTitle(val);
			vscode.postMessage({ type: 'renameThread', title: val, agentId: agentSelect.value });
		} else {
			showTitle(currentTitle);
		}
	};
	sessionTitleInput.onkeydown = (e) => {
		if (e.key === 'Enter') sessionTitleInput.blur();
		if (e.key === 'Escape') {
			sessionTitleInput.value = currentTitle;
			sessionTitleInput.blur();
		}
	};

	// Header buttons
	expandBtn.onclick = () => vscode.postMessage({ type: 'openAgentWindow' });
	newChatBtn.onclick = () => vscode.postMessage({ type: 'newChat' });
	historyBtn.onclick = (e) => {
		e.stopPropagation();
		const isOpen = historyPopover.style.display !== 'none';
		if (isOpen) {
			historyPopover.style.display = 'none';
		} else {
			updateHistoryPopover();
			historyPopover.style.display = 'flex';
		}
	};
	closeHistoryBtn.onclick = () => { historyPopover.style.display = 'none'; };


	// Context pill remove / attach
	pillRemoveBtn.onclick = (e) => {
		e.stopPropagation();
		contextAttached = false;
		updateContextPill();
	};
	attachBtn.onclick = () => {
		contextAttached = !contextAttached;
		updateContextPill();
	};
	atBtn.onclick = () => vscode.postMessage({ type: 'pickContext' });
	codebaseBtn.onclick = () => setCodebase(!(state.codebase !== false));
	setCodebase(state.codebase !== false);



	// Model picker popover
	/** One row in the picker: a name, an optional detail on the right, a check when selected. */
	function pickerRow(name, detail, selected, warn, onPick) {
		const row = el('div', 'model-popover-item' + (selected ? ' active' : ''));
		const left = el('div', 'model-item-left');
		left.append(el('span', '', name));
		const right = el('div', 'model-item-right');
		if (detail) right.append(el('span', 'model-item-tier', detail));
		if (selected) {
			const check = el('span', 'model-item-check');
			check.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>';
			right.append(check);
		}
		row.append(left, right);
		row.onclick = () => {
			modelPopover.style.display = 'none';
			onPick();
		};
		return row;
	}

	// The picker: which agent this panel talks to, and that agent's model.
	modelPickerBtn.onclick = (e) => {
		e.stopPropagation();
		if (modelPopover.style.display !== 'none') {
			modelPopover.style.display = 'none';
			return;
		}
		modelPopover.replaceChildren();
		const currentAgent = rawAgents.find((agent) => agent.id === agentSelect.value);

		if (rawAgents.length > 1) {
			modelPopover.append(el('div', 'model-popover-header', 'Agent'));
			for (const agent of rawAgents) {
				modelPopover.append(pickerRow(agent.name, '', agent.id === agentSelect.value, '', () => {
					agentSelect.value = agent.id;
					state.agentId = agent.id;
					vscode.setState(state);
					updateModelBadge();
					vscode.postMessage({ type: 'selectAgent', agentId: agent.id });
				}));
			}
			modelPopover.append(el('div', 'model-popover-divider'));
		}

		modelPopover.append(el('div', 'model-popover-header', 'Model'));
		if (!rawModels.length) modelPopover.append(el('div', 'history-item', 'No models yet. Add one in Saturn.'));
		for (const model of rawModels) {
			const keyless = model.hasSecret === false && model.provider !== 'claude-code' && model.provider !== 'lmstudio';
			modelPopover.append(pickerRow(model.name, effortLabel(model), Boolean(currentAgent && currentAgent.modelConnectionId === model.id), keyless ? 'No API key saved' : '', () => {
				if (!currentAgent) return;
				currentAgent.modelConnectionId = model.id;
				updateModelBadge();
				vscode.postMessage({ type: 'patchAgent', agentId: currentAgent.id, patch: { modelConnectionId: model.id } });
			}));
		}

		// Effort of the model this agent uses (saved on the model, so the Saturn app shows the same setting).
		const activeModel = currentAgent && rawModels.find((model) => model.id === currentAgent.modelConnectionId);
		if (activeModel && activeModel.provider !== 'lmstudio' && activeModel.provider !== 'deepseek') {
			modelPopover.append(el('div', 'model-popover-divider'));
			modelPopover.append(el('div', 'model-popover-header', 'Effort · ' + activeModel.name));
			const choices = [['', 'Default']].concat(Object.entries(EFFORT_LABELS));
			for (const [value, label] of choices) {
				modelPopover.append(pickerRow(label, '', (activeModel.effort || '') === value, '', () => {
					if (value) activeModel.effort = value; else delete activeModel.effort;
					updateModelBadge();
					vscode.postMessage({ type: 'patchModel', modelId: activeModel.id, patch: { effort: value || null } });
				}));
			}
		}

		modelPopover.append(el('div', 'model-popover-divider'));
		const usageAction = el('button', 'model-popover-action');
		usageAction.type = 'button';
		const usageLeft = el('div', 'model-action-left');
		usageLeft.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg><span>Usage &amp; Models in Saturn</span>';
		usageAction.append(usageLeft);
		usageAction.onclick = () => {
			modelPopover.style.display = 'none';
			vscode.postMessage({ type: 'openApp' });
		};
		modelPopover.append(usageAction);
		modelPopover.style.display = 'flex';
	};

	// Slash command button & popup
	slashBtn.onclick = (e) => {
		e.stopPropagation();
		slashPopup.style.display = slashPopup.style.display === 'none' ? 'flex' : 'none';
	};
	document.querySelectorAll('.slash-item').forEach((item) => {
		item.addEventListener('click', () => {
			const cmd = item.getAttribute('data-cmd');
			slashPopup.style.display = 'none';
			if (cmd === '/clear') {
				vscode.postMessage({ type: 'newChat' });
			} else if (cmd === '/model') {
				modelPickerBtn.click();
			} else if (cmd === '/help') {
				input.value = 'What tools and capabilities can you execute in this workspace?';
				$('form').requestSubmit();
			}
		});
	});

	// Global click outside to dismiss popovers
	document.addEventListener('click', (e) => {
		if (!historyPopover.contains(e.target) && e.target !== historyBtn) {
			historyPopover.style.display = 'none';
		}
		if (!modelPopover.contains(e.target) && e.target !== modelPickerBtn) {
			modelPopover.style.display = 'none';
		}
		if (!slashPopup.contains(e.target) && e.target !== slashBtn) {
			slashPopup.style.display = 'none';
		}
	});


	// While a turn runs, the send button is a square Stop button, as in the Saturn Agent App.
	const SEND_ICON = send.innerHTML;
	const STOP_ICON = '<svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="1" y="1" width="10" height="10" rx="2"/></svg>';
	function updateSend() {
		const stopping = busy(current);
		send.classList.toggle('stop', Boolean(stopping));
		send.innerHTML = stopping ? STOP_ICON : SEND_ICON;
		send.title = stopping ? 'Stop' : 'Send (Enter)';
		send.setAttribute('aria-label', stopping ? 'Stop' : 'Send');
		send.disabled = stopping ? false : !agentSelect.value;
	}

	// Form submission
	$('form').addEventListener('submit', (event) => {
		event.preventDefault();
		if (busy(current)) {
			vscode.postMessage({ type: 'stop', runId: current.id });
			return;
		}
		const text = input.value.trim();
		if (!text || !agentSelect.value || busy(current)) return;
		input.value = '';
		input.rows = 1;
		send.disabled = true;
		vscode.postMessage({
			type: 'send',
			agentId: agentSelect.value,
			text,
			withContext: contextAttached,
			codebase: state.codebase !== false,
			contextItems: pendingContext,
		});
		pendingContext = [];
		renderChips();
	});

	input.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			// Enter sends; it never stops a running turn (only the Stop button does).
			if (busy(current)) return;
			$('form').requestSubmit();
		}
	});
	input.addEventListener('input', () => {
		input.rows = Math.min(6, Math.max(1, input.value.split('\\n').length));
		// Typing "@" at the start of a word opens the context picker (the "@" itself is removed).
		const caret = input.selectionStart || 0;
		if (input.value.charAt(caret - 1) === '@' && (caret === 1 || /\\s/.test(input.value.charAt(caret - 2)))) {
			input.value = input.value.slice(0, caret - 1) + input.value.slice(caret);
			input.setSelectionRange(caret - 1, caret - 1);
			vscode.postMessage({ type: 'pickContext' });
		}
		if (input.value === '/') {
			slashPopup.style.display = 'flex';
		} else if (slashPopup.style.display !== 'none' && !input.value.startsWith('/')) {
			slashPopup.style.display = 'none';
		}
	});

	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
	const runtime = new Runtime();
	shared.review = registerAgentReview(context, runtime);
	const view = new AgentView(context, runtime);
	registerEditorAi(context, runtime);
	registerGitAi(context, runtime);
	registerIdeBridge(context, runtime);
	reportToRuntime(context, runtime);
	// The side bar is laid out before extensions load, so it starts hidden as an empty container. Show the
	// Saturn panel once on the first launch; after that the user's own layout is remembered.
	if (!context.globalState.get('saturn.panelRevealed')) {
		void context.globalState.update('saturn.panelRevealed', true);
		void vscode.commands.executeCommand('saturn.agent.focus');
	}
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(shared.content.scheme, shared.content),
		shared.terminal,
		vscode.commands.registerCommand('saturn.showAgentTerminal', () => shared.terminal.ensure().show()),
		vscode.window.registerWebviewViewProvider('saturn.agent', view, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.workspace.onDidSaveTextDocument((document) => {
			if (document.uri.scheme === 'file') {
				view.reindex([vscode.workspace.asRelativePath(document.uri)]);
			}
		}),
		{ dispose: () => view.dispose() },
		vscode.commands.registerCommand('saturn.focusAgent', async () => {
			await vscode.commands.executeCommand('saturn.agent.focus');
			view.focusInput();
		}),
		vscode.commands.registerCommand('saturn.newChat', () => view.newChat()),
		vscode.commands.registerCommand('saturn.openAgentWindow', () => openAgentWindow(context, runtime)),
		vscode.commands.registerCommand('saturn.openAppSettings', () => {
			// Only the Saturn app's Settings window (the saturn://settings link the app registers), not the whole Agent App.
			openSaturnLink('saturn://settings', 'Could not open Saturn Settings. Install or start the Saturn app once, then try again.');
		}),
		vscode.commands.registerCommand('saturn.openApp', () => {
			// The Saturn app starts the runtime; open it the way each platform knows it.
			const { execFile } = require('child_process');
			const warn = () => void vscode.window.showWarningMessage('Could not open the Saturn app. Start it to bring the runtime online.');
			if (process.platform === 'darwin') {
				// By bundle id first; fall back to the app name for copies Launch Services has not registered.
				execFile('open', ['-b', 'inc.saturntechnology.desktop'], (error) => {
					if (!error) { return; }
					execFile('open', ['-a', 'Saturn'], (fallbackError) => { if (fallbackError) { warn(); } });
				});
				return;
			}
			if (process.platform === 'win32') {
				const candidates = [
					nodePath.join(process.env.LOCALAPPDATA || '', 'Programs', 'Saturn', 'Saturn.exe'),
					nodePath.join(process.env.ProgramFiles || 'C:\\Program Files', 'Saturn', 'Saturn.exe'),
				];
				const exe = candidates.find((file) => { try { return require('fs').existsSync(file); } catch { return false; } });
				if (exe) {
					require('child_process').spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
					return;
				}
				openSaturnLink('saturn://', 'Could not open the Saturn app. Start it to bring the runtime online.');
				return;
			}
			openSaturnLink('saturn://', 'Could not open the Saturn app. Start it to bring the runtime online.');
		}),
	);
}

/**
 * Tells the runtime this IDE window is open (every 15 s, and once more on close), so the Saturn app keeps the
 * runtime running while the IDE uses it and stops it once every Saturn window and IDE window is closed.
 * @param {vscode.ExtensionContext} context @param {Runtime} runtime
 */
function reportToRuntime(context, runtime) {
	// vscode.env.sessionId is a fixed placeholder in this build, so each window makes its own id.
	const id = `ide:${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
	const beat = () => runtime.request('/runtime/clients', { method: 'POST', body: JSON.stringify({ id, kind: 'ide' }) }).catch(() => undefined);
	void beat();
	const timer = setInterval(beat, 15000);
	context.subscriptions.push({
		dispose: () => {
			clearInterval(timer);
			void runtime.request(`/runtime/clients/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
		},
	});
}

/** @type {vscode.WebviewPanel | undefined} */
let agentWindow;

/**
 * The Agent window: the same chat as the sidebar, in a window of its own (the title bar's "Agent Window"
 * button). A second click brings the existing window forward instead of opening another.
 * @param {vscode.ExtensionContext} context @param {Runtime} runtime
 */
async function openAgentWindow(context, runtime) {
	if (agentWindow) {
		agentWindow.reveal();
		return;
	}
	const panel = vscode.window.createWebviewPanel('saturn.agentWindow', 'Saturn Agent', vscode.ViewColumn.One, {
		enableScripts: true,
		retainContextWhenHidden: true,
	});
	panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
	const session = new AgentView(context, runtime);
	session.attach(panel.webview);
	agentWindow = panel;
	panel.onDidDispose(() => {
		session.stopPolling();
		session.dispose();
		agentWindow = undefined;
	});
	// Code-OSS moves the active editor (this panel) into a new auxiliary window.
	await new Promise(resolve => setTimeout(resolve, 150));
	await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
}

function deactivate() { }

module.exports = { activate, deactivate };
