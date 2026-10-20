// @ts-check
'use strict';

/*
 * Answers the Saturn runtime's editor-tool requests (runtime/src/application/ide-bridge.ts) with this window's
 * language servers, so agents can ask what the compiler reports, where a symbol is defined and used, its type,
 * and rename it everywhere. The window keeps one server-sent-event stream open to the runtime, naming its
 * workspace folders; each event is one request, answered with a POST. A rename is computed here and returned as
 * each file's new text; the runtime writes it through the run's checkpoint, so it can be reviewed and reverted.
 */

const vscode = require('vscode');
const nodePath = require('path');

/** Waits between reconnect attempts while the runtime is down (the last one repeats). */
const RECONNECT_MS = [1000, 2000, 5000, 15000];
/** How long to wait for a just-opened file's diagnostics to arrive from its language server (a cold one is slow). */
const DIAGNOSTICS_SETTLE_MS = 8000;
const MAX_ITEMS = 200;

/** @typedef {{ request: (path: string, init?: RequestInit) => Promise<any>, base: () => string, token: () => string }} RuntimeLike */

class IdeBridge {
	/** @param {RuntimeLike} runtime */
	constructor(runtime) {
		this.runtime = runtime;
		this.id = `ide-tools:${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
		/** @type {AbortController | undefined} */
		this.connection = undefined;
		this.stopped = false;
		this.failures = 0;
	}

	start() {
		void this.loop();
	}

	/** Reconnects with the new folder list (a folder was added to or removed from the workspace). */
	refolder() {
		this.connection?.abort();
	}

	dispose() {
		this.stopped = true;
		this.connection?.abort();
	}

	async loop() {
		while (!this.stopped) {
			try {
				await this.connectOnce();
				this.failures = 0;
			} catch {
				this.failures += 1;
			}
			if (this.stopped) {
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS[Math.min(this.failures, RECONNECT_MS.length - 1)]));
		}
	}

	async connectOnce() {
		const folders = (vscode.workspace.workspaceFolders || []).filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath);
		if (!folders.length) {
			// Nothing open yet: wait for a folder instead of polling the runtime.
			await new Promise((resolve) => {
				const once = vscode.workspace.onDidChangeWorkspaceFolders(() => { once.dispose(); resolve(undefined); });
			});
			return;
		}
		const controller = new AbortController();
		this.connection = controller;
		const token = this.runtime.token();
		const query = folders.map((folder) => `folder=${encodeURIComponent(folder)}`).join('&');
		const response = await fetch(`${this.runtime.base()}/runtime/clients/${encodeURIComponent(this.id)}/requests?${query}`, {
			headers: token ? { authorization: `Bearer ${token}` } : {},
			signal: controller.signal,
		});
		if (!response.ok || !response.body) {
			throw new Error(`Saturn runtime returned ${response.status}`);
		}
		this.failures = 0;
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffered = '';
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) {
					return;
				}
				buffered += decoder.decode(value, { stream: true });
				let end;
				while ((end = buffered.indexOf('\n\n')) >= 0) {
					const event = buffered.slice(0, end);
					buffered = buffered.slice(end + 2);
					if (event.startsWith('data: ')) {
						void this.answer(JSON.parse(event.slice(6)));
					}
				}
			}
		} finally {
			if (this.connection === controller) {
				this.connection = undefined;
			}
		}
	}

	/** @param {{ id: string, tool: string, args: Record<string, any>, root: string }} request */
	async answer(request) {
		let body;
		try {
			body = { result: await this.run(request.tool, request.args || {}, request.root) };
		} catch (error) {
			body = { error: error instanceof Error ? error.message : String(error) };
		}
		await this.runtime.request(`/runtime/clients/${encodeURIComponent(this.id)}/responses/${encodeURIComponent(request.id)}`, {
			method: 'POST',
			body: JSON.stringify(body),
		}).catch(() => undefined);
	}

	/** @param {string} tool @param {Record<string, any>} args @param {string} root */
	async run(tool, args, root) {
		// Language servers (TypeScript and most others) do not run in a folder the user has not trusted.
		if (!vscode.workspace.isTrusted) {
			throw new Error('Saturn IDE has this folder in Restricted Mode, so its language servers are off. Trust the folder (the Restricted Mode banner, or Manage Workspace Trust) to use the editor tools.');
		}
		switch (tool) {
			case 'ide_diagnostics': return diagnostics(root, args.path, args.severity);
			case 'ide_definition': return definition(await locate(args));
			case 'ide_references': return references(await locate(args));
			case 'ide_hover': return hover(await locate(args));
			case 'ide_symbols': return symbols(root, String(args.query || ''));
			case 'ide_rename': return rename(await locate(args), String(args.newName || ''));
			default: throw new Error(`Saturn IDE has no tool named ${tool}`);
		}
	}
}

/**
 * The document and position of `symbol` in `path`: on `line` when given (1-based), else its first whole-word
 * occurrence in the file.
 * @param {Record<string, any>} args
 */
async function locate(args) {
	const symbol = String(args.symbol || '').trim();
	if (!args.path || !symbol) {
		throw new Error('path and symbol are required');
	}
	const document = await vscode.workspace.openTextDocument(vscode.Uri.file(String(args.path)));
	const pattern = new RegExp(`(?<![\\w$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`);
	const lines = typeof args.line === 'number' && args.line >= 1 && args.line <= document.lineCount ? [args.line - 1] : [];
	// An import names the symbol without being it: look at the other lines first.
	const all = Array.from({ length: document.lineCount }, (_, line) => line);
	lines.push(...all.filter((line) => !IMPORTING.test(document.lineAt(line).text)), ...all.filter((line) => IMPORTING.test(document.lineAt(line).text)));
	for (const line of lines) {
		const match = pattern.exec(document.lineAt(line).text);
		if (match) {
			return { document, position: new vscode.Position(line, match.index), symbol };
		}
	}
	throw new Error(`${symbol} does not appear in ${vscode.workspace.asRelativePath(document.uri)}`);
}

/** @param {vscode.Uri} uri @param {number} start @param {number} end */
async function snippet(uri, start, end) {
	try {
		const document = await vscode.workspace.openTextDocument(uri);
		const from = Math.max(0, start);
		const to = Math.min(document.lineCount - 1, end);
		const lines = [];
		for (let line = from; line <= to; line += 1) {
			lines.push(`${line + 1}: ${document.lineAt(line).text}`);
		}
		return lines.join('\n');
	} catch {
		return '';
	}
}

/** @param {vscode.Location | vscode.LocationLink} item */
function rangeOf(item) {
	return 'targetUri' in item ? { uri: item.targetUri, range: item.targetSelectionRange || item.targetRange } : { uri: item.uri, range: item.range };
}

/** A line that imports names rather than declaring them. */
const IMPORTING = /^\s*(import\b|export\s+\{[^}]*\}\s+from\b|(const|let|var)\s+.*=\s*require\()/;

/**
 * Definitions of the symbol at a position. A definition that lands on an import line of the same file is the
 * import's alias (TypeScript answers a use of an imported name that way): it is followed to the real declaration.
 * @param {vscode.Uri} uri @param {vscode.Position} position
 * @returns {Promise<(vscode.Location | vscode.LocationLink)[]>}
 */
async function definitionsAt(uri, position, depth = 0) {
	/** @type {(vscode.Location | vscode.LocationLink)[]} */
	const found = (await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position)) || [];
	if (depth > 1) {
		return found;
	}
	const followed = [];
	for (const item of found) {
		const target = rangeOf(item);
		const document = target.uri.fsPath === uri.fsPath ? await vscode.workspace.openTextDocument(target.uri) : undefined;
		if (document && IMPORTING.test(document.lineAt(target.range.start.line).text) && !target.range.start.isEqual(position)) {
			const next = await definitionsAt(target.uri, target.range.start, depth + 1);
			followed.push(...(next.length ? next : [item]));
		} else {
			followed.push(item);
		}
	}
	return followed;
}

/** @param {{ document: vscode.TextDocument, position: vscode.Position }} at */
async function definition(at) {
	const found = await definitionsAt(at.document.uri, at.position);
	const results = [];
	for (const item of found.slice(0, 10)) {
		const { uri, range } = rangeOf(item);
		const full = 'targetUri' in item ? item.targetRange : range;
		results.push({ path: uri.fsPath, line: range.start.line + 1, code: await snippet(uri, full.start.line - 2, Math.min(full.end.line, full.start.line + 40) + 2) });
	}
	if (!results.length) {
		throw new Error('The language server found no definition (it may still be starting, or the file type has none).');
	}
	return results;
}

/** @param {{ document: vscode.TextDocument, position: vscode.Position }} at */
async function references(at) {
	/** @type {vscode.Location[]} */
	const found = (await vscode.commands.executeCommand('vscode.executeReferenceProvider', at.document.uri, at.position)) || [];
	const results = [];
	for (const item of found.slice(0, MAX_ITEMS)) {
		const document = await vscode.workspace.openTextDocument(item.uri).then((doc) => doc, () => undefined);
		results.push({ path: item.uri.fsPath, line: item.range.start.line + 1, text: document ? document.lineAt(item.range.start.line).text.trim() : '' });
	}
	return { count: found.length, references: results };
}

/** @param {{ document: vscode.TextDocument, position: vscode.Position }} at */
async function hover(at) {
	/** @type {vscode.Hover[]} */
	const found = (await vscode.commands.executeCommand('vscode.executeHoverProvider', at.document.uri, at.position)) || [];
	const text = found.flatMap((item) => item.contents.map((content) => (typeof content === 'string' ? content : 'value' in content ? content.value : ''))).filter(Boolean).join('\n\n');
	if (!text) {
		throw new Error('The language server has no hover information for this symbol.');
	}
	return text;
}

/** @param {string} root @param {string} query */
async function symbols(root, query) {
	/** @type {vscode.SymbolInformation[]} */
	const found = (await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query)) || [];
	return found
		.filter((item) => item.location.uri.scheme === 'file' && inside(root, item.location.uri.fsPath))
		.slice(0, 100)
		.map((item) => ({ name: item.name, kind: vscode.SymbolKind[item.kind], path: item.location.uri.fsPath, line: item.location.range.start.line + 1, ...(item.containerName ? { container: item.containerName } : {}) }));
}

/** @param {string} root @param {string | undefined} file @param {string | undefined} severity */
async function diagnostics(root, file, severity) {
	const wanted = severity === 'error' ? [vscode.DiagnosticSeverity.Error] : severity === 'all' ? [0, 1, 2, 3] : [vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning];
	/** @type {[vscode.Uri, vscode.Diagnostic[]][]} */
	let entries;
	if (file) {
		const uri = vscode.Uri.file(file);
		// Open the file (a file nobody opened has no diagnostics yet) and let its language server finish reporting.
		const document = await vscode.workspace.openTextDocument(uri);
		await settleDiagnostics(uri);
		const reported = vscode.languages.getDiagnostics(uri);
		// TypeScript checks only the files shown in an editor; for the others, ask its server directly.
		entries = [[uri, TS_LANGUAGES.has(document.languageId) ? merge(reported, await typescriptDiagnostics(uri)) : reported]];
	} else {
		entries = vscode.languages.getDiagnostics().filter(([uri]) => uri.scheme === 'file' && inside(root, uri.fsPath));
	}
	const items = [];
	for (const [uri, list] of entries) {
		for (const item of list) {
			if (!wanted.includes(item.severity)) {
				continue;
			}
			items.push({
				path: uri.fsPath,
				line: item.range.start.line + 1,
				column: item.range.start.character + 1,
				severity: ['error', 'warning', 'info', 'hint'][item.severity],
				message: item.message,
				...(item.source ? { source: item.source } : {}),
				...(item.code !== undefined ? { code: typeof item.code === 'object' ? String(item.code.value) : String(item.code) } : {}),
			});
		}
	}
	return { count: items.length, problems: items.slice(0, MAX_ITEMS) };
}

const TS_LANGUAGES = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);

/**
 * A TypeScript or JavaScript file's syntax and type errors from TypeScript's server, which answers for files
 * no editor shows. Empty when the TypeScript extension is not running.
 * @param {vscode.Uri} uri @returns {Promise<vscode.Diagnostic[]>}
 */
async function typescriptDiagnostics(uri) {
	const severities = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, suggestion: vscode.DiagnosticSeverity.Hint, message: vscode.DiagnosticSeverity.Information };
	const found = [];
	for (const command of ['syntacticDiagnosticsSync', 'semanticDiagnosticsSync']) {
		/** @type {{ body?: { start: { line: number, offset: number }, end: { line: number, offset: number }, text: string, code?: number, category: string }[] } | undefined} */
		const response = await Promise.resolve(vscode.commands.executeCommand('typescript.tsserverRequest', command, { file: uri })).catch(() => undefined);
		for (const item of (response && response.body) || []) {
			const range = new vscode.Range(item.start.line - 1, item.start.offset - 1, item.end.line - 1, item.end.offset - 1);
			const diagnostic = new vscode.Diagnostic(range, item.text, severities[/** @type {keyof typeof severities} */ (item.category)] ?? vscode.DiagnosticSeverity.Error);
			diagnostic.source = 'ts';
			if (item.code !== undefined) {
				diagnostic.code = item.code;
			}
			found.push(diagnostic);
		}
	}
	return found;
}

/** The editor's diagnostics plus those it lacks, one per line and message. @param {vscode.Diagnostic[]} a @param {vscode.Diagnostic[]} b */
function merge(a, b) {
	const key = (/** @type {vscode.Diagnostic} */ item) => `${item.range.start.line}:${item.message}`;
	const seen = new Set(a.map(key));
	return [...a, ...b.filter((item) => !seen.has(key(item)))];
}

/** After a file's diagnostics last changed, this long without another change means its language server is done. */
const DIAGNOSTICS_QUIET_MS = 1200;

/**
 * Resolves once the language server has gone quiet about `uri` (TypeScript, for one, reports syntax problems
 * first and type errors a moment later), or after the settle time.
 * @param {vscode.Uri} uri
 */
function settleDiagnostics(uri) {
	return new Promise((resolve) => {
		const deadline = setTimeout(done, DIAGNOSTICS_SETTLE_MS);
		/** @type {NodeJS.Timeout | undefined} */
		let quiet = setTimeout(done, DIAGNOSTICS_QUIET_MS * 2);
		const listener = vscode.languages.onDidChangeDiagnostics((event) => {
			if (event.uris.some((item) => item.fsPath === uri.fsPath)) {
				clearTimeout(quiet);
				quiet = setTimeout(done, DIAGNOSTICS_QUIET_MS);
			}
		});
		function done() {
			clearTimeout(deadline);
			clearTimeout(quiet);
			listener.dispose();
			resolve(undefined);
		}
	});
}

/**
 * Each file's text after the language server's rename, without applying it: the runtime writes the files
 * through the run's checkpoint.
 * @param {{ document: vscode.TextDocument, position: vscode.Position, symbol: string }} at @param {string} newName
 */
async function rename(at, newName) {
	if (!/^[\w$]+$/.test(newName)) {
		throw new Error('newName must be a plain identifier');
	}
	/** @type {vscode.WorkspaceEdit | undefined} */
	const edit = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', at.document.uri, at.position, newName);
	if (!edit || !edit.size) {
		throw new Error(`The language server cannot rename ${at.symbol} here.`);
	}
	const files = [];
	for (const [uri, edits] of edit.entries()) {
		if (uri.scheme !== 'file') {
			continue;
		}
		const document = await vscode.workspace.openTextDocument(uri);
		let text = document.getText();
		const sorted = [...edits].sort((a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start));
		for (const item of sorted) {
			text = text.slice(0, document.offsetAt(item.range.start)) + item.newText + text.slice(document.offsetAt(item.range.end));
		}
		files.push({ path: uri.fsPath, content: text });
	}
	return { files };
}

/** @param {string} root @param {string} file */
function inside(root, file) {
	const relative = nodePath.relative(root, file);
	return relative === '' || (!relative.startsWith('..') && !nodePath.isAbsolute(relative));
}

/** @param {vscode.ExtensionContext} context @param {RuntimeLike} runtime */
function registerIdeBridge(context, runtime) {
	const bridge = new IdeBridge(runtime);
	bridge.start();
	context.subscriptions.push(bridge, vscode.workspace.onDidChangeWorkspaceFolders(() => bridge.refolder()));
	return bridge;
}

module.exports = { registerIdeBridge, IdeBridge, inside };
