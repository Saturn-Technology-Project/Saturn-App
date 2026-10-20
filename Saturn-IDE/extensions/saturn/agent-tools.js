// @ts-check
'use strict';

/*
 * The Agent panel's editor-side tools:
 *  - Codebase retrieval: finds the files and lines in the open project that a message is about (ripgrep and the
 *    language servers' workspace symbols) so the agent starts with the relevant code, not just the open file.
 *  - Context picker (@): files, a folder, a web page or the git changes, attached to the next message.
 *  - Diffs: an agent run's changes side by side (original vs. the file now), and Apply previews.
 *  - Apply: merges a chat code block into its file through the runtime's completion model, previewed as a diff.
 *  - Agent terminal: mirrors the commands an agent runs (and their output) into a read-only terminal, and opens
 *    a real terminal with a suggested command so the user can take over.
 */

const vscode = require('vscode');
const fs = require('node:fs');
const nodePath = require('node:path');
const { execFile } = require('node:child_process');

const RETRIEVAL_BUDGET = 14000;
const ATTACH_BUDGET = 60000;
const MAX_FILES = 8;
const STOP = new Set(('the and for are but not you all any can had her was one our out day get has him his how man new now old see two way who boy did its let put say she too use this that with have from they will what when your said each which their time about would there could other into than then them these some like make made more also just only over such most very after where while should does here those being through want need file files code please help make sure write find look show using used fix add update change remove create function class method value return thing work works make into same work why what').split(' '));
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.cache', 'coverage', 'vendor', '.venv', '__pycache__']);

/** Search terms from a message: identifiers and words of 3+ letters, with camelCase/snake_case parts. */
function terms(text) {
	const found = new Map();
	const add = (word, weight) => {
		const lower = word.toLowerCase();
		if (lower.length < 3 || STOP.has(lower) || /^\d+$/.test(lower)) {
			return;
		}
		found.set(word, Math.max(found.get(word) || 0, weight));
	};
	for (const token of String(text).match(/[A-Za-z_][A-Za-z0-9_.$-]{2,}/g) || []) {
		const clean = token.replace(/[.$-]+$/, '');
		// Code-looking tokens (camelCase, snake_case, dotted, PascalCase) are the strongest signal.
		const codeLike = /[a-z][A-Z]|_|\.|^[A-Z][a-z]+[A-Z]/.test(clean);
		add(clean, codeLike ? 3 : 1);
		for (const part of clean.split(/[._-]|(?<=[a-z])(?=[A-Z])/)) {
			add(part, 1);
		}
	}
	return [...found.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([word]) => word);
}

