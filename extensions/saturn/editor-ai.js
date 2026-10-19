// @ts-check
'use strict';

/*
 * Saturn IDE's in-editor AI, backed by the Saturn runtime's POST /complete (the extension never holds keys):
 *  - Tab completion: an inline completion provider for every file.
 *  - Inline edit (Cmd+I): rewrite the selection from an instruction, shown as an inline diff to accept or reject.
 * Failures (runtime down, no completion model) surface once in the status bar, never as popups.
 */

const vscode = require('vscode');

const DEBOUNCE_MS = 300;
/** After a failure, Tab completion pauses this long so a stopped runtime is not hit on every keystroke. */
const ERROR_PAUSE_MS = 15000;
const SCHEMES = new Set(['file', 'untitled', 'vscode-remote', 'vscode-userdata', 'vscode-notebook-cell']);

/**
 * @typedef {{ request: (path: string, init?: RequestInit) => Promise<any> }} RuntimeLike
 * @typedef {{ text: string }} Completion
 */

/** Turns a failed call into one short sentence; null for a cancelled call. */
function errorText(error) {
	if (error && error.name === 'AbortError') {
		return null;
	}
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof TypeError || /fetch failed|ECONNREFUSED/.test(message)) {
		return 'The Saturn runtime is not running. Open the Saturn app.';
	}
	return message;
}

/** @param {number} ms @param {vscode.CancellationToken} token */
function pause(ms, token) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => { listener.dispose(); resolve(true); }, ms);
		const listener = token.onCancellationRequested(() => { clearTimeout(timer); listener.dispose(); resolve(false); });
	});
}

/** @param {vscode.CancellationToken} token */
function abortOn(token) {
	const controller = new AbortController();
	const listener = token.onCancellationRequested(() => controller.abort());
	return { signal: controller.signal, dispose: () => listener.dispose() };
}

/** The status bar item for Tab completion, which also carries the one-time error message for both features. */
class AiStatus {
	constructor() {
		this.item = vscode.window.createStatusBarItem('saturn.completions', vscode.StatusBarAlignment.Right, 100);
		this.item.name = 'Saturn Tab Completion';
		this.item.command = 'saturn.toggleCompletions';
		/** @type {string | null} */
		this.error = null;
		this.busy = '';
		this.render();
		this.item.show();
	}

	enabled() {
		return vscode.workspace.getConfiguration('saturn').get('completions.enabled', true) !== false;
	}

	/** Shows a failure once: repeated identical failures only keep the warning icon. */
	fail(message) {
		if (message !== this.error) {
			vscode.window.setStatusBarMessage(`$(warning) Saturn: ${message}`, 8000);
		}
		this.error = message;
		this.render();
	}

	ok() {
		if (this.error !== null) {
			this.error = null;
			this.render();
		}
	}

	/** @param {string} text */
	working(text) {
		this.busy = text;
		this.render();
	}

	render() {
		if (this.busy) {
			this.item.text = `$(loading~spin) ${this.busy}`;
			this.item.tooltip = 'Saturn is editing. Press Esc to cancel.';
			return;
		}
		const on = this.enabled();
		this.item.text = this.error ? '$(warning) Tab' : on ? '$(sparkle) Tab' : '$(circle-slash) Tab';
		const state = on ? 'Saturn Tab completion is on. Click to turn it off.' : 'Saturn Tab completion is off. Click to turn it on.';
		this.item.tooltip = this.error ? `${this.error}\n\n${state}` : state;
	}

	dispose() {
		this.item.dispose();
	}
}

/** Tab completion: debounced, cancelled by the next keystroke, and served from the last result while it still fits. */
class TabCompletions {
	/** @param {RuntimeLike} runtime @param {AiStatus} status */
	constructor(runtime, status) {
		this.runtime = runtime;
		this.status = status;
		this.pausedUntil = 0;
		/** @type {{ uri: string, prefix: string, suffix: string, text: string } | undefined} */
		this.last = undefined;
	}

