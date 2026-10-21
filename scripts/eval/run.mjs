#!/usr/bin/env node
// Saturn task evals: small coding tasks run end to end through Saturn's own agent loop with a real model, graded by
// tests the agent never sees. They show whether a change to the loop, the prompts or the tools made agents better
// or worse at real work, in pass rate, steps, tokens and cost.
//
//   SATURN_EVAL_PROVIDER=claude SATURN_EVAL_MODEL=claude-sonnet-5-5 SATURN_EVAL_API_KEY=… node scripts/eval/run.mjs
//   node scripts/eval/run.mjs --tasks off-by-one,rename-across-files --out results.json
//   node scripts/eval/run.mjs --baseline scripts/eval/baseline.json      (exit 1 when the pass rate drops)
//
// Optional: SATURN_EVAL_BASE_URL (an OpenAI-compatible server), SATURN_EVAL_EFFORT. Each run starts its own runtime on
// a free port with a temporary data folder, so it never touches a running Saturn. Every task costs model tokens.

import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
// The runtime accepts a launcher's token of 32 characters or more.
const TOKEN = `eval-${randomBytes(24).toString('hex')}`;
/** A pass rate this many points under the baseline fails the run. */
const ALLOWED_DROP = 0.15;

function args(argv) {
	const flags = {};
	for (let i = 0; i < argv.length; i += 1) {
		if (!argv[i].startsWith('--')) continue;
		const name = argv[i].slice(2);
		flags[name] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
	}
	return flags;
}

function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
		server.on('error', reject);
	});
}

/** Starts a runtime from this checkout on a free port, with its own data folder and token. */
export async function startRuntime() {
	const port = await freePort();
	const data = await mkdtemp(path.join(os.tmpdir(), 'saturn-eval-data-'));
	const tsx = path.join(root, 'runtime', 'node_modules', 'tsx', 'dist', 'cli.mjs');
	const child = spawn(process.execPath, [tsx, path.join(root, 'runtime', 'src', 'main.ts')], {
		cwd: path.join(root, 'runtime'),
		env: { ...process.env, SATURN_DATA_DIR: data, SATURN_RUNTIME_PORT: String(port), SATURN_RUNTIME_TOKEN: TOKEN, SATURN_NO_WAKEUP: '1', SATURN_SECRET_STORE: 'file' },
		stdio: ['ignore', 'ignore', 'inherit'],
	});
	const base = `http://127.0.0.1:${port}`;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			if ((await fetch(`${base}/health`)).ok) break;
		} catch {
			// Not up yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
		if (attempt === 99) throw new Error('The runtime did not start');
	}
	const api = async (method, route, body) => {
		const response = await fetch(base + route, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
		const text = await response.text();
		if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${text.slice(0, 300)}`);
		return text ? JSON.parse(text) : undefined;
	};
	return { api, base, token: TOKEN, data, stop: async () => { child.kill(); await rm(data, { recursive: true, force: true }); } };
}

async function waitForRun(api, runId, timeoutMs) {
	const until = Date.now() + timeoutMs;
	for (;;) {
		const current = await api('GET', `/runs/${runId}`);
		if (!['running', 'queued', 'sleeping'].includes(current.status)) return current;
		if (Date.now() > until) {
			await api('POST', `/runs/${runId}/stop`).catch(() => undefined);
			return { ...current, status: 'timed_out' };
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}

/** Runs one task: a fresh copy of its repo as a project, one message, then the hidden checks. */
export async function runTask(api, agentId, name) {
	const folder = path.join(here, 'tasks', name);
	const task = JSON.parse(await readFile(path.join(folder, 'task.json'), 'utf8'));
	const work = await mkdtemp(path.join(os.tmpdir(), `saturn-eval-${name}-`));
	await cp(path.join(folder, 'repo'), work, { recursive: true });
	await run('git', ['init', '-q'], { cwd: work });
	const project = await api('POST', '/projects', { path: work, grant: true });
	await api('POST', `/projects/${project.id}/access`, { granted: true });
	const from = new Date().toISOString();
	const started = Date.now();
	const begun = await api('POST', `/agents/${agentId}/runs`, { input: task.prompt, projectId: project.id });
	const done = await waitForRun(api, begun.id, task.timeoutMs ?? 300_000);
	const seconds = Math.round((Date.now() - started) / 100) / 10;
	const usage = await api('GET', `/usage/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(new Date().toISOString())}`).catch(() => ({}));
	// The grading tests go in only now, so changing the visible tests cannot pass a task.
	await cp(path.join(folder, 'check'), path.join(work, '.eval-check'), { recursive: true });
	let checked = { ok: false, output: '' };
	try {
		// NODE_TEST_CONTEXT (set when this runs under node --test) would make the check report to that runner and exit 0.
		const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
		const result = await run('/bin/sh', ['-c', task.check], { cwd: work, timeout: 120_000, env });
		checked = { ok: true, output: `${result.stdout}${result.stderr}` };
	} catch (error) {
		checked = { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}`.slice(-2000) };
	}
	const answered = task.answerMatches ? new RegExp(task.answerMatches, 'i').test(done.output ?? '') : true;
	await rm(work, { recursive: true, force: true });
	return {
		task: name,
		passed: done.status === 'completed' && checked.ok && answered,
		status: done.status,
		checks: checked.ok,
		answer: answered,
		steps: done.actions?.length ?? 0,
		seconds,
		inputTokens: usage.totals?.inputTokens ?? 0,
		outputTokens: usage.totals?.outputTokens ?? 0,
		cost: usage.totals?.costUsd ?? 0,
		...(checked.ok ? {} : { checkOutput: checked.output.slice(-800) }),
		...(done.error ? { error: done.error } : {}),
	};
}