/** The ripgrep that ships inside the IDE, or one on PATH. */
function ripgrep() {
	const root = vscode.env.appRoot;
	const platform = `${process.platform}-${process.arch}`;
	const rg = process.platform === 'win32' ? 'rg.exe' : 'rg';
	const candidates = [
		nodePath.join(root, 'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', platform, rg),
		nodePath.join(root, 'node_modules', '@vscode', 'ripgrep-universal', 'bin', platform, rg),
		nodePath.join(root, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', rg),
		nodePath.join(root, 'node_modules', '@vscode', 'ripgrep', 'bin', rg),
	];
	return candidates.find((file) => fs.existsSync(file)) || rg;
}

/** @returns {Promise<Map<string, { hits: Map<string, number>, lines: Set<number> }>>} */
function rgSearch(folder, words, signal) {
	return new Promise((resolve) => {
		const args = ['--json', '-i', '-F', '--max-count', '30', '--max-filesize', '1M', '--max-columns', '400', '-g', '!*.lock', '-g', '!*.min.*', '-g', '!*.map', '-g', '!package-lock.json'];
		for (const word of words) {
			args.push('-e', word);
		}
		args.push('--', folder);
		execFile(ripgrep(), args, { maxBuffer: 16 * 1024 * 1024, timeout: 8000, signal }, (_error, stdout) => {
			/** @type {Map<string, { hits: Map<string, number>, lines: Set<number> }>} */
			const files = new Map();
			for (const line of String(stdout || '').split('\n')) {
				if (!line.startsWith('{"type":"match"')) {
					continue;
				}
				try {
					const data = JSON.parse(line).data;
					const file = data.path.text;
					const entry = files.get(file) || { hits: new Map(), lines: new Set() };
					entry.lines.add(data.line_number);
					for (const sub of data.submatches || []) {
						const word = String(sub.match.text).toLowerCase();
						entry.hits.set(word, (entry.hits.get(word) || 0) + 1);
					}
					files.set(file, entry);
				} catch {
					// A malformed line from rg: skip it.
				}
			}
			resolve(files);
		});
	});
}

/** Line ranges around the matched lines, merged when close. @param {number[]} lines */
function windows(lines, total, pad = 3, max = 3) {
	const sorted = [...lines].sort((a, b) => a - b);
	/** @type {[number, number][]} */
	const ranges = [];
	for (const line of sorted) {
		const start = Math.max(1, line - pad);
		const end = Math.min(total, line + pad);
		const last = ranges[ranges.length - 1];
		if (last && start <= last[1] + 1) {
			last[1] = Math.max(last[1], end);
		} else {
			ranges.push([start, end]);
		}
	}
	return ranges.slice(0, max);
}

/**
 * Codebase retrieval for one message: ranks the project's files by how many of the message's terms they contain
 * (and whether their path or a workspace symbol names them), then returns the best files with numbered snippets.
 * Lexical + symbol search, not embeddings: fast, offline, and nothing leaves the machine.
 */
async function retrieve(query, folder, budget = RETRIEVAL_BUDGET, semantic = undefined) {
	const words = terms(query);
	if (!folder || (!words.length && !semantic)) {
		return { text: '', files: [] };
	}
	const controller = new AbortController();
	const [matches, symbols, hits] = await Promise.all([
		words.length ? rgSearch(folder, words, controller.signal) : new Map(),
		words.length ? symbolFiles(words.slice(0, 4)) : new Map(),
		semantic ? semantic(query).catch(() => []) : Promise.resolve([]),
	]);
	/** Semantic hits by file: the chunks' lines, and the best rank, for fusion with the lexical ranking. */
	/** @type {Map<string, { rank: number; lines: number[] }>} */
	const semanticByFile = new Map();
	hits.forEach((hit, index) => {
		const file = nodePath.join(folder, hit.path);
		const entry = semanticByFile.get(file) || { rank: index + 1, lines: [] };
		entry.lines.push(hit.start);
		semanticByFile.set(file, entry);
	});
	/** @type {{ file: string; score: number; lines: number[] }[]} */
	const ranked = [];
	const consider = new Set([...matches.keys(), ...symbols.keys(), ...semanticByFile.keys()]);
	for (const file of consider) {
		const relative = nodePath.relative(folder, file);
		if (relative.startsWith('..') || relative.split(nodePath.sep).some((part) => SKIP_DIRS.has(part))) {
			continue;
		}
		const entry = matches.get(file);
		const distinct = entry ? entry.hits.size : 0;
		const total = entry ? [...entry.hits.values()].reduce((sum, count) => sum + count, 0) : 0;
		const pathLower = relative.toLowerCase();
		const pathHits = words.filter((word) => pathLower.includes(word.toLowerCase())).length;
		const symbolLines = symbols.get(file) || [];
		const score = distinct * 4 + Math.min(total, 20) * 0.5 + pathHits * 5 + symbolLines.length * 6;
		const found = semanticByFile.get(file);
		ranked.push({ file, score, lines: [...(entry ? entry.lines : []), ...symbolLines, ...(found ? found.lines : [])], semanticRank: found ? found.rank : 0 });
	}
	ranked.sort((a, b) => b.score - a.score);
	if (semanticByFile.size) {
		// Reciprocal rank fusion: a file near the top of either list (keywords, or meaning) comes first; one near
		// the top of both comes before both. The 60 is the usual damping constant.
		ranked.forEach((item, index) => { item.lexicalRank = item.score > 0 ? index + 1 : 0; });
		for (const item of ranked) {
			item.score = (item.lexicalRank ? 1 / (60 + item.lexicalRank) : 0) + (item.semanticRank ? 1 / (60 + item.semanticRank) : 0);
		}
		ranked.sort((a, b) => b.score - a.score);
	}
	const parts = [];
	const files = [];
	let used = 0;
	for (const item of ranked.slice(0, MAX_FILES)) {
		let content;
		try {
			content = fs.readFileSync(item.file, 'utf8');
		} catch {
			continue;
		}
		if (content.includes('\u0000')) {
			continue;
		}
		const lines = content.split('\n');
		const relative = nodePath.relative(folder, item.file).split(nodePath.sep).join('/');
		const snippets = windows(item.lines.length ? item.lines : [1], lines.length).map(([start, end]) => {
			const body = lines.slice(start - 1, end).map((text, index) => `${start + index}: ${text}`).join('\n');
			return body;
		});
		const block = `<file path="${relative}">\n${snippets.join('\n...\n')}\n</file>`;
		if (used + block.length > budget) {
			if (files.length) {
				break;
			}
		}
		parts.push(block);
		files.push(relative);
		used += block.length;
	}
	if (!parts.length) {
		return { text: '', files: [] };
	}
	return {
		text: `Files in this project that look relevant to the request (${semanticByFile.size ? 'by meaning and ' : ''}search terms: ${words.join(', ') || 'none'}). Line numbers are the file's own; read whole files with your tools when you need more.\n${parts.join('\n')}`,
		files,
	};
}

/** Files (and lines) the language servers' workspace symbols point to for these words. */
async function symbolFiles(words) {
	/** @type {Map<string, number[]>} */
	const found = new Map();
	await Promise.all(words.map(async (word) => {
		try {
			/** @type {vscode.SymbolInformation[]} */
			const symbols = await Promise.race([
				vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', word),
				new Promise((resolve) => setTimeout(() => resolve([]), 1500)),
			]) || [];
			for (const symbol of symbols.slice(0, 20)) {
				if (symbol.name.toLowerCase() !== word.toLowerCase() || symbol.location.uri.scheme !== 'file') {
					continue;
				}
				const file = symbol.location.uri.fsPath;
				const list = found.get(file) || [];
				list.push(symbol.location.range.start.line + 1);
				found.set(file, list);
			}
		} catch {
			// No language server for these files.
		}
	}));
	return found;
}

/**
 * The @ menu: what to attach to the next message.
 * @returns {Promise<{ kind: string; label: string; path?: string; url?: string }[]>}
 */
async function pickContext(folder) {
	const choice = await vscode.window.showQuickPick([
		{ label: `$(file) ${vscode.l10n.t('Files…')}`, description: vscode.l10n.t('Attach files from the project'), kind: 'files' },
		{ label: `$(folder) ${vscode.l10n.t('Folder…')}`, description: vscode.l10n.t("Attach a folder's file list"), kind: 'folder' },
		{ label: `$(git-compare) ${vscode.l10n.t('Git changes')}`, description: vscode.l10n.t('Attach the uncommitted diff'), kind: 'git' },
		{ label: `$(error) ${vscode.l10n.t('Problems in this file')}`, description: vscode.l10n.t('Errors and warnings the language servers report for the open file'), kind: 'problems-file' },
		{ label: `$(warning) ${vscode.l10n.t('All problems')}`, description: vscode.l10n.t('Every error and warning in the workspace (the Problems panel)'), kind: 'problems' },
		{ label: `$(terminal) ${vscode.l10n.t('Terminal output')}`, description: vscode.l10n.t('The last commands run in the terminal, with exit codes and output'), kind: 'terminal' },
		{ label: `$(files) ${vscode.l10n.t('Open editors')}`, description: vscode.l10n.t('The files open in editor tabs'), kind: 'open-editors' },
		{ label: `$(globe) ${vscode.l10n.t('Web page…')}`, description: vscode.l10n.t('Attach the text of a URL'), kind: 'web' },
	], { placeHolder: vscode.l10n.t('Attach context to the next message') });
	if (!choice) {
		return [];
	}
	if (choice.kind === 'problems-file') {
		const editor = vscode.window.activeTextEditor;
		return editor ? [{ kind: 'problems', label: `problems: ${nodePath.basename(editor.document.uri.fsPath)}`, path: editor.document.uri.fsPath }] : [];
	}
	if (choice.kind === 'problems') {
		return [{ kind: 'problems', label: 'problems' }];
	}
	if (choice.kind === 'terminal') {
		return [{ kind: 'terminal', label: 'terminal' }];
	}
	if (choice.kind === 'open-editors') {
		return [{ kind: 'open-editors', label: 'open editors' }];
	}
	if (choice.kind === 'files') {
		const uris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**}', 5000);
		const picks = await vscode.window.showQuickPick(
			uris.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })).sort((a, b) => a.label.localeCompare(b.label)),
			{ canPickMany: true, placeHolder: 'Choose files to attach', matchOnDescription: true },
		);
		return (picks || []).map((pick) => ({ kind: 'file', label: pick.label, path: pick.uri.fsPath }));
	}
	if (choice.kind === 'folder') {
		const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, defaultUri: folder ? vscode.Uri.file(folder) : undefined, openLabel: 'Attach' });
		return picked && picked[0] ? [{ kind: 'folder', label: vscode.workspace.asRelativePath(picked[0]) + '/', path: picked[0].fsPath }] : [];
	}
	if (choice.kind === 'git') {
		return folder ? [{ kind: 'git', label: 'git changes', path: folder }] : [];
	}
	const url = await vscode.window.showInputBox({ prompt: 'URL of the page to attach', placeHolder: 'https://…', validateInput: (value) => (/^https?:\/\/\S+$/.test(value.trim()) ? null : 'Enter an http(s) URL') });
	return url ? [{ kind: 'web', label: url.trim().replace(/^https?:\/\//, '').slice(0, 40), url: url.trim() }] : [];
}

/** The attached items as text for the agent, within a total budget. */
async function expandContext(items, folder) {
	const parts = [];
	let used = 0;
	const push = (text) => {
		const room = ATTACH_BUDGET - used;
		if (room <= 200) {
			return;
		}
		const clipped = text.length > room ? `${text.slice(0, room)}\n…(truncated)` : text;
		parts.push(clipped);
		used += clipped.length;
	};
	for (const item of items || []) {
		try {
			if (item.kind === 'file' && item.path) {
				const content = fs.readFileSync(item.path, 'utf8');
				if (!content.includes('\u0000')) {
					push(`<file path="${item.label}">\n${content.slice(0, 30000)}\n</file>`);
				}
			} else if (item.kind === 'folder' && item.path) {
				const listing = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard'], item.path).catch(() => '');
				const files = (listing || listFiles(item.path)).split('\n').filter(Boolean).slice(0, 400);
				push(`<folder path="${item.label}">\n${files.join('\n')}\n</folder>`);
			} else if (item.kind === 'git' && (item.path || folder)) {
				const cwd = item.path || folder;
				const status = await run('git', ['status', '--short'], cwd).catch(() => '');
				const diff = await run('git', ['diff', 'HEAD', '--stat', '--patch', '--no-color'], cwd).catch(() => '');
				push(`<git_changes>\n${status}\n${diff.slice(0, 40000)}\n</git_changes>`);
			} else if (item.kind === 'web' && item.url) {
				push(`<web_page url="${item.url}">\n${await fetchText(item.url)}\n</web_page>`);
			} else if (item.kind === 'problems') {
				push(`<problems>\n${problemsText(item.path, folder)}\n</problems>`);
			} else if (item.kind === 'terminal') {
				push(`<terminal>\n${terminalHistory.text()}\n</terminal>`);
			} else if (item.kind === 'open-editors') {
				for (const document of openEditorDocuments()) {
					push(`<file path="${vscode.workspace.asRelativePath(document.uri)}">\n${document.getText().slice(0, 30000)}\n</file>`);
				}
			}
		} catch (error) {
			push(`<error item="${item.label}">${error instanceof Error ? error.message : String(error)}</error>`);
		}
	}
	return parts.join('\n');
}

/**
 * The language servers' errors and warnings, for one file or the whole workspace folder, each with its line of
 * code, as the Problems panel lists them.
 * @param {string | undefined} file @param {string | undefined} folder
 */
function problemsText(file, folder) {
	const entries = file
		? [[vscode.Uri.file(file), vscode.languages.getDiagnostics(vscode.Uri.file(file))]]
		: vscode.languages.getDiagnostics().filter(([uri]) => uri.scheme === 'file' && (!folder || uri.fsPath.startsWith(folder + nodePath.sep)));
	const lines = [];
	for (const [uri, list] of /** @type {[vscode.Uri, vscode.Diagnostic[]][]} */ (entries)) {
		const shown = list.filter((item) => item.severity <= vscode.DiagnosticSeverity.Warning);
		if (!shown.length) {
			continue;
		}
		const document = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === uri.fsPath);
		for (const item of shown.slice(0, 50)) {
			const severity = item.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
			const source = item.source ? ` (${item.source}${item.code !== undefined ? ` ${typeof item.code === 'object' ? item.code.value : item.code}` : ''})` : '';
			const code = document ? `\n    ${document.lineAt(item.range.start.line).text.trim()}` : '';
			lines.push(`${vscode.workspace.asRelativePath(uri)}:${item.range.start.line + 1}:${item.range.start.character + 1} ${severity}${source}: ${item.message}${code}`);
		}
	}
	return lines.length ? lines.join('\n') : 'No errors or warnings.';
}

/** The text documents open in editor tabs (not the diff or output views). */
function openEditorDocuments() {
	const uris = vscode.window.tabGroups.all
		.flatMap((group) => group.tabs)
		.map((tab) => (tab.input instanceof vscode.TabInputText ? tab.input.uri : undefined))
		.filter((uri) => uri && uri.scheme === 'file');
	const seen = new Set();
	return vscode.workspace.textDocuments.filter((doc) => uris.some((uri) => uri && uri.fsPath === doc.uri.fsPath) && !seen.has(doc.uri.fsPath) && seen.add(doc.uri.fsPath));
}

/** Characters of one command's output kept. */
const TERMINAL_OUTPUT = 6000;

/**
 * The last commands run in this window's terminals, through shell integration: command line, working folder,
 * exit code and output (escape codes removed). Lets "@terminal" hand the agent what just failed, and lets a
 * command started from the chat report back how it ended.
 */
class TerminalHistory {
	constructor() {
		/** @type {{ command: string, cwd?: string, exitCode?: number, output: string, terminal: vscode.Terminal }[]} */
		this.entries = [];
		/** @type {Map<vscode.TerminalShellExecution, { output: string }>} */
		this.reading = new Map();
		this.ended = new vscode.EventEmitter();
		/** Fires with each finished command. */
		this.onDidEnd = this.ended.event;
		this.disposables = [
			vscode.window.onDidStartTerminalShellExecution((event) => void this.read(event.execution)),
			vscode.window.onDidEndTerminalShellExecution((event) => {
				const buffer = this.reading.get(event.execution);
				this.reading.delete(event.execution);
				const entry = {
					command: event.execution.commandLine.value,
					cwd: event.execution.cwd ? event.execution.cwd.fsPath : undefined,
					exitCode: event.exitCode,
					output: buffer ? buffer.output : '',
					terminal: event.terminal,
				};
				this.entries = [...this.entries, entry].slice(-10);
				this.ended.fire(entry);
			}),
		];
	}

	/** @param {vscode.TerminalShellExecution} execution */
	async read(execution) {
		const buffer = { output: '' };
		this.reading.set(execution, buffer);
		try {
			for await (const chunk of execution.read()) {
				buffer.output = (buffer.output + stripAnsi(chunk)).slice(-TERMINAL_OUTPUT);
			}
		} catch {
			// The terminal closed mid-command.
		}
	}

	/** The recent commands as text for the agent. */
	text() {
		if (!this.entries.length) {
			return 'No commands have run in a terminal with shell integration yet.';
		}
		return this.entries.slice(-5).map((entry) => `$ ${entry.command}${entry.cwd ? `   (in ${entry.cwd})` : ''}\nexit code: ${entry.exitCode === undefined ? 'unknown' : entry.exitCode}\n${entry.output.trim()}`).join('\n\n');
	}

	dispose() {
		this.ended.dispose();
		for (const item of this.disposables) {
			item.dispose();
		}
	}
}

/** @param {string} text */
function stripAnsi(text) {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\][^\x07]*(\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\r/g, '');
}

