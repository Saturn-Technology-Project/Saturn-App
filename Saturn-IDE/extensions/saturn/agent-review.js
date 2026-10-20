// @ts-check
'use strict';

/*
 * Review an agent's edits inside the editor, hunk by hunk. For a file the agent changed, the file as it is now is
 * shown with each changed region marked: the lines the agent removed appear above it in red (as a ghost block
 * from the checkpoint), the lines it added are green, and a CodeLens on each hunk offers Keep and Revert.
 * Reverting a hunk writes the agent's text for that hunk back to the original; keeping it only removes the marks.
 * Once every hunk of a file is decided, the run's change record is updated through the runtime (kept, or reverted
 * when nothing of the agent's edit survives).
 */

const vscode = require('vscode');

/** @typedef {{ request: (path: string, init?: RequestInit) => Promise<any> }} RuntimeLike */
/** @typedef {{ start: number; oldLines: string[]; newLines: string[]; decided?: 'kept' | 'reverted' }} Hunk */
/** @typedef {{ runId: string; path: string; uri: vscode.Uri; before: string; hunks: Hunk[] }} Review */

/**
 * Line-level diff of two texts (Myers would be nicer; an LCS table is plenty for the few hundred lines an edit
 * touches). Returns hunks against the NEW text: `start` is the line in the new text where the hunk begins.
 * @param {string[]} a @param {string[]} b
 * @returns {Hunk[]}
 */
function diffLines(a, b) {
	const n = a.length;
	const m = b.length;
	if (n * m > 4_000_000) {
		// Too big to table; one hunk for the whole file.
		return [{ start: 0, oldLines: a, newLines: b }];
	}
	/** @type {Uint32Array[]} */
	const table = [];
	for (let i = 0; i <= n; i++) {
		table.push(new Uint32Array(m + 1));
	}
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}
	/** @type {Hunk[]} */
	const hunks = [];
	let i = 0;
	let j = 0;
	/** @type {Hunk | undefined} */
	let open;
	const close = () => { if (open) { hunks.push(open); open = undefined; } };
	while (i < n || j < m) {
		if (i < n && j < m && a[i] === b[j]) {
			close();
			i++;
			j++;
		} else if (j < m && (i >= n || table[i][j + 1] >= table[i + 1][j])) {
			open = open || { start: j, oldLines: [], newLines: [] };
			open.newLines.push(b[j]);
			j++;
		} else {
			open = open || { start: j, oldLines: [], newLines: [] };
			open.oldLines.push(a[i]);
			i++;
		}
	}
	close();
	return hunks;
}

