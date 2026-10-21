# Contributing to Saturn

Thank you for helping. This file covers the parts of a change that keep Saturn's supply chain sound; the README's [Development](README.md#development) section covers building and testing.

## Before a pull request

```bash
npm test            # runtime tests
npm run typecheck   # runtime and desktop
npm run test:ide    # Saturn IDE extension checks
node scripts/check-lockfiles.mjs
```

- Domain code imports neither Express nor React.
- Never log or return a secret: log which credential was used, never its value.
- Commit lock files with the `package.json` change that produced them, made with npm 11.19 or later.

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

  Approve a script only when the package cannot work without it, and say why in the pull request. CI installs the runtime and the desktop app with `--ignore-scripts`, so an approval must also be reflected in the workflows. Saturn IDE follows Code-OSS's own `allowScripts` list.
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
4. Electron is not updated by Dependabot: it follows Saturn IDE's version (`Saturn-IDE/.npmrc`, `target`), which moves with upstream Code-OSS.
5. An advisory that cannot be fixed now (no patch yet, or the fix needs an upstream change) goes into [`docs/known-advisories.md`](docs/known-advisories.md) with the reason and what closes it, and its Dependabot alert is dismissed with a link to that file. Remove the entry in the change that ships the fix. The README links to that file, so it never needs editing for this.

## Saturn IDE and upstream Code-OSS

Read [`Saturn-IDE/UPSTREAM.md`](Saturn-IDE/UPSTREAM.md) before changing anything in `Saturn-IDE/` outside `extensions/saturn/`. In short: put features in the Saturn extension, never delete an upstream file (exclude it from the build instead), mark each upstream edit with a `Saturn` comment, and add it to the list in `UPSTREAM.md`.

New VS Code releases arrive as pull requests from the [upstream sync](.github/workflows/upstream-sync.yml). For a draft with conflicts: resolve each file in favour of upstream's change plus Saturn's listed edit, update `UPSTREAM.md`, build the IDE (`npm run build:ide --prefix desktop`), run the smoke test (`node Saturn-IDE/test/smoke/smoke.mjs "VSCode-darwin-arm64/Saturn IDE.app"`) and `npm run test:ide`.

## Releases

Push a `v<version>` tag (repository admins only) or run the Release workflow. Publishing waits for a maintainer's approval in the `release` environment. Each release carries checksums, build provenance attestations and an SBOM; see the README's [Security and trust](README.md#security-and-trust) section for how users verify them.

## Reporting a vulnerability

Email [security@saturn-core.com](mailto:security@saturn-core.com) rather than opening a public issue.
