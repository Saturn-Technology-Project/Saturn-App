# Known advisories

Security advisories that affect a dependency Saturn carries, have been reviewed, and are deliberately left open, with the reason and the condition for closing each one. Everything else is fixed: the [supply-chain workflow](../.github/workflows/supply-chain.yml) fails on any high or critical advisory in what the runtime and the desktop app ship, and Dependabot proposes patches as soon as they exist.

[中文](#已知的安全公告)

## Accepted in code that ships

| Package | Where | Advisory | Severity | Why it stays open | Closed when |
|---|---|---|---|---|---|
| `braces` | Saturn IDE: built-in npm and Mermaid extensions | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | High | No patched release exists. | A fixed release is published; Dependabot proposes it. |
| `@azure/msal-node` | Saturn IDE: built-in Microsoft Authentication extension | [GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5) | High | The fix is in 7.1.0, two major versions past the 5.4 that Code-OSS uses; the extension does not call `acquireTokenByCode`, the flow the advisory names, and runs only when you sign in with a Microsoft account. | Code-OSS moves to `@azure/msal-node` 7.1 or later; the upstream sync brings it in. |
| `zod` 3.x | Saturn IDE: `@vscode/sandbox-runtime`, inside the IDE and its remote server | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | High | Only zod 4.6.6 is patched and the package is built on the zod 3 API. It validates the terminal sandbox's own settings, not input from a network or a workspace file. | `@vscode/sandbox-runtime` moves to zod 4, or a zod 3 fix is published. |

## Reported but not shipped

Dependabot scans every lock file in the repository, including code that never reaches a Saturn download. Advisories there are not fixed in Saturn's tree; they follow upstream Code-OSS:

- **Saturn IDE tests and test fixtures** (`Saturn-IDE/test/**`, test extensions such as `vscode-api-tests`).
- **Build tooling** (`Saturn-IDE/build/**`, development dependencies).
- **The Rust CLI** (`Saturn-IDE/cli/Cargo.lock`): Saturn does not build or ship Code-OSS's `code` CLI.
- **The Copilot extension source** (`Saturn-IDE/extensions/copilot/**`): kept only so upstream merges stay clean, excluded from every build. See [`Saturn-IDE/UPSTREAM.md`](../Saturn-IDE/UPSTREAM.md).

## Adding an entry

An advisory goes here only after a review shows it cannot be fixed now (no patch, or the patch needs an upstream change) and its exposure is understood. Each entry records the advisory, where the package is, why it stays open, and what closes it. Dismiss the Dependabot alert with the matching reason and link back to this file. Remove the entry in the same change that ships the fix.

---

# 已知的安全公告

這裡列出影響 Saturn 某個相依套件、已經審視過、並刻意暫不處理的安全公告，以及每一項的理由與結案條件。其他公告一律修補：[supply-chain workflow](../.github/workflows/supply-chain.yml) 只要在 Runtime 或桌面應用程式出貨的內容中發現 high 或 critical 等級的公告就會失敗，而修補一發布 Dependabot 就會提出更新。

[English](#known-advisories)

## 出貨程式中已接受的公告

| 套件 | 位置 | 公告 | 等級 | 暫不處理的原因 | 結案條件 |
|---|---|---|---|---|---|
| `braces` | Saturn IDE：內建的 npm 與 Mermaid 擴充套件 | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | High | 尚無修補版本。 | 修補版本發布；Dependabot 會提出更新。 |
| `@azure/msal-node` | Saturn IDE：內建的 Microsoft Authentication 擴充套件 | [GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5) | High | 修正在 7.1.0，比 Code-OSS 使用的 5.4 高兩個主版本；此擴充套件不呼叫公告所指的 `acquireTokenByCode`，且只在以 Microsoft 帳號登入時執行。 | Code-OSS 改用 `@azure/msal-node` 7.1 以上；upstream sync 會帶入。 |
| `zod` 3.x | Saturn IDE：`@vscode/sandbox-runtime`，在 IDE 與其遠端伺服器中 | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | High | 只有 zod 4.6.6 有修補，而此套件以 zod 3 的 API 撰寫。它只驗證終端機沙箱自己的設定，不處理來自網路或工作區檔案的輸入。 | `@vscode/sandbox-runtime` 改用 zod 4，或 zod 3 發布修補。 |

## 有回報但不會出貨

Dependabot 會掃描 repository 中的每個 lock 檔，包括從不會進入 Saturn 下載檔的程式碼。這些位置的公告不在 Saturn 的程式樹中修補，而是跟隨上游 Code-OSS：

- **Saturn IDE 的測試與測試資料**（`Saturn-IDE/test/**`，以及 `vscode-api-tests` 等測試用擴充套件）。
- **建置工具**（`Saturn-IDE/build/**` 與開發用相依套件）。
- **Rust CLI**（`Saturn-IDE/cli/Cargo.lock`）：Saturn 不建置也不出貨 Code-OSS 的 `code` CLI。
- **Copilot 擴充套件原始碼**（`Saturn-IDE/extensions/copilot/**`）：只為了讓上游合併保持乾淨而保留，所有建置都會排除。見 [`Saturn-IDE/UPSTREAM.md`](../Saturn-IDE/UPSTREAM.md)。

## 新增一筆

只有在審視後確認目前無法修補（沒有修補版本，或修補需要上游變更），且清楚其曝險範圍時，公告才會列入這裡。每筆都要記錄公告、套件位置、暫不處理的原因與結案條件。以相符的理由關閉對應的 Dependabot 警示，並連回本檔。修補出貨時，在同一個變更中移除該筆。
