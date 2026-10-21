# Known advisories

Security advisories that affect a dependency Saturn carries, have been reviewed, and are deliberately left open, with the reason and the condition for closing each one. Everything else is fixed: the [supply-chain workflow](../.github/workflows/supply-chain.yml) fails on any high or critical advisory in what the runtime and the desktop app ship, and Dependabot proposes patches as soon as they exist.

[中文](#已知的安全公告)

## Accepted in code that ships

| Package | Where | Advisory | Severity | Why it stays open | Closed when |
|---|---|---|---|---|---|
| `braces` | Saturn IDE: built-in npm and Mermaid extensions | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | High | No patched release exists. | A fixed release is published; Dependabot proposes it. |
| `image-size` | Saturn IDE: built-in Emmet extension | [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) | High | The fix is in 2.x, whose API Emmet does not use yet. The flaw is reachable only by running Emmet's *Update Image Size* on a crafted image. | Code-OSS moves Emmet to `image-size` 2.x; the [upstream sync](../.github/workflows/upstream-sync.yml) brings it in. |

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
| `image-size` | Saturn IDE：內建的 Emmet 擴充套件 | [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) | High | 修正在 2.x，Emmet 尚未改用其 API。只有對惡意圖片執行 Emmet 的 *Update Image Size* 才會觸發。 | Code-OSS 將 Emmet 改用 `image-size` 2.x；[upstream sync](../.github/workflows/upstream-sync.yml) 會帶入。 |

## 有回報但不會出貨

Dependabot 會掃描 repository 中的每個 lock 檔，包括從不會進入 Saturn 下載檔的程式碼。這些位置的公告不在 Saturn 的程式樹中修補，而是跟隨上游 Code-OSS：

- **Saturn IDE 的測試與測試資料**（`Saturn-IDE/test/**`，以及 `vscode-api-tests` 等測試用擴充套件）。
- **建置工具**（`Saturn-IDE/build/**` 與開發用相依套件）。
- **Rust CLI**（`Saturn-IDE/cli/Cargo.lock`）：Saturn 不建置也不出貨 Code-OSS 的 `code` CLI。
- **Copilot 擴充套件原始碼**（`Saturn-IDE/extensions/copilot/**`）：只為了讓上游合併保持乾淨而保留，所有建置都會排除。見 [`Saturn-IDE/UPSTREAM.md`](../Saturn-IDE/UPSTREAM.md)。

## 新增一筆

只有在審視後確認目前無法修補（沒有修補版本，或修補需要上游變更），且清楚其曝險範圍時，公告才會列入這裡。每筆都要記錄公告、套件位置、暫不處理的原因與結案條件。以相符的理由關閉對應的 Dependabot 警示，並連回本檔。修補出貨時，在同一個變更中移除該筆。