	/**
	 * @param {vscode.TextDocument} document @param {vscode.Position} position
	 * @param {vscode.InlineCompletionContext} context @param {vscode.CancellationToken} token
	 */
	async provideInlineCompletionItems(document, position, context, token) {
		if (!this.status.enabled() || !SCHEMES.has(document.uri.scheme)) {
			return undefined;
		}
		const line = document.lineAt(position.line).text;
		// Mid-word typing rarely wants a suggestion and would fire on every letter.
		if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic && /\w/.test(line.charAt(position.character))) {
			return undefined;
		}
		const prefix = document.getText(new vscode.Range(Math.max(0, position.line - 80), 0, position.line, position.character)).slice(-6000);
		const end = document.lineAt(Math.min(document.lineCount - 1, position.line + 40)).range.end;
		const suffix = document.getText(new vscode.Range(position, end)).slice(0, 2000);
		const uri = document.uri.toString();

		const cached = this.fromCache(uri, prefix, suffix);
		if (cached !== undefined) {
			return cached ? [new vscode.InlineCompletionItem(cached, new vscode.Range(position, position))] : undefined;
		}
		if (Date.now() < this.pausedUntil && context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
			return undefined;
		}
		if (!(await pause(DEBOUNCE_MS, token))) {
			return undefined;
		}

		const abort = abortOn(token);
		try {
			const result = await this.runtime.request('/complete', {
				method: 'POST',
				signal: abort.signal,
				body: JSON.stringify({
					kind: 'inline',
					language: document.languageId,
					path: vscode.workspace.asRelativePath(document.uri),
					prefix,
					suffix,
				}),
			});
			this.status.ok();
			this.pausedUntil = 0;
			const text = String((result && result.text) || '');
			this.last = { uri, prefix, suffix, text };
			if (token.isCancellationRequested || !text.trim()) {
				return undefined;
			}
			return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];
		} catch (error) {
			const message = errorText(error);
			if (message) {
				this.pausedUntil = Date.now() + ERROR_PAUSE_MS;
				this.status.fail(message);
			}
			return undefined;
		} finally {
			abort.dispose();
		}
	}

	/** The rest of the last completion when the user typed into it; undefined when a new call is needed. */
	fromCache(uri, prefix, suffix) {
		const last = this.last;
		if (!last || last.uri !== uri || last.suffix !== suffix) {
			return undefined;
		}
		const whole = last.prefix + last.text;
		if (prefix.length < last.prefix.length || !whole.startsWith(prefix)) {
			return undefined;
		}
		return whole.slice(prefix.length);
	}
}

/**
 * Inline edit: the proposal is inserted below the original lines, with the original marked red and the
 * proposal green, until Accept (deletes the original) or Reject (deletes the proposal).
 */
