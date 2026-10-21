// Saturn: the build step that names Saturn IDE where upstream's interface text says "VS Code".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { rebrand, rebrandBuild, rebrandManifest, rebrandMessagesInCode } from '../../build/saturn/rebrand.mjs';

const NAME = 'Saturn IDE';

test('interface text names Saturn IDE; phrases about the real VS Code stay', () => {
	assert.equal(rebrand('Get started with VS Code', NAME), 'Get started with Saturn IDE');
	assert.equal(rebrand("Extensions are VS Code's power-ups.", NAME), "Extensions are Saturn IDE's power-ups.");
	assert.equal(rebrand('Please reload Visual Studio Code to enable it.', NAME), 'Please reload Saturn IDE to enable it.');
	assert.equal(rebrand('Whether new shells should inherit their environment from VS Code', NAME), 'Whether new shells should inherit their environment from Saturn IDE');
	assert.equal(rebrand('Please report this issue to the VS Code team:', NAME), 'Please report this issue to the Saturn IDE team:');
	for (const kept of [
		'Banner used in the VS Code marketplace.',
		'Press the reload button to switch to the Insiders version of VS Code.',
		'In VS Code Insiders and Code - OSS, the dropdown updates this setting.',
		'Signup for the VS Code Newsletter',
		'Tie the VS Code mark with fast parabolic ribbon motion',
		'hide the VS Code icon.',
		'before publishing you MUST reach out to the VS Code team.',
	]) {
		assert.equal(rebrand(kept, NAME), kept);
	}
	assert.equal(rebrand('vscode.dev and code --help', NAME), 'vscode.dev and code --help', 'technical names are not words "VS Code"');
});

test('in extension code only l10n.t messages change', () => {
	const code = 'a(t.l10n.t("Please open a folder in VS Code")),b=t.l10n.t(`filing an issue against VS Code.${x}`),c="Visual Studio Code",d={description:"Visual Studio Code"},e=t.l10n.t(\'Use VS Code\\\'s Version\')';
	assert.equal(
		rebrandMessagesInCode(code, NAME),
		'a(t.l10n.t("Please open a folder in Saturn IDE")),b=t.l10n.t(`filing an issue against Saturn IDE.${x}`),c="Visual Studio Code",d={description:"Visual Studio Code"},e=t.l10n.t(\'Use Saturn IDE\\\'s Version\')',
	);
});

test('manifests: literal text fields change; ids, references and other fields do not', () => {
	const manifest = { name: 'vscode-notebook', displayName: '%displayName%', engines: { vscode: '^1.0.0' }, contributes: { notebookRenderer: [{ id: 'vscode.builtin-renderer', displayName: 'VS Code Builtin Notebook Output Renderer', entrypoint: './VS Code.js' }], commands: [{ command: 'x.open', title: 'Open in VS Code' }] } };
	assert.deepEqual(rebrandManifest(manifest, NAME), { name: 'vscode-notebook', displayName: '%displayName%', engines: { vscode: '^1.0.0' }, contributes: { notebookRenderer: [{ id: 'vscode.builtin-renderer', displayName: 'Saturn IDE Builtin Notebook Output Renderer', entrypoint: './VS Code.js' }], commands: [{ command: 'x.open', title: 'Open in Saturn IDE' }] } });
});

test('a built app folder is rewritten in place: message tables, extension manifests and messages', () => {
	const app = fs.mkdtempSync(path.join(os.tmpdir(), 'saturn-rebrand-'));
	fs.mkdirSync(path.join(app, 'out'));
	fs.mkdirSync(path.join(app, 'extensions', 'git', 'dist'), { recursive: true });
	fs.writeFileSync(path.join(app, 'product.json'), JSON.stringify({ nameShort: NAME }));
	fs.writeFileSync(path.join(app, 'out', 'nls.messages.json'), JSON.stringify(['Welcome to Visual Studio Code', 'Banner used in the VS Code marketplace.', 'Untouched']));
	fs.writeFileSync(path.join(app, 'out', 'nls.messages.js'), '/* header */\nglobalThis._VSCODE_NLS_MESSAGES=["Reload VS Code"];');
	fs.writeFileSync(path.join(app, 'extensions', 'git', 'package.nls.json'), JSON.stringify({ a: 'Show VS Code\'s Git output.', b: { message: 'VS Code setting', comment: ['x'] }, c: 'plain' }));
	fs.writeFileSync(path.join(app, 'extensions', 'git', 'dist', 'main.js'), 'x=l10n.t("Open in VS Code"),y="VS Code"');
	fs.mkdirSync(path.join(app, 'extensions', 'grunt'));
	fs.writeFileSync(path.join(app, 'extensions', 'grunt', 'package.json'), JSON.stringify({ name: 'grunt', displayName: 'Grunt support for VS Code', description: '%description%', engines: { vscode: '*' } }));

	assert.equal(rebrandBuild(app, NAME), 5);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app, 'extensions', 'grunt', 'package.json'), 'utf8')), { name: 'grunt', displayName: 'Grunt support for Saturn IDE', description: '%description%', engines: { vscode: '*' } });
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app, 'out', 'nls.messages.json'), 'utf8')), ['Welcome to Saturn IDE', 'Banner used in the VS Code marketplace.', 'Untouched']);
	assert.equal(fs.readFileSync(path.join(app, 'out', 'nls.messages.js'), 'utf8'), '/* header */\nglobalThis._VSCODE_NLS_MESSAGES=["Reload Saturn IDE"];');
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app, 'extensions', 'git', 'package.nls.json'), 'utf8')), { a: "Show Saturn IDE's Git output.", b: { message: 'Saturn IDE setting', comment: ['x'] }, c: 'plain' });
	assert.equal(fs.readFileSync(path.join(app, 'extensions', 'git', 'dist', 'main.js'), 'utf8'), 'x=l10n.t("Open in Saturn IDE"),y="VS Code"');
	assert.equal(rebrandBuild(app, NAME), 0, 'running it twice changes nothing');
});