class AgentReview {
	/** @param {RuntimeLike} runtime */
	constructor(runtime) {
		this.runtime = runtime;
		/** @type {Map<string, Review>} by document uri */
		this.reviews = new Map();
		this.added = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
			overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
			overviewRulerLane: vscode.OverviewRulerLane.Left,
		});
		this.removed = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
			overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
			overviewRulerLane: vscode.OverviewRulerLane.Left,
		});
		this.ghost = vscode.window.createTextEditorDecorationType({
			before: { color: new vscode.ThemeColor('diffEditor.removedTextBackground'), margin: '0 0 0 0' },
		});
		this.lensChanged = new vscode.EventEmitter();
		this.onDidChangeCodeLenses = this.lensChanged.event;
	}

	dispose() {
		this.added.dispose();
		this.removed.dispose();
		this.ghost.dispose();
		this.lensChanged.dispose();
	}

	/**
	 * Opens the file with the agent's changes marked for review.
	 * @param {string} runId @param {string} root @param {string} file
	 */
	async open(runId, root, file) {
		const before = await this.runtime.request(`/runs/${encodeURIComponent(runId)}/changes/file?path=${encodeURIComponent(file)}&side=before`);
		if (before.binary) {
			void vscode.window.showInformationMessage(`${file} is a binary file; review it in the diff view instead.`);
			return;
		}
		const uri = vscode.Uri.file(require('node:path').join(root, file));
		const document = await vscode.workspace.openTextDocument(uri);
		const editor = await vscode.window.showTextDocument(document, { preview: false });
		const original = before.exists ? before.content : '';
		const hunks = diffLines(original.split('\n'), document.getText().split('\n'));
		if (!hunks.length) {
			vscode.window.setStatusBarMessage('Saturn: this file matches what the agent found; nothing to review.', 4000);
			return;
		}
		this.reviews.set(uri.toString(), { runId, path: file, uri, before: original, hunks });
		this.render(editor);
		this.lensChanged.fire();
		if (hunks[0]) {
			editor.revealRange(new vscode.Range(hunks[0].start, 0, hunks[0].start, 0), vscode.TextEditorRevealType.InCenter);
		}
	}

	/** @param {vscode.TextEditor} [editor] */
	render(editor) {
		for (const target of editor ? [editor] : vscode.window.visibleTextEditors) {
			const review = this.reviews.get(target.document.uri.toString());
			if (!review) {
				target.setDecorations(this.added, []);
				target.setDecorations(this.removed, []);
				continue;
			}
			/** @type {vscode.DecorationOptions[]} */
			const added = [];
			/** @type {vscode.DecorationOptions[]} */
			const removed = [];
			for (const hunk of review.hunks) {
				if (hunk.decided) {
					continue;
				}
				const end = Math.max(hunk.start, hunk.start + hunk.newLines.length - 1);
				if (hunk.newLines.length) {
					added.push({ range: new vscode.Range(hunk.start, 0, end, Number.MAX_SAFE_INTEGER) });
				}
				if (hunk.oldLines.length) {
					// The removed lines, as a hover on the hunk's first line (the editor cannot show phantom lines).
					const shown = hunk.oldLines.slice(0, 40).join('\n') + (hunk.oldLines.length > 40 ? `\n… ${hunk.oldLines.length - 40} more` : '');
					const hover = new vscode.MarkdownString();
					hover.appendMarkdown(`**Removed by the agent** (${hunk.oldLines.length} line${hunk.oldLines.length === 1 ? '' : 's'}):\n`);
					hover.appendCodeblock(shown, target.document.languageId);
					removed.push({ range: new vscode.Range(hunk.start, 0, hunk.start, 0), hoverMessage: hover });
				}
			}
			target.setDecorations(this.added, added);
			target.setDecorations(this.removed, removed);
		}
	}

	/** @param {vscode.TextDocument} document */
	provideCodeLenses(document) {
		const review = this.reviews.get(document.uri.toString());
		if (!review) {
			return [];
		}
		/** @type {vscode.CodeLens[]} */
		const lenses = [];
		const pending = review.hunks.filter((hunk) => !hunk.decided);
		review.hunks.forEach((hunk, index) => {
			if (hunk.decided) {
				return;
			}
			const range = new vscode.Range(hunk.start, 0, hunk.start, 0);
			const what = hunk.oldLines.length && hunk.newLines.length ? `${hunk.oldLines.length} → ${hunk.newLines.length} lines` : hunk.newLines.length ? `+${hunk.newLines.length}` : `−${hunk.oldLines.length}`;
			lenses.push(new vscode.CodeLens(range, { title: `$(check) Keep (${what})`, command: 'saturn.review.keepHunk', arguments: [document.uri.toString(), index] }));
			lenses.push(new vscode.CodeLens(range, { title: '$(discard) Revert', command: 'saturn.review.revertHunk', arguments: [document.uri.toString(), index] }));
		});
		if (pending.length > 1) {
			const first = pending[0];
			const range = new vscode.Range(first.start, 0, first.start, 0);
			lenses.push(new vscode.CodeLens(range, { title: `Keep all ${pending.length}`, command: 'saturn.review.keepAll', arguments: [document.uri.toString()] }));
			lenses.push(new vscode.CodeLens(range, { title: 'Revert all', command: 'saturn.review.revertAll', arguments: [document.uri.toString()] }));
		}
		return lenses;
	}

	/** @param {string} uri @param {number} index */
	async keepHunk(uri, index) {
		const review = this.reviews.get(uri);
		if (!review || !review.hunks[index]) {
			return;
		}
		review.hunks[index].decided = 'kept';
		await this.settle(review);
	}

	/** @param {string} uri @param {number} index */
	async revertHunk(uri, index) {
		const review = this.reviews.get(uri);
		const hunk = review && review.hunks[index];
		if (!review || !hunk || hunk.decided) {
			return;
		}
		const document = await vscode.workspace.openTextDocument(review.uri);
		const edit = new vscode.WorkspaceEdit();
		const endLine = hunk.start + hunk.newLines.length;
		const range = hunk.newLines.length
			? new vscode.Range(hunk.start, 0, Math.min(document.lineCount, endLine), 0)
			: new vscode.Range(hunk.start, 0, hunk.start, 0);
		const replacement = hunk.oldLines.length ? hunk.oldLines.join('\n') + (hunk.newLines.length || hunk.start < document.lineCount ? '\n' : '') : '';
		edit.replace(review.uri, range, replacement);
		await vscode.workspace.applyEdit(edit);
		await document.save();
		hunk.decided = 'reverted';
		// Later hunks moved by the line difference.
		const delta = hunk.oldLines.length - hunk.newLines.length;
		for (const later of review.hunks) {
			if (!later.decided && later.start > hunk.start) {
				later.start += delta;
			}
		}
		await this.settle(review);
	}

	/** @param {string} uri */
	async keepAll(uri) {
		const review = this.reviews.get(uri);
		if (!review) {
			return;
		}
		for (const hunk of review.hunks) {
			if (!hunk.decided) {
				hunk.decided = 'kept';
			}
		}
		await this.settle(review);
	}

	/** @param {string} uri */
	async revertAll(uri) {
		const review = this.reviews.get(uri);
		if (!review) {
			return;
		}
		// Back to front, so earlier hunks' line numbers stay valid.
		for (let index = review.hunks.length - 1; index >= 0; index--) {
			if (!review.hunks[index].decided) {
				await this.revertHunk(uri, index);
			}
		}
	}

	/** After each decision: re-render; once the file is fully decided, tell the runtime and end the review. */
	async settle(review) {
		this.render();
		this.lensChanged.fire();
		if (review.hunks.some((hunk) => !hunk.decided)) {
			return;
		}
		this.reviews.delete(review.uri.toString());
		this.render();
		this.lensChanged.fire();
		const allReverted = review.hunks.every((hunk) => hunk.decided === 'reverted');
		try {
			if (allReverted) {
				await this.runtime.request(`/runs/${encodeURIComponent(review.runId)}/changes/revert`, { method: 'POST', body: JSON.stringify({ path: review.path }) });
			} else {
				// A partly reverted file is the user's file now: the run keeps its record, and the file counts as kept.
				await this.runtime.request(`/runs/${encodeURIComponent(review.runId)}/changes/keep`, { method: 'POST', body: JSON.stringify({ path: review.path }) }).catch(() => undefined);
			}
		} catch {
			// The runtime's record is a convenience; the file on disk is what the user decided.
		}
		vscode.window.setStatusBarMessage(`Saturn: ${review.path} reviewed (${review.hunks.filter((hunk) => hunk.decided === 'kept').length} kept, ${review.hunks.filter((hunk) => hunk.decided === 'reverted').length} reverted).`, 5000);
	}
}

/** @param {vscode.ExtensionContext} context @param {RuntimeLike} runtime */
function registerAgentReview(context, runtime) {
	const review = new AgentReview(runtime);
	context.subscriptions.push(
		review,
		vscode.languages.registerCodeLensProvider({ pattern: '**' }, review),
		vscode.commands.registerCommand('saturn.review.keepHunk', (uri, index) => review.keepHunk(uri, index)),
		vscode.commands.registerCommand('saturn.review.revertHunk', (uri, index) => review.revertHunk(uri, index)),
		vscode.commands.registerCommand('saturn.review.keepAll', (uri) => review.keepAll(uri)),
		vscode.commands.registerCommand('saturn.review.revertAll', (uri) => review.revertAll(uri)),
		vscode.window.onDidChangeVisibleTextEditors(() => review.render()),
		vscode.workspace.onDidCloseTextDocument((document) => {
			review.reviews.delete(document.uri.toString());
			review.lensChanged.fire();
		}),
	);
	return review;
}

module.exports = { registerAgentReview, diffLines };
