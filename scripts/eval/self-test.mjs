// The eval harness itself, without spending tokens: a scripted OpenAI-compatible model solves two tasks (one by
// editing a file, one by answering), and one it leaves unsolved, through a real runtime started by the harness.
// Run: node --test scripts/eval/self-test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { markdown, runTask, setUp, startRuntime, summarize } from './run.mjs';

const FIXED = '/** The page numbers for `total` items, `size` per page: [1, 2, …]. */\nexport function pages(total, size) {\n  const count = Math.ceil(total / size);\n  return Array.from({ length: count }, (_, index) => index + 1);\n}\n';

function scriptedModel() {
	const server = createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			const messages = JSON.parse(raw || '{}').messages ?? [];
			const ask = messages.filter((item) => item.role === 'user').map((item) => item.content).join('\n');
			const acted = messages.some((item) => item.role === 'assistant' && String(item.content).includes('"toolId"'));
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