class InlineEdit {
	/** @param {RuntimeLike} runtime @param {AiStatus} status */
	constructor(runtime, status) {
		this.runtime = runtime;
		this.status = status;
		this.removed = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
			overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
			overviewRulerLane: vscode.OverviewRulerLane.Left,
		});
		this.added = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
			overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
			overviewRulerLane: vscode.OverviewRulerLane.Left,
		});
		this.hint = vscode.window.createTextEditorDecorationType({
			after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('editorCodeLens.foreground') },
		});
		/** @type {{ document: vscode.TextDocument, start: number, oldLength: number, newText: string, hasOld: boolean } | undefined} */
		this.pending = undefined;
		/** @type {AbortController | undefined} */
		this.inFlight = undefined;
		this.applying = false;
		this.lensChanged = new vscode.EventEmitter();
		this.onDidChangeCodeLenses = this.lensChanged.event;
	}

	async start() {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		if (this.pending) {
			vscode.window.setStatusBarMessage('Saturn: accept (Cmd+Enter) or reject (Esc) the current edit first.', 5000);
			return;
		}
		if (this.inFlight) {
			return;
		}
		const document = editor.document;
		const selection = editor.selection;
		// Whole lines, so the diff reads line by line; a selection ending at column 0 stops at the line before.
		let first = selection.start.line;
		let last = selection.end.line;
		if (!selection.isEmpty && selection.end.character === 0 && last > first) {
			last -= 1;
		}
		const cursorLine = document.lineAt(first);
		// An empty selection on a non-blank line inserts new lines after it; on a blank line it replaces that line.
		const hasOld = !selection.isEmpty || cursorLine.isEmptyOrWhitespace;
		const oldRange = hasOld
			? new vscode.Range(first, 0, last, document.lineAt(last).text.length)
			: new vscode.Range(cursorLine.range.end, cursorLine.range.end);
		const instruction = await vscode.window.showInputBox({
			title: 'Saturn Edit',
			prompt: hasOld && !selection.isEmpty ? `Edit lines ${first + 1}–${last + 1}` : `Insert after line ${first + 1}`,
			placeHolder: 'Describe the change, e.g. "add error handling"',
			ignoreFocusOut: true,
		});
		if (!instruction || !instruction.trim()) {
			return;
		}
		const version = document.version;
		const before = document.getText(new vscode.Range(Math.max(0, oldRange.start.line - 60), 0, oldRange.start.line, oldRange.start.character));
		const afterEnd = document.lineAt(Math.min(document.lineCount - 1, oldRange.end.line + 30)).range.end;
		const after = document.getText(new vscode.Range(oldRange.end, afterEnd));

		const controller = new AbortController();
		this.inFlight = controller;
		void vscode.commands.executeCommand('setContext', 'saturn.inlineEditBusy', true);
		this.status.working('Editing…');
		/** @type {string | undefined} */
		let newText;
		try {
			const result = await this.runtime.request('/complete', {
				method: 'POST',
				signal: controller.signal,
				body: JSON.stringify({
					kind: 'edit',
					language: document.languageId,
					path: vscode.workspace.asRelativePath(document.uri),
					prefix: before,
					selection: document.getText(oldRange),
					suffix: after,
					instruction,
				}),
			});
			this.status.ok();
			newText = String((result && result.text) || '');
		} catch (error) {
			const message = errorText(error);
			if (message) {
				this.status.fail(message);
			}
			return;
		} finally {
			this.inFlight = undefined;
			void vscode.commands.executeCommand('setContext', 'saturn.inlineEditBusy', false);
			this.status.working('');
		}
		if (document.version !== version) {
			vscode.window.setStatusBarMessage('Saturn: the file changed while editing; the edit was dropped.', 6000);
			return;
		}
		if (!newText.trim() && !hasOld) {
			vscode.window.setStatusBarMessage('Saturn: the model proposed no change.', 5000);
			return;
		}
		const start = document.offsetAt(oldRange.start);
		const oldLength = hasOld ? document.offsetAt(oldRange.end) - start : 0;
		this.applying = true;
		try {
			const edit = new vscode.WorkspaceEdit();
			edit.insert(document.uri, oldRange.end, `\n${newText}`);
			if (!(await vscode.workspace.applyEdit(edit))) {
				return;
			}
		} finally {
			this.applying = false;
		}
		this.pending = { document, start, oldLength, newText, hasOld };
		void vscode.commands.executeCommand('setContext', 'saturn.inlineEditPending', true);
		this.render();
	}

	cancel() {
		this.inFlight?.abort();
	}

	async accept() {
		const pending = this.pending;
		if (!pending || !this.intact()) {
			return this.clear();
		}
		this.clear();
		if (pending.hasOld) {
			await this.replace(pending.document, pending.start, pending.start + pending.oldLength + 1, '');
		}
	}

	async reject() {
		const pending = this.pending;
		if (!pending || !this.intact()) {
			return this.clear();
		}
		this.clear();
		const from = pending.start + pending.oldLength;
		await this.replace(pending.document, from, from + 1 + pending.newText.length, '');
	}

	/** True while the document still holds the original followed by the proposal where we put them. */
	intact() {
		const pending = this.pending;
		if (!pending || pending.document.isClosed) {
			return false;
		}
		const length = pending.oldLength + 1 + pending.newText.length;
		const text = pending.document.getText(new vscode.Range(pending.document.positionAt(pending.start), pending.document.positionAt(pending.start + length)));
		return text.endsWith(`\n${pending.newText}`) && text.length === length;
	}

	/** @param {vscode.TextDocument} document @param {number} from @param {number} to @param {string} text */
	async replace(document, from, to, text) {
		this.applying = true;
		try {
			const edit = new vscode.WorkspaceEdit();
			edit.replace(document.uri, new vscode.Range(document.positionAt(from), document.positionAt(to)), text);
			await vscode.workspace.applyEdit(edit);
		} finally {
			this.applying = false;
		}
	}

	clear() {
		this.pending = undefined;
		void vscode.commands.executeCommand('setContext', 'saturn.inlineEditPending', false);
		this.render();
	}

	/**
	 * Keeps the proposal's offsets right when the user edits above it; an edit inside it ends the proposal.
	 * @param {vscode.TextDocumentChangeEvent} event
	 */
	onChange(event) {
		const pending = this.pending;
		if (!pending || this.applying || event.document !== pending.document) {
			return;
		}
		const end = pending.start + pending.oldLength + 1 + pending.newText.length;
		for (const change of event.contentChanges) {
			if (change.rangeOffset + change.rangeLength <= pending.start) {
				pending.start += change.text.length - change.rangeLength;
			} else if (change.rangeOffset < end) {
				this.clear();
				vscode.window.setStatusBarMessage('Saturn: the proposed edit was changed by hand, so it is kept as is.', 6000);
				return;
			}
		}
		this.render();
	}

	render() {
		const pending = this.pending;
		for (const editor of vscode.window.visibleTextEditors) {
			if (!pending || editor.document !== pending.document) {
				editor.setDecorations(this.removed, []);
				editor.setDecorations(this.added, []);
				editor.setDecorations(this.hint, []);
				continue;
			}
			const document = pending.document;
			const oldStart = document.positionAt(pending.start);
			const newStart = document.positionAt(pending.start + pending.oldLength + 1);
			const newEnd = document.positionAt(pending.start + pending.oldLength + 1 + pending.newText.length);
			editor.setDecorations(this.removed, pending.hasOld ? [new vscode.Range(oldStart, document.positionAt(pending.start + pending.oldLength))] : []);
			editor.setDecorations(this.added, pending.newText ? [new vscode.Range(newStart, newEnd)] : []);
			const hintLine = document.lineAt(newStart.line).range.end;
			editor.setDecorations(this.hint, [{
				range: new vscode.Range(hintLine, hintLine),
				renderOptions: { after: { contentText: '⌘↵ Accept   Esc Reject' } },
			}]);
		}
		this.lensChanged.fire(undefined);
	}

	/** @param {vscode.TextDocument} document */
	provideCodeLenses(document) {
		const pending = this.pending;
		if (!pending || document !== pending.document) {
			return [];
		}
		const at = document.positionAt(pending.start);
		const range = new vscode.Range(at, at);
		return [
			new vscode.CodeLens(range, { title: 'Accept (⌘↵)', command: 'saturn.inlineEdit.accept' }),
			new vscode.CodeLens(range, { title: 'Reject (Esc)', command: 'saturn.inlineEdit.reject' }),
		];
	}

	dispose() {
		this.removed.dispose();
		this.added.dispose();
		this.hint.dispose();
		this.lensChanged.dispose();
	}
}

