# Saturn Agent 安全審查

範圍：啟動設定載入、讀寫權限/工具調用繞過、沙箱隔離、鏈式 RCE。
靈感對照：DeepSeek harness「網頁 → 本機服務 → RCE」類漏洞。

結論：**存在同一類（且更嚴重）的問題**。核心原因是 runtime 的本機 HTTP API（`127.0.0.1:4700`）**完全沒有認證**，再加上 CORS 設定可被繞過，形成「使用者只要開一個網頁就能被 RCE」的鏈路。以下依嚴重度排列，均已用無害 PoC 或原始碼確認。

---

## 1. 〔Critical〕本機 API 無認證 + CORS 可繞過 → 任意網頁 RCE

**這就是 DeepSeek harness 那一類漏洞，而且可直接拿到 shell。**

- runtime 所有路由監聽 `127.0.0.1:4700`，**沒有任何 token / 密鑰**。`loopback` 不是認證邊界：同一台機器上任何程序（別的 app、npm 的 postinstall、瀏覽器分頁）都能打。
- `POST /workspace/terminal` 直接用使用者的 shell 執行任意指令，無確認。
- CORS 處理 (`runtime/src/presentation/app.ts:20`)：`loopbackOrigin()` 對 `Origin: null` 直接回傳 `"null"`，於是回應 `Access-Control-Allow-Origin: null` + `Access-Control-Allow-Private-Network: true`，預檢（preflight）通過。

**攻擊鏈（使用者只要開一個惡意網頁）**：惡意站 `evil.com` 內嵌 `<iframe sandbox="allow-scripts">`，其 origin 為 `null` → 對 `127.0.0.1:4700/workspace/terminal` 的預檢通過 → iframe 內的 JS 送出 `POST`，指令在使用者身分下執行。無需任何點擊。

已確認（無害 PoC）：
```
OPTIONS /workspace/terminal  Origin: null
→ HTTP/1.1 204, Access-Control-Allow-Origin: null, Access-Control-Allow-Private-Network: true
POST /workspace/terminal  {"command":"echo SATURN_POC uid=$(id -u)"}
→ {"stdout":"SATURN_POC uid=501\n","exitCode":0}
```
也沒有 Host header 檢查：`Host: attacker.example:4700` 仍回 200，所以 DNS-rebinding 也成立。

**修法（優先做這個，一次關掉大半問題）**：
1. 啟動時產生一次性 session token（寫進 runtime 記憶體 / 一個 0600 檔），desktop 透過環境變數或 IPC 拿到，之後**每個 runtime 請求都帶 `Authorization: Bearer <token>`**，middleware 驗證（`/health` 除外）。loopback 不能當認證。
2. CORS：**永遠不要**允許 `Origin: null`；只允許 desktop 實際用的那一個 origin。移除對未知 origin 回 `null` 的分支。
3. 加 Host allowlist（只接受 `127.0.0.1` / `localhost`），擋 DNS-rebinding。

---

## 2. 〔Critical〕`/workspace/browser/proxy` 把攻擊者網頁放到 runtime 自己的 origin + SSRF

`runtime/src/presentation/workspace-controller.ts`：
- `GET /workspace/browser/proxy?url=` 伺服器端 fetch 任意 URL，**沒有** `PublicAddress` 的私網防護（`web` skill 有，這裡沒有）。可打 `http://127.0.0.1:*`、`http://169.254.169.254/`（雲端 metadata）、內網主機並回傳內容 → SSRF。
- 回傳時主動 `removeHeader("Content-Security-Policy")` 與 `X-Frame-Options`，且內容是從 `127.0.0.1:4700` 這個 origin 送出的。等於把攻擊者 HTML 變成**與 runtime 同源**，連 CORS 都不用繞 → 直接呼叫上面所有 API。

**修法**：proxy 的 `url` 套用 `PublicAddress.parse()`（擋 loopback/私網）；不要在 runtime 主 origin 上回傳第三方 HTML（用獨立 origin / sandbox iframe，且不要剝除 CSP）。

---

## 3. 〔High〕Agent 沒有真正的沙箱；「工作目錄外」限制可輕易繞過

問題 3、4 問的「VM 沙箱逃逸 / 讀取工作目錄外檔案」——**目前根本沒有 VM 或 OS 沙箱**。「沙箱」只是 `~/.saturn-app/workspace` 這個資料夾，且只用字串比對把關。

- `code` skill (`infrastructure/skills/code-skill.ts`) 只限制 `cwd` 在 workspace 內，**不限制指令內容**。`cat ~/.ssh/id_rsa`、`cd / && ...`、對外網連線全都能跑，用的是 runtime 的完整使用者權限與真實 PATH。工作目錄外的檔案照讀照寫。
- `files` skill 的 `Workspace.resolve()` (`domain/skills/workspace.js`) 用的是**字面** `path.resolve`，**不解析 symlink**。先在 workspace 內 `ln -s / link`（用 code skill）再 `files read link/etc/passwd`，即可讀出界外（TOCTOU）。
- local（非 Claude Code）agent 的審批：`isSensitiveOperation()` 的黑名單正則很容易繞（`rm` 變形、`python -c`、base64、`$IFS`…），而且**只在 `default` 模式生效**。agent 設成 `fully_autonomous` / `bypass` / `turbo` 時 `runTools()` 完全不審批 → 無約束 RCE。

