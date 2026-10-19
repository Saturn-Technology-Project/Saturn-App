# Saturn IDE：離「真正好用」還差什麼

對照 Cursor 與 VS Code，基於實際讀 code（`extensions/saturn/extension.js`、`editor-ai.js`、`product.json`、`saturn.contribution.ts`）的結論。

## 先講定位

Saturn IDE 是 **Code-OSS（VS Code 開源核心）的 fork**，所以 **VS Code 編輯器本體幾乎都在**：多游標、LSP/IntelliSense、除錯器、整合終端機、Git/SCM、搜尋、設定、佈景、快捷鍵、工作區。這些不是差距。

真正的差距集中在兩塊：**(A) Cursor 式的 AI 深度整合**、**(B) 閉源商業服務（市集、遠端、同步）**。

---

## A. 對 Cursor 的 AI 差距（這是重點）

### 現在已經有的
- 側邊 Agent 聊天面板（Ctrl+L 聚焦）、綁定專案、對話串/歷史、模型切換、停止、輪詢狀態。
- Tab 行內補全（`provideInlineCompletionItems`）＋開關。
- **Cmd+I 行內編輯**：對選取範圍下指令改寫，以行內 diff 接受/拒絕（CodeLens 實作）。做得不錯。
- Slash：`/help`、`/clear`、`/compact`（很精簡）。
- 遙測只送本機 runtime（隱私上**贏** Cursor）。

### 缺的（依影響大小）

1. **程式庫索引／語意檢索（@codebase）— 最大的缺口。**
   Cursor 會把整個 repo 做 embedding 索引，問問題時自動檢索相關檔案。Saturn 目前只把**當前開啟的檔案＋選取**塞進 context（`editorContext()`，上限 12k 字元）。沒有索引＝agent 看不到它沒開的檔案，大型專案幾乎沒法「理解整包」。

2. **@ 提及的真實 context 選擇器。**
   Cursor 有 `@files / @folders / @code / @docs / @web / @git`。Saturn 的「attach」按鈕（`attachBtn`）只是切換「要不要帶當前檔案」的開關，沒有檔案挑選器、沒有 `workspace.findFiles`、沒有多檔/資料夾/網頁引用。

3. **IDE 內的 agent 編輯審查（Accept/Reject diff）。**
   Cursor 把多檔修改以行內 diff 呈現，逐塊 Accept/Reject，還有 Apply 流程。Saturn 的 agent 是在 runtime 端**直接寫檔到專案資料夾**；IDE 面板沒有 `vscode.diff`、沒有 SCM 整合、沒有接受/還原 UI。改動只能靠一般編輯器/Git 看，審查/還原要去**桌面 app**（RunChanges）。

4. **Agent 核准無法在 IDE 內操作。**
   實測：面板只顯示「Waiting for approval」狀態，**沒有**送出核准/拒絕的程式碼（`/decision` 出現 0 次）。需要核准的動作（claude-code 的寫檔/Bash）在 IDE 裡按不了，得去桌面 app，否則只能把 agent 設全自主。

5. **聊天程式碼區塊的「Apply 到檔案」。**
   Cursor 聊天裡每段 code 有 Apply（智慧合併進檔案）。Saturn 只顯示程式碼，要自己複製貼上。

6. **Tab 補全的「次世代」能力。**
   Cursor Tab 會預測**多行改寫**與**下一個編輯位置**（跨行跳轉）。Saturn 是游標處單一 `InlineCompletionItem`，屬傳統補全。

7. **對話 checkpoint／還原。**
   Cursor 聊天可回溯到某個 checkpoint 還原檔案。Runtime 其實有 checkpoint，但 IDE 沒把「還原到這一步」接出來。

8. **終端機整合的 agent 指令。**
   Cursor 的 agent 在整合終端機跑指令、你看得到也能接手。Saturn 的 `code` skill 在 server 端跑，輸出只回到聊天，不進 IDE 終端機（沒有 `createTerminal`/`sendText`）。

9. **補全效能細節**：Cursor 有快取/推測式編輯/專用快模型。Saturn 走 runtime `/complete`，看配的模型；缺快取與推測機制。

---

## B. 對 VS Code 的生態／服務差距

這些 Code-OSS fork 幾乎都會缺（因為是微軟閉源服務）：

1. **擴充市集：用的是 Open VSX**（`extensionsGallery = open-vsx.org`），**不是**微軟市集。結果：沒有 GitHub Copilot、Pylance、很多閉源熱門擴充；目錄較小、更新較慢。對「日常可用度」是實質影響。
2. **遠端開發**（Remote-SSH / Dev Containers / WSL）：微軟的遠端擴充不授權給 fork，通常不能用。
3. **Settings Sync**（跨機器同步設定）：`product.json` 沒設，目前沒有。
4. **Live Share**（即時協作）：微軟閉源，不可用。
5. 其他小項：內建帳號登入、部分需要 MS 服務的功能。

> 註：這些多半能用替代方案補（Open VSX 擴充、`openvscode-server`/自建遠端、第三方 sync），但都要額外工程。

---

## C. Saturn 已經做得好／領先的地方（公平講）

- 多 Agent、可指定模型與 effort、群組協作（桌面 app）。
- 本機 runtime＋Claude 訂閱接入，遙測全留本機（隱私勝 Cursor/Copilot）。
- Agent 審批閘門、checkpoint 還原、專案資料夾授權模型（安全設計完整，剛補了 token 認證）。
- Cmd+I 行內編輯的 diff 體驗已接近 Cursor。

---

## D. 若要「真正好用」，建議優先序

**P0（不做就稱不上 AI IDE）**
- 程式庫索引＋檢索（哪怕先做簡單的：ripgrep/符號檢索 + 關聯檔案自動帶入），解決 #1。
- IDE 內 agent 編輯以 `vscode.diff`/SCM 呈現，逐檔 Accept/Reject，並把核准（`/decision`）接出來，解決 #3、#4。

**P1（體驗拉到 Cursor 等級）**
- `@files/@folders/@web` 真實 context 選擇器（#2）。
- 聊天 code block 的 Apply（#5）。
- 對話 checkpoint 還原接到 IDE（#7）。

**P2（打磨）**
- Tab 多行/下一處預測與補全快取（#6、#9）。
- agent 指令走 IDE 整合終端機（#8）。
- 生態：確認 Open VSX 夠用、評估遠端開發替代方案、Settings Sync。

---

一句話總結：**編輯器本體（對 VS Code）幾乎不缺；缺的是 Cursor 的「AI 深度整合」——尤其程式庫索引、IDE 內的 diff/核准/Apply、真實 @context——以及閉源生態（市集/遠端/同步）。把 P0 兩項補上，就從「能聊天的編輯器」變成「真的能用的 AI IDE」。**
