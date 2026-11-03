# Known advisories

Security advisories that affect a dependency Saturn carries, have been reviewed, and are deliberately left open, with the reason and the condition for closing each one. Everything else is fixed: the [supply-chain workflow](../.github/workflows/supply-chain.yml) fails on any high or critical advisory in what the runtime and the desktop app ship, and Dependabot proposes patches as soon as they exist.

[中文](#已知的安全公告)

## Accepted in code that ships

There are none: no known advisory is left open in the runtime or the desktop app.

## Adding an entry

An advisory goes here only after a review shows it cannot be fixed now (no patch, or the patch needs an upstream change) and its exposure is understood. Each entry records the advisory, where the package is, why it stays open, and what closes it. Dismiss the Dependabot alert with the matching reason and link back to this file. Remove the entry in the same change that ships the fix.

---

# 已知的安全公告

這裡列出影響 Saturn 某個相依套件、已經審視過、並刻意暫不處理的安全公告，以及每一項的理由與結案條件。其他公告一律修補：[supply-chain workflow](../.github/workflows/supply-chain.yml) 只要在 Runtime 或桌面應用程式出貨的內容中發現 high 或 critical 等級的公告就會失敗，而修補一發布 Dependabot 就會提出更新。

[English](#known-advisories)

## 出貨程式中已接受的公告

沒有：Runtime 與桌面應用程式中沒有任何已知而未修補的公告。

## 新增一筆

只有在審視後確認目前無法修補（沒有修補版本，或修補需要上游變更），且清楚其曝險範圍時，公告才會列入這裡。每筆都要記錄公告、套件位置、暫不處理的原因與結案條件。以相符的理由關閉對應的 Dependabot 警示，並連回本檔。修補出貨時，在同一個變更中移除該筆。
