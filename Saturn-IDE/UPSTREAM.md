# Saturn IDE and upstream Code-OSS

Saturn IDE is [microsoft/vscode](https://github.com/microsoft/vscode) (Code-OSS) with a small, listed set of changes.
Everything else is upstream's, byte for byte, so each VS Code release can be merged in with few or no conflicts.

## Base

| | |
|---|---|
| Upstream commit | [`cd759971726f26f5796ffa83f12a772aeac2d69e`](https://github.com/microsoft/vscode/commit/cd759971726f26f5796ffa83f12a772aeac2d69e) |
| Version | 1.143.0 |
| In this repository | `f6e8069f` ("Saturn IDE base"): the upstream tree as its own root commit, merged under `Saturn-IDE/` by `e2f86b13` |

The sync workflow updates this table when it merges a new release.

## Rules for changes

1. **Saturn's features live in [`extensions/saturn/`](extensions/saturn)**, an ordinary built-in extension. Prefer it, then `product.json`, then configuration defaults, and only then an edit to upstream source.
2. **Never delete upstream files.** A deleted file turns every later upstream change to it into a modify/delete conflict. Leave the file and exclude it from the build or the install instead (GitHub Copilot is the example: its source is here, `build/npm/dirs.ts` keeps it out of `npm install`, and upstream's `excludedExtensions` keeps it out of the package).
3. **Keep each upstream edit small and marked** with a `Saturn` comment that says why, so a conflict is quick to resolve.
4. **Every upstream edit is listed below.** A change that is not listed is a bug in this file.

## What Saturn changes

Compared with the base, outside `extensions/saturn/`: 49 files, all edits or additions, none deleted.

**Build and packaging**
- `build/gulpfile.vscode.ts`: leaves GitHub Copilot and the agent host's Claude, Codex and Copilot CLI binaries out of the package (Saturn's runtime has its own); Saturn product metadata.
- `build/gulpfile.reh.ts`: Windows signature verification tolerates a machine without the Windows SDK.
- `build/lib/git.ts`: finds the commit when Saturn IDE is a folder of a larger repository or a worktree.
- `build/npm/dirs.ts`: `extensions/copilot` is not installed (saves 1.4 GB per `npm ci`).
- `build/saturn/undo-telemetry.mjs` (new): replaces Microsoft telemetry hostnames (`*.data.microsoft.com`) in the source before a build, as VSCodium does.
- `package.json`, `package-lock.json`: no Copilot compile and watch scripts; the agent host's Anthropic packages, which only served the Claude harness Saturn IDE turns off, are removed.

**Product and branding**
- `product.json`: Saturn's name, icons and links; Open VSX as the extension gallery; no update URL, since the Saturn app updates Saturn IDE.
- `resources/darwin/code.icns`, `resources/linux/code.png`, `resources/win32/code.ico`, `code_70x70.png`, `code_150x150.png`: Saturn's icon.

**Telemetry stays on the machine**
- `src/vs/platform/telemetry/node/saturnAppender.ts` (new), `src/vs/platform/telemetry/common/telemetryService.ts`, `src/vs/code/electron-utility/sharedProcess/sharedProcessMain.ts`: telemetry goes to the Saturn runtime on `127.0.0.1` instead of Microsoft.
- `src/vs/workbench/services/assignment/common/assignmentService.ts`, `src/vs/workbench/contrib/editTelemetry/browser/editTelemetry.contribution.ts`: experiments and edit telemetry default to off.
- `src/vs/workbench/contrib/editSessions/browser/editSessionsStorageService.ts`: no sign-in prompt for Microsoft's edit-session sync.

**Code-OSS's AI features off, Saturn's on**
- `src/vs/platform/agentHost/node/agentHostMain.ts`, `agentHostServerMain.ts`, `claude/claudeAgent.ts`, `claude/claudeSdkOptions.ts`, `common/claudeSessionConfigKeys.ts`: the agent host registers no Copilot agent and does not look for bundled CLIs.
- `src/vs/workbench/contrib/chat/browser/chatParticipant.contribution.ts`, `chat.shared.contribution.ts`, `agentSessions/agentSessions.ts`, `src/vs/sessions/contrib/sessions/browser/views/sessionsListFilters.ts`: Copilot's chat panel is not the default side panel; harness labels.

**Interface**
- `src/vs/workbench/contrib/saturn/browser/saturn.contribution.ts` and `media/saturn.css` (new), imported from `src/vs/workbench/workbench.common.main.ts`: Saturn's theme and layout.
- `src/vs/workbench/browser/parts/titlebar/commandCenterControl.ts`, `titlebarPart.ts`, `src/vs/workbench/browser/media/floatingPanels.css`, `src/vs/workbench/contrib/scm/browser/media/scm.css`: title bar and Source Control layout.
- `src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStartedService.ts`: the built-in walkthroughs say the product's name (Saturn IDE) where upstream says "VS Code" ("Get started with Saturn IDE"), replaced as they are registered so `gettingStartedContent.ts` stays upstream's.
- `src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.contribution.ts`, `terminalContrib/inlineHint/browser/terminal.initialHint.contribution.ts`, `preferences/common/preferencesContribution.ts`, `src/vs/workbench/browser/workbench.contribution.ts`, `src/vs/workbench/electron-browser/desktop.contribution.ts`, `remoteTunnel/electron-browser/remoteTunnel.contribution.ts`: quieter defaults (no walkthrough or Welcome page on start, no Copilot prompts in the terminal hint, no remote-tunnel prompt without its extension).
- `extensions/github-authentication/src/config.ts`: Saturn IDE's own GitHub OAuth app, so GitHub's consent page names Saturn.

**Security fixes ahead of upstream** (drop them when upstream ships the same versions)
- `package-lock.json`, `remote/package-lock.json`: shell-quote 1.12.0 (GHSA-pqg4-j6r4-53mv).
- `extensions/markdown-language-features/package-lock.json`, `extensions/extension-editing/package-lock.json`: markdown-it 14.3.3 (GHSA-gfr2-rv44-r23c).

**Tests**
- `test/smoke/smoke.mjs`, `diff.test.mjs`, `webview.test.mjs` (new): Saturn's smoke test and panel checks.

Regenerate the list with:

```bash
git diff --stat f6e8069f HEAD:Saturn-IDE -- . ':!extensions/saturn'
```

(After a sync, replace `f6e8069f` with the merged upstream commit.)

## Syncing with upstream

[`.github/workflows/upstream-sync.yml`](../.github/workflows/upstream-sync.yml) runs weekly and on demand. It finds the newest stable VS Code release after the base above, merges that tag into `Saturn-IDE/` on a branch, builds the IDE, runs `npm run test:ide` and the smoke test, and opens a pull request that lists any conflicts.

Cadence:
- **Each monthly VS Code release** is merged within two weeks of its release.
- **Upstream security fixes** (a VS Code recovery release, or an advisory against Code-OSS or Electron) are merged within a week.
- Electron and Node follow upstream's choice; the Saturn desktop app moves to the same Electron.

By hand:

```bash
git remote add vscode https://github.com/microsoft/vscode.git   # once
git fetch vscode tag 1.144.0 --no-tags
git merge -X subtree=Saturn-IDE/ 1.144.0
```

Resolve conflicts with the rules above, update the Base table and the list, then build and run the smoke test.
