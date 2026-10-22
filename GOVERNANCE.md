# Governance

[中文](#專案治理)

How Saturn is run: who decides, how, and what each role is responsible for. It describes the project as it is today and changes, through a pull request, as the project grows.

## Model

Saturn is maintained by the **Saturn Technology Project** organization on GitHub. It currently has **one maintainer**, [@rickwengdev](https://github.com/rickwengdev), who has final say on what is merged and released (a benevolent-dictator model, usual for a young project). Decisions are made in the open: in issues, pull requests and their reviews, and recorded in the git history, [`CHANGELOG.md`](CHANGELOG.md) and the release notes.

## Roles and responsibilities

| Role | Who | Responsibilities |
|---|---|---|
| **Maintainer** | @rickwengdev | Sets direction and the [roadmap](README.md#roadmap); reviews and merges changes; keeps CI, the supply-chain checks and the dependencies healthy; publishes releases (tagging and approving the `release` environment); keeps the documentation current with each release; answers issues. |
| **Security contact** | The maintainer, at [security@saturn-core.com](mailto:security@saturn-core.com) | Receives private vulnerability reports, acknowledges them, fixes them, coordinates disclosure and credits reporters, as [`SECURITY.md`](SECURITY.md) describes. |
| **Code owner** | Listed in [`.github/CODEOWNERS`](.github/CODEOWNERS) | Reviews changes to the paths they own before they merge. |
| **Contributor** | Anyone | Proposes changes by pull request following [`CONTRIBUTING.md`](CONTRIBUTING.md) (tests, the coding standard, the supply-chain rules), reports issues, and follows the [code of conduct](CODE_OF_CONDUCT.md). |

## How decisions are made

- **Everyday changes** (fixes, features within the roadmap, dependency updates): a pull request or commit that passes CI and the maintainer's review is merged.
- **Larger changes** (new subsystems, changes to the security model, breaking changes to the local API or the CLI): proposed in an issue first, discussed in the open, then decided by the maintainer, with the reasoning recorded in the issue.
- **Security fixes** may be prepared privately and merged before they are discussed in public, then disclosed as `SECURITY.md` describes.
- **Releases** are cut by the maintainer from `main` with a `v*` tag; publishing waits for approval in the `release` environment.

## Becoming a maintainer

A contributor with a record of sustained, high-quality contributions and reviews may be invited to become a maintainer by the existing maintainers. A new maintainer gets write access to the repository and, once trusted with releases, admin access to the organization. This file and `CODEOWNERS` are updated in the same change.

## Continuity

Everything needed to continue Saturn is public or held by GitHub, not on one person's machine: the source, the history, issues, the CI and release workflows that build every download, the documentation, and the release signing (build provenance is signed by GitHub Actions through Sigstore, with no private key to hand over). Saturn is MIT-licensed, so anyone may continue it in a fork. Access to the organization, the `release` environment and the security mailbox is today held by the single maintainer; adding a second person with admin access, so the project can continue without interruption if one person cannot, is an open goal.

---

# 專案治理

[English](#governance)

Saturn 如何運作：誰做決定、如何決定，以及每個角色的職責。本文描述專案目前的實際狀況，並隨專案成長以 pull request 更新。

## 模式

Saturn 由 GitHub 上的 **Saturn Technology Project** 組織維護。目前只有**一位維護者** [@rickwengdev](https://github.com/rickwengdev)，對合併與發布擁有最終決定權（年輕專案常見的「仁慈獨裁者」模式）。決策公開進行：在 issue、pull request 與其審查中討論，並記錄於 git 歷史、[`CHANGELOG.md`](CHANGELOG.md) 與發布說明。

## 角色與職責

| 角色 | 人員 | 職責 |
|---|---|---|
| **維護者** | @rickwengdev | 決定方向與[路線圖](README_ZH.md)；審查並合併變更；維持 CI、供應鏈檢查與相依套件的健全；發布版本（打 tag 並核准 `release` 環境）；每次發布時更新文件；回覆 issue。 |
| **安全聯絡人** | 維護者，[security@saturn-core.com](mailto:security@saturn-core.com) | 依 [`SECURITY.md`](SECURITY.md) 接收私密的漏洞回報、確認、修補、協調公開時程並列出回報者的貢獻。 |
| **程式碼負責人** | 列於 [`.github/CODEOWNERS`](.github/CODEOWNERS) | 在變更合併前審查其負責的路徑。 |
| **貢獻者** | 任何人 | 依 [`CONTRIBUTING.md`](CONTRIBUTING.md)（測試、程式碼規範、供應鏈規則）以 pull request 提出變更、回報問題，並遵守[行為準則](CODE_OF_CONDUCT.md)。 |

## 如何做決定

- **日常變更**（修正、路線圖內的功能、相依套件更新）：通過 CI 與維護者審查的 pull request 或 commit 即合併。
- **較大的變更**（新的子系統、安全模型的改變、本機 API 或 CLI 的不相容變更）：先在 issue 中提出並公開討論，再由維護者決定，理由記錄在 issue 中。
- **安全修補**可以私下準備並在公開討論前合併，之後依 `SECURITY.md` 公開。
- **發布**由維護者從 `main` 以 `v*` tag 進行；公開發布須經 `release` 環境核准。

## 成為維護者

長期提供高品質貢獻與審查的貢獻者，可由現有維護者邀請成為維護者。新維護者會取得 repository 的寫入權限，在被信任負責發布後取得組織的管理權限。本文件與 `CODEOWNERS` 會在同一個變更中更新。

## 延續性

延續 Saturn 所需的一切都是公開的或由 GitHub 保管，而不在某個人的電腦上：原始碼、歷史、issue、建置所有下載檔的 CI 與發布 workflow、文件，以及發布簽章（建置來源證明由 GitHub Actions 經 Sigstore 簽署，沒有需要交接的私鑰）。Saturn 採 MIT 授權，任何人都可以 fork 延續。組織、`release` 環境與安全信箱的存取權目前由唯一的維護者持有；增加第二位具管理權限的人，讓專案在任何一人無法繼續時仍能不中斷地延續，是尚待完成的目標。