const terminalHistory = new TerminalHistory();

function run(command, args, cwd) {
	return new Promise((resolve, reject) => {
		execFile(command, args, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 8000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
	});
}

function listFiles(dir, depth = 0, prefix = '') {
	if (depth > 3) {
		return '';
	}
	let out = '';
	for (const entry of fs.readdirSync(dir, { withFileTypes: true }).slice(0, 200)) {
		if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
			continue;
		}
		const relative = prefix + entry.name;
		out += entry.isDirectory() ? listFiles(nodePath.join(dir, entry.name), depth + 1, relative + '/') : relative + '\n';
	}
	return out;
}

/** A web page's readable text: tags, scripts and styles removed. */
async function fetchText(url) {
	const response = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'Saturn IDE' } });
	const body = await response.text();
	return body
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 20000);
}

/** Read-only documents for diffs: the original of an agent-changed file, or an Apply proposal. */
class DiffContent {
	constructor() {
		this.scheme = 'saturn-diff';
		/** @type {Map<string, string>} */
		this.texts = new Map();
		this.changed = new vscode.EventEmitter();
		this.onDidChange = this.changed.event;
		this.counter = 0;
	}

	/** @param {vscode.Uri} uri */
	provideTextDocumentContent(uri) {
		return this.texts.get(uri.query) || '';
	}