/** Sets up a model connection and an agent from the environment (or the given values). */
export async function setUp(api, env = process.env) {
	const provider = env.SATURN_EVAL_PROVIDER;
	const model = env.SATURN_EVAL_MODEL;
	if (!provider || !model) throw new Error('Set SATURN_EVAL_PROVIDER and SATURN_EVAL_MODEL (and SATURN_EVAL_API_KEY for a hosted model).');
	if (provider === 'claude-code' || provider === 'codex') throw new Error(`${provider} runs on a personal plan and is not for unattended evals; use an API provider.`);
	const connection = await api('POST', '/connections/models', {
		name: `Eval ${model}`, provider, model,
		...(env.SATURN_EVAL_BASE_URL ? { baseUrl: env.SATURN_EVAL_BASE_URL } : {}),
		...(env.SATURN_EVAL_API_KEY ? { secret: env.SATURN_EVAL_API_KEY } : {}),
		...(env.SATURN_EVAL_EFFORT ? { effort: env.SATURN_EVAL_EFFORT } : {}),
	});
	// Full autonomy inside the sandbox: an eval has nobody to answer approval cards.
	const agent = await api('POST', '/agents', { name: 'Eval', modelConnectionId: connection.id, autonomy: 'bypass' });
	return { agent, model: `${provider}/${model}` };
}

export function summarize(results, model) {
	const passed = results.filter((item) => item.passed).length;
	const sum = (key) => results.reduce((total, item) => total + (item[key] || 0), 0);
	return {
		model,
		at: new Date().toISOString(),
		passRate: results.length ? passed / results.length : 0,
		passed,
		total: results.length,
		steps: sum('steps'),
		inputTokens: sum('inputTokens'),
		outputTokens: sum('outputTokens'),
		cost: Math.round(sum('cost') * 10000) / 10000,
		seconds: Math.round(sum('seconds')),
		results,
	};
}

export function markdown(summary, baseline) {
	const lines = [
		`## Saturn evals: ${summary.model}`,
		'',
		`${summary.passed}/${summary.total} passed (${Math.round(summary.passRate * 100)}%)${baseline ? `, baseline ${Math.round(baseline.passRate * 100)}%` : ''} · ${summary.steps} steps · ${summary.inputTokens + summary.outputTokens} tokens · $${summary.cost} · ${summary.seconds}s`,
		'',
		'| Task | Result | Steps | Tokens | Seconds |',
		'|---|---|---|---|---|',
		...summary.results.map((item) => `| ${item.task} | ${item.passed ? 'pass' : `fail (${item.status !== 'completed' ? item.status : !item.checks ? 'checks' : 'answer'})`} | ${item.steps} | ${item.inputTokens + item.outputTokens} | ${item.seconds} |`),
	];
	return `${lines.join('\n')}\n`;
}

async function main() {
	const flags = args(process.argv.slice(2));
	const all = (await readdir(path.join(here, 'tasks'))).sort();
	const names = typeof flags.tasks === 'string' ? flags.tasks.split(',') : all;
	const runtime = await startRuntime();
	try {
		const { agent, model } = await setUp(runtime.api);
		const results = [];
		for (const name of names) {
			process.stderr.write(`${name}… `);
			const result = await runTask(runtime.api, agent.id, name);
			process.stderr.write(`${result.passed ? 'pass' : 'FAIL'} (${result.steps} steps, ${result.seconds}s)\n`);
			results.push(result);
		}
		const summary = summarize(results, model);
		const baseline = typeof flags.baseline === 'string' ? JSON.parse(await readFile(flags.baseline, 'utf8').catch(() => 'null')) : null;
		await writeFile(typeof flags.out === 'string' ? flags.out : 'eval-results.json', `${JSON.stringify(summary, null, 2)}\n`);
		const report = markdown(summary, baseline);
		process.stdout.write(report);
		if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, report, { flag: 'a' });
		if (baseline && summary.passRate < baseline.passRate - ALLOWED_DROP) {
			process.stderr.write(`Pass rate ${Math.round(summary.passRate * 100)}% is more than ${ALLOWED_DROP * 100} points under the baseline's ${Math.round(baseline.passRate * 100)}%.\n`);
			process.exitCode = 1;
		}
	} finally {
		await runtime.stop();
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`eval: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(2);
	});
}
