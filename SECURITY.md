# Security policy

[中文](#安全政策)

Saturn runs AI agents that execute commands, edit files and control apps on your computer, and it holds your model providers' API keys. We treat reports about any of that seriously and thank everyone who reports responsibly.

## Reporting a vulnerability

Email **[security@saturn-core.com](mailto:security@saturn-core.com)**. Please do not open a public issue, discussion or pull request for a vulnerability.

Include what you can of:

- the affected component (the desktop app, the runtime, Saturn IDE, the CLI or the SDK) and version (Settings → About, or the release tag);
- the steps to reproduce, or a proof of concept;
- the impact as you see it (for example: a web page or file makes an agent run a command without approval, another local program or a website calls the runtime's API, a sandboxed command writes outside the workspace, a key leaves the machine);
- whether, and when, you plan to disclose it.

## What happens next

- We acknowledge the report, aiming for within five working days, and keep you updated as we investigate.
- We agree a disclosure date with you; 90 days from the report is the default, sooner once a fix ships.
- Fixes are released as a new version, with a GitHub security advisory that credits you unless you ask us not to.

## Supported versions

Saturn is a preview. Only the latest release receives security fixes; please check that a problem reproduces on it.

## Scope

In scope: this repository's own code, that is the runtime (`runtime/`), the desktop app (`desktop/`), the SDK (`packages/sdk/`), Saturn IDE's Saturn extension and build changes (`Saturn-IDE/extensions/saturn/` and the edits listed in [`Saturn-IDE/UPSTREAM.md`](Saturn-IDE/UPSTREAM.md)), and the release and supply-chain workflows.

Out of scope, reported to their owners instead:

- Code-OSS itself (everything in Saturn IDE that `UPSTREAM.md` does not list): Microsoft's [security policy](https://github.com/microsoft/vscode/security/policy).
- Claude Code, Codex, MCP servers, model providers and other third-party programs Saturn starts or calls.
- Advisories in dependencies that do not ship, or that [`docs/known-advisories.md`](docs/known-advisories.md) already lists as reviewed.

What Saturn defends against, and what it deliberately leaves to you, is in the [threat model](docs/threat-model.md), which also lists what an external review should cover first. For example, an agent you put in full autonomy running a harmful command inside a folder you granted it is the documented design, not a vulnerability; the same command run without the approval your settings require is one.

Please test only against your own installation and accounts, do not access other people's data, and avoid degrading anyone's service.

---

# 安全政策

[English](#security-policy)

Saturn 執行的 AI Agent 會在你的電腦上執行指令、修改檔案與操作 App，並保管你的模型供應商 API 金鑰。我們認真看待與這些相關的每一份回報，也感謝每一位負責任揭露的人。

## 回報漏洞

請寄信至 **[security@saturn-core.com](mailto:security@saturn-core.com)**。請不要以公開的 issue、討論或 pull request 回報漏洞。

請盡量附上：

- 受影響的元件（桌面應用程式、Runtime、Saturn IDE、CLI 或 SDK）與版本（設定 → About，或發布的 tag）；
- 重現步驟或概念驗證；
- 你認為的影響（例如：網頁或檔案讓 Agent 未經核准就執行指令、其他本機程式或網站呼叫了 Runtime 的 API、沙箱中的指令寫到工作目錄之外、金鑰離開了這台電腦）；
- 你是否、以及何時打算公開。

## 接下來

- 我們會確認收到回報，目標是五個工作天內，並在調查期間持續告知進度。
- 我們會與你約定公開日期；預設為回報後 90 天，修補發布後可提前。
- 修補會以新版本發布，並附上 GitHub 安全公告，除非你要求不具名，否則會列出你的貢獻。

## 支援的版本

Saturn 目前為預覽版，只有最新版本會收到安全修補；回報前請確認問題在最新版本上仍會發生。

## 範圍

範圍內：此 repository 自己的程式碼，即 Runtime（`runtime/`）、桌面應用程式（`desktop/`）、SDK（`packages/sdk/`）、Saturn IDE 的 Saturn 擴充套件與建置修改（`Saturn-IDE/extensions/saturn/`，以及 [`Saturn-IDE/UPSTREAM.md`](Saturn-IDE/UPSTREAM.md) 列出的修改），以及發布與供應鏈的 workflow。

範圍外，請回報給各自的維護者：

- Code-OSS 本身（Saturn IDE 中 `UPSTREAM.md` 未列出的部分）：見 Microsoft 的[安全政策](https://github.com/microsoft/vscode/security/policy)。
- Claude Code、Codex、MCP 伺服器、模型供應商，以及 Saturn 啟動或呼叫的其他第三方程式。
- 不會出貨的相依套件中的公告，或 [`docs/known-advisories.md`](docs/known-advisories.md) 已列為審視過的公告。

Saturn 防範什麼、刻意交由你決定什麼，見[威脅模型](docs/threat-model.md)，其中也列出外部審查應優先涵蓋的範圍。例如：你設為完全自主的 Agent 在你授權的資料夾內執行了有害指令，是文件中說明的設計，不是漏洞；同一個指令若在你的設定要求核准時卻未經核准就執行，才是漏洞。

請只在你自己的安裝與帳號上測試，不要存取他人的資料，也不要影響任何人的服務。