	/** A document holding `text`, named like the file so the editor picks the right language. */
	uri(name, text) {
		const id = String(++this.counter);
		this.texts.set(id, text);
		if (this.texts.size > 200) {
			const oldest = this.texts.keys().next().value;
			if (oldest !== undefined) {
				this.texts.delete(oldest);
			}
		}
		return vscode.Uri.from({ scheme: this.scheme, path: '/' + name.replace(/^\/+/, ''), query: id });
	}
}

/** Opens one file of an agent run side by side: before the agent (left) and the file as it is now (right). */
async function openRunDiff(runtime, content, runId, root, file) {
	const before = await runtime.request(`/runs/${encodeURIComponent(runId)}/changes/file?path=${encodeURIComponent(file)}&side=before`);
	if (before.binary) {
		void vscode.window.showInformationMessage(`${file} is a binary file; its diff cannot be shown.`);
		return;
	}
	const target = nodePath.join(root, file);
	const left = content.uri(`${file}`, before.exists ? before.content : '');
	const right = fs.existsSync(target) ? vscode.Uri.file(target) : content.uri(`${file} (deleted)`, '');
	const label = before.exists ? (fs.existsSync(target) ? 'agent changes' : 'deleted by agent') : 'created by agent';
	await vscode.commands.executeCommand('vscode.diff', left, right, `${nodePath.basename(file)} — ${label}`, { preview: true });
}

