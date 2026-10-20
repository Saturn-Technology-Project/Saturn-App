// @ts-check
'use strict';

/*
 * The Agents view: every agent at work (running, waiting for an approval, sleeping) and the latest finished
 * chats, from the runtime's GET /runs. Agents started with "Run in the background" are followed, and a
 * notification says when each finishes, with a button to open its chat.
 */

const vscode = require('vscode');

/** How often the list refreshes while it is visible or a followed agent is still working. */
const POLL_MS = 3000;
const ACTIVE = new Set(['running', 'queued', 'waiting_approval', 'sleeping']);

/** @typedef {{ id: string, agentId: string, agentName: string, threadId: string, threadTitle: string, projectId?: string, branch?: string, status: string, input: string, changedFiles: number }} RunSummary */
/** @typedef {{ request: (path: string, init?: RequestInit) => Promise<any> }} RuntimeLike */

/** @implements {vscode.TreeDataProvider<RunSummary>} */
class AgentsView {
	/**
	 * @param {RuntimeLike} runtime
	 * @param {(agentId: string, threadId: string) => Promise<void>} openChat
	 */
	constructor(runtime, openChat) {
		this.runtime = runtime;
		this.openChat = openChat;
		/** @type {RunSummary[]} */
		this.runs = [];
		/** Background runs to report on when they end. @type {Map<string, { threadId: string, agentId: string }>} */
		this.followed = new Map();
		this.changed = new vscode.EventEmitter();
		this.onDidChangeTreeData = this.changed.event;
		/** @type {NodeJS.Timeout | undefined} */
		this.timer = undefined;
		/** @type {vscode.TreeView<RunSummary> | undefined} */
		this.view = undefined;
	}

	/** @param {vscode.TreeView<RunSummary>} view */
	attach(view) {
		this.view = view;
		view.onDidChangeVisibility(() => this.schedule(0));
		this.schedule(0);
	}

	/** Reports on a run started in the background once it finishes. @param {string} runId @param {string} threadId @param {string} agentId */
	follow(runId, threadId, agentId) {
		this.followed.set(runId, { threadId, agentId });
		this.schedule(0);
	}

	/** @param {number} delay */
	schedule(delay) {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => void this.tick(), delay);
	}

	async tick() {
		this.timer = undefined;
		const visible = Boolean(this.view && this.view.visible);
		if (!visible && !this.followed.size) {
			return;
		}
		try {
			/** @type {RunSummary[]} */
			const runs = await this.runtime.request('/runs?limit=15');
			this.runs = runs || [];
			this.changed.fire(undefined);
			if (this.view) {
				const working = this.runs.filter((run) => ACTIVE.has(run.status)).length;
				this.view.badge = working ? { value: working, tooltip: `${working} agent${working === 1 ? '' : 's'} working` } : undefined;
			}
			for (const [runId, where] of [...this.followed]) {
				const run = this.runs.find((item) => item.id === runId);
				if (run && !ACTIVE.has(run.status)) {
					this.followed.delete(runId);
					void this.announce(run, where);
				} else if (run && run.status === 'waiting_approval') {
					// Asked once per run: the approval card is in its chat.
					if (!this.followed.get(runId)?.asked) {
						this.followed.set(runId, { ...where, asked: true });
						void vscode.window.showInformationMessage(`A background agent needs your approval: ${run.threadTitle.replace(/^⧉ /, '')}`, 'Open Chat').then((choice) => {
							if (choice) void this.openChat(where.agentId, where.threadId);
						});
					}
				}
			}
		} catch {
			// The runtime is down; the chat panel says so.
		}
		if (visible || this.followed.size) {
			this.schedule(POLL_MS);
		}
	}

	/** @param {RunSummary} run @param {{ threadId: string, agentId: string }} where */
	async announce(run, where) {
		const title = run.threadTitle.replace(/^⧉ /, '');
		const files = run.changedFiles ? ` · ${run.changedFiles} file${run.changedFiles === 1 ? '' : 's'} changed${run.branch ? ` on ${run.branch}` : ''}` : '';
		const message = run.status === 'completed' ? `Background agent finished: ${title}${files}` : `Background agent ${run.status === 'failed' ? 'failed' : 'stopped'}: ${title}`;
		const show = run.status === 'completed' ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
		const choice = await show(message, 'Open Chat');
		if (choice) {
			await this.openChat(where.agentId, where.threadId);
		}
	}

	/** @param {RunSummary} run */
	getTreeItem(run) {
		const item = new vscode.TreeItem(run.threadTitle.replace(/^⧉ /, ''), vscode.TreeItemCollapsibleState.None);
		const state = { running: 'working', queued: 'queued', waiting_approval: 'needs approval', sleeping: 'waiting', completed: 'done', failed: 'failed', cancelled: 'stopped' }[run.status] || run.status;
		item.description = `${run.agentName} · ${state}${run.changedFiles ? ` · ${run.changedFiles} file${run.changedFiles === 1 ? '' : 's'}` : ''}`;
		item.tooltip = new vscode.MarkdownString(`**${run.agentName}** — ${state}${run.branch ? `\n\nBranch \`${run.branch}\`` : ''}\n\n${run.input}`);
		item.iconPath = new vscode.ThemeIcon(
			run.status === 'running' || run.status === 'queued' ? 'sync~spin'
				: run.status === 'waiting_approval' ? 'question'
					: run.status === 'sleeping' ? 'clock'
						: run.status === 'completed' ? 'pass'
							: 'error',
		);
		item.command = { command: 'saturn.openAgentChat', title: 'Open Chat', arguments: [run.agentId, run.threadId] };
		item.contextValue = ACTIVE.has(run.status) ? 'saturn.run.active' : 'saturn.run.done';
		return item;
	}

	getChildren() {
		return this.runs;
	}

	dispose() {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.changed.dispose();
	}
}

/** What a new AGENTS.md starts with. */
const RULES_TEMPLATE = `# Instructions for agents

<!-- Saturn gives this file to every agent working in this project (Codex reads it by itself too).
     Keep it short: what is not obvious from the code. -->

## Commands
- Install:
- Test:
- Type check / lint:

## Conventions
-

## Don't
-
`;

/**
 * Opens the project's rule file for editing: the first that exists of AGENTS.md, CLAUDE.md and .cursorrules,
 * else a new AGENTS.md from a short template.
 * @param {string | undefined} folder
 */
async function editRules(folder) {
	if (!folder) {
		void vscode.window.showInformationMessage('Open a folder first: project rules live in the project.');
		return;
	}
	const root = vscode.Uri.file(folder);
	for (const name of ['AGENTS.md', 'CLAUDE.md', '.cursorrules']) {
		const uri = vscode.Uri.joinPath(root, name);
		try {
			await vscode.workspace.fs.stat(uri);
			await vscode.window.showTextDocument(uri);
			return;
		} catch {
			// Not there; try the next.
		}
	}
	const uri = vscode.Uri.joinPath(root, 'AGENTS.md');
	await vscode.workspace.fs.writeFile(uri, Buffer.from(RULES_TEMPLATE, 'utf8'));
	await vscode.window.showTextDocument(uri);
}

module.exports = { AgentsView, editRules };
