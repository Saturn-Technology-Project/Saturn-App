// @ts-check
'use strict';

/*
 * Saturn in the Source Control view: the sparkle button in the commit message box writes the message for the
 * changes about to be committed, through the runtime's POST /complete (kind "commit") and the completion model.
 *  - Staged changes when there are any, otherwise everything in Changes (what a commit would take).
 *  - The repository's recent subjects, so the message follows its style; saturn.commitMessage.instructions on top.
 *  - Whatever the user already typed is kept as a draft to complete, unless it is the last message Saturn wrote.
 */

const vscode = require('vscode');
const { errorText } = require('./editor-ai');

/** Diff budget for the whole request; the file list still names every file past it. */
const MAX_DIFF = 60000;
/** One file's share of the diff before it is cut. */
const MAX_FILE_DIFF = 12000;
/** How much of a new (untracked) file is shown. */
const MAX_UNTRACKED = 4000;
const RECENT_COMMITS = 15;
/** Generated files whose diff says nothing about the change. */
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|Podfile\.lock|pubspec\.lock|flake\.lock|packages\.lock\.json)$/;

/** The git extension's Status enum (extensions/git/src/api/git.d.ts), as the letters `git status` uses. */
const STATUS = ['M', 'A', 'D', 'R', 'C', 'M', 'D', 'A', '!', 'A', 'R', 'T', 'U', 'U', 'U', 'U', 'U', 'U', 'U'];
const UNTRACKED = 7;

/**
 * @typedef {{ request: (path: string, init?: RequestInit) => Promise<any> }} RuntimeLike
 * @typedef {{ uri: vscode.Uri, originalUri: vscode.Uri, renameUri?: vscode.Uri, status: number }} Change
 * @typedef {{
 *   rootUri: vscode.Uri,
 *   inputBox: { value: string },
 *   state: { HEAD?: { name?: string }, indexChanges: Change[], workingTreeChanges: Change[], untrackedChanges: Change[] },
 *   diff(cached?: boolean): Promise<string>,
 *   log(options?: { maxEntries?: number }): Promise<{ message: string }[]>,
 * }} Repository
 * @typedef {{ repositories: Repository[], getRepository(uri: vscode.Uri): Repository | null }} GitApi
 */

/** @returns {Promise<GitApi | undefined>} */
async function gitApi() {
	const extension = vscode.extensions.getExtension('vscode.git');
	if (!extension) {
		return undefined;
	}
	const exports = extension.isActive ? extension.exports : await extension.activate();
	return exports && exports.enabled ? exports.getAPI(1) : undefined;
}

/**
 * The repository the button belongs to; from the Command Palette, the active file's, or the one the user picks.
 * @param {GitApi} git @param {unknown} rootUri @returns {Promise<Repository | undefined>}
 */
async function pickRepository(git, rootUri) {
	if (rootUri instanceof vscode.Uri) {
		return git.getRepository(rootUri) || undefined;
	}
	if (git.repositories.length <= 1) {
		return git.repositories[0];
	}
	const editor = vscode.window.activeTextEditor;
	const active = editor && git.getRepository(editor.document.uri);
	if (active) {
		return active;
	}
	const choice = await vscode.window.showQuickPick(
		git.repositories.map((repository) => ({ label: vscode.workspace.asRelativePath(repository.rootUri, true) || repository.rootUri.fsPath, repository })),
		{ placeHolder: 'Generate a commit message for which repository?' },
	);
	return choice && choice.repository;
}

/** @param {Repository} repository @param {vscode.Uri} uri */
function relative(repository, uri) {
	const root = repository.rootUri.path.replace(/\/$/, '');
	return uri.path.startsWith(root + '/') ? uri.path.slice(root.length + 1) : uri.path;
}

/**
 * The changes a commit would take: the staged ones when there are any, else the Changes group (tracked files, plus
 * untracked ones unless git.smartCommitChanges is "tracked").
 * @param {Repository} repository
 */
function changesToCommit(repository) {
	const state = repository.state;
	if (state.indexChanges.length) {
		return { staged: true, changes: state.indexChanges };
	}
	const config = vscode.workspace.getConfiguration('git', repository.rootUri);
	const tracked = config.get('smartCommitChanges') === 'tracked';
	const changes = [...state.workingTreeChanges, ...state.untrackedChanges].filter((change) => !tracked || change.status !== UNTRACKED);
	return { staged: false, changes };
}

/** @param {Repository} repository @param {Change[]} changes */
function fileList(repository, changes) {
	return changes.map((change) => {
		const letter = STATUS[change.status] || 'M';
		return change.renameUri
			? `${letter} ${relative(repository, change.originalUri)} -> ${relative(repository, change.renameUri)}`
			: `${letter} ${relative(repository, change.uri)}`;
	}).join('\n');
}

/**
 * A unified diff within budget: lockfiles reduced to a note, each file cut at its share, and new files shown as added
 * lines (git diff leaves untracked files out).
 * @param {Repository} repository @param {boolean} staged @param {Change[]} changes
 */
