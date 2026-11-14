# Contributing to Saturn

Thank you for helping. This file covers the parts of a change that keep Saturn's supply chain sound; the README's [Development](README.md#development) section covers building and testing.

## Before a pull request

```bash
npm test            # cargo test, then the HTTP contract tests
npm run typecheck   # the desktop interface
npm run lint        # the coding standard (oxlint)
node scripts/check-lockfiles.mjs
node scripts/contract-routes.mjs --check   # the route list in contract/
cargo fmt --all --check && cargo clippy --all-targets && cargo deny check
```

- Domain code imports neither axum nor React.
- Never log or return a secret: log which credential was used, never its value.
- Commit lock files with the `package.json` or `Cargo.toml` change that produced them; `desktop/package-lock.json` made with npm 11.19 or later.

By taking part you agree to the [code of conduct](CODE_OF_CONDUCT.md). How decisions are made and who reviews what is in [`GOVERNANCE.md`](GOVERNANCE.md).

## Coding standard

Saturn's code follows one standard, enforced automatically:

- **Rust**: `cargo fmt` for formatting, and `cargo clippy --all-targets` with every lint in clippy's `all` group denied and `unsafe_code` forbidden ([`Cargo.toml`](Cargo.toml)), but for `crates/saturn-appcontainer`, which makes the Windows sandbox from Win32 calls and keeps them to one file, each with the reason it is sound. [`clippy.toml`](clippy.toml) refuses a request sent any way but `saturn_telemetry::network::SendNoted`, so that it is in the network log.
- **TypeScript strict mode** (`strict: true`) for the desktop interface; `npm run typecheck` must pass with no errors.
- **oxlint with [`.oxlintrc.json`](.oxlintrc.json)**: every rule in its correctness category is an error, including unused code and React's rules of hooks; `npm run lint` must pass with no warnings. CI runs it on every push and pull request ([supply-chain workflow](.github/workflows/supply-chain.yml)). React's effect-dependency and set-state-in-effect rules are not enforced yet, until the existing effects have been reviewed.
- **Write like the code around it**: the same naming, comment density and idiom; names in whole words; a short comment above a function or type that says what it is for.
- **Layering**: domain code imports neither axum nor React; infrastructure is reached through the application layer.

## Test policy

This policy is mandatory for every change to Saturn's own code (the runtime, the desktop app, the scripts; the [SDK](https://github.com/Saturn-Technology-Project/Saturn-SDK) follows it in its own repository):

1. **New functionality comes with tests.** A pull request that adds major functionality must add tests for it to the automated suite (`contract/`, a crate's tests, `scripts/eval/`), or say why it cannot be tested automatically; such a pull request is not merged until it does.
2. **Every bug fix comes with a regression test** that fails before the fix and passes after it, wherever the bug can be reproduced in a test.
3. **Tests use no credentials and touch no real data**: a temporary data folder and fake or scripted model servers, as the existing tests do. `contract/cases` were recorded from the old TypeScript runtime and are frozen: do not re-record them.
4. **The suite must pass** (`npm test`) before a change merges; CI runs it on every pull request and push to `main` and before every release. On Windows the workflows run `cargo test` without the contract tests; those are run by hand in a Windows virtual machine (set `SATURN_CONTRACT_PLATFORM=win32-x64` when Node there is not x64).

## Adding or updating a dependency

- **Prefer none.** Every package is code that runs with the user's keys and files. Use the platform or a few lines of our own when that is enough.
- **Crates from crates.io only.** [`deny.toml`](deny.toml) refuses git and other registries, and licenses outside its list. Read a new crate's build script: it runs when Saturn is compiled, and Cargo cannot deny it.
- **npm packages from the npm registry only.** Git, tarball-URL, http and file dependencies fail `scripts/check-lockfiles.mjs`. An exception needs an entry in that script's `EXCEPTIONS`, with the reason, and a maintainer's review.
- **npm install scripts are denied.** npm 11.19 and later block dependency install scripts that `allowScripts` in `package.json` does not list. After an install, review what was skipped:

  ```bash
  cd desktop
  npm install-scripts ls
  npm install-scripts deny <package>      # the default answer
  npm install-scripts approve <package>   # only after reading the script, pinned to that version
  ```

  Approve a script only when the package cannot work without it, and say why in the pull request. CI installs the desktop app with `--ignore-scripts`, so an approval must also be reflected in the workflows.
- **Check what ships.** `cargo deny check` must pass at the root. `npm audit --omit=dev --audit-level=high` must pass in `desktop/`, and `npm audit signatures` must report no invalid signatures.

## Moving Claude Code or Codex to a new version

Saturn downloads the Claude Code and Codex programs on demand, pinned to exact packages in `crates/saturn-core/src/agent-programs.json`. To move them, try the new versions against the protocol the contract tests record (`contract/programs.mjs`), then:

```bash
node scripts/agent-programs-manifest.mjs <claude-agent-sdk version> <codex version>   # rewrites agent-programs.json
cargo build -p saturn-server -p saturn-cli
node --test contract/programs.test.mjs contract/agent-programs-runs.test.mjs
```

Then download each program once from **Settings → General** on an isolated runtime (`SATURN_DATA_DIR`, `SATURN_RUNTIME_PORT`) and confirm it reports its version and sign-in status.

## Dependabot pull requests

Dependabot opens security updates at once and grouped version updates for npm packages, crates and GitHub Actions every Monday, for releases at least seven days old.

1. Read the changelog of anything that ships (crates, and the desktop app's production dependencies, not dev tools), and look for new install scripts (`npm install-scripts ls`) and new build scripts.
2. Let CI finish: the supply-chain workflow and the Windows build.
3. Tauri is pinned in `desktop/src-tauri/Cargo.toml` and Dependabot proposes its updates like any other; check that the desktop app still starts before merging one.
4. An advisory that cannot be fixed now (no patch yet, or the fix needs an upstream change) goes into [`docs/known-advisories.md`](docs/known-advisories.md) with the reason and what closes it, and its Dependabot alert is dismissed with a link to that file. Remove the entry in the change that ships the fix. The README links to that file, so it never needs editing for this.
5. Advisories in code Saturn does not ship (development dependencies of the desktop app) are waived for OSV and OpenSSF Scorecard in `osv-scanner.toml` files, each with its reason and an expiry. They are generated: after a dependency change run `node scripts/osv-waivers.mjs` and commit what it writes (`--check` reports when they are out of date). It never waives a production dependency of the desktop app, nor a crate.

## Releases

Every push to `main` is checked and packaged by the Release workflow. To release, set the version with one command, give the CHANGELOG's Unreleased section that version's heading, and merge to `main`:

```bash
node scripts/set-version.mjs 0.4.2   # Cargo.toml, desktop/package.json and both lock files
```

The workflow then tags the commit `v<version>` and publishes it. A version older than the newest release fails the workflow; an unchanged one only packages. Pushing a matching `v<version>` tag or running the workflow by hand does the same. A release tag cannot be moved or deleted once it exists. Publishing waits for a maintainer's approval in the `release` environment, if the repository's settings ask for one. Each release carries checksums, build provenance attestations and an SBOM; see the README's [Security and trust](README.md#security-and-trust) section for how users verify them. Installed Saturns update only from a release built with the updater key (the `TAURI_SIGNING_PRIVATE_KEY` secret and the `SATURN_UPDATER_PUBKEY` variable); without them the build has no updater.

## Reporting a vulnerability

Email [security@saturn-core.com](mailto:security@saturn-core.com) rather than opening a public issue.
