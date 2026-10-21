// The eval harness itself, without spending tokens: a scripted OpenAI-compatible model solves two tasks (one by
// editing a file, one by answering), and one it leaves unsolved, through a real runtime started by the harness.
// And every task's hidden checks: they fail on the repo as given and pass with the task's reference fix
// (solution/, never shown to the agent); a task without one (answer only) must pass untouched.
// Run: node --test scripts/eval/self-test.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { markdown, runTask, setUp, startRuntime, summarize } from './run.mjs';

const tasksDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tasks');
const exec = promisify(execFile);

const FIXED = '/** The page numbers for `total` items, `size` per page: [1, 2, …]. */\nexport function pages(total, size) {\n  const count = Math.ceil(total / size);\n  return Array.from({ length: count }, (_, index) => index + 1);\n}\n';

function scriptedModel() {
	const server = createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			const messages = JSON.parse(raw || '{}').messages ?? [];
			const ask = messages.filter((item) => item.role === 'user').map((item) => item.content).join('\n');
			// A tool result comes back as a native tool turn (or, from older runtimes, as JSON in an assistant turn).
			const acted = messages.some((item) => item.role === 'tool' || (item.role === 'assistant' && String(item.content).includes('"toolId"')));
			let message = { content: 'I could not do this one.' };
			if (/tests fail/.test(ask) && !acted) message = { content: '', tool_calls: [{ id: 'c0', type: 'function', function: { name: 'files', arguments: JSON.stringify({ action: 'write', path: 'src/pages.js', content: FIXED }) } }] };
			else if (/tests fail/.test(ask)) message = { content: 'Fixed: the last partial page was dropped by Math.floor.' };
			else if (/cache\.js/.test(ask)) message = { content: 'It caches a computed value per key. The bug: ttl is documented in milliseconds but multiplied by 1000, so values stay 1000 times too long.' };
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
		});
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

test('the harness runs tasks end to end and grades them with the hidden checks', { timeout: 120_000 }, async () => {
	const model = await scriptedModel();
	const runtime = await startRuntime();
	try {
		const { agent, model: name } = await setUp(runtime.api, { SATURN_EVAL_PROVIDER: 'openai', SATURN_EVAL_MODEL: 'scripted', SATURN_EVAL_BASE_URL: model.url, SATURN_EVAL_API_KEY: 'k' });
		const results = [];
		for (const task of ['off-by-one', 'explain-without-changing', 'implement-function']) results.push(await runTask(runtime.api, agent.id, task));
		const [fixed, explained, missed] = results;
		assert.equal(fixed.passed, true, JSON.stringify(fixed));
		assert.equal(fixed.steps, 1);
		assert.equal(explained.passed, true, JSON.stringify(explained));
		assert.equal(missed.passed, false, JSON.stringify(missed));
		assert.equal(missed.checks, false, 'its hidden checks fail');
		const summary = summarize(results, name);
		assert.equal(summary.passed, 2);
		assert.ok(summary.inputTokens >= 300, 'tokens are counted from the usage summary');
		assert.match(markdown(summary, { passRate: 1 }), /2\/3 passed \(67%\), baseline 100%/);
	} finally {
		await runtime.stop();
		model.server.close();
	}
});

test('plan providers are refused for unattended evals', async () => {
	await assert.rejects(setUp(async () => ({}), { SATURN_EVAL_PROVIDER: 'claude-code', SATURN_EVAL_MODEL: 'x' }), /not for unattended evals/);
	await assert.rejects(setUp(async () => ({}), {}), /Set SATURN_EVAL_PROVIDER/);
});

/** Runs a task's check in a copy of its repo, optionally with the reference fix laid over it. */
async function checkPasses(name, withSolution) {
	const folder = path.join(tasksDir, name);
	const task = JSON.parse(await readFile(path.join(folder, 'task.json'), 'utf8'));
	const work = await mkdtemp(path.join(os.tmpdir(), `saturn-eval-check-${name}-`));
	try {
		await cp(path.join(folder, 'repo'), work, { recursive: true });
		if (withSolution) await cp(path.join(folder, 'solution'), work, { recursive: true });
		await cp(path.join(folder, 'check'), path.join(work, '.eval-check'), { recursive: true });
		const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
		try {
			// Before the fix a check may hang (slow-dedupe's is the slowness itself); 20 s is plenty to fail.
			await exec('/bin/sh', ['-c', task.check], { cwd: work, env, timeout: withSolution ? 60_000 : 20_000 });
			if (withSolution) await exec('/bin/sh', ['-c', "[ ! -d test ] || node --test 'test/*.test.js' 2>/dev/null"], { cwd: work, env, timeout: 60_000 });
			return true;
		} catch {
			return false;
		}
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

test("every task's hidden checks fail as given and pass with its reference fix", { timeout: 300_000 }, async () => {
	for (const name of (await readdir(tasksDir)).sort()) {
		const task = JSON.parse(await readFile(path.join(tasksDir, name, 'task.json'), 'utf8'));
		const hasSolution = await readdir(path.join(tasksDir, name, 'solution')).then(() => true, () => false);
		if (task.answerMatches) {
			assert.equal(await checkPasses(name, false), true, `${name}: an answer-only task passes untouched`);
			continue;
		}
		assert.equal(await checkPasses(name, false), false, `${name}: the checks fail before the fix`);
		if (hasSolution) assert.equal(await checkPasses(name, true), true, `${name}: the checks and the visible tests pass with the fix`);
	}
});