/** A path named in a code block (first-line comment or the fence's info string), resolved in the project. */
function blockTarget(code, lang, folder) {
	const first = String(code).split('\n')[0] || '';
	const comment = /^\s*(?:\/\/|#|--|;|<!--|\/\*)\s*(?:file:\s*)?([\w@./\\-]+\.[A-Za-z0-9]+)/.exec(first);
	const fromLang = /([\w@./\\-]+\.[A-Za-z0-9]+)/.exec(String(lang || '').includes('.') || String(lang || '').includes('/') ? lang : '');
	const named = (comment && comment[1]) || (fromLang && fromLang[1]);
	if (!named || !folder) {
		return undefined;
	}
	const candidate = nodePath.isAbsolute(named) ? named : nodePath.join(folder, named);
	return fs.existsSync(candidate) ? candidate : undefined;
}

/**
 * Apply: merges a chat code block into its file (named in the block, else the active editor) with the runtime's
 * completion model, then shows the result as a diff to accept or discard. With a selection in the target editor,
 * the block replaces the selection directly.
 */
async function applyCode(runtime, content, code, lang, folder) {
	const named = blockTarget(code, lang, folder);
	let editor = vscode.window.activeTextEditor;
	/** @type {vscode.TextDocument | undefined} */
	let document;
	if (named) {
		document = await vscode.workspace.openTextDocument(vscode.Uri.file(named));
	} else if (editor) {
		document = editor.document;
	}
	if (!document) {
		const created = await vscode.workspace.openTextDocument({ content: code, language: lang || undefined });
		await vscode.window.showTextDocument(created);
		return;
	}
	const original = document.getText();
	const selection = editor && editor.document === document && !editor.selection.isEmpty ? editor.selection : undefined;
	let proposed;
	if (selection) {
		proposed = original.slice(0, document.offsetAt(selection.start)) + code + original.slice(document.offsetAt(selection.end));
	} else {
		try {
			proposed = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Saturn: applying…' }, () =>
				runtime.request('/complete', {
					method: 'POST',
					body: JSON.stringify({ kind: 'apply', language: document.languageId, path: vscode.workspace.asRelativePath(document.uri), file: original, selection: code }),
				}).then((result) => String((result && result.text) || '')));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const pick = await vscode.window.showWarningMessage(`Saturn could not merge the block automatically (${message}).`, 'Replace Whole File', 'Insert at Cursor');
			if (pick === 'Replace Whole File') {
				proposed = code;
			} else if (pick === 'Insert at Cursor' && editor && editor.document === document) {
				const at = document.offsetAt(editor.selection.active);
				proposed = original.slice(0, at) + code + original.slice(at);
			} else {
				return;
			}
		}
		if (!proposed.trim()) {
			void vscode.window.showWarningMessage('Saturn returned an empty file; nothing was applied.');
			return;
		}
	}
	if (proposed === original) {
		void vscode.window.showInformationMessage('The file already contains these changes.');
		return;
	}
	const name = vscode.workspace.asRelativePath(document.uri);
	const proposedUri = content.uri(name, proposed);
	await vscode.commands.executeCommand('vscode.diff', content.uri(name, original), proposedUri, `${nodePath.basename(name)} — Apply`, { preview: true });
	const closePreview = async () => {
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === proposedUri.toString()) {
					await vscode.window.tabGroups.close(tab);
				}
			}
		}
	};
	const answer = await vscode.window.showInformationMessage(`Apply these changes to ${name}?`, 'Accept', 'Discard');
	await closePreview();
	if (answer !== 'Accept') {
		return;
	}
	if (document.getText() !== original) {
		void vscode.window.showWarningMessage(`${name} changed while the preview was open; apply again to merge the latest version.`);
		return;
	}
	const edit = new vscode.WorkspaceEdit();
	edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(original.length)), proposed);
	if (await vscode.workspace.applyEdit(edit)) {
		await vscode.window.showTextDocument(document, { preview: false });
	}
}

