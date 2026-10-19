# Saturn App

[English](README.md)

Saturn App 是在你自己的電腦上跑的代理程式。它包含兩個行程：

- **Saturn Desktop**：Electron 視窗。對話、連線模型與 MCP、查看日誌。
- **Saturn Runtime**：本機核心。真正呼叫模型、執行內建技能、連接 MCP，並保存這台機器的狀態。

Desktop 只透過 `http://127.0.0.1:4700` 操作 Runtime。Runtime 不依賴 Electron，可以單獨啟動。

## 內建技能

每個代理都會帶上 General Skills。工具識別碼固定為：

| 技能 | 做什麼 |
|------|--------|
| `files` | 在工作區列出、讀取、寫入或套用補丁 |
| `code` | 在工作區裡執行指令 |
| `web` | 讀取公開網頁。本機與私有網址會被拒絕 |
| `mcp` | 呼叫這個代理已接上的其他 MCP 工具 |
| `multi_step` | 維護一份計畫。未完成時，恰好一個步驟是進行中 |

檔案與指令都限制在資料目錄下的 `workspace/`。補丁使用 `*** Begin Patch` / `*** End Patch` 語法。

## 目錄

```
Saturn App/
  desktop/          Electron 殼
    src/domain/         畫面用的規則與型別
    src/application/    對 Runtime 的用例
    src/infrastructure/ HTTP 用戶端
    src/presentation/   React 畫面
  runtime/          本機核心
    src/presentation/   HTTP。路由只轉給控制器
    src/application/    用例。目錄、執行、設定
    src/domain/         代理、技能與路徑規則
    src/infrastructure/ 模型、MCP、檔案
```

領域物件不依賴 Express 或 React。基礎設施負責檔案系統、殼層指令與模型 API。

## 需求

- Node.js 22 或更新版本
- macOS 或 Windows。打包 macOS 應用需要在 Mac 上執行

## 開發

在 `Saturn App/` 安裝兩邊的依賴：

```bash
npm install --prefix runtime
npm install --prefix desktop
```

啟動視窗。若 4700 埠還沒有 Runtime，Desktop 會自己啟動它。

```bash
npm run desktop
```

只跑核心：

```bash
npm run dev
```

核心預設聽 `127.0.0.1:4700`。開發中的畫面由 Vite 提供在 `http://127.0.0.1:5174`。

本機狀態寫在 `~/.saturn-app`。可用環境變數改掉：

| 變數 | 預設 | 用途 |
|------|------|------|
| `SATURN_RUNTIME_HOST` | `127.0.0.1` | Runtime 綁定的位址 |
| `SATURN_RUNTIME_PORT` | `4700` | Runtime 的埠 |
| `SATURN_DATA_DIR` | `~/.saturn-app` | 狀態、密鑰與工作區 |
| `SATURN_NODE` | 從 `PATH` 尋找 | Desktop 用來啟動 Runtime 的 `node` |

模型金鑰保存在本機金鑰庫中，呼叫模型時直接帶給供應商，API 不會把明文回給畫面。支援 OpenAI、Claude、Gemini、DeepSeek 及本機 LM Studio。

## 測試

```bash
npm test
```

測試打的是 Runtime 的 HTTP API，使用暫存資料目錄。

## 打包

產出未簽名的 macOS `.app` 與 Windows x64 安裝檔，放在 `desktop/release/`。

```bash
npm run dist:mac
npm run dist:win
```

macOS 第一次開啟時，在 Finder 對 `.app` 按右鍵再選「打開」。Windows 可能出現 SmartScreen 提示。打包後的 Runtime 由應用程式自己的執行檔以 Node 模式啟動，不需要另外安裝 Node。

## 本機 API

Runtime 只接受來自 loopback 的瀏覽器來源。常用路徑：

| 方法 | 路徑 | 用途 |
|------|------|------|
| GET | `/health` | 核心是否在跑 |
| GET、POST | `/agents` | 列出或建立代理 |
| POST | `/agents/:id/runs` | 對代理下達任務 |
| GET | `/runs/:id` | 讀取這一輪的狀態 |
| POST | `/runs/:id/stop` | 停止這一輪 |

## 授權

[MIT](LICENSE)。Copyright (c) 2026 Prism Capital LLC.
