<div align="center">

<img src="desktop/build/icon.png" alt="Saturn" width="112" height="112" />

# Saturn

**A local-first workbench for AI research.**

Bring your own models, scope every agent to the folders you grant, and keep each tool call, file edit and network request inspectable, reviewable and reversible.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)
![Rust](https://img.shields.io/badge/Rust-1.99-000000.svg?logo=rust&logoColor=white)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB.svg?logo=tauri&logoColor=white)
![Status](https://img.shields.io/badge/status-early%20preview-orange.svg)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Saturn-Technology-Project/Saturn-App/badge)](https://scorecard.dev/viewer/?uri=github.com/Saturn-Technology-Project/Saturn-App)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/15780/badge)](https://www.bestpractices.dev/projects/15780)

[Features](#features) · [Install](#install) · [Architecture](#architecture) · [Models](#models) · [Security](#security-and-trust) · [API](#local-api) · [中文](README_ZH.md)

</div>

---

## Why Saturn

Most agent products run the control plane in a vendor cloud, or hand a model an unrestricted shell. Saturn keeps the control plane on your machine:

- **Local-first and verifiable.** The runtime is a loopback-only HTTP service on `127.0.0.1`. State, credentials and telemetry are files on disk, and every HTTP(S) request the runtime sends is logged ([how to verify](#security-and-trust)).
- **Model-agnostic.** Anthropic, OpenAI, Google and DeepSeek over their APIs with your keys; Claude Code and Codex on your existing subscriptions through their official programs; or fully offline models served by LM Studio.
- **Least privilege by default.** Agents are confined to granted folders, side-effecting actions go through an approval policy, and every edit is checkpointed and revertible per step.

### Saturn, Claude Code and Codex

What Saturn's own agent loop does (for API and local models; agents on Claude Code or Codex get those programs' own versions), next to the two programs. "—" means not checked for this table.

| | Saturn | Claude Code | Codex |
|---|---|---|---|
| Runs on your machine, any provider or a local model | Yes: Anthropic, OpenAI, Google, DeepSeek, LM Studio | Anthropic models | OpenAI models, local through `--oss` |
| Permission rules (allow, ask, deny by pattern) | Yes, with `.claude/settings.json` rules read too | Yes | Approval modes |
| OS sandbox for commands | macOS, Linux (bubblewrap); none on Windows | Yes | Yes |
| Context compaction | Yes, and `/compact` | Yes | Yes |
| Sub-agents | Yes (`delegate`) | Yes | — |
| Background commands | Yes | Yes | — |
| Hooks | Yes (`pre_tool`, `post_tool`, `stop`; Claude Code's format read) | Yes | — |
| Skills and slash commands | Yes (`SKILL.md`, `.claude/commands` read) | Yes | — |
| Plugins | Yes (Claude Code's layout installs as is) | Yes | — |
| Headless CLI | `saturn run` | `claude -p` | `codex exec` |
| SDK | [`@saturn-app/sdk`](https://github.com/Saturn-Technology-Project/Saturn-SDK) (TypeScript, local) | Agent SDK | Codex SDK |
| Pull request follow-up (fix failing checks) | Runtime only, at most two rounds | Yes, in Claude Code on the web | — |
| Desktop app and editor | Research workbench with a code editor | Desktop app, IDE extensions | IDE extension, app |
| Computer use, browser; multi-agent groups and schedules through the runtime | Yes | — | — |
| Measured | Task evals (`scripts/eval`), nightly when a key is set | Anthropic's evaluations | OpenAI's evaluations |

Saturn is younger than both and has had far less real-world use; the evals are how changes to its loop are checked.

## Features

The interface is built around research. Groups, schedules and pull request follow-up remain in the runtime and its API, without screens of their own.

| | |
|---|---|
| 🤖 **Agents** | Per-agent system prompt, model, reasoning effort, tool set and approval policy. Agent, Ask (read-only) and Plan modes per message. |
| 🌿 **Isolated worktrees** | Run a task in its own git worktree and branch, in the background. Merge, keep or discard it; resolve conflicts with the agent; open a pull request from the branch. |
| 📎 **Context** | `@`-mention files, folders, git changes and URLs; paste screenshots; per-project rules from `AGENTS.md` and similar files; semantic code search backed by a bundled on-device embedding model. |
| ✅ **Verification loop** | After a turn edits files, the project's check command (typecheck, lint, tests) runs, and failures go back to the agent for up to two automatic fix rounds. |
| 🔍 **Review** | Per-turn diffs with inline comments sent back to the agent, editable plans, a summary card per turn, terminal output, and replayable browser recordings. |
| ↩️ **Checkpoints** | Every file edit is recorded. Keep or revert a turn, or restore the workspace to any individual step. |
| 📚 **Skills** | Folders with a `SKILL.md` (name, description, instructions) in a project's `.agents/skills`, `.saturn/skills` or `.claude/skills`, or your `~/.saturn-app/skills`. Agents see only the names and descriptions and load a skill when a task calls for it; type `/name` in the composer to use one yourself. |
| 🧩 **Plugins** | One folder that bundles skills, `/` commands, hooks and MCP servers, installed from a folder or a git URL in **Settings → Plugins** and turned on or off as a unit. Claude Code plugins (`.claude-plugin/plugin.json`) install as they are. Installing runs nothing: a plugin's hooks and local MCP servers each wait for your approval. |
| ⌨️ **Slash commands** | `/` in the composer lists Saturn's own commands (`/compact`, `/plan`, `/ask`, `/new`), the chat's skills, and prompt templates from a project's `.saturn/commands` or `.claude/commands` or your `~/.saturn-app/commands` (`$ARGUMENTS` is what follows the name). The chat shows what you typed; the expansion goes to the agent. |
| 🪆 **Sub-agents** | An agent hands a self-contained task (a wide search, an investigation, a subtask) to a sub-agent with a fresh context and gets back only its answer; several run in parallel, read-only by default, nested under the step that started them, with the same approvals and checkpoints as the chat. |
| 🛠️ **Tools** | Filesystem, shell (with background commands: a dev server or watcher keeps running across turns, readable and stoppable from the Terminal tab), web fetch, a browser you watch the agent use (live in the chat's Browser tab with its cursor, a visible Chrome window with Saturn's own profile, or a Safari automation window on macOS after turning on Develop → Allow Remote Automation once; Settings → General → Agent browser; Saturn ships no browser of its own, so the first two need Chrome or a relative such as Chromium or Edge, and the tool says so when there is none), multi-step planning, computer use on macOS and Windows, GitHub, automations, and any [MCP](https://modelcontextprotocol.io) server from the built-in marketplace. |
| 🔬 **Research workbench** | Questions, hypotheses, frozen experiment versions, runs, samples and findings, kept as plain files in the project's `.saturn/research`. Write code yourself beside an experiment, follow a model from checkpoint to policy, compare one sample across runs, and label it without touching its score. A run records what it really computed, including uncommitted code, and survives a crash with its samples readable. A research assistant can carry out a study itself through its [research tools and skills](docs/research-skills.md), on any backend: design it, train, evaluate, read samples and report, leaving verdicts, labels and merging to you. Each chat can be Manual, Pair or Delegate for its agent. These modes are a workflow constraint, not a security boundary, and [`docs/research-contract.md`](docs/research-contract.md) says exactly what each backend can enforce. Experiment runs work on macOS and Linux, not yet on Windows. |
| 💸 **Usage and cost** | Token counts and cost at list price, per model and per agent, over any time range. |
| 📈 **Observability** | OpenTelemetry traces, metrics and logs, an outbound network log, and optional OTLP export (JSON over HTTP) to your own collector. |

**Reviewing samples.** Disputed and error views filter the whole run before paging. In Experiments, map custom label names to the scorer's words (for example, “Wrong name” → “Wrong”); the same rule drives agreement statistics and review warnings, while original labels and scores stay intact.

**Run counters.** Resources warns when a program rewrites an already counted samples prefix, recounts the current file, and starts throughput again. Experiment programs should append complete JSONL lines.

**Environment jobs.** Creation, package installs and lock-file syncs default to a 30-minute deadline, adjustable in Environment. A timeout stops the whole process group, keeps the output and allows a retry. The API accepts `timeoutSeconds` from 1 to 86400.

**Existing results.** Home and Experiments can preview and import project JSONL/JSON/CSV/TSV results, with explicit column
mapping and numeric score columns, without rewriting training code or first creating a hypothesis. Trainer state JSON
imports its `log_history` as separate training metrics. Sources remain unchanged, unknown provenance stays unknown, and
imported versions cannot be executed. Experiments plots training metrics by step, separately from evaluation samples.

**Behavior changes.** Experiments compares sealed samples across runs or selected models, showing improvements,
regressions, missing/error counts and category slices. Uncertainty groups repeated trials by sample ID and is omitted
when evaluation conditions are unknown or different. Save the whole regression cohort and reopen its membership later.

## Install

Download the latest build from [Releases](../../releases): a `.dmg` (or `.zip`) for macOS on Apple Silicon, and a setup `.exe` for Windows x64. Releases are pre-releases while Saturn is in preview; [`CHANGELOG.md`](CHANGELOG.md) summarizes what changed in each. Each file ships with a SHA-256 checksum and a signed build provenance attestation ([verify a download](#5-verify-the-release-provenance)).

The macOS app is not signed with an Apple Developer ID yet: approve the first launch in **System Settings → Privacy & Security → Open Anyway**. Windows builds are Authenticode-signed with Saturn's self-signed certificate (SHA-1 thumbprint `D285DA425077C16A3D115D61F9748AFA574BC786`, public half in [`desktop/build/saturn-code-signing.cer`](desktop/build/saturn-code-signing.cer)). Windows does not trust a self-signed publisher, so SmartScreen still asks: choose **More info → Run anyway**. As of the rewrite in Rust and Tauri, the Windows version has been type-checked but not run ([Platform notes](#platform-notes)). There is nothing else to install: the runtime is a native program inside the app, and the interface runs in the system's web view (WebKit on macOS 12 or later, WebView2 on Windows).

**One app.** The runtime and the `saturn` command ship inside Saturn. Applications, Launchpad and Spotlight list Saturn alone.

**Updates.** Saturn looks for a new version at startup, downloads it in the background and installs it when you quit. A version from before the rewrite in Rust and Tauri cannot update to this one: install it by hand once. Your data in `~/.saturn-app` keeps working, and later versions update themselves.

On first launch, a tour boxes each part of the interface over the live app and says what it is for, then helps you choose a project folder, connect a model and write your first question. It is in Commands (⌘K) as "Take the tour" afterwards. The research assistant (⌘J) knows the workbench too: ask it what a screen is for or how to do something, and it can walk you through it, boxing each place while you do the work. Claude Code and Codex are not in the installer: Saturn uses your own installation if it finds one, or downloads the official program when you first need it (see [Models](#models)).

## Build from source

### Requirements

- [Rust](https://rustup.rs): the version in `rust-toolchain.toml`, which `rustup` installs by itself
- [Node.js](https://nodejs.org): the version in `.nvmrc`, with npm 11.19 or later, for the interface's build and the contract tests
- macOS or Windows for the app, with [Tauri's prerequisites](https://tauri.app/start/prerequisites/). Each system's package must be built on that system. The runtime alone also builds on Linux.

### Run in development

```bash
git clone https://github.com/Saturn-Technology-Project/Saturn-App.git
cd Saturn-App
npm install --prefix desktop
npm run desktop
```

`npm run desktop` runs `tauri dev`, which builds the runtime and the `saturn` command and serves the interface with Vite. The app starts the runtime unless one already answers on port `4700`. To run the runtime alone, headless, with its HTTP API:

```bash
npm run dev
```

### Package

```bash
cd desktop
npm run package -- --bundles app    # macOS: Saturn.app, ad-hoc signed, in target/release/bundle/
npm run package -- --bundles nsis   # Windows: the x64 NSIS installer, in target/release/bundle/
npm run archive                     # the downloads and their checksums, in desktop/release/
```

`npm run package` builds the interface, downloads the embedding model into `desktop/.staging/` (checked against its pinned SHA-256), builds the runtime and `saturn` for release, and bundles them. The Claude Code and Codex programs are not in the package: Saturn downloads them on demand. A build has an updater only when it is made with Saturn's updater key ([`updater-config.mjs`](desktop/scripts/updater-config.mjs)).

Release builds come from the [release workflow](.github/workflows/release.yml): it builds and tests both platforms on GitHub-hosted runners (on Windows without the contract tests), attests the artifacts and publishes the release when a `v*` tag is pushed.

### Platform notes

- **Computer use** runs on macOS (accessibility APIs) and Windows (SendInput and UI Automation); see [Computer use](#computer-use).
- **Claude Code** on Windows requires [Git for Windows](https://git-scm.com/downloads/win), which provides the Bash it executes commands in.
- On Windows, the `code` tool and the Terminal panel run commands under `cmd.exe`.
- **Windows has been type-checked, not run,** as of the rewrite in Rust and Tauri: not in CI and not on real hardware. What this file says about Windows is what the code does, not what has been seen working.

## Architecture

```mermaid
flowchart LR
  subgraph Machine["Your computer"]
    D["Saturn Desktop<br/><sub>Tauri + React · system web view</sub>"]
    R["Saturn Runtime<br/><sub>Rust · 127.0.0.1:4700</sub>"]
    S[("~/.saturn-app<br/><sub>state · keys · workspace</sub>")]
    P["Project folders"]
    D -- "HTTP + bearer token" --> R
    R --> S
    R -- "granted paths only" --> P
  end
  R -- "HTTPS" --> M["Model APIs<br/><sub>Anthropic · OpenAI · Google · DeepSeek</sub>"]
  R -- "official programs" --> C["Claude Code · Codex"]
  R --> L["LM Studio<br/><sub>local inference</sub>"]
  R --> X["MCP servers"]
```

| Component | Responsibility |
|---|---|
| **Saturn Runtime** (`crates/`) | The control plane: model adapters, the agent loop, tool execution, MCP clients, the approval policy, checkpoints, worktrees, usage accounting, telemetry and persistence. `saturn-server` is the HTTP API and `saturn-cli` the `saturn` command. It needs no desktop app and runs headless. |
| **Saturn Desktop** (`desktop/`) | The React interface in a Tauri 2 shell (`desktop/src-tauri`): chats, the Agents board, projects, groups, automations and settings. It reaches the runtime only through its HTTP API. |
| **Contract** (`contract/`) | Tests of what the runtime must do over HTTP, run against the real `saturn-server` and `saturn` programs. |

Runtime and desktop follow the same layered architecture; dependencies point inward, except that `saturn-server` also uses a few infrastructure crates directly (telemetry, the store, the Browser tab's fetch):

```
crates/                                   desktop/src/
  saturn-domain   entities, policies        domain/          view models and rules
  saturn-core     use cases, the agent      application/     use cases over the API
                  loop
  saturn-llm, -mcp, -tools, -store,         infrastructure/  HTTP client
  -browser, -computer, -embed, -telemetry
  saturn-server   HTTP routes               presentation/    React components
  saturn-cli      the saturn command
```

### Lifecycle

Launching Saturn starts its own runtime and keeps it running: it restarts one that dies, and refuses to use another Saturn already on the port (set `SATURN_RUNTIME_PORT` to use a runtime you started yourself). The window shows where the runtime stands until it answers. Closing the last window stops the runtime it started. The runtime holds a pipe from the app and stops when the pipe closes, so it does not outlive an app that crashed or was force-quit.

**Context.** A chat's earlier turns are sent within a budget sized to the model's context window (half of it; a connection can state its own `contextTokens`). When they outgrow it, the oldest turns are summarized by the same model into the chat's running summary, which later turns ride on; the chat shows `⤵ n earlier turns folded` where it happened. The header's **Context · n%** chip shows how full the chat is, and clicking it, or sending `/compact`, folds the turns now. Claude Code and Codex manage their own context.

## Models

| Provider | Authentication | Notes |
|---|---|---|
| Claude | API key | Effort levels and adaptive thinking where supported |
| Claude (via Claude Code) | Claude subscription | Runs the official Claude Code program over the protocol its Agent SDK speaks; Saturn sends no API request for these models (see [Claude and Anthropic's terms](#claude-and-anthropics-terms)). Uses your `claude` on the PATH, or downloads the official program from **Settings → General** (about 120 MB). Sign in once with it; Saturn never handles the credential. |
| Codex | ChatGPT subscription | Runs the official Codex program, started as the Codex SDK starts it (see [Codex and OpenAI's terms](#codex-and-openais-terms)). Uses your `codex` on the PATH, or downloads the official program from **Settings → General** (about 140 MB). Codex's own device-code sign-in, started from Settings. |
| OpenAI | API key | Chat Completions and Responses APIs; reasoning effort on reasoning models |
| Google Gemini | API key | Thinking level (3.x and later) or thinking budget (2.5) |
| DeepSeek | API key | |
| LM Studio | None | Any locally served model, fully offline |

API keys are stored encrypted in `~/.saturn-app/secrets.json` (AES-256-GCM, key in the OS key store; see [Data at rest](#data-at-rest)), sent only to the provider they belong to, and never returned to the UI. One key covers every model of its provider.

### Claude and Anthropic's terms

Saturn offers Claude in two ways that are kept strictly apart:

| Provider | Authentication | What Saturn sends |
|---|---|---|
| Claude | Your Anthropic API key, under Anthropic's [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) | API requests from Saturn to Anthropic |
| Claude (via Claude Code) | Your own Claude subscription, signed in with the official `claude` program | No API request at all: every turn runs in the unmodified Claude Code program, which Saturn drives over the stream-json protocol its Agent SDK speaks |

How Saturn follows Anthropic's [Claude Code legal and compliance terms](https://code.claude.com/docs/en/legal-and-compliance):

- **Sign-in through Anthropic's own flow.** You sign in to Claude Code with `claude auth login` in a terminal. Saturn has no Claude login button and never collects, stores or forwards Claude.ai credentials or session tokens; it does not read `~/.claude` or the Keychain, and Claude Code runs in its own config folder with none of your Claude settings loaded.
- **The unmodified program.** Saturn runs Claude Code as Anthropic publishes it: the program from the npm package of the Agent SDK release Saturn pins, checked against a pinned SHA-512, or your own installation.
- **Your own plan, billed to you.** Each user signs in with their own subscription; Saturn does not pay for, resell or intermediate Claude usage.
- **No authentication method removed.** Claude Code runs with the runtime's environment, less only Saturn's own session variables, so every method it supports stays available: your subscription, or your own `ANTHROPIC_API_KEY`, Bedrock, Vertex AI or Foundry settings, which it picks in its own documented order. Saturn never adds a credential: a key saved for the Claude provider stays with that provider.
- **Enforced in code, not by convention.** The model broker refuses any API request for a Claude (via Claude Code) model, such a model cannot hold an API key, and Saturn's side tasks (memory notes, automation drafts, completions) use API models only. Tests keep it that way.
- **Ordinary, individual use.** Anthropic's plan limits assume it, and its Consumer Terms allow automated access only through an API key, so automations cannot run on Claude (via Claude Code): those agents are disabled in the automation form and refused by the runtime.
- **Naming.** Saturn says in plain text that this provider runs Claude Code; it does not use Claude Code or Anthropic as the name of its own product or features, and it is not built, endorsed or partnered by Anthropic.

This is our reading of Anthropic's published terms, not legal advice, and Anthropic has the final say: if your use differs (a team deployment, a hosted service), use the Claude provider with an API key, or [ask Anthropic](https://code.claude.com/docs/en/legal-and-compliance).

### Codex and OpenAI's terms

Saturn offers OpenAI models in two ways, kept apart like Claude's:

| Provider | Authentication | What Saturn sends |
|---|---|---|
| OpenAI | Your OpenAI API key, under OpenAI's [Business Terms](https://openai.com/policies/business-terms/) | API requests from Saturn to OpenAI |
| Codex | Your own ChatGPT plan, signed in to the official `codex` program | No API request at all: every turn runs in Codex, started and driven as the [Codex SDK](https://developers.openai.com/codex/sdk) does |

How Saturn follows OpenAI's [Terms of Use](https://openai.com/policies/terms-of-use/), the [Codex authentication guide](https://learn.chatgpt.com/docs/auth) and OpenAI's [brand guidelines](https://openai.com/brand/):

- **Codex signs you in, not Saturn.** Settings starts `codex login` (device code, or the browser) and shows what Codex prints. Saturn is not a "Sign in with ChatGPT" app, has no ChatGPT login of its own, and never reads Codex's `auth.json`; Codex keeps it in a Saturn-specific `CODEX_HOME`.
- **The official program.** Codex is open source under Apache-2.0, and OpenAI publishes the SDK for integrating Codex into other applications. Saturn starts the program as that SDK does: the npm release Saturn pins, checked against a pinned SHA-512, or your own installation.
- **Your own account.** OpenAI's terms do not let you share your account or credentials; each person signs in with their own, and Saturn does not resell or intermediate ChatGPT usage. Usage counts toward your plan's limits, which Saturn does not work around.
- **Enforced in code.** The model broker refuses any API request for a Codex model, a Codex model cannot hold an API key, and Saturn removes API-key variables (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`) from Codex's environment so it always runs on the sign-in you chose.
- **Automations.** OpenAI documents ChatGPT sign-in for trusted scripts and schedulers but recommends API keys for automation; for scheduled work, prefer an agent on the OpenAI provider.
- **Naming.** Saturn names OpenAI's products only to say what a provider runs. It does not use ChatGPT, GPT, Codex or OpenAI's logos in its own name or features, and it is not built, endorsed or partnered by OpenAI.

This is our reading of OpenAI's published terms, not legal advice; OpenAI's terms govern your account.

### Local models

**Built-in embedding models.** The code index runs its own embedding model on the CPU, so semantic search works with no model connected and no network. Choose it in **Settings → General → Embedding model**:

| Model | Size | Notes |
|---|---|---|
| Multilingual E5 small (default) | 118 MB, bundled | Chinese and English questions, 512-token passages |
| Jina v2 code | 162 MB, downloaded on first use | English questions about code, 2,048-token passages |

You can also use an embedding model served by LM Studio (default `text-embedding-nomic-embed-text-v1.5`) or OpenAI.

**Chat and agent models through LM Studio.** Two settings decide whether a local model works as a Saturn agent:

- **Tool calling.** Agents act through tools, so the model must be trained for function calling (LM Studio marks these models with a tool icon). Models without it answer, but never act.
- **Context length of 32K or more.** Saturn's system prompt and tool definitions alone exceed LM Studio's default 8K load, which fails with *"tokens to keep … greater than the context length"*. Load the model with a larger context in LM Studio, or:

```bash
lms load qwen/qwen3.5-4b --context-length 32768
```

**Tested models.** Each model ran three agent tasks twice through Saturn's own tools (read a file and answer from it; write a script, run it and report its output; fix a bug and verify the fix with a command), Results are checked on disk, not taken from the model's reply. Tested on 2026-10-21 on an Apple M1 Pro with 16 GB, LM Studio 0.4.26, 4-bit weights, 32K context:

| Model | Size | Agent tasks | Median task | Use it for |
|---|---|---|---|---|
| Qwen3.5 4B (`qwen/qwen3.5-4b`) | 3.1 GB | 6/6 | 29 s | Agents on 16 GB machines: fastest and smallest |
| Gemma 4 E4B (`google/gemma-4-e4b`) | 6.9 GB | 6/6 | 48 s | Agents |
| Ministral 3 8B (`mistralai/ministral-3-8b`) | 6.1 GB | 6/6 | 65 s | Agents |
| Qwen3.5 9B (`qwen/qwen3.5-9b`) | 6.0 GB | 6/6 | 71 s | Agents |
| Qwen2.5-Coder 7B | 4.3 GB | 3/6 | n/a | Not for agents: unreliable tool use |

Reasoning models (Qwen3.5, Gemma 4) think before every completion, so expect longer tasks. These are small tasks on one machine; larger models (Qwen3.6 27B, Qwen3-Coder 30B and up) need 32 GB or more and were not tested.

## Security and trust

Saturn executes code on your machine and holds your provider credentials, so its trust model should not depend on taking our word for it. The [threat model](docs/threat-model.md) says what Saturn defends against, and what it does not, with the code behind each control; [`SECURITY.md`](SECURITY.md) says how to report a problem. This section documents the data inventory, every egress path, and how to verify each claim with standard tooling, without reading the source.

**Summary:** there is no Saturn backend. Credentials, conversations and telemetry are local files under `~/.saturn-app`. Outbound traffic goes only to endpoints you configure (model providers, and the sites, APIs and MCP servers your agents use), and every request is observable.

### Data at rest

Everything lives under `~/.saturn-app` (override with `SATURN_DATA_DIR`). Deleting the directory is a complete reset.

| Data | Location | Notes |
|---|---|---|
| API keys and OAuth tokens | `secrets.json` | Encrypted at rest with AES-256-GCM under a random 256-bit key held by the OS key store: the macOS Keychain, Windows DPAPI, or the Secret Service (libsecret) on Linux; a mode `0600` key file only where none is available. Mode `0600` (Windows has no such mode: there the file has the permissions of your user profile's folder). Plaintext files from earlier versions are encrypted on first launch. |
| Agents, conversations, projects, settings | `state.json` | Plain JSON. |
| Telemetry (traces, metrics, logs) | In memory and `telemetry.json` | Exported only if you configure an OTLP endpoint. |
| Outbound request log | `network.log` | JSON Lines: timestamp, method, host, path, and whether the host is this computer. Query strings and bodies are never recorded. Above 5 MB it moves to `network.log.1`. |
| Memory, code index, checkpoints, attachments | `memory/`, `index/`, `checkpoints/`, `run-images/` | Local files. Embeddings are computed on-device by the bundled model. |
| API session token | `runtime-token` | Mode `0600` (on Windows, as `secrets.json`). |
| Claude Code and Codex programs | `tools/` | Downloaded only when you ask, checked against a sha512 pinned in Saturn before they are unpacked. Removable from Settings. |
| Claude Code and Codex sign-ins, the agent browser's profile | `claude/`, `codex/`, `browser-profile/` | Kept by those programs. Saturn does not read the sign-ins. |

### Egress inventory

| Destination | Trigger | Payload |
|---|---|---|
| Your model provider (Anthropic, OpenAI, Google, DeepSeek) | Agent turns | The conversation, files you or the agent attach, tool results. The key goes only to that provider. |
| Anthropic / OpenAI via Claude Code and Codex | Turns on those providers | Their official CLIs talk to their own vendor under your subscription. Saturn never reads or forwards those credentials. |
| Sites, APIs and MCP servers | When an agent fetches a URL, drives the browser, calls GitHub, or uses an MCP server you added | Whatever that tool call needs. Remote MCP servers are reached over HTTP(S); a local one runs only after you approve its exact command, and its own traffic is its business. The web and browser tools refuse private, link-local and loopback addresses (SSRF protection). |
| GitHub Releases | App startup | The update check (`latest.json` of the `updates` release), and the package when there is a newer version. Only in builds made with Saturn's updater key. The app makes these requests, not the runtime, so they are not in the network log. Disable with `SATURN_NO_UPDATES=1`. |
| Hugging Face | Only if you select an embedding model that is not bundled | The model download. Unlike the bundled model, it is not checked against a pinned hash. |
| `registry.npmjs.org` | Only when you press **Download** for Claude Code or Codex | The official program's npm package, the exact version pinned in Saturn, verified against a pinned sha512. |
| Your OpenTelemetry collector | Only if an `OTEL_EXPORTER_OTLP_*ENDPOINT` variable or `SATURN_OTEL=otlp` is set | Saturn's traces, metrics and logs, as JSON over HTTP. |

There is no other egress: no product analytics, no crash reporting, no account and no hosted service.

Measured baseline: with a fresh data folder and no active turn, the runtime opened **zero** outbound connections during 30 seconds (2026-11-04, a macOS debug build of the runtime alone).

### Verify it yourself

Each check is independent and needs no knowledge of the codebase.

#### 1. Observe egress at the OS level

The kernel sees every socket, regardless of what the application claims.

```bash
# macOS: live TCP connections of every Saturn process
nettop -m tcp -p $(pgrep -d, -f "Saturn") 2>/dev/null || lsof -i -nP | grep -i saturn
```

```powershell
# Windows: established connections owned by Saturn processes
Get-NetTCPConnection -State Established | Where-Object { (Get-Process -Id $_.OwningProcess).ProcessName -like "Saturn*" }
```

For per-connection prompts, use an outbound application firewall: [LuLu](https://objective-see.org/products/lulu.html) (free, open source) or Little Snitch on macOS, or outbound rules in Windows Defender Firewall. Every connection should map to a row in the egress inventory.

#### 2. Read the runtime's network log

**Settings → Telemetry → Network** lists every host the runtime has contacted, with request counts and the latest requests. The same data is appended to a file:

```bash
tail -f ~/.saturn-app/network.log
jq -r .host ~/.saturn-app/network.log | sort | uniq -c | sort -rn   # requests per host
```

Every HTTP(S) request the runtime sends goes through one function that records it, redirects included, and a lint rule ([`clippy.toml`](clippy.toml)) fails CI on a request sent any other way. So it covers the model adapters, the tools and the MCP clients. It does not cover other programs ([Known limitations](#known-limitations)) or the app's own update check.

#### 3. Run air-gapped

Connect a local model in [LM Studio](https://lmstudio.ai) (one that supports tool calling, loaded with a 32K context; see [Local models](#local-models)), block Saturn in your firewall, and keep working: agents and the code index run offline.

#### 4. Inspect data at rest

```bash
ls -la ~/.saturn-app          # secrets.json and runtime-token are -rw------- (owner-only)
head -c 300 ~/.saturn-app/secrets.json   # an AES-256-GCM envelope: no key appears in it
security find-generic-password -s Saturn | grep acct   # macOS: the Keychain item that holds the encryption key
cat ~/.saturn-app/state.json  # agents, conversations and settings as plain JSON
```

#### 5. Verify the release provenance

Every release artifact has a SHA-256 checksum and a signed [build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations) (SLSA provenance, signed through Sigstore). It binds the file's digest to this repository, the public [release workflow](.github/workflows/release.yml) and the exact commit it was built from:

```bash
shasum -a 256 -c Saturn-<version>-mac-arm64-unsigned.dmg.sha256
gh attestation verify Saturn-<version>-mac-arm64-unsigned.dmg -R Saturn-Technology-Project/Saturn-App
```

From 0.3.1 on, each release also carries the signed attestations themselves (`Saturn-<version>-mac-arm64.sigstore.json`, `-win-x64.sigstore.json` and the SBOM's), so a download can be checked without fetching anything from GitHub:

```bash
gh attestation verify Saturn-<version>-mac-arm64-unsigned.dmg --bundle Saturn-<version>-mac-arm64.sigstore.json -R Saturn-Technology-Project/Saturn-App
```

From the next release on, `Saturn-<version>.intoto.jsonl` holds all of a release's attestations in one file (one per line), and works with `--bundle` for any of its downloads.

On Windows, the installer's Authenticode signature names Saturn's certificate:

```powershell
(Get-AuthenticodeSignature .\Saturn-<version>-win-x64-setup.exe).SignerCertificate.Thumbprint   # D285DA425077C16A3D115D61F9748AFA574BC786
```

Build logs are public on the [Actions](../../actions/workflows/release.yml) page. Alternatively, [build from source](#build-from-source).

### Monitoring

- **Network log:** `network.log` is JSON Lines; ship it with Vector, Fluent Bit or Promtail, or `tail -f` it during a session.
- **OpenTelemetry:** set `OTEL_EXPORTER_OTLP_ENDPOINT` (optionally `SATURN_OTEL=otlp`) to export traces, metrics and logs to a collector that accepts OTLP over HTTP with JSON. Protobuf and gRPC are not offered, and `OTEL_EXPORTER_OTLP_PROTOCOL` has no effect. Each model call, tool call and agent turn is a span, with outbound HTTP requests as child spans. The desktop app exports no spans of its own for now.
- **Local API:** `GET /network`, `GET /telemetry/traces`, `GET /telemetry/logs` and `GET /usage/summary` expose the same data to scripts ([Local API](#local-api)).
- **Spend:** **Settings → Usage & Billing** breaks down tokens and cost by model and agent over any time range.

### Security controls

- **Loopback binding.** The runtime listens on `127.0.0.1` only, rejects any non-loopback `Host` header (defeating DNS rebinding), and gives `null` and non-local browser origins no cross-origin access (CORS).
- **Encrypted credentials.** API keys and OAuth tokens are encrypted at rest (AES-256-GCM, authenticated); the key never touches the data folder when an OS key store is available, and is passed to the system tools on stdin, never as a command-line argument. A file whose key cannot be found is set aside, never overwritten.
- **Bearer authentication.** Every route except `/health`, the OAuth redirect and `/agent-mcp` (which takes a running Codex turn's own token instead) requires `Authorization: Bearer <token>`. The token lives in `~/.saturn-app/runtime-token` (mode `0600`; on Windows, the permissions of your user profile's folder), so other local users and web pages cannot call the API.
- **Local MCP servers run only with your approval.** A remote MCP server is an HTTP(S) URL. A local one (a program Saturn starts and talks to over stdio, such as `npx -y @modelcontextprotocol/server-filesystem …`) is saved but does not start until you have seen its exact command and allowed it; changing the program, an argument or a variable asks again, and the approval call must name the version you saw. It starts in Saturn's workspace folder with only a minimal environment (PATH and the few system variables programs need) plus the variables you set, whose values are kept encrypted in `secrets.json`; Saturn's own environment, including any API keys in it, never reaches it. Removing the server stops the program.
- **Hooks, and project hooks only with your approval.** A hook is a command that runs before or after an agent's tool call (exit 2 blocks it or sends feedback; stdout can answer allow, ask or deny) or when its turn ends (exit 2 sends the agent back to work, at most twice per message). Your own hooks are set in **Settings → Hooks**. A project's `.saturn/hooks.json`, and the PreToolUse, PostToolUse and Stop hooks of its `.claude/settings.json`, come with the folder, so they run only after you have read and allowed that exact set; any change asks again. Claude Code loads a project's `.claude/settings.json` only when you turn on **Use the project's Claude Code settings**.
- **Filesystem scoping.** Agents read, write and execute only within Saturn's workspace and project folders you grant; grants are revocable at any time.
- **An OS sandbox around commands.** Each shell command an agent runs is confined by the operating system: on macOS with seatbelt (`sandbox-exec`), on Linux with bubblewrap when it is installed. The default, *workspace-write*, allows writes only inside the project folder, temp folders and the usual package caches; *read-only* allows none outside the temp folders; the network can be switched off for commands. An agent that needs to write elsewhere asks with `sandbox: "off"`, which shows an approval card in every mode but full autonomy. Set it under **Settings → General → Sandbox**, or per project. Windows has no sandbox; commands there say so in their result.
- **Permission rules, then the approval policy, then checkpoints.** A rule names a tool and a pattern (`code: npm test *`, `files: write src/**`) and says allow, ask or deny; deny beats ask beats allow, and a shell line is judged one command at a time. Rules live in **Settings → Permissions** for everywhere, a project or an agent, and in the project's own `.saturn/settings.json`; the `permissions` of a `.claude/settings.json` are read too. Those two files come with the folder (a cloned repository, say), so their deny and ask rules apply at once but their allow rules only after you have allowed that exact set in the project's rules; any change asks again. A rule that allows every command is refused wherever it comes from. **Always allow…** on an approval card saves one. When no rule applies, risky commands and writes outside the working directory block on your approval unless you opt into full autonomy. Every edit is checkpointed and revertible down to a single step, including files a shell command changes, in the foreground or the background. In a git project git tells what changed (ignored files stay out); in another folder Saturn keeps a private git snapshot of it in its own data folder, never in yours, leaving out `node_modules`, builds and caches, and skips a folder too big to snapshot within a few seconds. **Settings → General → Storage** shows each folder's snapshot size and deletes it after a confirmation; earlier changes stay revertible.
- **Subscription credential isolation.** Claude Code and Codex authenticate through their official CLIs, in Saturn-specific config directories. Saturn never reads, copies or forwards those credentials, and never adds a key of its own. Claude Code gets the runtime's environment, less only Saturn's own session variables, so any authentication method you set up for it (your own `ANTHROPIC_API_KEY`, Bedrock, Vertex AI or Foundry) stays available, as Anthropic's terms require; Codex gets its API-key variables removed so a stray key cannot override the ChatGPT sign-in.

### Reducing exposure

- Issue Saturn dedicated API keys with spend limits, so they can be rotated or revoked independently.
- Prefer the **Default** approval policy (prompt on risky actions) over full autonomy, and grant only the project folders a task needs.
- For code that must never leave the machine, use a local model through LM Studio.

### Supply chain

Saturn's download is built from about 360 Rust crates (what `cargo tree` reports for the app, the runtime and `saturn` on macOS, without compile-time-only crates), three npm packages (React, ReactDOM and scheduler; the rest of `desktop/package-lock.json` is build tooling) and a machine-learning model. The web view is the operating system's. `Cargo.lock` lists more, 642 crates from crates.io, because it covers every platform and the build and test tools. Each one is pinned and checked, and the checks run in public CI.

**What gets installed**

- **Pinned lock files.** `Cargo.lock` pins every crate to an exact version with a SHA-256 checksum, and [`deny.toml`](deny.toml) allows only crates.io, with no git or other sources. `desktop/package-lock.json` pins every package to an exact version from `https://registry.npmjs.org/` with a SHA-512 integrity hash, and [`scripts/check-lockfiles.mjs`](scripts/check-lockfiles.mjs) fails CI on any git, tarball-URL, http or file source.
- **Registry signatures.** `npm audit signatures` verifies every installed npm package's registry signature, and its provenance attestation where the publisher provides one. crates.io has no such signature; the checksums in `Cargo.lock` are the check there.
- **No npm install scripts.** npm install scripts, the usual way a compromised package runs code, never run: the desktop app denies each one in `allowScripts`, and CI installs with `--ignore-scripts`. Cargo has no such switch: a crate's build script runs when Saturn is compiled, in CI and on your machine if you build from source, so crates are trusted that far.
- **Hashes for the rest.** The Claude Code and Codex downloads are pinned to the registry's SHA-512 ([`agent-programs.json`](crates/saturn-core/src/agent-programs.json), written by [`agent-programs-manifest.mjs`](scripts/agent-programs-manifest.mjs)); the bundled embedding model and its tokenizer to SHA-256 ([`fetch-embedding-model.mjs`](desktop/scripts/fetch-embedding-model.mjs)); every GitHub Action to a full commit SHA.

**Staying current**

- **Dependabot** opens a security update as soon as an advisory is published, and grouped version updates weekly for npm packages, crates and GitHub Actions, only for releases that have been public for seven days, which is when compromised or broken versions are usually caught and pulled.
- **The [Supply chain workflow](.github/workflows/supply-chain.yml)** runs on every change and weekly: lock files, registry signatures, `npm audit` at high severity for the npm packages that ship, and `cargo deny` for the crates (sources, advisories, licenses).
- **Tauri** is pinned in `desktop/src-tauri/Cargo.toml` (2.12.5); Dependabot proposes its updates like any other dependency. The web view is the system's, so its security fixes come with the operating system, not with Saturn.

**What ships, and who can ship it**

- **An SBOM with every release.** `Saturn-<version>-sbom.cdx.json` (CycloneDX 1.5) lists every crate in `Cargo.lock` with its SHA-256, the interface's npm packages with their licenses and SHA-512, and the model with its hashes. The SBOM, installers, archives and update packages all carry build provenance attestations.
- **Signatures that mean something.** Windows builds sign Saturn's programs and the installer with Saturn's certificate.
- **Signed updates.** The updater installs a package only with a valid signature from Saturn's updater key. That key is Saturn's own, so updates do not depend on an Apple Developer ID. A build made without the key, such as a fork's or your own, has no updater at all.
- **Release permissions.** Publishing waits for a maintainer's approval in a protected environment. Release tags can be created only by admins and can never be moved or deleted, `main` cannot be force-pushed, and [CODEOWNERS](.github/CODEOWNERS) requests the maintainer's review on every pull request. Two-factor authentication is recommended for every member with write access.

**Reviewed exceptions.** Advisories that cannot be fixed yet (no patch, or the patch needs an upstream change) are listed with their reason and closing condition in [`docs/known-advisories.md`](docs/known-advisories.md).

**Check it yourself**

```bash
node scripts/check-lockfiles.mjs
(cd desktop && npm ci --ignore-scripts && npm audit signatures)
cargo deny --locked check   # needs cargo-deny
gh attestation verify Saturn-<version>-sbom.cdx.json -R Saturn-Technology-Project/Saturn-App
```

### Known limitations

Saturn is an early preview and has not had a third-party security audit. The Windows version has been type-checked but not run since the rewrite in Rust and Tauri. macOS builds are not yet Developer ID-signed or notarized, and Windows builds are signed with a self-signed certificate that Windows does not trust. API keys are encrypted at rest, which keeps them out of backups, synced folders, disk images and copied data folders; but any process running as your user can still ask the OS key store for the key, as with every app that keeps credentials in the Keychain or DPAPI. Settings → About shows which key store is in use. An agent granted full autonomy can execute arbitrary commands within its granted folders; that is inherent to the design, so scope grants accordingly. Claude Code, Codex, git, local MCP servers, the agent browser and the system's web view processes run separately and do not appear in the runtime's network log; observe them with OS-level tools. A local MCP server you allow runs with your user account's permissions, so allow only programs you trust.

Report vulnerabilities privately to [security@saturn-core.com](mailto:security@saturn-core.com) rather than in a public issue; [`SECURITY.md`](SECURITY.md) says what to include, what happens next and what is in scope.

## Computer use

Computer use tools observe the screen through screenshots and act through synthesized mouse and keyboard events and the platform's element tree: the accessibility API on macOS, UI Automation on Windows.

### macOS

macOS requires these permissions for **Saturn**, under System Settings → Privacy & Security:

- **Accessibility**, to click, type and read the UI tree.
- **Screen & System Audio Recording**, to capture screenshots.
- **Automation** of System Events, for keys, typing and reading the UI tree. macOS asks the first time it is needed.

**Settings → General → Computer use** (and the onboarding) shows the first two, with **Request**: macOS then shows its own prompt and lists Saturn in System Settings, so there is nothing to add by hand.

macOS keys these grants to the app's code signature. Ad-hoc-signed builds present a new identity after every update, so the grants stop applying: if an agent reports a missing permission that is already enabled, remove Saturn with − and add it again. While the screen is locked, agents report it rather than act.

### Windows

Windows asks for no permission. A single helper process (Windows PowerShell running a small compiled C# module) handles every action: SendInput for the mouse, wheel and keys, Unicode input for typing (any language, without touching the clipboard), GDI+ for screenshots, and UI Automation for reading and acting on an app's elements. It is DPI aware, so coordinates match on scaled displays. A chord written the macOS way (`cmd+c`) means Ctrl.

- Windows lets an app control only apps at its own privilege level: an app running as administrator ignores Saturn's input unless Saturn runs as administrator too, and agents say so.
- Nothing can be seen or clicked while the lock screen or a UAC prompt (the secure desktop) is showing; agents report it rather than act.
- The [Windows computer use workflow](.github/workflows/computer-use-windows.yml) drives Notepad on a real Windows desktop when `crates/saturn-computer` changes on `main`. It has not run on the Rust code yet.

### Driving Saturn with another agent

Saturn can itself be operated by a computer-use agent such as [agent-desktop](https://github.com/vercel-labs/agent-desktop) or Claude computer use. Every control in the window has a role and a name in the accessibility tree: icon buttons are labelled, chats and agents in the sidebar are buttons that answer Enter and Space, and modals are dialogs named after their title. An agent can therefore find "New Agent", "Settings" or a chat by name instead of by pixels.

Drive it through the accessibility tree, for example `agent-desktop snapshot --app Saturn`. The app opens no DevTools port.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SATURN_DATA_DIR` | `~/.saturn-app` | State, credentials, session token and workspace |
| `SATURN_RUNTIME_HOST` | `127.0.0.1` | Bind address |
| `SATURN_RUNTIME_PORT` | `4700` | Listen port |
| `SATURN_RUNTIME_TOKEN` | generated | Fixed session token (32+ characters) instead of the persisted one |
| `SATURN_BROWSER` | an installed Chrome or relative | The Chrome-family program the agent browser starts |
| `SATURN_OTEL` | local only | `otlp` or `console` to export telemetry, `off` to keep it local |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | OTLP collector endpoint, spoken as JSON over HTTP; setting it enables export. `SATURN_OTEL=otlp` alone uses `http://localhost:4318` |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | `name=value,…` headers for the collector |
| `OTEL_SDK_DISABLED` | unset | `true` disables telemetry entirely |
| `SATURN_NO_UPDATES` | unset | `1` disables the update check |
| `SATURN_SECRET_STORE` | the OS key store | `keychain`, `dpapi`, `libsecret` or `file`: where a new secrets key is kept |

## Command line

**Settings → General → Command Line** installs `saturn` in `~/.local/bin`. It runs the app's own CLI against the running Saturn, so it always matches the app:

```bash
saturn run "fix the failing test" --agent Saturn --project .
saturn run - --agent Reviewer --json < prompt.txt
saturn runs
saturn approve RUN ACTION
```

`saturn run` streams the agent's steps to stderr and its answer to stdout (`--json` prints the whole run). An approval is asked on a terminal; in a script `saturn` exits with code 3 and prints the `saturn approve` command that answers it. As with automations, an agent on Claude (via Claude Code) only runs from a terminal, never unattended.

**From code.** The [Saturn SDK](https://github.com/Saturn-Technology-Project/Saturn-SDK) (its own repository) has a dependency-free TypeScript client for the same API: start a run, get its steps as they happen, answer approvals in a callback, read its changes.

```ts
import { Saturn } from "@saturn-app/sdk";

const saturn = new Saturn(); // finds the running Saturn and its token
const run = await saturn.run("fix the failing test", {
  agent: "Saturn",
  project: process.cwd(),
  onStep: (step) => console.log("·", step.toolId),
  onApproval: (step) => step.toolId === "code" && String(step.arguments.command).startsWith("npm test"),
});
console.log(run.status, run.output);
```

The same rule applies: an agent on Claude (via Claude Code) is refused, since the SDK runs it from code.

## Local API

The desktop app is a client of the same HTTP API, and so can your scripts be:

```bash
TOKEN=$(cat ~/.saturn-app/runtime-token)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4700/agents
```

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness probe (unauthenticated) |
| `GET` `POST` | `/agents` | List or create agents |
| `POST` | `/agents/:id/runs` | Start a turn (`mode`, `images` and project options) |
| `GET` | `/runs` · `/runs/:id` | Active and recent turns; one turn's output, reasoning, tool calls and approvals |
| `POST` | `/runs/:id/actions/:actionId/decision` | Approve or deny a pending action |
| `GET` `POST` | `/runs/:id/changes` · `/changes/keep` · `/changes/revert` | Review, keep or revert a turn's file changes |
| `POST` | `/runs/:id/restore` | Restore the workspace to a step |
| `POST` | `/runs/:id/stop` | Cancel a turn |
| `POST` | `/threads/:id/worktree` · `/worktree/finish` · `/pull-request` | Isolated worktrees: create, merge/keep/discard, open a PR |
| `POST` | `/threads/:id/pull-request/check` · `/watch` · `/feedback/send` · `/feedback/dismiss` | Follow the PR: look now, stop or resume, send or dismiss review comments |
| `GET` `POST` | `/groups` · `/groups/:id/messages` | Group conversations |
| `GET` `POST` | `/automations` | Scheduled runs |
| `GET` | `/usage/summary?from=&to=` | Tokens and cost over a time window |
| `GET` | `/events` · `/runs/:id/events` | Live updates as server-sent events: which runs changed, or one run as it changes |
| `GET` | `/network` | Outbound request log: hosts and recent requests |
| `GET` | `/telemetry/traces` · `/telemetry/logs` · `/telemetry/metrics` | Local OpenTelemetry data |
| `POST` | `/complete` · `/complete/stream` | Single model call |
| `GET` `POST` `DELETE` | `/programs` · `/programs/:id` · `/programs/:id/install` | Claude Code and Codex: installed or not, where from, download, remove |

## Development

**Research helper checks.** With torch and transformers installed in a research Python, `python crates/saturn-core/tests/research_followup_test.py` checks residual self-patches and final normalization using tiny random models, without downloads. The [Pythia follow-up](docs/research/name-tracking-2026-11-05.md) includes a real offline checkpoint experiment, its evidence and replay command; candidate-name margins and full-vocabulary top-1 are reported separately.

```bash
npm test            # cargo test, then the HTTP contract tests
npm run typecheck   # strict type-check of the desktop interface
npm run lint        # the coding standard (oxlint)
```

The contract tests (`contract/`) start the real `saturn-server` and `saturn` programs against a temporary data directory and fake model servers, so they need no credentials and never touch your data; the Rust tests live in each crate. `contract/cases` were recorded from the old TypeScript runtime and are frozen. CI runs both on Linux for every change and on macOS for every release. On Windows the workflows run `cargo test` without the contract tests, and have not run on the Rust code yet.

**Task evals.** `scripts/eval` runs coding tasks end to end through Saturn's agent loop with a real model and grades them with tests the agent never sees: pass rate, steps, tokens, cost and time. Fourteen tasks range from small fixes to a bug whose symptom is in another module, an async concurrency limit, a feature across layers that must read old files, a CSV parser from a crash report, a quadratic function that must handle 200,000 rows, a read-only search past a decoy, a promise API beside callbacks, and a time-zone bug. `cargo build -p saturn-server && node --test scripts/eval/self-test.mjs` checks the harness with a scripted model, and that every task's hidden checks fail as given and pass with its reference fix (`solution/`, never shown to the agent); it costs nothing. A real run spends tokens:

```bash
SATURN_EVAL_PROVIDER=claude SATURN_EVAL_MODEL=claude-sonnet-5-5 SATURN_EVAL_API_KEY=… node scripts/eval/run.mjs
```

The [Evals workflow](.github/workflows/evals.yml) runs them nightly once the repository has the `SATURN_EVAL_API_KEY` secret and the `SATURN_EVAL_PROVIDER` and `SATURN_EVAL_MODEL` variables, and fails when the pass rate drops more than 15 points under `scripts/eval/baseline.json`.

Before opening a pull request:

1. Respect the layering: domain code imports neither axum nor React.
2. Add or update tests for runtime behavior, in `contract/` or a crate's tests (the [test policy](CONTRIBUTING.md#test-policy) is mandatory), and run `npm test`, `npm run typecheck` and `npm run lint`.
3. Never log or return a secret. Log which credential was used (provider or model), never its value.

[CONTRIBUTING.md](CONTRIBUTING.md) has the coding standard and the test policy, and covers dependency changes: moving Claude Code or Codex to a new version, install-script approvals, and Dependabot pull requests.

## Roadmap

- Developer ID-signed, notarized macOS builds, and Windows builds signed with a CA-issued Authenticode certificate
- Linux packages
- For the research workbench: a PDF reader, a debugger, language servers and a real terminal

How the project is run and who decides is in [`GOVERNANCE.md`](GOVERNANCE.md); everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © 2026 Rick Weng
