# Contributing to Saturn

Thank you for helping. This file covers the parts of a change that keep Saturn's supply chain sound; the README's [Development](README.md#development) section covers building and testing.

## Before a pull request

```bash
npm test            # runtime tests
npm run typecheck   # runtime and desktop
npm run lint        # the coding standard (oxlint)
node scripts/check-lockfiles.mjs
node scripts/contract-routes.mjs --check   # the route list in contract/
cargo fmt --all --check && cargo clippy --all-targets && cargo test && cargo deny check   # the Rust rewrite
cargo build -p saturn-server
SATURN_TEST_RUNTIME=ts node --test contract/*.test.mjs     # the HTTP contract, on both runtimes
SATURN_TEST_RUNTIME=rust node --test contract/*.test.mjs
```

- Domain code imports neither Express nor React.
- Never log or return a secret: log which credential was used, never its value.
- Commit lock files with the `package.json` change that produced them, made with npm 11.19 or later.

By taking part you agree to the [code of conduct](CODE_OF_CONDUCT.md). How decisions are made and who reviews what is in [`GOVERNANCE.md`](GOVERNANCE.md).

## Coding standard

Saturn's TypeScript follows one standard, enforced automatically:

- **TypeScript strict mode** (`strict: true`) for the runtime and the desktop app; `npm run typecheck` must pass with no errors.
- **oxlint with [`.oxlintrc.json`](.oxlintrc.json)**: every rule in its correctness category is an error, including unused code and, in the desktop app, React's rules of hooks; `npm run lint` must pass with no warnings. CI runs it on every push and pull request ([supply-chain workflow](.github/workflows/supply-chain.yml)). React's effect-dependency and set-state-in-effect rules are not enforced yet, until the existing effects have been reviewed.
- **Write like the code around it**: the same naming, comment density and idiom; names in whole words; a short comment above a function or type that says what it is for.
- **Layering**: domain code imports neither Express nor React; infrastructure is reached through the application layer.

## Test policy

This policy is mandatory for every change to Saturn's own code (the runtime, the desktop app, the scripts; the [SDK](https://github.com/Saturn-Technology-Project/Saturn-SDK) follows it in its own repository):

1. **New functionality comes with tests.** A pull request that adds major functionality must add tests for it to the automated suite (`runtime/test/`, `scripts/eval/`), or say why it cannot be tested automatically; such a pull request is not merged until it does.
2. **Every bug fix comes with a regression test** that fails before the fix and passes after it, wherever the bug can be reproduced in a test.
3. **Tests use no credentials and touch no real data**: a temporary data folder and fake or scripted model servers, as the existing tests do.
4. **The suite must pass** (`npm test`) before a change merges; CI runs it on every push to `main` and before every release.

## Adding or updating a dependency

- **Prefer none.** Every package is code that runs with the user's keys and files. Use the platform or a few lines of our own when that is enough.
- **From the npm registry only.** Git, tarball-URL, http and file dependencies fail `scripts/check-lockfiles.mjs`. An exception needs an entry in that script's `EXCEPTIONS`, with the reason, and a maintainer's review.
- **Install scripts are denied.** npm 11.19 and later block dependency install scripts that `allowScripts` in `package.json` does not list. After an install, review what was skipped:

  ```bash
  cd runtime            # or desktop
  npm install-scripts ls
  npm install-scripts deny <package>      # the default answer
  npm install-scripts approve <package>   # only after reading the script, pinned to that version
  ```

  Approve a script only when the package cannot work without it, and say why in the pull request. CI installs the runtime and the desktop app with `--ignore-scripts`, so an approval must also be reflected in the workflows.
- **Check what ships.** `npm audit --omit=dev --audit-level=high` must pass in `runtime/` and `desktop/`, and `npm audit signatures` must report no invalid signatures.

## Updating the Claude Agent SDK or the Codex SDK

Saturn downloads the Claude Code and Codex programs on demand, pinned to the exact packages the SDKs were built against. After changing either SDK version in `runtime/package.json`:

```bash
npm install --prefix runtime
node runtime/scripts/agent-programs-manifest.mjs   # rewrites runtime/src/infrastructure/agent-programs-manifest.ts
npm test --prefix runtime                          # includes the check that the manifest matches the lock file
```

Then download each program once from **Settings → General** on an isolated runtime (`SATURN_DATA_DIR`, `SATURN_RUNTIME_PORT`) and confirm it reports its version and sign-in status.

## Dependabot pull requests

Dependabot opens security updates at once and grouped version updates every Monday, for releases at least seven days old.

1. Read the changelog of anything that ships (runtime and desktop dependencies, not dev tools), and look for new install scripts (`npm install-scripts ls`).
2. Let CI finish: the supply-chain workflow, the runtime tests and the Windows build.
3. An SDK bump fails the manifest test until you regenerate it as above.
4. Electron is chosen in `desktop/package.json` and Dependabot proposes its updates like any other; check that the desktop app still starts and its tests pass before merging one.
5. An advisory that cannot be fixed now (no patch yet, or the fix needs an upstream change) goes into [`docs/known-advisories.md`](docs/known-advisories.md) with the reason and what closes it, and its Dependabot alert is dismissed with a link to that file. Remove the entry in the change that ships the fix. The README links to that file, so it never needs editing for this.
6. Advisories in code Saturn does not ship (development dependencies of the runtime and the desktop app) are waived for OSV and OpenSSF Scorecard in `osv-scanner.toml` files, each with its reason and an expiry. They are generated: after a dependency change run `node scripts/osv-waivers.mjs` and commit what it writes (`--check` reports when they are out of date). It never waives a production dependency of the runtime or the desktop app, nor Electron.

## Releases

Push a `v<version>` tag (repository admins only) or run the Release workflow. Publishing waits for a maintainer's approval in the `release` environment. Each release carries checksums, build provenance attestations and an SBOM; see the README's [Security and trust](README.md#security-and-trust) section for how users verify them.

## Reporting a vulnerability

Email [security@saturn-core.com](mailto:security@saturn-core.com) rather than opening a public issue.