/** Shell-like commands an agent ran, and their output, from a run's actions. */
function commandOf(action) {
	const args = action.arguments || {};
	if ((action.toolId === 'code' || action.toolId === 'Bash') && typeof args.command === 'string') {
		const result = action.result;
		let output = '';
		if (result && typeof result === 'object' && !Array.isArray(result)) {
			output = [result.stdout, result.stderr].filter(Boolean).join('\n');
			if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
				output += `\n[exit ${result.exitCode}]`;
			}
		} else if (Array.isArray(result)) {
			output = result.map((item) => (item && typeof item.text === 'string' ? item.text : '')).join('\n');
		} else if (typeof result === 'string') {
			output = result;
		}
		if (!output && action.reason) {
			output = action.reason;
		}
		return { command: args.command, output, status: action.status };
	}
	return undefined;
}

/**
 * "Saturn Agent" terminal: a read-only mirror of the commands agents run, with their output, so a run's shell work
 * is visible where developers expect it. Opening a real terminal with a command (runInTerminal) lets the user take over.
 */
class AgentTerminal {
	constructor() {
		this.writer = new vscode.EventEmitter();
		/** @type {vscode.Terminal | undefined} */
		this.terminal = undefined;
		/** @type {Set<string>} */
		this.seen = new Set();
		this.ready = false;
		/** @type {string[]} */
		this.queue = [];
	}

