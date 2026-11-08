# Threat model

[中文](#威脅模型)

What Saturn protects, from whom, how, and what it deliberately leaves to you. It is written for security reviewers and for anyone deciding how much autonomy to give an agent. Each control names the code that implements it; the [assurance case](#assurance-case) argues why the security requirements are met, with the tests that show it; [Review scope](#review-scope) lists what an external audit should cover first. Report a problem as described in [`SECURITY.md`](../SECURITY.md).

## The system

Saturn is a desktop app (Tauri with the system's web view, `desktop/`), a client of one local **runtime** (`crates/`): a Rust HTTP server on `127.0.0.1:4700` that runs the agent loop, calls model providers, executes tools and keeps all state in `~/.saturn-app`. The `saturn` CLI and the [SDK](https://github.com/Saturn-Technology-Project/Saturn-SDK) (its own repository) are clients of the same API. There is no Saturn server: nothing is sent to Saturn's developers.

Saturn is a workbench for AI research. A project's research records (questions, hypotheses, experiments, frozen versions, runs, samples, labels, findings) are files in the project's `.saturn/research` folder. Runs execute the project's own programs, on this computer or on an SSH host the user configured; the research assistant is an agent that works on those records through `research_*` tools, in the chat's mode (Ask, Approve, Auto, Agent).

An agent turn: the runtime sends the conversation and tool definitions to a model; the model asks for tool calls (read or write files, run shell commands, fetch pages, drive a browser, control desktop apps, call GitHub or MCP servers); the runtime decides each call against permission rules and the approval policy, runs it (shell commands inside an OS sandbox), records file changes in a checkpoint, and sends the results back.

## What it protects

| Asset | Where |
|---|---|
| Model provider API keys, OAuth tokens, MCP server secrets | `~/.saturn-app/secrets.json`, AES-256-GCM, key in the OS key store |
| The user's files, and the computer itself (commands run as the user) | Granted project folders; the whole machine for commands outside the sandbox and for computer use |
| Accounts tools can reach | GitHub (a token the user provides), signed-in sites in the agent browser's own profile |
| Research records and their integrity: what a run computed, which data and scorer a version froze, who set a verdict or a label | The project's `.saturn/research`; frozen inputs are hashed and locked against agents |
| Conversations, memory, telemetry | `~/.saturn-app`, local files |
| Claude Code and Codex sign-ins | Their own config folders; Saturn never reads them |

## Trust boundaries and threats

### 1. Content the agent reads (prompt injection)

Web pages, repository files, issue and review comments, MCP and tool results and screenshots are untrusted. Instructions in them can steer the model, and no model reliably ignores them. Saturn therefore does not rely on the model to resist: it limits what the model's calls can do.

- **Approvals and rules decide every call**, not the model: deny beats ask beats allow; a shell line is judged one command at a time; the built-in sensitive-operation check applies when no rule speaks (`crates/saturn-domain/src/permissions.rs`, `crates/saturn-domain/src/policies.rs`, `run_tools` in `crates/saturn-core/src/runs.rs`).
- **Rules that come with a folder cannot loosen approvals on their own.** A project's `.saturn/settings.json` and `.claude/settings.json` arrive with the repository, so their deny and ask rules apply at once, but their allow rules apply only after the user has reviewed and allowed that exact set; any change asks again. Rules that allow every shell command are refused wherever they come from (`crates/saturn-core/src/permissions.rs`).
- **The OS sandbox** confines shell commands' writes to the workspace, temp folders and package caches (macOS seatbelt, Linux bubblewrap); leaving it is an approval in every mode but full autonomy (`crates/saturn-tools/src/sandbox.rs`).
- **Checkpoints** record every change, including what shell commands change, so it can be reviewed and reverted (`crates/saturn-core/src/checkpoints.rs`).
- **Public addresses only** for the web tool and the Browser tab's page loader: loopback, private and link-local addresses, including names that resolve to them, are refused at the moment of connecting, on every redirect (`crates/saturn-domain/src/skills/public_address.rs`, `crates/saturn-tools/src/public_host.rs`). The agent browser's `browser_navigate` makes the same check before it opens a page, but the browser itself makes the connection, so see Known gaps.
- **The agent browser** uses its own profile, never the user's browser profile or sign-ins (`crates/saturn-browser/src/chrome.rs`). It needs an installed Chrome or relative. In Safari mode it is instead a separate Safari automation window, through Apple's `safaridriver`, with none of the user's logins (`crates/saturn-browser/src/safari.rs`).

Residual risk: within what the user has allowed, injected instructions act with the agent's full permissions. With the network on (the default), a command or a fetch can send data the agent can read to any public address. Full autonomy, broad allow rules and computer use (which controls the whole desktop) widen this. See [Reducing exposure](../README.md#reducing-exposure).

### 2. Other programs and web pages on the same computer

Loopback is not a trust boundary: any local process, and any web page through the user's browser, can reach `127.0.0.1`.

- The runtime listens on `127.0.0.1` only, rejects non-loopback `Host` headers (DNS rebinding) and gives non-local `Origin`s no cross-origin access (CORS) (`crates/saturn-server/src/guards.rs`).
- Every route needs `Authorization: Bearer <token>`; the token is in `~/.saturn-app/runtime-token`, mode `0600` (Windows has no such mode: the file has the permissions of the user profile's folder). Exceptions: `/health`; `/agent-mcp`, which takes a running Codex turn's own short-lived token instead (`crates/saturn-server/src/guards.rs`, `answer_agent_mcp` in `crates/saturn-core/src/agent_sessions.rs`).
- The desktop shell reads the token and gives it to the interface through a script that runs in the main frame only and only on the interface's own origin, so no frame and no other page sees it; the shell's own commands are allowed only to the interface's address. The interface embeds no web page and sets no HTML from content: model output is rendered as text and Markdown, and kept outputs as text or images, never executed. A project PDF is drawn page by page onto canvases by pdf.js in a worker from the app's own files, with no frame and no plugin, so the policy keeps `object-src 'none'` and allows no frames (`desktop/src/presentation/workspace/PdfView.tsx`) (`desktop/src-tauri/src/main.rs`, `desktop/src-tauri/src/bridge.js`, `desktop/src/presentation/FormattedOutput.tsx`, `desktop/src/presentation/experiments/Artifacts.tsx`).

Out of scope: a process already running as the same user can read the token file and the OS key store, as it can for any app.

### 3. Things that come with a folder or a plugin

- **Hooks** from a project or a plugin run only after the user has read and allowed that exact set, by fingerprint (`crates/saturn-core/src/hooks.rs`, `crates/saturn-core/src/plugins.rs`).
- **Local MCP servers** start only after the user has seen and allowed their exact command, arguments and variables, with a minimal environment that never includes Saturn's own (`crates/saturn-mcp/src/local.rs`, `crates/saturn-core/src/catalog.rs`).
- **Skills and rules files** (`AGENTS.md`, `CLAUDE.md`, `SKILL.md`) are instructions to the model, treated like any other untrusted content (threat 1).

### 4. Research evidence and remote hosts

- **Samples, model output, imported results and bundles are data.** They reach the assistant marked as data, outside its instructions; text in them is never a command (threat 1 still applies to what the model does with them) (`desktop/src/domain/assistant.ts`, `crates/saturn-core/src/research/data.rs`).
- **The person's decisions are not tools.** Verdicts, labels, the lock policy, the SSH host and merging have no agent tool; an agent's findings are always recorded as its suggestions, and a hypothesis it makes cannot be changed afterwards (`crates/saturn-core/src/research/agent.rs`, `crates/saturn-domain/src/research.rs`).
- **Frozen inputs are locked against agents.** File tools refuse to write a frozen version's data and scorer; a shell can still write them, and Saturn records the change afterwards under Protection, so this is a workflow constraint, not a security boundary (`crates/saturn-core/src/research/policy.rs`, `crates/saturn-core/src/research/checks.rs`).
- **A bundle brings evidence, never authority.** Import checks every file's size and hash, rejects symlinks and paths outside the research namespaces, refuses conflicting contents, and restores no permissions, credentials or settings; imported versions and sessions never execute and imported remote jobs never reconnect (`crates/saturn-core/src/research/bundles.rs`).
- **Remote runs use the user's SSH, not Saturn's.** Saturn stores no SSH credentials; it runs `ssh` with batch authentication and the user's own host verification, and reconnects only to jobs this computer started, recorded in its own data folder (`crates/saturn-core/src/research/remote.rs`).
- **Notebook kernels and environment jobs run code as the user**, like any command; for agents they are write tools, so an Ask chat cannot reach them and an Approve chat asks first (`crates/saturn-core/src/research/notebooks.rs`, `crates/saturn-core/src/research/environment.rs`).

### 5. Credentials

- Keys are encrypted at rest; the key is in the macOS Keychain, Windows DPAPI or the Linux Secret Service, passed to system tools on stdin (`crates/saturn-store/src/key_store.rs`, `crates/saturn-store/src/secrets.rs`).
- A key goes only to its own provider (`crates/saturn-llm/src/broker.rs`). Subscription sign-ins (Claude Code, Codex) stay in those programs' folders; Saturn never reads or forwards them (`crates/saturn-core/src/claude_code.rs`, `crates/saturn-core/src/codex.rs`).

### 6. Supply chain and updates

- No npm install scripts in the desktop app; npm lock file, registry signatures and an audit in CI; crates from crates.io only, with checksums in `Cargo.lock` and `cargo deny` in CI; GitHub Actions pinned to commit SHAs (`.github/workflows/supply-chain.yml`, `deny.toml`).
- Claude Code and Codex downloads are checked against pinned SHA-512 hashes (`crates/saturn-core/src/agent-programs.json`, `crates/saturn-core/src/agent_programs.rs`); the bundled embedding model and tokenizer against SHA-256 when the release is built (`desktop/scripts/fetch-embedding-model.mjs`).
- Releases carry SHA-256 files, a CycloneDX SBOM and signed build provenance (`.github/workflows/release.yml`).
- An update installs only with a valid signature from Saturn's updater key, whatever the operating system's signing says; a build made without that key has no updater (`desktop/src-tauri/src/update.rs`, `desktop/src-tauri/tauri.updater.json`).
- Reviewed, accepted advisories are listed in [`known-advisories.md`](known-advisories.md).

## Not defended against

- A malicious or compromised local user account, administrator or operating system.
- Harm an agent does within permissions the user gave it: full autonomy, allow rules, `sandbox: "off"` approvals, computer use.
- Model providers, Claude Code, Codex, MCP servers and other programs Saturn calls; they are trusted with what is sent to them.

## Known gaps

- **Windows has no command sandbox**; commands say so in their result.
- **The Windows version has been type-checked, not run,** since the rewrite in Rust and Tauri, so the Windows controls here are what the code does, untested in use.
- **macOS builds are not Developer ID-signed or notarized**, and Windows builds use a self-signed certificate, so users cannot rely on the OS to confirm a download's origin; the SHA-256 files and build provenance are the check.
- **Network access is on by default** inside the sandbox, so package installs work; switch it off per project for sensitive work.
- **A crate's build script runs at build time.** Cargo cannot deny it as npm can an install script, so a compromised crate could run code in CI or on a machine that builds Saturn.
- **The agent browser's address check covers `browser_navigate` only.** A page it opens can still redirect to, link to or load from a private address, because the browser makes those requests itself.
- **An experiment run's sandbox has limits.** It hides the project, Saturn's data and the usual credential folders, but not every file a program could misuse: a key kept elsewhere in the home folder can be read, and with the network allowed (the default) whatever the program reads can be sent anywhere. On macOS the keychain is reached through the system's own service, which asks the person; the shared temporary folders and the shared caches stay writable, so one run can leave files there for another. What the snapshot links to (an uncontrolled `.venv`, say) is readable. On Linux a program can overwrite its own run's `run.json` and `evidence.json`, which bubblewrap cannot keep read-only, so a Linux run's evidence is only as trustworthy as its program; on macOS it cannot. Where no sandbox works, or a version turns it off, the snapshot is protected by read-only permissions only, and a program can replace a file in it (which the check at the end records) and write anywhere the account can. A remote run's evidence is what the host's worker recorded; a compromised host can report anything.
- **No third-party security audit yet.**

## Assurance case

Why Saturn's security requirements are met: each requirement, the argument, and the evidence that can be checked. The controls are described above; the tests named here are in `contract/` and the crates' `tests/` folders. They run on Linux for every change and on macOS for every release; on Windows the workflows run the crates' tests only, and have not run on the Rust code yet.

### Requirements and evidence

| Requirement | Argument | Evidence |
|---|---|---|
| **R1. No tool call runs beyond what the user allowed.** | Every call passes `run_tools`: rules (deny before ask before allow, one shell command at a time), then the approval mode and the sensitive-operation check; rules that come with a folder cannot allow on their own; commands run in the OS sandbox; every change is checkpointed. | `contract/config-permissions.test.mjs` (rule order, Review mode, rules from project files held until allowed, allow-everything refused), `contract/loop.test.mjs`, `crates/saturn-tools/tests/tools.rs` (`on_macos_a_sandboxed_command_writes_inside_the_workspace_only`), `contract/files-shell-changes.test.mjs`, `contract/files-checkpoints.test.mjs` |
| **R2. Only the user's own clients can use the runtime.** | Loopback only; `Host` and `Origin` checks; a 256-bit token in a `0600` file on every route but the health probe and the OAuth redirect; the Codex route takes a per-turn token. | `contract/http.test.mjs`: "a request without the right token is refused", "a Host that is not loopback is refused, even with the token and on open paths", "only loopback origins are allowed across origins"; `contract/agent-programs-runs.test.mjs` |
| **R3. Credentials stay encrypted at rest and go only to their provider.** | AES-256-GCM with a random key in the OS key store and a random IV per write; authenticated, so tampering is detected; a key is attached only to its own provider's requests; values are never logged. | `crates/saturn-store/tests/data_folder.rs` (ciphertext only, tampering rejected, plaintext migrated, key store fallbacks), `crates/saturn-llm/tests/providers.rs` |
| **R4. The web tool and the Browser tab cannot reach this computer or the private network.** | Every such request is checked against loopback, private and link-local ranges in the connection's own DNS lookup and on every redirect. The agent browser checks only the address it is told to open (see Known gaps). | `crates/saturn-tools/tests/tools.rs` (`the_web_tool_does_not_reach_this_computer`), `contract/runs-flows.test.mjs` (the Browser tab's proxy), `contract/model-context.test.mjs`: "a browser tool refuses a private address before any browser starts", `contract/browser.test.mjs` |
| **R5. Things that come with a folder or plugin run only once allowed.** | Hooks, local MCP servers and project allow rules are approved by a fingerprint of exactly what the user saw; any change asks again. | `contract/config-hooks.test.mjs`, `contract/config-mcp.test.mjs`, `contract/mcp.test.mjs`, `contract/config-plugins.test.mjs`, `contract/config-permissions.test.mjs` |
| **R6. A download is what the public workflow built.** | Releases are built only by `release.yml` from a tagged commit; each file has a SHA-256 and signed build provenance; updates carry a signature from Saturn's updater key; Claude Code and Codex downloads are checked against pinned SHA-512; no npm install scripts run. | The attestations on every release (`gh attestation verify`), `contract/programs.test.mjs` ("the pinned downloads…", "a download that does not match its pin…"), `.github/workflows/supply-chain.yml` |

### Secure design principles

- **Least privilege**: agents get only the folders granted to them; shell commands write only inside the workspace, temp folders and package caches; workflow tokens are read-only unless a job needs more.
- **Fail-safe defaults**: the Default approval mode asks for risky operations; no rule means the normal approval applies; a missing or wrong token is refused; an unreadable secrets file is kept aside, never overwritten.
- **Complete mediation**: every tool call goes through `run_tools`, every API request through the authentication middleware, every web tool and Browser tab fetch through the address check.
- **Separation of privilege**: a project's own files can make rules stricter but cannot loosen them without the user.
- **Economy of mechanism**: one local runtime, one HTTP API for every client, no Saturn backend.
- **Open design**: the source, the threat model and the build are public; security does not rest on secrecy.
- **Psychological acceptability**: approvals show the exact command and why it asks; Always allow turns a decision into a visible, removable rule.

### Common weaknesses countered

| Weakness | How Saturn counters it | Where |
|---|---|---|
| OS command injection (CWE-78) | Arguments are passed as lists to `Command`, never interpolated into a shell line by Saturn; the agent's own shell commands are judged one command at a time and sandboxed | `crates/saturn-tools/src/shell.rs`, `crates/saturn-domain/src/permissions.rs`, `crates/saturn-tools/src/sandbox.rs` |
| Path traversal (CWE-22) | Paths resolve inside the workspace or a granted project; symlinks are resolved first; a revert writes only the files its checkpoint lists, inside that project's folder | `crates/saturn-domain/src/skills/workspace.rs`, `crates/saturn-tools/src/file.rs`, `crates/saturn-core/src/checkpoints.rs` |
| Server-side request forgery (CWE-918) | Public-address checks after resolution and on redirects | R4 |
| Cross-site request forgery and missing authentication (CWE-352, CWE-306) | Bearer token on every route, Origin and Host checks | R2 |
| Cleartext storage and exposure of credentials (CWE-312, CWE-532) | Encryption at rest, no secrets in logs or URLs | R3 |
| Untrusted content executing in the app (CWE-79) | The interface embeds no web page and sets no HTML from content; model output and kept outputs are rendered as text, Markdown or images, never executed; a project PDF is drawn onto canvases by pdf.js, with no frame or plugin | `desktop/src/presentation/FormattedOutput.tsx`, `desktop/src/presentation/experiments/Artifacts.tsx` |
| Inclusion of untrusted functionality (CWE-829) | Fingerprint approval of hooks, plugins and local MCP servers; pinned hashes for downloads | R5, R6 |

## Review scope

For an external audit, in priority order.

| Priority | Area | Code |
|---|---|---|
| 1 | Local API authentication: token, Host and Origin checks, the unauthenticated and Codex-token routes | `crates/saturn-server/src/guards.rs`, `auth.rs`, `crates/saturn-core/src/agent_sessions.rs`, `codex.rs` |
| 1 | Tool authorization: permission rules (including rules from project files), approvals, modes, sub-agents | `crates/saturn-domain/src/permissions.rs`, `policies.rs`, `crates/saturn-core/src/permissions.rs`, `runs.rs` |
| 1 | Command execution and the sandbox: shell selection, seatbelt and bubblewrap profiles, background jobs | `crates/saturn-tools/src/sandbox.rs`, `shell.rs`, `code.rs`, `jobs.rs` |
| 1 | File access scoping: workspace and project path resolution, symlinks | `crates/saturn-domain/src/skills/workspace.rs`, `crates/saturn-tools/src/file.rs`, `crates/saturn-core/src/projects.rs` |
| 2 | SSRF and fetching: public address checks, DNS rebinding, redirects, the Browser tab proxy | `crates/saturn-domain/src/skills/public_address.rs`, `crates/saturn-tools/src/public_host.rs`, `web.rs`, `crates/saturn-server/src/routes_admin.rs` |
| 2 | Hooks, plugins and local MCP servers: approval by fingerprint, environment passed | `crates/saturn-core/src/hooks.rs`, `plugins.rs`, `catalog.rs`, `crates/saturn-mcp/src/local.rs` |
| 2 | Credential storage and use | `crates/saturn-store/src/key_store.rs`, `secrets.rs`, `crates/saturn-llm/src/broker.rs`, `crates/saturn-server/src/auth.rs` |
| 2 | Desktop app: the Tauri shell and its bridge, its content security policy, permission requests, the updater | `desktop/src-tauri/src/main.rs`, `bridge.js`, `ui.rs`, `permissions.rs`, `update.rs` |
| 2 | Research evidence: bundle import, artifact snapshots, imports, remote workers and the SSH exchange | `crates/saturn-core/src/research/bundles.rs`, `artifacts.rs`, `imports.rs`, `remote.rs` |
| 3 | Agent browser and computer use: profile isolation, what reaches the model | `crates/saturn-browser/src/chrome.rs`, `safari.rs`, `crates/saturn-computer/src/lib.rs`, `macos.rs`, `windows.rs` |
| 3 | Checkpoints and revert: writes outside the folder, path traversal | `crates/saturn-core/src/checkpoints.rs` |
| 3 | Release and supply-chain workflows, downloads of Claude Code and Codex | `.github/workflows/`, `crates/saturn-core/src/agent-programs.json`, `agent_programs.rs` |

Useful for reviewers: `npm test` runs the runtime against fake model servers with no credentials; [Verify it yourself](../README.md#verify-it-yourself) shows how to observe every outbound request.

---

# 威脅模型

[English](#threat-model)

Saturn 保護什麼、防範誰、如何防範，以及刻意交由你決定的部分。本文寫給安全審查者，也寫給正在決定要給 Agent 多少自主權的人。每項控制都註明實作它的程式碼；[審查範圍](#審查範圍)列出外部審計應優先涵蓋的部分。回報問題請依 [`SECURITY.md`](../SECURITY.md)。

## 系統概要

Saturn 是一個桌面應用程式（Tauri 與系統的網頁檢視，`desktop/`），是本機 **Runtime**（`crates/`）的 client：一個在 `127.0.0.1:4700` 的 Rust HTTP 伺服器，負責執行 Agent 迴圈、呼叫模型供應商、執行工具，所有狀態存在 `~/.saturn-app`。`saturn` CLI 與 [SDK](https://github.com/Saturn-Technology-Project/Saturn-SDK)（獨立的 repository）也是同一套 API 的 client。Saturn 沒有伺服器，不會傳送任何資料給 Saturn 的開發者。

Saturn 是 AI 研究工作台。專案的研究紀錄（問題、假說、實驗、凍結的版本、執行、樣本、標註、發現）都是專案 `.saturn/research` 資料夾裡的檔案。執行跑的是專案自己的程式，在這台電腦或使用者設定的 SSH 主機上；研究助理是一個 Agent，依對話的模式（Ask、Approve、Auto、Agent）透過 `research_*` 工具處理這些紀錄。

Agent 的一個回合：Runtime 把對話與工具定義送給模型；模型要求呼叫工具（讀寫檔案、執行 shell 指令、擷取網頁、操作瀏覽器、操作桌面 App、呼叫 GitHub 或 MCP 伺服器）；Runtime 依權限規則與核准策略決定每個呼叫，執行它（shell 指令在作業系統沙箱中），把檔案變更記錄在檢查點，再把結果送回模型。

## 保護的資產

| 資產 | 位置 |
|---|---|
| 模型供應商 API 金鑰、OAuth token、MCP 伺服器的機密 | `~/.saturn-app/secrets.json`，AES-256-GCM，金鑰在作業系統金鑰庫 |
| 使用者的檔案，以及電腦本身（指令以使用者身分執行） | 授權的專案資料夾；沙箱外的指令與電腦操作則是整台電腦 |
| 工具能觸及的帳號 | GitHub（使用者提供的 token）、Agent 瀏覽器自有設定檔中登入的網站 |
| 研究紀錄及其完整性：一次執行實際算了什麼、版本凍結了哪些資料與評分器、判定與標註由誰設定 | 專案的 `.saturn/research`；凍結的輸入有雜湊值，並對 Agent 鎖定 |
| 對話、記憶、遙測 | `~/.saturn-app` 的本機檔案 |
| Claude Code 與 Codex 的登入 | 各自的設定資料夾；Saturn 從不讀取 |

## 信任邊界與威脅

### 1. Agent 讀到的內容（提示注入）

網頁、repository 的檔案、issue 與 review 留言、MCP 與工具結果、截圖都不可信。其中的指示能影響模型，而沒有任何模型能可靠地忽略它們。因此 Saturn 不依賴模型自己抵抗，而是限制模型的呼叫能做什麼。

- **每個呼叫由核准與規則決定**，不是模型：拒絕優先於詢問，詢問優先於允許；shell 指令串逐一判斷；沒有規則適用時套用內建的敏感操作檢查（`crates/saturn-domain/src/permissions.rs`、`crates/saturn-domain/src/policies.rs`、`crates/saturn-core/src/runs.rs` 的 `run_tools`）。
- **隨資料夾而來的規則不能自行放寬核准。** 專案的 `.saturn/settings.json` 與 `.claude/settings.json` 隨 repository 而來，其中的拒絕與詢問規則立即生效，允許規則則要在使用者看過並允許那一組規則後才生效；任何變更都會再次詢問。允許所有 shell 指令的規則無論來自哪裡都會被拒絕（`crates/saturn-core/src/permissions.rs`）。
- **作業系統沙箱**把 shell 指令的寫入限制在工作目錄、暫存資料夾與套件快取（macOS seatbelt、Linux bubblewrap）；離開沙箱在完全自主以外的所有模式都需要核准（`crates/saturn-tools/src/sandbox.rs`）。
- **檢查點**記錄每一次變更，包含 shell 指令造成的變更，可供檢視與還原（`crates/saturn-core/src/checkpoints.rs`）。
- **只允許公開位址**：web 工具與 Browser 分頁的頁面載入器，會在建立連線時與每次重新導向時拒絕 loopback、私有與 link-local 位址，包括解析到這些位址的網域名稱（`crates/saturn-domain/src/skills/public_address.rs`、`crates/saturn-tools/src/public_host.rs`）。Agent 瀏覽器的 `browser_navigate` 在開啟頁面前也做同樣檢查，但實際連線由瀏覽器自己建立，見已知缺口。
- **Agent 瀏覽器**使用自己的設定檔，從不使用使用者瀏覽器的設定檔或登入（`crates/saturn-browser/src/chrome.rs`）。它需要已安裝的 Chrome 或同類瀏覽器。Safari 模式則是透過 Apple 的 `safaridriver` 開啟的獨立 Safari 自動化視窗，沒有使用者的任何登入（`crates/saturn-browser/src/safari.rs`）。

剩餘風險：在使用者允許的範圍內，被注入的指示能以 Agent 的完整權限行動。網路開啟時（預設），指令或擷取可以把 Agent 讀得到的資料送到任何公開位址。完全自主、範圍廣的允許規則與電腦操作（可控制整個桌面）都會擴大這個風險。見[降低風險](../README_ZH.md)。

### 2. 同一台電腦上的其他程式與網頁

loopback 不是信任邊界：任何本機程式，以及透過使用者瀏覽器的任何網頁，都能連到 `127.0.0.1`。

- Runtime 只監聽 `127.0.0.1`，拒絕非 loopback 的 `Host` 標頭（DNS rebinding），並且不給非本機的 `Origin` 任何跨來源存取（CORS）（`crates/saturn-server/src/guards.rs`）。
- 每個路由都需要 `Authorization: Bearer <token>`；token 存於 `~/.saturn-app/runtime-token`，權限 `0600`（Windows 沒有這種權限：檔案沿用使用者設定檔資料夾的權限）。例外：`/health`；`/agent-mcp`，改用執行中 Codex 回合自己的短期 token（`crates/saturn-server/src/guards.rs`、`crates/saturn-core/src/agent_sessions.rs` 的 `answer_agent_mcp`）。
- 桌面外殼讀取 token，並透過只在主 frame、且只在介面自己的 origin 上執行的腳本交給介面，所以沒有任何 iframe 或其他頁面看得到；外殼自己的指令只開放給介面的位址。介面不嵌入任何網頁，也不從內容設定 HTML：模型輸出以文字與 Markdown 呈現，保存的產出以文字或圖片呈現，都不會被執行。專案裡的 PDF 由 pdf.js 在 App 自己檔案中的 worker 裡逐頁繪製到畫布上，不使用框架或外掛，所以政策維持 `object-src 'none'` 且不允許任何框架（`desktop/src/presentation/workspace/PdfView.tsx`）（`desktop/src-tauri/src/main.rs`、`desktop/src-tauri/src/bridge.js`、`desktop/src/presentation/FormattedOutput.tsx`、`desktop/src/presentation/experiments/Artifacts.tsx`）。

範圍外：已經以同一使用者身分執行的程式能讀取 token 檔與作業系統金鑰庫，這對任何 App 都一樣。

### 3. 隨資料夾或外掛而來的東西

- 專案或外掛的 **hooks** 要在使用者看過並允許那一組（依指紋）後才會執行（`crates/saturn-core/src/hooks.rs`、`crates/saturn-core/src/plugins.rs`）。
- **本機 MCP 伺服器**要在使用者看過並允許其確切的指令、參數與變數後才會啟動，且只拿到最小的環境變數，從不包含 Saturn 自己的（`crates/saturn-mcp/src/local.rs`、`crates/saturn-core/src/catalog.rs`）。
- **Skills 與規則檔**（`AGENTS.md`、`CLAUDE.md`、`SKILL.md`）是給模型的指示，與其他不可信內容同樣看待（威脅 1）。

### 4. 研究證據與遠端主機

- **樣本、模型輸出、匯入的結果與研究包都是資料。** 它們以「資料」的標記送到研究助理，放在指示之外；其中的文字永遠不是指令（模型拿它們做什麼，仍適用威脅 1）（`desktop/src/domain/assistant.ts`、`crates/saturn-core/src/research/data.rs`）。
- **人的決定不是工具。** 判定、標註、鎖定政策、SSH 主機與合併都沒有 Agent 工具；Agent 的發現一律記為它的建議，它建立的假說之後無法更改（`crates/saturn-core/src/research/agent.rs`、`crates/saturn-domain/src/research.rs`）。
- **凍結的輸入對 Agent 鎖定。** 檔案工具拒絕寫入凍結版本的資料與評分器；shell 仍可能寫入，Saturn 會在事後記錄在「防護」中，所以這是工作流程約束，不是安全邊界（`crates/saturn-core/src/research/policy.rs`、`crates/saturn-core/src/research/checks.rs`）。
- **研究包只帶來證據，不帶來權限。** 匯入時檢查每個檔案的大小與雜湊值，拒絕符號連結與研究命名空間以外的路徑，拒絕內容衝突，也不還原任何權限、憑證或設定；匯入的版本與工作階段永遠不會執行，匯入的遠端工作永遠不會重新連線（`crates/saturn-core/src/research/bundles.rs`）。
- **遠端執行用的是使用者的 SSH，不是 Saturn 的。** Saturn 不儲存任何 SSH 憑證；它以批次驗證和使用者自己的主機驗證執行 `ssh`，而且只重新連線到這台電腦啟動、記錄在自己資料資料夾中的工作（`crates/saturn-core/src/research/remote.rs`）。
- **筆記本核心與環境工作以使用者身分執行程式碼**，與任何指令相同；對 Agent 來說它們是寫入工具，所以 Ask 對話碰不到，Approve 對話會先詢問（`crates/saturn-core/src/research/notebooks.rs`、`crates/saturn-core/src/research/environment.rs`）。

### 5. 憑證

- 金鑰靜態加密；加密金鑰存於 macOS 鑰匙圈、Windows DPAPI 或 Linux Secret Service，並經由 stdin 傳給系統工具（`crates/saturn-store/src/key_store.rs`、`crates/saturn-store/src/secrets.rs`）。
- 每把金鑰只會送到它自己的供應商（`crates/saturn-llm/src/broker.rs`）。訂閱方案的登入（Claude Code、Codex）留在那些程式的資料夾中；Saturn 從不讀取或轉送（`crates/saturn-core/src/claude_code.rs`、`crates/saturn-core/src/codex.rs`）。

### 6. 供應鏈與更新

- 桌面應用程式不執行 npm 安裝腳本；CI 檢查 npm lock 檔、registry 簽章與 audit；crate 只來自 crates.io，以 `Cargo.lock` 的校驗碼固定，CI 執行 `cargo deny`；GitHub Actions 固定到 commit SHA（`.github/workflows/supply-chain.yml`、`deny.toml`）。
- Claude Code 與 Codex 的下載以固定的 SHA-512 驗證（`crates/saturn-core/src/agent-programs.json`、`crates/saturn-core/src/agent_programs.rs`）；內建的嵌入模型與 tokenizer 在建置發行版時以 SHA-256 驗證（`desktop/scripts/fetch-embedding-model.mjs`）。
- 每次發布附 SHA-256 檔、CycloneDX SBOM 與簽章的建置來源證明（`.github/workflows/release.yml`）。
- 更新只有在帶有 Saturn 更新金鑰的有效簽章時才會安裝，與作業系統的簽章無關；沒有這把金鑰建置的版本沒有更新功能（`desktop/src-tauri/src/update.rs`、`desktop/src-tauri/tauri.updater.json`）。
- 審視過並接受的公告列於 [`known-advisories.md`](known-advisories.md)。

## 不防範的情況

- 惡意或已遭入侵的本機使用者帳號、管理員或作業系統。
- Agent 在使用者給予的權限內造成的損害：完全自主、允許規則、核准過的 `sandbox: "off"`、電腦操作。
- 模型供應商、Claude Code、Codex、MCP 伺服器與 Saturn 呼叫的其他程式；它們被信任能處理送給它們的內容。

## 已知缺口

- **Windows 沒有指令沙箱**；指令的結果會註明。
- **改寫為 Rust 與 Tauri 之後，Windows 版本只做過型別檢查，尚未實際執行**，所以這裡關於 Windows 的控制是程式碼的行為，尚未經實際使用驗證。
- **macOS 版本未以 Developer ID 簽章或公證**，Windows 版本使用自簽憑證，使用者無法依賴作業系統確認下載來源；應以 SHA-256 檔與建置來源證明檢查。
- **沙箱內預設可連網**，以便安裝套件；處理敏感工作時可針對專案關閉。
- **crate 的 build script 會在建置時執行。** Cargo 無法像 npm 拒絕安裝腳本那樣拒絕它，所以遭入侵的 crate 可能在 CI 或建置 Saturn 的電腦上執行程式碼。
- **Agent 瀏覽器的位址檢查只涵蓋 `browser_navigate`。** 它開啟的頁面仍可能重新導向、連結或載入私有位址，因為這些請求由瀏覽器自己發出。
- **執行快照只以唯讀權限保護，並非隔離。** 實驗程式仍可替換快照中的檔案（結束時的核對會記錄下來），也能透過連結的未受控資料夾寫入專案。遠端執行的證據是主機上的 worker 所記錄的內容；遭入侵的主機可以回報任何內容。
- **尚未經過第三方安全審計。**

## 保證論證

Saturn 的安全需求為何成立：每一項需求、論證，以及可檢驗的證據。各項控制已在上文說明；這裡列出的測試位於 `contract/` 與各 crate 的 `tests/` 資料夾，在每次變更時於 Linux、每次發布時於 macOS 執行；Windows 的 workflow 只跑 crate 的測試，且還沒有在 Rust 程式碼上執行過。

### 需求與證據

| 需求 | 論證 | 證據 |
|---|---|---|
| **R1. 工具呼叫不會超出使用者允許的範圍。** | 每個呼叫都經過 `run_tools`：先看規則（拒絕優先於詢問，詢問優先於允許，shell 指令逐一判斷），再看核准模式與敏感操作檢查；隨資料夾而來的規則無法自行允許；指令在作業系統沙箱中執行；每次變更都有檢查點。 | `contract/config-permissions.test.mjs`（規則順序、Review 模式、專案檔案的規則在允許前暫緩、允許一切的規則被拒絕）、`contract/loop.test.mjs`、`crates/saturn-tools/tests/tools.rs`（`on_macos_a_sandboxed_command_writes_inside_the_workspace_only`）、`contract/files-shell-changes.test.mjs`、`contract/files-checkpoints.test.mjs` |
| **R2. 只有使用者自己的 client 能使用 Runtime。** | 只監聽 loopback；檢查 `Host` 與 `Origin`；除健康檢查與 OAuth 重新導向外，每個路由都需要存於 `0600` 檔案的 256 位元 token；Codex 的路由改用每回合的 token。 | `contract/http.test.mjs`：「a request without the right token is refused」、「a Host that is not loopback is refused, even with the token and on open paths」、「only loopback origins are allowed across origins」；`contract/agent-programs-runs.test.mjs` |
| **R3. 憑證靜態加密，且只送到它自己的供應商。** | AES-256-GCM，隨機金鑰存於作業系統金鑰庫，每次寫入使用隨機 IV；具驗證性，竄改會被發現；金鑰只附加在其供應商的請求上；值從不記錄於 log。 | `crates/saturn-store/tests/data_folder.rs`（只有密文、拒絕被竄改的內容、明文自動遷移、金鑰庫的備援）、`crates/saturn-llm/tests/providers.rs` |
| **R4. Web 工具與 Browser 分頁無法連到這台電腦或私有網路。** | 每個這類請求都在連線自己的 DNS 查詢中與每次重新導向時，檢查是否為 loopback、私有或 link-local 位址。Agent 瀏覽器只檢查它被要求開啟的位址（見已知缺口）。 | `crates/saturn-tools/tests/tools.rs`（`the_web_tool_does_not_reach_this_computer`）、`contract/runs-flows.test.mjs`（Browser 分頁的代理）、`contract/model-context.test.mjs`：「a browser tool refuses a private address before any browser starts」、`contract/browser.test.mjs` |
| **R5. 隨資料夾或外掛而來的東西，要經允許才會執行。** | Hooks、本機 MCP 伺服器與專案的允許規則，都以使用者實際看到內容的指紋核准；任何變更都會再次詢問。 | `contract/config-hooks.test.mjs`、`contract/config-mcp.test.mjs`、`contract/mcp.test.mjs`、`contract/config-plugins.test.mjs`、`contract/config-permissions.test.mjs` |
| **R6. 下載檔就是公開 workflow 建置的成果。** | 發布只由 `release.yml` 從打了 tag 的 commit 建置；每個檔案都有 SHA-256 與簽署的建置來源證明；更新帶有 Saturn 更新金鑰的簽章；Claude Code 與 Codex 的下載以固定的 SHA-512 驗證；不執行 npm 安裝腳本。 | 每次發布附的證明（`gh attestation verify`）、`contract/programs.test.mjs`（「the pinned downloads…」、「a download that does not match its pin…」）、`.github/workflows/supply-chain.yml` |

### 安全設計原則

- **最小權限**：Agent 只取得授權的資料夾；shell 指令只能寫入工作目錄、暫存資料夾與套件快取；workflow 的 token 除非 job 需要，否則唯讀。
- **預設安全**：Default 核准模式會對有風險的操作詢問；沒有規則就套用一般核准；缺少或錯誤的 token 一律拒絕；無法讀取的機密檔案會被保留在旁，從不覆寫。
- **完全仲裁**：每個工具呼叫都經過 `run_tools`，每個 API 請求都經過驗證 middleware，web 工具與 Browser 分頁的每次擷取都經過位址檢查。
- **權限分離**：專案自己的檔案可以讓規則更嚴格，但未經使用者同意不能放寬。
- **機制精簡**：一個本機 Runtime、所有 client 共用一套 HTTP API、沒有 Saturn 後端。
- **公開設計**：原始碼、威脅模型與建置都是公開的；安全性不依賴保密。
- **心理可接受性**：核准卡顯示確切的指令與詢問的原因；「永遠允許」會把決定變成一條看得見、可刪除的規則。

### 已對應的常見弱點

| 弱點 | Saturn 的對應方式 | 位置 |
|---|---|---|
| 作業系統指令注入（CWE-78） | Saturn 以清單把參數傳給 `Command`，從不把值插入 shell 指令串；Agent 自己的 shell 指令逐一判斷並在沙箱中執行 | `crates/saturn-tools/src/shell.rs`、`crates/saturn-domain/src/permissions.rs`、`crates/saturn-tools/src/sandbox.rs` |
| 路徑穿越（CWE-22） | 路徑解析在工作目錄或授權的專案內；先解析符號連結；還原只寫入其檢查點列出、且位於該專案資料夾內的檔案 | `crates/saturn-domain/src/skills/workspace.rs`、`crates/saturn-tools/src/file.rs`、`crates/saturn-core/src/checkpoints.rs` |
| 伺服器端請求偽造（CWE-918） | 解析後與重新導向時檢查公開位址 | R4 |
| 跨站請求偽造與缺少驗證（CWE-352、CWE-306） | 每個路由都需要 Bearer token，並檢查 Origin 與 Host | R2 |
| 憑證以明文儲存或外洩（CWE-312、CWE-532） | 靜態加密，log 與網址中沒有機密 | R3 |
| 不可信內容在 App 中執行（CWE-79） | 介面不嵌入任何網頁，也不從內容設定 HTML；模型輸出與保存的產出以文字、Markdown 或圖片呈現，不會被執行；專案的 PDF 由 pdf.js 繪製到畫布上，不使用框架或外掛 | `desktop/src/presentation/FormattedOutput.tsx`、`desktop/src/presentation/experiments/Artifacts.tsx` |
| 引入不可信的功能（CWE-829） | 以指紋核准 hooks、外掛與本機 MCP 伺服器；下載檔以固定雜湊驗證 | R5、R6 |

## 審查範圍

外部審計依優先順序涵蓋以下部分。

| 優先 | 範圍 | 程式碼 |
|---|---|---|
| 1 | 本機 API 驗證：token、Host 與 Origin 檢查、免驗證與 Codex token 的路由 | `crates/saturn-server/src/guards.rs`、`auth.rs`、`crates/saturn-core/src/agent_sessions.rs`、`codex.rs` |
| 1 | 工具授權：權限規則（含專案檔案中的規則）、核准、模式、子 Agent | `crates/saturn-domain/src/permissions.rs`、`policies.rs`、`crates/saturn-core/src/permissions.rs`、`runs.rs` |
| 1 | 指令執行與沙箱：shell 選擇、seatbelt 與 bubblewrap 設定、背景工作 | `crates/saturn-tools/src/sandbox.rs`、`shell.rs`、`code.rs`、`jobs.rs` |
| 1 | 檔案存取範圍：工作目錄與專案路徑解析、符號連結 | `crates/saturn-domain/src/skills/workspace.rs`、`crates/saturn-tools/src/file.rs`、`crates/saturn-core/src/projects.rs` |
| 2 | SSRF 與擷取：公開位址檢查、DNS rebinding、重新導向、Browser 分頁代理 | `crates/saturn-domain/src/skills/public_address.rs`、`crates/saturn-tools/src/public_host.rs`、`web.rs`、`crates/saturn-server/src/routes_admin.rs` |
| 2 | Hooks、外掛與本機 MCP 伺服器：依指紋核准、傳入的環境變數 | `crates/saturn-core/src/hooks.rs`、`plugins.rs`、`catalog.rs`、`crates/saturn-mcp/src/local.rs` |
| 2 | 憑證的儲存與使用 | `crates/saturn-store/src/key_store.rs`、`secrets.rs`、`crates/saturn-llm/src/broker.rs`、`crates/saturn-server/src/auth.rs` |
| 2 | 桌面應用程式：Tauri 外殼與其橋接、內容安全政策、權限請求、更新程式 | `desktop/src-tauri/src/main.rs`、`bridge.js`、`ui.rs`、`permissions.rs`、`update.rs` |
| 2 | 研究證據：研究包匯入、產出快照、匯入結果、遠端 worker 與 SSH 交換 | `crates/saturn-core/src/research/bundles.rs`、`artifacts.rs`、`imports.rs`、`remote.rs` |
| 3 | Agent 瀏覽器與電腦操作：設定檔隔離、哪些內容會送到模型 | `crates/saturn-browser/src/chrome.rs`、`safari.rs`、`crates/saturn-computer/src/lib.rs`、`macos.rs`、`windows.rs` |
| 3 | 檢查點與還原：寫到資料夾外、路徑穿越 | `crates/saturn-core/src/checkpoints.rs` |
| 3 | 發布與供應鏈 workflow、Claude Code 與 Codex 的下載 | `.github/workflows/`、`crates/saturn-core/src/agent-programs.json`、`agent_programs.rs` |

給審查者：`npm test` 會以假的模型伺服器執行 Runtime，不需要任何憑證；[自行驗證](../README_ZH.md)說明如何觀察每一個對外請求。
