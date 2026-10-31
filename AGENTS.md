# Instructions for agents

<!-- Saturn gives this file to every agent working in this project (Codex reads it by itself too; CLAUDE.md points
     Claude Code here). Keep it short: what is not obvious from the code. -->

Saturn is a desktop app that runs coding agents (API models, local models, Claude Code, Codex) on the user's own
projects. Three parts, each with its own `package.json` and lock file:

- `runtime/`: the local HTTP API (Express, `127.0.0.1:4700`, data in `~/.saturn-app`). `src/main.ts` starts it,
  `src/cli.ts` is the `saturn` command.
- `desktop/`: the Electron + React (Vite) app. It reaches the runtime only through
  `src/infrastructure/runtime-client.ts`.
- `Saturn-IDE/`: a fork of Code-OSS. Saturn's own features live in `Saturn-IDE/extensions/saturn/`.

Also `scripts/` (lock-file check, SBOM, `eval/` task evals) and `docs/` (threat model, known advisories).

## Commands
- Install: `npm install --prefix runtime` and `npm install --prefix desktop` (the root has no dependencies). Node 24
  (`Saturn-IDE/.nvmrc`), npm 11.19 or later.
- Test: `npm test` (runtime). One file: `cd runtime && npx tsx --import ./test/setup.ts --test test/llm.test.ts`.
  Saturn IDE: `npm run test:ide`. Eval harness, free: `node --test scripts/eval/self-test.mjs`.
- Type check / lint: `npm run typecheck`, `npm run lint` (oxlint, no warnings allowed), `node scripts/check-lockfiles.mjs`.
- Run: `npm run dev` (runtime), `npm run desktop` (app). Packaging: `npm run dist:mac`, `npm run dist:win`.

## Conventions
- Layering, in `runtime/src` and `desktop/src`: `domain` imports neither Express nor React, `presentation` is routes
  or UI, and infrastructure is reached through `application`.
- Write like the code around it: whole-word names, a short comment above each function or type saying what it is
  for, the same comment density and idiom.
- Every new feature comes with tests and every bug fix with a regression test (`runtime/test/`). Tests use a temporary
  data folder and fake model servers (`createServer` on `127.0.0.1:0`), never credentials or real data.
- Commit messages: `Area: what changed, in plain words` (`Runtime: …`, `LM Studio: …`, `Windows: …`), one change per
  commit, the lock file in the same commit as the `package.json` change that produced it.
- A change users would notice goes into `CHANGELOG.md` under the next version (Security, Fixed, Changed, Added),
  written for users. `README.md` and `README_ZH.md` change together.
- Dependencies: prefer none; npm registry only; install scripts stay denied unless `allowScripts` lists them.
  `npm audit --omit=dev --audit-level=high` must pass in `runtime/` and `desktop/`. An advisory that cannot be fixed
  yet goes into `docs/known-advisories.md`.
- After changing the Claude Agent SDK or Codex SDK version, run `node runtime/scripts/agent-programs-manifest.mjs`; a
  test fails until you do. Electron follows `Saturn-IDE/.npmrc` (`target`), not Dependabot.
- In `Saturn-IDE/` outside `extensions/saturn/`, read `Saturn-IDE/UPSTREAM.md` first: mark each upstream edit with a
  `Saturn` comment and list it there.

## Don't
- Don't log or return a secret: log which credential was used (provider or model), never its value.
- Don't test against the developer's own Saturn (port 4700, `~/.saturn-app`) or read its stored keys. Run an isolated
  runtime instead: `SATURN_DATA_DIR=$(mktemp -d) SATURN_RUNTIME_PORT=4791 npm start --prefix runtime`.
- Don't delete an upstream file in `Saturn-IDE/`: exclude it from the build.
- Don't edit build output: `VSCode-darwin-*/`, `desktop/dist/`, `desktop/.staging/`, `desktop/release/`.
- Don't push, tag or publish unless asked: a `v*` tag starts a release.
- Don't push to `main`: it only takes pull requests whose `check` job (the supply-chain workflow) passes.
