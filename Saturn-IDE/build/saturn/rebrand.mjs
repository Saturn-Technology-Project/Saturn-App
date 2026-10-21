/*---------------------------------------------------------------------------------------------
 *  Saturn: names Saturn IDE in a built Saturn IDE's interface text where upstream says "VS Code".
 *--------------------------------------------------------------------------------------------*/
// Runs on a finished build (desktop/scripts/bundle-ide.cjs calls it as Saturn IDE goes into the app), so the
// sources stay upstream's and merge cleanly. It rewrites only interface text:
//   out/nls.messages.json and out/nls.messages.js     the workbench's localized strings
//   extensions/*/package.nls.json                     extension settings, commands and descriptions
//   extensions/*/package.json                         the text fields of manifests that skip package.nls.json
//   extensions/*/dist/*.js, only in l10n.t(...)        the messages extensions show
// and leaves alone the phrases that name the real product or its services (its marketplace, Insiders, its team
// and newsletter, its logo), and every other string in code.
//
// Usage: node build/saturn/rebrand.mjs <app folder: the one with product.json and out/> [name]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRAND = /\b(Visual Studio Code|VS Code)\b/g;
/** What follows "VS Code" when it means the real product: kept as is. */
const KEEP_AFTER = /^(?:'s)? (?:marketplace|Marketplace|Insiders|team|Team|Newsletter|newsletter|mark|icon|logo)\b/;
/** What comes before it when it means the real product. */
const KEEP_BEFORE = /(?:Insiders version of |Insiders )$/;

/** The text with the product named `name` where it says VS Code, except where VS Code means the real product. */
export function rebrand(text, name) {
	// A bug report goes to whoever makes this build, not to the VS Code team.
	return text.replace(/\breport this issue to the VS Code team\b/g, `report this issue to the ${name} team`).replace(BRAND, (match, _brand, offset, whole) => {
		const before = whole.slice(Math.max(0, offset - 24), offset);
		const after = whole.slice(offset + match.length, offset + match.length + 24);
		return KEEP_AFTER.test(after) || KEEP_BEFORE.test(before) ? match : name;
	});
}

/** l10n.t("…") / l10n.t('…') / l10n.t(`…`): only the message literal is renamed, never the code around it. */
export function rebrandMessagesInCode(code, name) {
	return code.replace(/(l10n\.t\()(["'`])((?:\\[\s\S]|(?!\2)[^\\])*)\2/g, (whole, call, quote, body) => `${call}${quote}${rebrand(body, name)}${quote}`);
}

/** Manifest fields people read; anything else (ids, commands, globs, paths) is never touched. */
const TEXT_FIELDS = new Set(['displayName', 'description', 'title', 'label', 'markdownDescription', 'shortTitle', 'category']);

/** A package.json with its literal text fields renamed (`%key%` references go through package.nls.json). */
export function rebrandManifest(json, name) {
	const walk = (value, key) => {
		if (typeof value === 'string') {
			return TEXT_FIELDS.has(key) && !value.startsWith('%') ? rebrand(value, name) : value;
		}
		if (Array.isArray(value)) {
			return value.map((item) => walk(item, key));
		}
		if (value && typeof value === 'object') {
			return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, walk(item, field)]));
		}
		return value;
	};
	const next = { ...json };
	for (const field of ['displayName', 'description', 'contributes']) {
		if (field in json) {
			next[field] = walk(json[field], field);
		}
	}
	return next;
}

function rewrite(file, change) {
	const before = fs.readFileSync(file, 'utf8');
	const after = change(before);
	if (after === before) {
		return 0;
	}
	fs.writeFileSync(file, after, 'utf8');
	return 1;
}

/** Rewrites a built app folder in place; returns how many files changed. */
export function rebrandBuild(appDir, name) {
	let changed = 0;
	const messagesJson = path.join(appDir, 'out', 'nls.messages.json');
	if (fs.existsSync(messagesJson)) {
		changed += rewrite(messagesJson, (text) => JSON.stringify(JSON.parse(text).map((message) => typeof message === 'string' ? rebrand(message, name) : message)));
	}
	const messagesJs = path.join(appDir, 'out', 'nls.messages.js');
	if (fs.existsSync(messagesJs)) {
		// globalThis._VSCODE_NLS_MESSAGES=[…]; the array is JSON.
		changed += rewrite(messagesJs, (text) => {
			const start = text.indexOf('[');
			const end = text.lastIndexOf(']');
			if (start < 0 || end < start) {
				return text;
			}
			const messages = JSON.parse(text.slice(start, end + 1)).map((message) => typeof message === 'string' ? rebrand(message, name) : message);
			return text.slice(0, start) + JSON.stringify(messages) + text.slice(end + 1);
		});
	}
	const extensions = path.join(appDir, 'extensions');
	for (const extension of fs.existsSync(extensions) ? fs.readdirSync(extensions) : []) {
		const nls = path.join(extensions, extension, 'package.nls.json');
		if (fs.existsSync(nls)) {
			changed += rewrite(nls, (text) => {
				const entries = Object.entries(JSON.parse(text)).map(([key, value]) => [key, typeof value === 'string' ? rebrand(value, name) : value && typeof value.message === 'string' ? { ...value, message: rebrand(value.message, name) } : value]);
				const next = JSON.stringify(Object.fromEntries(entries), null, '\t');
				return next === JSON.stringify(JSON.parse(text), null, '\t') ? text : next;
			});
		}
		const manifest = path.join(extensions, extension, 'package.json');
		if (fs.existsSync(manifest)) {
			changed += rewrite(manifest, (text) => {
				const json = JSON.parse(text);
				const next = rebrandManifest(json, name);
				return JSON.stringify(next) === JSON.stringify(json) ? text : JSON.stringify(next);
			});
		}
		const dist = path.join(extensions, extension, 'dist');
		for (const file of fs.existsSync(dist) ? fs.readdirSync(dist).filter((item) => item.endsWith('.js')) : []) {
			changed += rewrite(path.join(dist, file), (code) => rebrandMessagesInCode(code, name));
		}
	}
	return changed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	const appDir = process.argv[2];
	if (!appDir || !fs.existsSync(path.join(appDir, 'product.json'))) {
		console.error('Usage: node build/saturn/rebrand.mjs <app folder with product.json> [name]');
		process.exit(2);
	}
	const name = process.argv[3] || JSON.parse(fs.readFileSync(path.join(appDir, 'product.json'), 'utf8')).nameShort;
	const changed = rebrandBuild(appDir, name);
	console.log(`rebrand: "${name}" in ${changed} files of ${appDir}`);
}
