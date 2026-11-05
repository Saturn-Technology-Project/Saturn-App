# Changelog

The major changes in each Saturn release, for deciding whether to upgrade and what changes when you do. Every release is on [GitHub Releases](https://github.com/Saturn-Technology-Project/Saturn-App/releases) with its downloads, checksums and build provenance; versions below 1.0.0 are previews. Security fixes are also published as [GitHub security advisories](https://github.com/Saturn-Technology-Project/Saturn-App/security/advisories).

## Unreleased

### Fixed

- **The app keeps its runtime running.** It restarts a runtime that dies, shows where the runtime stands until it answers instead of a blank error, and no longer uses another Saturn that happens to be on its port, which could overwrite the same data folder. Settings and the command palette offer a restart.

### Changed

- **Saturn's interface is rebuilt for research.** Instead of agents and chats, it is organized around your questions, code, experiments, models, samples and findings. A research assistant sits beside your work and does what the open file's mode allows, and long work goes to Tasks, each in its own worktree.
- **The first launch is a tour, not a setup form.** It boxes each part of the live interface in turn and says what it is for, then helps you choose a project folder, connect a model and write your first question. Commands (⌘K) has "Take the tour" for later.
- **Groups, Automations, the Agents board, pull request follow-up and the marketplace no longer have screens.** Their data stays, and the runtime still offers them. Earlier chats are kept in your data folder and are not shown. Schedules and follow-up you already set going keep running until you turn them off in **Settings → Still running**.

### Added

- **A research workbench.** Under Research, open a project's file, write it yourself, run an experiment and read its samples next to the code, then write down what you understood. Everything is kept as plain files in the project's `.saturn/research` folder, and reopening picks up where you stopped. A run records exactly what it computed, including uncommitted code, and a crash leaves its samples readable. Experiment runs work on macOS and Linux; on Windows they say they are not supported yet.
- **A model's lineage and fair comparisons.** Connect checkpoints to their fine-tuned branches, and compare one sample across runs. Two runs that measured differently say which setting differs instead of showing a misleading comparison.
- **Your labels and counterexamples.** Label a sample without touching its score, see how far you agree with the scorer, and keep the samples that matter.
- **Where a score comes from, and what was concluded.** An experiment is linked to its question and hypothesis, says apart whether it executed and whether the hypothesis holds, splits its score into what the scorer judged, what you disputed and what was excluded as an error, and keeps your conclusion with the run it rests on. Export writes the whole record as one file into the project.
- **A sample from every side.** The Samples screen lists a run's samples with their review state, shows each one across the models that saw it with the scorer's own word next to your label, says which conditions were held the same, and keeps the sample as a counterexample. Looking inside reads a model's activations on the sample at every layer, or patches the residual stream after one layer in from another model, with the Python the experiment's command names, and keeps the answer with the run.
- **Home picks up where you stopped.** When the project was last active, what the workspace restores, what changed since this device last looked, and what is still open: undecided hypotheses, runs that failed or were interrupted, refusals to decide on.
- **Tasks say what they may touch.** Each task is grouped by whether it needs a decision, is running or is ready for review, shows what it can change, what is locked and where it is sandboxed, and when it was refused a locked file you can release the file for the next version, keep it, or edit it yourself.
- **The workspace sidebar lists the project's questions, models, notes, code with each file's mode, and experiments.**
- **What a run costs.** While an experiment runs, the Resources tab shows how long it has been going, its processor share and memory, its GPUs where `nvidia-smi` can say, and how fast its samples come, sampled every two seconds from the run's own processes and kept with the run. A program that writes `usage` on its sample lines (input and output tokens, the device memory it holds) gets those added up too: tokens per second while it runs, totals and peak memory per model in the summary.
- **The project's environment.** The Environment screen names the Python the experiments run with, asks it for its version, the packages research code leans on and the devices torch can see, and lists the lock files at the project's root with their hashes, each of which can be frozen with the experiment's versions so a changed environment is a new version.
- **How much AI each file gets.** Set a file or folder to Manual, Pair or Delegate. An agent's file tools cannot write a Manual or locked file, and a Pair file always asks you. Modes are a workflow constraint rather than a security boundary: a shell or Codex can still write a file, which Saturn notices afterwards and records under Protection.

### Security

- **An agent's GitHub tools could read any git repository on this computer.** A repository owner or name such as `../..` was used as a folder path, so a prompt-injected agent could read a repository outside its project. Owners and names must now be plain names. A remote on a host that merely ends in `github.com` also no longer counts as GitHub.
- **The code index could send a linked or hidden file to the embedding model.** When the index was asked to refresh named files, a link to a file outside the project, a hidden file such as `.env`, or a file in a folder next to the project with a similar name was indexed. With an OpenAI-compatible embedding connection, that text left the computer. Named files now follow the same rules as a whole pass.
- **The agent browser's screenshot tool could write outside the workspace.** A file path such as `../../secrets.json` or an absolute path was accepted, and the tool counts as a read, so it did not ask first. A screenshot now stays in the workspace, also through links, and a recording's name stays one folder under `recordings`.
- **Computer use only starts apps.** Finding an app by path or name handed it to the system's opener, so a script, a document or a web address given as an "app" would run outside the sandbox.
- **An agent's customization tools stay in the project.** A rule named `../../somewhere` was written outside it, and a link in a cloned repository could lead a new rule, skill or plugin out of it, or bring a file from elsewhere into a migrated workflow or a bundled plugin.
- **The web tool, the agent browser and the Browser tab could reach this computer and the private network through an IPv6 spelling of a private address** (such as `[::ffff:127.0.0.1]`). These addresses are now refused, along with carrier-grade NAT (which Tailscale uses), multicast and other reserved ranges. The web tool and the Browser tab now check an address at the moment of connecting, so a name cannot pass the check and then resolve somewhere private, and `browser_navigate` refuses names that resolve to private addresses.
- **Opening a terminal on Windows no longer puts the folder's path on a command line**, where a folder name containing `&` could run a command.
- **The file view no longer follows a symbolic link out of the workspace**, which a cloned repository could use to show a file from elsewhere on the computer.
- **An agent's `files` tool no longer follows a symbolic link out of the workspace.** A cloned repository could bring a link that let the agent read or change files elsewhere on the computer, and writing through a link also got around the command sandbox. Links that stay inside the workspace still work.
- **Reverting an agent's changes no longer writes through a symbolic link.** A command the agent ran could put a link in place of a file it had changed, so that reverting wrote the original contents to wherever the link led. The revert now stops and says so.
- **Attaching a file or folder with `@` no longer follows a symbolic link out of the project**, which a cloned repository could use to put a file from elsewhere on the computer into a message.
- **A project's rule files, skills and commands, and a plugin's files, can no longer be links to files elsewhere on the computer.** A cloned repository could make `AGENTS.md` a link to, say, a credentials file, and its contents went into every prompt sent to the model's provider. Such links are now ignored; links that stay inside the project still work.

### Fixed

- Signing Codex out when Codex is not installed now says to download it, instead of reporting a failed sign-out.
- Cancelling a code index build no longer reports it as failed.
- **Computer use can act on the elements it reads.** Each tool call forgot the last one, so an element id from `computer_app_state` was always called stale in `computer_set_value`, `computer_app_action` and `computer_type`.
- **Migrating workflows says when it fails**, instead of reporting success with fewer migrated.
- **`saturn` keeps a flag's whole value.** In `--agent=A=B`, everything after the second `=` was dropped.
- **The agent browser now submits forms.** Pressing Enter, and typing with `submit`, did nothing to a form in Chrome. A key chord such as `ctrl+b` no longer also types its letter, and typing with `clear: false` adds to a field's text instead of replacing it.
- **Safari recordings play in the app.** They were listed with no frames, since only Chrome's JPEG frames were counted.
- **Quitting Saturn closes the agent browser**, which used to keep running in the background.
- **Memory learned only from the start of a long chat.** Every six turns Saturn looks for things worth remembering; it read a chat's oldest six turns every time, and now reads the latest six.
- **Settings are no longer forgotten when Saturn restarts.** Your permission rules, sandbox, hooks, plugins, browser, embedding source, memory and plan-approval choices were saved but dropped at the next start, and the next save erased them from disk. The first-launch onboarding also came back. This also turned off the deny rules and the stricter sandbox you had set, and turned memory back on, until you set them again. Check **Settings → Permissions** and your sandbox after upgrading: what was lost before this fix cannot be recovered.
- **A `secrets.json` that Saturn cannot read as encrypted is kept aside** instead of being taken for an old plaintext file and overwritten.
- **Patches that close a hunk with `*** End of File` now apply**, instead of failing with an unknown patch line.

### Added

- **Other agents can operate Saturn.** Every button, chat, agent and dialog now has a role and a name in the accessibility tree, and the sidebar works from the keyboard, so a computer-use agent such as agent-desktop or Claude computer use can find and click them by name. See [Driving Saturn with another agent](README.md#driving-saturn-with-another-agent).

### Changed

- **Saturn is rewritten in Rust and Tauri.** The app and its runtime no longer carry Electron and Node.js, so the download is much smaller, and the interface now runs in your system's web view. Your data in `~/.saturn-app` keeps working as it is. An older Saturn cannot update to this version: install it by hand once, and later versions update themselves. The agent browser now needs Chrome or a relative such as Edge, or Safari on macOS, and says so when there is none. OTLP export sends JSON over HTTP only, so `OTEL_EXPORTER_OTLP_PROTOCOL` has no effect, and the desktop app's own spans are not exported for now. The Windows version has been type-checked but not run yet.
- **The Completion Model setting is now Background Model** in Settings → General. It writes memory notes from your chats and drafts automations when an agent's own model has no API, so check where it points: chat content goes to that model.

### Removed

- **Saturn IDE is removed.** Saturn no longer bundles an editor, so the download is smaller and Saturn is the agent app alone for now. Tab completion, next-edit suggestions, inline edits (Cmd+K), commit-message generation and the language-server tools for agents are gone with it, and so are the **Open at Launch** setting and the Settings-only window. A built-in editor is planned but not built yet. Its sources remain at the git tag `archive/code-oss`.

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
