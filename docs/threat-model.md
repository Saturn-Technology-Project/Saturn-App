# Threat model

[中文](#威脅模型)

What Saturn protects, from whom, how, and what it deliberately leaves to you. It is written for security reviewers and for anyone deciding how much autonomy to give an agent. Each control names the code that implements it; [Review scope](#review-scope) lists what an external audit should cover first. Report a problem as described in [`SECURITY.md`](../SECURITY.md).

## The system

Saturn is a desktop app (Electron, `desktop/`) and Saturn IDE (Code-OSS, `Saturn-IDE/`), both clients of one local **runtime** (`runtime/`): a Node.js HTTP server on `127.0.0.1:4700` that runs the agent loop, calls model providers, executes tools and keeps all state in `~/.saturn-app`. The `saturn` CLI and the SDK (`packages/sdk/`) are clients of the same API. There is no Saturn server: nothing is sent to Saturn's developers.

An agent turn: the runtime sends the conversation and tool definitions to a model; the model asks for tool calls (read or write files, run shell commands, fetch pages, drive a browser, control desktop apps, call GitHub or MCP servers); the runtime decides each call against permission rules and the approval policy, runs it (shell commands inside an OS sandbox), records file changes in a checkpoint, and sends the results back.

## What it protects

| Asset | Where |
|---|---|
| Model provider API keys, OAuth tokens, MCP server secrets | `~/.saturn-app/secrets.json`, AES-256-GCM, key in the OS key store |
| The user's files, and the computer itself (commands run as the user) | Granted project folders; the whole machine for commands outside the sandbox and for computer use |
| Accounts tools can reach | GitHub (a token the user provides), signed-in sites in the agent browser's own profile |
| Conversations, memory, code index, telemetry | `~/.saturn-app`, local files |
| Claude Code and Codex sign-ins | Their own config folders; Saturn never reads them |

## Trust boundaries and threats

### 1. Content the agent reads (prompt injection)

Web pages, repository files, issue and review comments, MCP and tool results and screenshots are untrusted. Instructions in them can steer the model, and no model reliably ignores them. Saturn therefore does not rely on the model to resist: it limits what the model's calls can do.

- **Approvals and rules decide every call**, not the model: deny beats ask beats allow; a shell line is judged one command at a time; the built-in sensitive-operation check applies when no rule speaks (`domain/permissions.ts`, `domain/policies.ts`, `application/runs.ts` `runTools`).
- **Rules that come with a folder cannot loosen approvals on their own.** A project's `.saturn/settings.json` and `.claude/settings.json` arrive with the repository, so their deny and ask rules apply at once, but their allow rules apply only after the user has reviewed and allowed that exact set; any change asks again. Rules that allow every shell command are refused wherever they come from (`application/permissions.ts`).
- **The OS sandbox** confines shell commands' writes to the workspace, temp folders and package caches (macOS seatbelt, Linux bubblewrap); leaving it is an approval in every mode but full autonomy (`infrastructure/sandbox.ts`).
- **Checkpoints** record every change, including what shell commands change, so it can be reviewed and reverted (`application/checkpoints.ts`).
- **Public addresses only** for the web and browser tools and the Browser tab's page loader: loopback, private and link-local addresses, including names that resolve to them, are refused (`domain/skills/public-address.ts`, `infrastructure/public-host.ts`).
- **The agent browser** uses its own profile, never the user's browser profile or sign-ins (`infrastructure/skills/browser-skill.ts`).

Residual risk: within what the user has allowed, injected instructions act with the agent's full permissions. With the network on (the default), a command or a fetch can send data the agent can read to any public address. Full autonomy, broad allow rules and computer use (which controls the whole desktop) widen this. See [Reducing exposure](../README.md#reducing-exposure).

### 2. Other programs and web pages on the same computer

Loopback is not a trust boundary: any local process, and any web page through the user's browser, can reach `127.0.0.1`.

- The runtime listens on `127.0.0.1` only, rejects non-loopback `Host` headers (DNS rebinding) and non-local `Origin`s (CORS) (`presentation/app.ts`).
- Every route needs `Authorization: Bearer <token>`; the token is in `~/.saturn-app/runtime-token`, mode `0600`. Exceptions: `/health`; `/oauth/callback` (the provider's redirect); `/agent-mcp`, which takes a running Codex turn's own short-lived token instead (`presentation/agent-skills-controller.ts`).
- The desktop app gets the token from its main process; pages it shows from the internet are sandboxed frames without the app's origin (`desktop/src/presentation/Inspector.tsx`).

Out of scope: a process already running as the same user can read the token file and the OS key store, as it can for any app.

### 3. Things that come with a folder or a plugin

- **Hooks** from a project or a plugin run only after the user has read and allowed that exact set, by fingerprint (`application/hooks.ts`, `application/plugins.ts`).
- **Local MCP servers** start only after the user has seen and allowed their exact command, arguments and variables, with a minimal environment that never includes Saturn's own (`infrastructure/mcp.ts`, `application/mcp-command.ts`).
- **Skills and rules files** (`AGENTS.md`, `CLAUDE.md`, `SKILL.md`) are instructions to the model, treated like any other untrusted content (threat 1).

### 4. Credentials

- Keys are encrypted at rest; the key is in the macOS Keychain, Windows DPAPI or the Linux Secret Service, passed to system tools on stdin (`infrastructure/secret-key.ts`, `infrastructure/secrets-file.ts`).
- A key goes only to its own provider (`infrastructure/llm.ts`). Subscription sign-ins (Claude Code, Codex) stay in those programs' folders; Saturn never reads or forwards them (`application/claude-code.ts`, `application/codex.ts`).

### 5. Supply chain and updates

- No dependency install scripts in the runtime or the desktop app; lock files, registry signatures and an audit in CI; GitHub Actions pinned to commit SHAs (`.github/workflows/supply-chain.yml`).
- Claude Code and Codex downloads are checked against pinned SHA-512 hashes (`infrastructure/agent-programs-manifest.ts`); the embedding model against SHA-256.
- Releases carry SHA-256 files, a CycloneDX SBOM and signed build provenance (`.github/workflows/release.yml`).
- Reviewed, accepted advisories are listed in [`known-advisories.md`](known-advisories.md).

## Not defended against

- A malicious or compromised local user account, administrator or operating system.
- Harm an agent does within permissions the user gave it: full autonomy, allow rules, `sandbox: "off"` approvals, computer use.
- Model providers, Claude Code, Codex, MCP servers and other programs Saturn calls; they are trusted with what is sent to them.
- Code-OSS itself, beyond the changes listed in [`Saturn-IDE/UPSTREAM.md`](../Saturn-IDE/UPSTREAM.md).

## Known gaps

- **Windows has no command sandbox**; commands say so in their result.
- **macOS builds are not Developer ID-signed or notarized**, and Windows builds use a self-signed certificate, so users cannot rely on the OS to confirm a download's origin; the SHA-256 files and build provenance are the check.
- **Network access is on by default** inside the sandbox, so package installs work; switch it off per project for sensitive work.
- **No third-party security audit yet.**

## Review scope

For an external audit, in priority order. Saturn IDE is upstream Code-OSS and out of scope except the listed changes.

| Priority | Area | Code |
|---|---|---|
| 1 | Local API authentication: token, Host and Origin checks, the unauthenticated and Codex-token routes | `runtime/src/presentation/app.ts`, `presentation/agent-skills-controller.ts`, `application/codex.ts` |
| 1 | Tool authorization: permission rules (including rules from project files), approvals, modes, sub-agents | `runtime/src/domain/permissions.ts`, `application/permissions.ts`, `domain/policies.ts`, `application/runs.ts` |
| 1 | Command execution and the sandbox: shell selection, seatbelt and bubblewrap profiles, background jobs | `runtime/src/infrastructure/sandbox.ts`, `infrastructure/shell.ts`, `infrastructure/skills/code-skill.ts`, `infrastructure/jobs.ts` |
| 1 | File access scoping: workspace and project path resolution, symlinks | `runtime/src/domain/skills/workspace.ts`, `infrastructure/skills/file-skill.ts`, `application/projects.ts` |
| 2 | SSRF and fetching: public address checks, DNS rebinding, redirects, the Browser tab proxy | `runtime/src/domain/skills/public-address.ts`, `infrastructure/public-host.ts`, `infrastructure/skills/web-skill.ts`, `presentation/workspace-controller.ts` |
| 2 | Hooks, plugins and local MCP servers: approval by fingerprint, environment passed | `runtime/src/application/hooks.ts`, `application/plugins.ts`, `infrastructure/mcp.ts`, `application/mcp-command.ts` |
| 2 | Credential storage and use | `runtime/src/infrastructure/secret-key.ts`, `infrastructure/secrets-file.ts`, `infrastructure/llm.ts`, `infrastructure/auth.ts` |
| 2 | Desktop app: main/preload bridge, frames showing web content, permission requests | `desktop/electron.cjs`, `desktop/preload.cjs`, `desktop/src/presentation/Inspector.tsx` |
| 3 | Agent browser and computer use: profile isolation, what reaches the model | `runtime/src/infrastructure/skills/browser-skill.ts`, `safari-browser.ts`, `computer-use-skill.ts`, `macos.ts`, `windows.ts` |
| 3 | Checkpoints and revert: writes outside the folder, path traversal | `runtime/src/application/checkpoints.ts` |
| 3 | Saturn IDE's Saturn extension and its bridge to the runtime | `Saturn-IDE/extensions/saturn/`, `runtime/src/application/ide-bridge.ts` |
| 3 | Release and supply-chain workflows, downloads of Claude Code and Codex | `.github/workflows/`, `runtime/src/infrastructure/agent-programs-manifest.ts`, `application/agent-programs.ts` |

Useful for reviewers: `npm test` runs the runtime against fake model servers with no credentials; [Verify it yourself](../README.md#verify-it-yourself) shows how to observe every outbound request.

---

# 威脅模型

[English](#threat-model)

Saturn 保護什麼、防範誰、如何防範，以及刻意交由你決定的部分。本文寫給安全審查者，也寫給正在決定要給 Agent 多少自主權的人。每項控制都註明實作它的程式碼；[審查範圍](#審查範圍)列出外部審計應優先涵蓋的部分。回報問題請依 [`SECURITY.md`](../SECURITY.md)。

## 系統概要

Saturn 由桌面應用程式（Electron，`desktop/`）與 Saturn IDE（Code-OSS，`Saturn-IDE/`）組成，兩者都是同一個本機 **Runtime**（`runtime/`）的 client：一個在 `127.0.0.1:4700` 的 Node.js HTTP 伺服器，負責執行 Agent 迴圈、呼叫模型供應商、執行工具，所有狀態存在 `~/.saturn-app`。`saturn` CLI 與 SDK（`packages/sdk/`）也是同一套 API 的 client。Saturn 沒有伺服器，不會傳送任何資料給 Saturn 的開發者。

Agent 的一個回合：Runtime 把對話與工具定義送給模型；模型要求呼叫工具（讀寫檔案、執行 shell 指令、擷取網頁、操作瀏覽器、操作桌面 App、呼叫 GitHub 或 MCP 伺服器）；Runtime 依權限規則與核准策略決定每個呼叫，執行它（shell 指令在作業系統沙箱中），把檔案變更記錄在檢查點，再把結果送回模型。

## 保護的資產

| 資產 | 位置 |
|---|---|
| 模型供應商 API 金鑰、OAuth token、MCP 伺服器的機密 | `~/.saturn-app/secrets.json`，AES-256-GCM，金鑰在作業系統金鑰庫 |
| 使用者的檔案，以及電腦本身（指令以使用者身分執行） | 授權的專案資料夾；沙箱外的指令與電腦操作則是整台電腦 |
| 工具能觸及的帳號 | GitHub（使用者提供的 token）、Agent 瀏覽器自有設定檔中登入的網站 |
| 對話、記憶、程式碼索引、遙測 | `~/.saturn-app` 的本機檔案 |
| Claude Code 與 Codex 的登入 | 各自的設定資料夾；Saturn 從不讀取 |

## 信任邊界與威脅

### 1. Agent 讀到的內容（提示注入）

網頁、repository 的檔案、issue 與 review 留言、MCP 與工具結果、截圖都不可信。其中的指示能影響模型，而沒有任何模型能可靠地忽略它們。因此 Saturn 不依賴模型自己抵抗，而是限制模型的呼叫能做什麼。

- **每個呼叫由核准與規則決定**，不是模型：拒絕優先於詢問，詢問優先於允許；shell 指令串逐一判斷；沒有規則適用時套用內建的敏感操作檢查（`domain/permissions.ts`、`domain/policies.ts`、`application/runs.ts` 的 `runTools`）。
- **隨資料夾而來的規則不能自行放寬核准。** 專案的 `.saturn/settings.json` 與 `.claude/settings.json` 隨 repository 而來，其中的拒絕與詢問規則立即生效，允許規則則要在使用者看過並允許那一組規則後才生效；任何變更都會再次詢問。允許所有 shell 指令的規則無論來自哪裡都會被拒絕（`application/permissions.ts`）。
- **作業系統沙箱**把 shell 指令的寫入限制在工作目錄、暫存資料夾與套件快取（macOS seatbelt、Linux bubblewrap）；離開沙箱在完全自主以外的所有模式都需要核准（`infrastructure/sandbox.ts`）。
- **檢查點**記錄每一次變更，包含 shell 指令造成的變更，可供檢視與還原（`application/checkpoints.ts`）。
- **只允許公開位址**：web 與瀏覽器工具，以及 Browser 分頁的頁面載入器，會拒絕 loopback、私有與 link-local 位址，包括解析到這些位址的網域名稱（`domain/skills/public-address.ts`、`infrastructure/public-host.ts`）。
- **Agent 瀏覽器**使用自己的設定檔，從不使用使用者瀏覽器的設定檔或登入（`infrastructure/skills/browser-skill.ts`）。

剩餘風險：在使用者允許的範圍內，被注入的指示能以 Agent 的完整權限行動。網路開啟時（預設），指令或擷取可以把 Agent 讀得到的資料送到任何公開位址。完全自主、範圍廣的允許規則與電腦操作（可控制整個桌面）都會擴大這個風險。見[降低風險](../README_ZH.md)。

### 2. 同一台電腦上的其他程式與網頁

loopback 不是信任邊界：任何本機程式，以及透過使用者瀏覽器的任何網頁，都能連到 `127.0.0.1`。

- Runtime 只監聽 `127.0.0.1`，拒絕非 loopback 的 `Host` 標頭（DNS rebinding）與非本機的 `Origin`（CORS）（`presentation/app.ts`）。
- 每個路由都需要 `Authorization: Bearer <token>`；token 存於 `~/.saturn-app/runtime-token`，權限 `0600`。例外：`/health`；`/oauth/callback`（供應商的重新導向）；`/agent-mcp`，改用執行中 Codex 回合自己的短期 token（`presentation/agent-skills-controller.ts`）。
- 桌面應用程式從主程序取得 token；它顯示的網路頁面放在沒有 App origin 的沙箱 frame 中（`desktop/src/presentation/Inspector.tsx`）。

範圍外：已經以同一使用者身分執行的程式能讀取 token 檔與作業系統金鑰庫，這對任何 App 都一樣。

### 3. 隨資料夾或外掛而來的東西

- 專案或外掛的 **hooks** 要在使用者看過並允許那一組（依指紋）後才會執行（`application/hooks.ts`、`application/plugins.ts`）。
- **本機 MCP 伺服器**要在使用者看過並允許其確切的指令、參數與變數後才會啟動，且只拿到最小的環境變數，從不包含 Saturn 自己的（`infrastructure/mcp.ts`、`application/mcp-command.ts`）。
- **Skills 與規則檔**（`AGENTS.md`、`CLAUDE.md`、`SKILL.md`）是給模型的指示，與其他不可信內容同樣看待（威脅 1）。

### 4. 憑證

- 金鑰靜態加密；加密金鑰存於 macOS 鑰匙圈、Windows DPAPI 或 Linux Secret Service，並經由 stdin 傳給系統工具（`infrastructure/secret-key.ts`、`infrastructure/secrets-file.ts`）。
- 每把金鑰只會送到它自己的供應商（`infrastructure/llm.ts`）。訂閱方案的登入（Claude Code、Codex）留在那些程式的資料夾中；Saturn 從不讀取或轉送（`application/claude-code.ts`、`application/codex.ts`）。

### 5. 供應鏈與更新

- Runtime 與桌面應用程式不執行相依套件的安裝腳本；CI 檢查 lock 檔、registry 簽章與 audit；GitHub Actions 固定到 commit SHA（`.github/workflows/supply-chain.yml`）。
- Claude Code 與 Codex 的下載以固定的 SHA-512 驗證（`infrastructure/agent-programs-manifest.ts`）；嵌入模型以 SHA-256 驗證。
- 每次發布附 SHA-256 檔、CycloneDX SBOM 與簽章的建置來源證明（`.github/workflows/release.yml`）。
- 審視過並接受的公告列於 [`known-advisories.md`](known-advisories.md)。

## 不防範的情況

- 惡意或已遭入侵的本機使用者帳號、管理員或作業系統。
- Agent 在使用者給予的權限內造成的損害：完全自主、允許規則、核准過的 `sandbox: "off"`、電腦操作。
- 模型供應商、Claude Code、Codex、MCP 伺服器與 Saturn 呼叫的其他程式；它們被信任能處理送給它們的內容。
- Code-OSS 本身，[`Saturn-IDE/UPSTREAM.md`](../Saturn-IDE/UPSTREAM.md) 列出的修改除外。

## 已知缺口

- **Windows 沒有指令沙箱**；指令的結果會註明。
- **macOS 版本未以 Developer ID 簽章或公證**，Windows 版本使用自簽憑證，使用者無法依賴作業系統確認下載來源；應以 SHA-256 檔與建置來源證明檢查。
- **沙箱內預設可連網**，以便安裝套件；處理敏感工作時可針對專案關閉。
- **尚未經過第三方安全審計。**

## 審查範圍

外部審計依優先順序涵蓋以下部分。Saturn IDE 是上游 Code-OSS，除列出的修改外不在範圍內。

| 優先 | 範圍 | 程式碼 |
|---|---|---|
| 1 | 本機 API 驗證：token、Host 與 Origin 檢查、免驗證與 Codex token 的路由 | `runtime/src/presentation/app.ts`、`presentation/agent-skills-controller.ts`、`application/codex.ts` |
| 1 | 工具授權：權限規則（含專案檔案中的規則）、核准、模式、子 Agent | `runtime/src/domain/permissions.ts`、`application/permissions.ts`、`domain/policies.ts`、`application/runs.ts` |
| 1 | 指令執行與沙箱：shell 選擇、seatbelt 與 bubblewrap 設定、背景工作 | `runtime/src/infrastructure/sandbox.ts`、`infrastructure/shell.ts`、`infrastructure/skills/code-skill.ts`、`infrastructure/jobs.ts` |
| 1 | 檔案存取範圍：工作目錄與專案路徑解析、符號連結 | `runtime/src/domain/skills/workspace.ts`、`infrastructure/skills/file-skill.ts`、`application/projects.ts` |
| 2 | SSRF 與擷取：公開位址檢查、DNS rebinding、重新導向、Browser 分頁代理 | `runtime/src/domain/skills/public-address.ts`、`infrastructure/public-host.ts`、`infrastructure/skills/web-skill.ts`、`presentation/workspace-controller.ts` |
| 2 | Hooks、外掛與本機 MCP 伺服器：依指紋核准、傳入的環境變數 | `runtime/src/application/hooks.ts`、`application/plugins.ts`、`infrastructure/mcp.ts`、`application/mcp-command.ts` |
| 2 | 憑證的儲存與使用 | `runtime/src/infrastructure/secret-key.ts`、`infrastructure/secrets-file.ts`、`infrastructure/llm.ts`、`infrastructure/auth.ts` |
| 2 | 桌面應用程式：主程序與 preload 橋接、顯示網路內容的 frame、權限請求 | `desktop/electron.cjs`、`desktop/preload.cjs`、`desktop/src/presentation/Inspector.tsx` |
| 3 | Agent 瀏覽器與電腦操作：設定檔隔離、哪些內容會送到模型 | `runtime/src/infrastructure/skills/browser-skill.ts`、`safari-browser.ts`、`computer-use-skill.ts`、`macos.ts`、`windows.ts` |
| 3 | 檢查點與還原：寫到資料夾外、路徑穿越 | `runtime/src/application/checkpoints.ts` |
| 3 | Saturn IDE 的 Saturn 擴充套件及其與 Runtime 的橋接 | `Saturn-IDE/extensions/saturn/`、`runtime/src/application/ide-bridge.ts` |
| 3 | 發布與供應鏈 workflow、Claude Code 與 Codex 的下載 | `.github/workflows/`、`runtime/src/infrastructure/agent-programs-manifest.ts`、`application/agent-programs.ts` |

給審查者：`npm test` 會以假的模型伺服器執行 Runtime，不需要任何憑證；[自行驗證](../README_ZH.md)說明如何觀察每一個對外請求。
