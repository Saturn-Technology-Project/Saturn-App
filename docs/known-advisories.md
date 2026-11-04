# Known advisories

Security advisories that affect a dependency Saturn carries, have been reviewed, and are deliberately left open, with the reason and the condition for closing each one. Everything else is fixed: the [supply-chain workflow](../.github/workflows/supply-chain.yml) runs `npm audit` at high severity on the npm packages the desktop app ships and `cargo deny` on the crates, and Dependabot proposes patches as soon as they exist.

[中文](#已知的安全公告)

## Accepted in code that ships

There are none: no known advisory is left open in what the macOS and Windows builds ship.

## In `Cargo.lock`, not in code that ships

`Cargo.lock` covers every platform, so it lists crates that Saturn's macOS and Windows builds do not contain. None of these is a security hole in what ships; all but one are notices that a crate is unmaintained.

| Advisory | Package | Where it is | What closes it |
|---|---|---|---|
| RUSTSEC-2024-0436 (unmaintained) | `paste` 1.0.15 | A compile-time macro of `tokenizers`, in `saturn-embed`; no code of it ships | `tokenizers` moves off it |
| RUSTSEC-2024-0429, GHSA-wrw7-89jp-8q8g (unsound `VariantStrIter`) | `glib` 0.18.5 | Linux builds of the Tauri shell only, through `muda` and `gtk`; Saturn has no Linux package | Tauri's Linux dependencies move to `glib` 0.20 or later |
| RUSTSEC-2024-0370 (unmaintained) | `proc-macro-error` 1.0.4 | The same Linux path, a compile-time macro of `glib` | As above |
| RUSTSEC-2026-0370, RUSTSEC-2026-0371, RUSTSEC-2026-0372 (unmaintained) | `zvariant` 5.15.1, `zbus_names` 4.3.5, `zvariant_derive` 5.15.1 | Linux builds of the Tauri shell only, through `tauri-plugin-single-instance` and `zbus` | `zbus` moves off them |

## Adding an entry

An advisory goes here only after a review shows it cannot be fixed now (no patch, or the patch needs an upstream change) and its exposure is understood. Each entry records the advisory, where the package is, why it stays open, and what closes it. Dismiss the Dependabot alert with the matching reason and link back to this file. Remove the entry in the same change that ships the fix.

---

# 已知的安全公告

這裡列出影響 Saturn 某個相依套件、已經審視過、並刻意暫不處理的安全公告，以及每一項的理由與結案條件。其他公告一律修補：[supply-chain workflow](../.github/workflows/supply-chain.yml) 對桌面應用程式出貨的 npm 套件執行 high 等級的 `npm audit`，對 crate 執行 `cargo deny`，而修補一發布 Dependabot 就會提出更新。

[English](#known-advisories)

## 出貨程式中已接受的公告

沒有：macOS 與 Windows 版本出貨的內容中，沒有任何已知而未修補的公告。

## 在 `Cargo.lock` 中，但不在出貨程式中

`Cargo.lock` 涵蓋所有平台，所以會列出 Saturn 的 macOS 與 Windows 版本不包含的 crate。以下沒有一項是出貨內容中的安全漏洞；除了一項之外，都是 crate 不再維護的通知。

| 公告 | 套件 | 位置 | 結案條件 |
|---|---|---|---|
| RUSTSEC-2024-0436（不再維護） | `paste` 1.0.15 | `tokenizers` 的編譯期巨集，位於 `saturn-embed`；不會出貨任何程式碼 | `tokenizers` 不再使用它 |
| RUSTSEC-2024-0429、GHSA-wrw7-89jp-8q8g（`VariantStrIter` 不健全） | `glib` 0.18.5 | 只在 Tauri 外殼的 Linux 建置中，經由 `muda` 與 `gtk`；Saturn 沒有 Linux 套件 | Tauri 的 Linux 相依套件改用 `glib` 0.20 以上 |
| RUSTSEC-2024-0370（不再維護） | `proc-macro-error` 1.0.4 | 同一條 Linux 路徑，`glib` 的編譯期巨集 | 同上 |
| RUSTSEC-2026-0370、RUSTSEC-2026-0371、RUSTSEC-2026-0372（不再維護） | `zvariant` 5.15.1、`zbus_names` 4.3.5、`zvariant_derive` 5.15.1 | 只在 Tauri 外殼的 Linux 建置中，經由 `tauri-plugin-single-instance` 與 `zbus` | `zbus` 不再使用它們 |

## 新增一筆

只有在審視後確認目前無法修補（沒有修補版本，或修補需要上游變更），且清楚其曝險範圍時，公告才會列入這裡。每筆都要記錄公告、套件位置、暫不處理的原因與結案條件。以相符的理由關閉對應的 Dependabot 警示，並連回本檔。修補出貨時，在同一個變更中移除該筆。