	enabled() {
		return vscode.workspace.getConfiguration('saturn').get('agentTerminal.enabled', true) !== false;
	}

	ensure() {
		if (this.terminal && vscode.window.terminals.includes(this.terminal)) {
			return this.terminal;
		}
		this.ready = false;
		/** @type {vscode.Pseudoterminal} */
		const pty = {
			onDidWrite: this.writer.event,
			open: () => {
				this.ready = true;
				this.writer.fire('\x1b[2mSaturn Agent — commands your agents run appear here (read-only).\x1b[0m\r\n');
				for (const text of this.queue.splice(0)) {
					this.writer.fire(text);
				}
			},
			close: () => {
				this.terminal = undefined;
				this.ready = false;
			},
		};
		this.terminal = vscode.window.createTerminal({ name: 'Saturn Agent', pty, iconPath: new vscode.ThemeIcon('sparkle') });
		return this.terminal;
	}

	write(text) {
		const out = text.replace(/\r?\n/g, '\r\n');
		if (this.ready) {
			this.writer.fire(out);
		} else {
			this.queue.push(out);
		}
	}

	/** Records commands already shown in a chat's history, so only new work is mirrored. */
	markSeen(runs) {
		for (const run of runs || []) {
			for (const action of run.actions || []) {
				if (commandOf(action) && action.status !== 'waiting_approval') {
					this.seen.add(`${run.id}:${action.id}`);
				}
			}
		}
	}

