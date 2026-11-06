# Instructions for agents

<!-- Saturn gives this file to every agent working in this project (Codex reads it by itself too; CLAUDE.md points
     Claude Code here). Keep it short: what is not obvious from the code. -->

Saturn is a desktop workbench for AI research: questions, frozen experiments, runs, samples and findings kept as files in a
project's `.saturn/research`, with a research assistant (on API models, local models, Claude Code or Codex) that works on
them through `research_*` tools in the chat's mode. Three parts:

- `crates/`: the Rust runtime, one workspace with `Cargo.lock` at the root. `saturn-server` is the local HTTP API
  (axum, `127.0.0.1:4700`, data in `~/.saturn-app`), `saturn-cli` the `saturn` command, `saturn-core` the research
  records and runs (`src/research/`, with the assistant's tools and bundled skills) and the agent loop.
- `desktop/`: the React (Vite) interface in a Tauri 2 shell (`desktop/src-tauri`), shown in the system web view, not
  Chromium. It has its own `package.json` and lock file, and reaches the runtime only through
  `src/infrastructure/runtime-client.ts`.
- `contract/`: what the runtime must do over HTTP, tested against the real programs. `contract/routes.json` lists every
  route. `contract/cases` were recorded from the old TypeScript runtime (git tag `archive/ts-runtime`) and are frozen.

Also `scripts/` (lock-file check, SBOM, `eval/` task evals) and `docs/` (threat model, known advisories, the research
contract, workflow and skills).

## Commands
- Install: `npm install --prefix desktop` (the root has no dependencies). Rust as pinned in `rust-toolchain.toml`, Node
  as pinned in `.nvmrc`, npm 11.19 or later.
- Test: `npm test` (`cargo test`, then the contract). One crate: `cargo test -p saturn-tools`. One contract file:
  `cargo build -p saturn-server -p saturn-cli && node --test contract/http.test.mjs`.
  Eval harness, free: `cargo build -p saturn-server && node --test scripts/eval/self-test.mjs`.
- Type check / lint: `npm run typecheck`, `npm run lint` (oxlint, no warnings allowed), `node scripts/check-lockfiles.mjs`.
  Rust: `cargo fmt --all --check`, `cargo clippy --all-targets`, `cargo deny check`. Plain cargo commands leave the
  desktop shell out; use `-p saturn-desktop`.
- Run: `npm run dev` (runtime), `npm run desktop` (app, `tauri dev`). Packaging, in `desktop/`: `npm run package`, then
  `npm run archive`.

## Conventions
- Layering: `saturn-domain` and `desktop/src/domain` import neither axum nor React, `saturn-server` and
  `desktop/src/presentation` are routes or UI, and infrastructure is reached through `saturn-core` or
  `desktop/src/application`.
- Write like the code around it: whole-word names, a short comment above each function or type saying what it is
  for, the same comment density and idiom.
- Every new feature comes with tests and every bug fix with a regression test, in `contract/` or a crate's tests. Tests
  use a temporary data folder and fake model servers (`createServer` on `127.0.0.1:0`), never credentials or real data.
- Every HTTP request the runtime sends goes through `saturn_telemetry::network::SendNoted`, so it is in the network log;
  `clippy.toml` refuses a plain `send`.
- Commit messages: `Area: what changed, in plain words` (`Runtime: …`, `LM Studio: …`, `Windows: …`), one change per
  commit, the lock file in the same commit as the `package.json` or `Cargo.toml` change that produced it.
- A change users would notice goes into `CHANGELOG.md` under the next version (Security, Fixed, Changed, Added),
  written for users. `README.md` and `README_ZH.md` change together.
- Dependencies: prefer none; crates.io only (`deny.toml`), npm registry only; npm install scripts stay denied unless
  `allowScripts` lists them. `npm audit --omit=dev --audit-level=high` must pass in `desktop/`, and `cargo deny check`
  at the root. An advisory that cannot be fixed yet goes into `docs/known-advisories.md`.
- To move Claude Code or Codex to a new version, run
  `node scripts/agent-programs-manifest.mjs <claude-agent-sdk version> <codex version>`, after trying them against the
  protocol `contract/programs.mjs` records.
- A new or changed route in `crates/saturn-server/src/`: run `node scripts/contract-routes.mjs` and commit the list.
- Windows has only been type-checked since the rewrite, not run. Do not claim otherwise, in docs or in reports.

## Don't
- Don't log or return a secret: log which credential was used (provider or model), never its value.
- Don't test against the developer's own Saturn (port 4700, `~/.saturn-app`) or read its stored keys. Run an isolated
  runtime instead: `SATURN_DATA_DIR=$(mktemp -d) SATURN_RUNTIME_PORT=4791 SATURN_SECRET_STORE=file npm start`.
- Don't edit build output: `target/`, `desktop/dist/`, `desktop/.staging/`, `desktop/release/`,
  `desktop/src-tauri/binaries/`, `desktop/src-tauri/gen/`.
- Don't push, tag or publish unless asked: a `v*` tag starts a release.
- Don't push to `main`: it only takes pull requests whose `check` job (the supply-chain workflow) passes.
