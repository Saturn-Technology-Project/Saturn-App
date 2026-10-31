# Changelog

The major changes in each Saturn release, for deciding whether to upgrade and what changes when you do. Every release is on [GitHub Releases](https://github.com/Saturn-Technology-Project/Saturn-App/releases) with its downloads, checksums and build provenance; versions below 1.0.0 are previews. Security fixes are also published as [GitHub security advisories](https://github.com/Saturn-Technology-Project/Saturn-App/security/advisories).

## Unreleased

### Security

- **Electron 43.8.3 in the app and Saturn IDE** (from 43.7.7), which stops trusting the compromised eMudhra intermediate certificates (GHSA-jr5w-w6x2-84p9). Saturn IDE is now based on VS Code 1.144.0.
- **Saturn IDE's Markdown preview and Mermaid diagrams use DOMPurify 3.4.17**, which closes sanitizer bypasses (one critical) that a crafted Markdown file could use to run script in the preview. The IDE's HTTP client (undici 7.30.1) and validation library (zod 4.6.7) are also patched.
- **Saturn IDE's Emmet uses image-size 2.0.3**, so *Update Image Size* on a crafted ICNS image can no longer hang it (GHSA-w3rx-r6r6-pgpr). The IDE also takes follow-redirects 1.16.2, which no longer forwards custom credential headers across origins on a redirect (GHSA-mrwp-f3q8-3g9p), and gives its tunnel client uuid 11.1.1 (GHSA-w5hq-g745-h8pq).

### Added

- **Other agents can operate Saturn.** Every button, chat, agent and dialog now has a role and a name in the accessibility tree, and the sidebar works from the keyboard, so a computer-use agent such as agent-desktop or Claude computer use can find and click them by name. See [Driving Saturn with another agent](README.md#driving-saturn-with-another-agent).

## 0.3.1 (2026-10-22)

### Security

- **A project's settings files can no longer pre-approve tool calls.** The allow rules in a project's `.saturn/settings.json` and `.claude/settings.json`, which come with the folder (a cloned repository, say), applied without being shown to you, and a rule allowing every shell command was not refused. A repository could therefore let an agent run commands without an approval card. Now their deny and ask rules apply at once, their allow rules only after you allow that exact set in **Settings → Permissions** (any change asks again), and a rule that allows every command is never applied. Affects v0.3.0 and earlier: upgrade, and check the project rules of any repository you opened.

### Fixed

- **Saturn no longer quits seconds after launch while indexing a project.** The built-in embedding model asked for one 2 GiB block of memory on large files, which Electron answers by ending the process. It now works in smaller batches and uses a fraction of the memory.
- An approval card for a Claude Code or Codex agent could refuse an answer given the moment it appeared ("This approval is no longer waiting"). The card is now shown only once Saturn is listening for the answer.

### Changed

- The TypeScript SDK (`@saturn-app/sdk`) moved to its own repository, [Saturn-SDK](https://github.com/Saturn-Technology-Project/Saturn-SDK), laid out for more languages.

### Added

- `SECURITY.md` (how to report a vulnerability, privately by email or through GitHub) and a [threat model](docs/threat-model.md) with the scope for an external security review.
- OpenSSF Scorecard, CodeQL code scanning and secret scanning on the repository.

## 0.3.0 (2026-10-21)

### Agents

- **Permission rules**: allow, ask or deny a tool by pattern, from Settings, a project, an agent, or **Always allow** on an approval card.
- **An OS sandbox** around shell commands on macOS (seatbelt): writes only inside the workspace, temp folders and package caches; leaving it asks. Windows has no sandbox yet.
- **Context compaction**: a long chat's oldest turns fold into a running summary; `/compact` on demand.
- **Sub-agents** (`delegate`), **background commands** (dev servers, watchers), **hooks**, **skills**, **slash commands** and **plugins**.
- **Pull request follow-up**: failing checks go back to the agent and its fix is pushed; review comments wait for you.
- **Tool calls in each provider's native format**, and heavy toolkits (GitHub, computer use, browser, automations) loaded only when needed: about 85% fewer input tokens per step.
- **Agent browser** shown live in the chat's Browser tab with the agent's cursor, or in a visible Chrome or Safari window.

### Review and recovery

- Every file change is reviewable and revertible, including what shell commands change (foreground or background, git projects or not). Settings → General → Storage shows and deletes the private snapshots of folders outside git.

### From code

- The `saturn` command line and the `@saturn-app/sdk` TypeScript SDK; live updates over server-sent events.

### Fixes

- The Browser tab loads pages again; very large accessibility trees come back partial instead of timing out; Settings asks macOS for Accessibility and Screen Recording itself; cached prompt tokens are billed at cache rates.

## 0.2.0 (2026-10-20)

### Windows and releases

- **Saturn on Windows**: the app, Saturn IDE (launch, packaging, smoke test) and computer use, built and tested on Windows by CI.
- **Release workflow** that builds macOS and Windows on GitHub Actions, with build attestations; a smaller app (no agent CLIs inside the IDE, a lean runtime, an LZMA disk image).

### Agent app

- **First-launch setup**: model, agent, project, permissions, first message.
- Paste images; Agent, Ask or Plan per message; restore a chat to a step.
- Editable plans, summary cards, comments on diffs, recordings that play back.
- An Agents board, an inbox, system notifications and background tasks; `@` attachments; auto-verify after changes.
- Open a pull request from a chat's branch, resolve merge conflicts, worktree-isolated chats.

### Agents

- Agents see images, editor diagnostics and project rules; a built-in, on-device code index.
- Claude Code and Codex agents get Saturn's skills, memory and knowledge, and Claude Code honors its own approval setting.
- Browser tools; computer use with real input, screenshots and accessibility on macOS.
- Model calls that fail transiently are retried.

### Saturn IDE

- Tab completion that streams and sees the code it calls; Next Edit follows renames across files.
- Chat with images, `@problems` and `@terminal`, slash commands and modes; commit messages generated from Source Control.
- Traditional Chinese, a Get Started walkthrough, Saturn's own links, no Copilot.

### Trust

- A network log and Network tab of every outbound request, and a README that says exactly what leaves your machine.
- Two holes found in a codebase sweep closed, and tools that only pretended removed.

## 0.1.0 (2026-10-20)

The first preview: the agent app, its local runtime and Saturn IDE in one download (macOS, Apple Silicon).

- Agents, projects and group chats where agents hand work to each other with `@mentions`.
- Claude, OpenAI, Gemini and DeepSeek with your API keys; Claude Code on your Claude plan; Codex on your ChatGPT plan; offline models in LM Studio.
- Approvals per agent or group, and every edit checkpointed, reviewable as a diff and revertible.
- Files, shell, web, plans, computer use, cron automations, and MCP servers from a built-in marketplace.
- Usage and cost by model and agent; telemetry that stays on your machine unless you export it.
- Saturn IDE, a Code-OSS editor wired to the same agents: Tab completion, next-edit, inline edits and an agent panel.
- The runtime listens only on `127.0.0.1` behind a session token.