	/** Writes the commands of a run that have finished since the last update. */
	feed(run) {
		if (!this.enabled() || !run || !Array.isArray(run.actions)) {
			return;
		}
		let first = true;
		for (const action of run.actions) {
			const command = commandOf(action);
			if (!command || command.status === 'waiting_approval' || command.status === 'sleeping') {
				continue;
			}
			const key = `${run.id}:${action.id}`;
			if (this.seen.has(key)) {
				continue;
			}
			this.seen.add(key);
			const terminal = this.ensure();
			if (first) {
				terminal.show(true);
				first = false;
			}
			const color = command.status === 'completed' ? '32' : '31';
			this.write(`\n\x1b[${color}m$\x1b[0m \x1b[1m${command.command}\x1b[0m\n${command.output ? command.output.slice(0, 20000) + '\n' : ''}`);
		}
	}

	/**
	 * A real terminal in the project folder with the command typed in but not run, so the user decides. When the
	 * user runs it, `onDone` hears how it ended (needs the shell's integration; without it nothing is reported).
	 * @param {string} command @param {string | undefined} cwd
	 * @param {(entry: { command: string, exitCode?: number, output: string }) => void} [onDone]
	 */
	runInTerminal(command, cwd, onDone) {
		const terminal = vscode.window.createTerminal({ name: 'Saturn', cwd: cwd || undefined });
		terminal.show();
		terminal.sendText(command, false);
		if (onDone) {
			const first = command.split('\n')[0].trim();
			const listener = terminalHistory.onDidEnd((entry) => {
				if (entry.terminal === terminal && entry.command.trim().startsWith(first)) {
					listener.dispose();
					clearTimeout(timer);
					onDone(entry);
				}
			});
			const timer = setTimeout(() => listener.dispose(), 30 * 60 * 1000);
		}
	}

	dispose() {
		this.writer.dispose();
	}
}

module.exports = { terms, retrieve, pickContext, expandContext, DiffContent, openRunDiff, applyCode, blockTarget, AgentTerminal, commandOf, terminalHistory, problemsText };