/** @param {vscode.ExtensionContext} context @param {RuntimeLike} runtime */
function registerEditorAi(context, runtime) {
	const status = new AiStatus();
	const tab = new TabCompletions(runtime, status);
	const edit = new InlineEdit(runtime, status);
	context.subscriptions.push(
		status,
		edit,
		vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, tab),
		vscode.languages.registerCodeLensProvider({ pattern: '**' }, edit),
		vscode.commands.registerCommand('saturn.inlineEdit', () => edit.start()),
		vscode.commands.registerCommand('saturn.inlineEdit.accept', () => edit.accept()),
		vscode.commands.registerCommand('saturn.inlineEdit.reject', () => edit.reject()),
		vscode.commands.registerCommand('saturn.inlineEdit.cancel', () => edit.cancel()),
		vscode.commands.registerCommand('saturn.toggleCompletions', async () => {
			const config = vscode.workspace.getConfiguration('saturn');
			await config.update('completions.enabled', !status.enabled(), vscode.ConfigurationTarget.Global);
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('saturn.completions.enabled')) {
				status.render();
			}
		}),
		vscode.workspace.onDidChangeTextDocument((event) => edit.onChange(event)),
		vscode.window.onDidChangeVisibleTextEditors(() => edit.render()),
	);
}

module.exports = { registerEditorAi };