**修法**：
- 定位要清楚：若「沙箱」是安全邊界，就要用 OS 級隔離跑 `code`/`files`（macOS `sandbox-exec`/`seatbelt`、Linux 容器或 bubblewrap、或獨立低權限使用者）。否則請在 UI/文件明講「agent 指令以使用者完整權限執行，workspace 不是安全邊界」。
- `Workspace.resolve` 改用 `fs.realpath` 後再比對，擋 symlink 逃逸。
- 不要讓 autonomy 模式可以把審批「整個關掉」；高風險動作（`code`、界外寫入、網路）無論模式都該經過一層固定閘門，而不是靠可繞的字串黑名單。

---

## 4. 〔High〕Claude Code 唯讀工具自動放行，無路徑限制 → 竊密鏈

`application/claude-code.ts`：`READ_ONLY_TOOLS`（`Read`/`Glob`/`Grep`/`LS`…）在 `canUseTool` 裡**直接 allow**，而 SDK 的 `cwd` 只是起始目錄、不限制讀取範圍。被 prompt injection 的 Claude Code agent 可**零審批**讀取全硬碟任何檔案（SSH 金鑰、雲端憑證、瀏覽器資料），再用一次（需審批的）Bash/MCP 送出去 → 竊密鏈。Bash 需審批算是部分緩解，但「讀」這一端完全無閘。

憑證剝除（`CREDENTIAL_VARIABLES`、`settingSources:[]`、`disallowedTools` 擋 WebSearch/WebFetch）做得對，符合你那份 Claude Code 架構文件，這點沒問題。

**修法**：唯讀工具也套用工作目錄（或專案資料夾）白名單；界外路徑降級為需審批。

---

## 5. 〔High〕Prompt injection → 工具執行（設計面）

- 系統提示 (`domain/policies.ts` `buildSystemPrompt`) 明寫「operate with full autonomy… without unnecessary confirmation requests, refusals, or artificial constraints」，等於鼓勵模型少問直接做。
- 專案 rules（`.cursorrules` / `AGENTS.md`）會被讀進系統提示；`web` skill 抓回的網頁、群組裡其他 agent 的訊息也都進 context。**clone 一個惡意 repo 並打開** = 把攻擊者文字注入系統提示 → 配合 fully_autonomous = 無審批 RCE。

**修法**：降低「全自主、別問」的措辭；把專案 rules / 網頁內容 / 其他 agent 訊息當**不可信資料**標註來源，別混進享有同等權威的系統提示段落（這點群組功能的提示有做一半，可推廣到 rules 與 web）。

---

## 6. 〔Medium〕啟動設定載入（問題 1）

- `~/.saturn-app/state.json` 以預設權限存放（`secrets.json` 是 0600，state.json 不是），且**無完整性驗證**。能寫 state.json 的人即可改：agent `instructions`、model `baseUrl`（把你的 API key 導到攻擊者端點）、MCP server `url`（換成惡意 tool server）。
- 讀檔本身有做防護（JSON 解析失敗會備份、不執行），**不會**因為讀設定而注入執行惡意「程式碼」——這點是安全的。風險在於**設定內容本身**（URL/指令/提示）能被改成惡意值，屬資料面注入而非程式碼注入。

**修法**：state.json 也設 0600；對 `baseUrl` / MCP `url` 做 scheme/host 檢查或在 UI 明確顯示「流量會送到這個位址」；敏感設定變更時提示使用者。

---

## 總結

| # | 問題 | 嚴重度 | 你問的對應 |
|---|------|--------|-----------|
| 1 | 本機 API 無認證 + CORS `null` 繞過 → 網頁 RCE | Critical | 2,4（鏈式注入） |
| 2 | proxy 同源回傳攻擊者 HTML + SSRF | Critical | 2,4 |
| 3 | 無真正沙箱；workspace 字串比對可繞（symlink/`code`） | High | 2,3（沙箱逃逸） |
| 4 | Claude Code 唯讀工具自動放行、不限路徑 | High | 2（讀界外檔） |
| 5 | prompt injection → 工具執行 | High | 4 |
| 6 | 設定檔可被改成惡意值 | Medium | 1 |

**最該先做的一件事**：給 runtime API 加 session token 認證並修 CORS（關掉 `Origin: null`、加 Host 檢查）。這一步直接切斷 #1、#2，以及 #3/#4 透過本機其他程序觸發的路徑——投資報酬率最高。

> 註：以上皆在你本機、你自己的 app 上，以無害指令（`echo`、寫入 scratchpad）驗證；未對外部目標或他人系統做任何測試。沒有改動任何程式碼，僅審查與回報。