async function buildDiff(repository, staged, changes) {
	const patch = await repository.diff(staged);
	/** @type {string[]} */
	const parts = [];
	let size = 0;
	const add = (/** @type {string} */ part) => {
		if (size + part.length > MAX_DIFF) {
			return false;
		}
		parts.push(part);
		size += part.length;
		return true;
	};
	for (const chunk of patch.split(/^(?=diff --git )/m)) {
		if (!chunk.trim()) {
			continue;
		}
		const header = /^diff --git a\/(.*?) b\/(.*)$/m.exec(chunk);
		const file = header ? header[2] : '';
		let part = chunk;
		if (LOCKFILE.test(file)) {
			part = `diff --git a/${file} b/${file}\n(lockfile updated; diff omitted)\n`;
		} else if (part.length > MAX_FILE_DIFF) {
			part = part.slice(0, MAX_FILE_DIFF) + '\n… (rest of this file\'s diff omitted)\n';
		}
		if (!add(part)) {
			break;
		}
	}
	if (!staged) {
		for (const change of changes) {
			if (change.status !== UNTRACKED) {
				continue;
			}
			const file = relative(repository, change.uri);
			if (!add(await newFileDiff(change.uri, file))) {
				break;
			}
		}
	}
	return parts.join('');
}

/** @param {vscode.Uri} uri @param {string} file */
async function newFileDiff(uri, file) {
	const head = `diff --git a/${file} b/${file}\nnew file\n--- /dev/null\n+++ b/${file}\n`;
	if (LOCKFILE.test(file)) {
		return `${head}(lockfile added; content omitted)\n`;
	}
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		if (bytes.subarray(0, 8000).includes(0)) {
			return `${head}(binary file)\n`;
		}
		const text = Buffer.from(bytes.subarray(0, MAX_UNTRACKED)).toString('utf8').replace(/\n$/, '');
		const lines = text.split('\n').map((line) => `+${line}`).join('\n');
		return `${head}${lines}\n${bytes.length > MAX_UNTRACKED ? '… (rest of the new file omitted)\n' : ''}`;
	} catch {
		// A directory (an untracked folder) or a file that vanished: the file list still names it.
		return `${head}(not readable)\n`;
	}
}

/** @param {vscode.ExtensionContext} context @param {RuntimeLike} runtime */
function registerGitAi(context, runtime) {
	/** The last message Saturn wrote per repository: clicking again regenerates instead of treating it as a draft. */
	const generated = new Map();

	/** @param {unknown} rootUri @param {unknown} _context @param {vscode.CancellationToken | undefined} token */
	async function generate(rootUri, _context, token) {
		const git = await gitApi();
		if (!git) {
			void vscode.window.showWarningMessage('Saturn: Git is not available. Turn on the built-in Git extension (git.enabled).');
			return;
		}
		const repository = await pickRepository(git, rootUri);
		if (!repository) {
			return;
		}
		const { staged, changes } = changesToCommit(repository);
		if (!changes.length) {
			vscode.window.setStatusBarMessage('Saturn: there are no changes to describe.', 5000);
			return;
		}
		const root = repository.rootUri.toString();
		const current = repository.inputBox.value.trim();
		const draft = current && current !== generated.get(root) ? current : '';
		const instruction = String(vscode.workspace.getConfiguration('saturn', repository.rootUri).get('commitMessage.instructions', '') || '').trim();

		const controller = new AbortController();
		const listener = token && token.onCancellationRequested(() => controller.abort());
		try {
			const text = await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: 'Writing commit message…' }, async () => {
				const [diff, recent] = await Promise.all([
					buildDiff(repository, staged, changes),
					repository.log({ maxEntries: RECENT_COMMITS }).catch(() => []),
				]);
				const result = await runtime.request('/complete', {
					method: 'POST',
					signal: controller.signal,
					body: JSON.stringify({
						kind: 'commit',
						branch: (repository.state.HEAD && repository.state.HEAD.name) || '',
						files: fileList(repository, changes),
						diff,
						recentCommits: recent.map((commit) => commit.message),
						draft,
						instruction,
					}),
				});
				return String((result && result.text) || '').trim();
			});
			if (controller.signal.aborted) {
				return;
			}
			if (!text) {
				vscode.window.setStatusBarMessage('Saturn: the model wrote no commit message.', 5000);
				return;
			}
			// The user may have typed while the model was writing; their text wins.
			if (repository.inputBox.value.trim() !== current) {
				vscode.window.setStatusBarMessage('Saturn: the commit message was edited meanwhile, so the suggestion was dropped.', 6000);
				return;
			}
			repository.inputBox.value = text;
			generated.set(root, text);
		} catch (error) {
			const message = errorText(error);
			if (!message) {
				return;
			}
			const settings = /Saturn Settings/.test(message) ? 'Open Saturn Settings' : undefined;
			const offline = /runtime is not running/.test(message) ? 'Open Saturn App' : undefined;
			const actions = /** @type {string[]} */ ([settings, offline].filter(Boolean));
			const choice = await vscode.window.showErrorMessage(`Saturn could not write the commit message: ${message}`, ...actions);
			if (choice === settings && settings) {
				void vscode.commands.executeCommand('saturn.openAppSettings');
			} else if (choice === offline && offline) {
				void vscode.commands.executeCommand('saturn.openApp');
			}
		} finally {
			if (listener) {
				listener.dispose();
			}
		}
	}

	context.subscriptions.push(vscode.commands.registerCommand('saturn.git.generateCommitMessage', generate));
}

module.exports = { registerGitAi };
