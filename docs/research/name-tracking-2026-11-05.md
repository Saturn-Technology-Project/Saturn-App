# Pythia 名字追蹤：embedding 與晚期下滑的後續實驗

2026-11-05，在 macOS 上以快取的 Pythia-160m 權重離線執行。這次接續兩個問題：130k → 143k 的
Laura/David 失敗能否只靠 input embedding 修復；120k 的廣泛下滑有沒有相同的介入反應。
資料是探索性結果，沒有修改任何既有假說的判定。

## 先更正量測與介入

原始 scorer 看的是 `logit(正確名字) - logit(另一名字) > 0`，不是正確名字必須成為全詞表 top-1。
模型可以把「the」放在第一名，同時仍在兩個名字之間選對。因此本次分開記錄 `correct`（margin > 0）
和 `topCorrect`，所有「恢復名字分數」均指前者。

舊 helper 還有兩個 normalization 問題，已用兩層隨機 GPT-NeoX 的回歸測試重現並修正：

- `hidden_states[-1]` 已經過 final norm，不能拿來替換最後一個 block 的未正規化輸出。現在直接以
  forward hook 擷取 block 的實際輸出。
- 最後一層的 logit-lens reading 曾再套一次 final norm。現在最後一個 hidden state 直接經過 output head。

新的 helper 雜湊會參與 cache key，舊結果留下，新 helper 重新計算。既有結果沒有被覆寫。
也已經透過實際 Rust HTTP API 執行修正後的 helper：
[0031 的最後一個 block patch](name-tracking-2026-11-05/runtime-intervention-0031.json) 恢復 `" Mike"`，
[120k 的 17×12 次 sweep](name-tracking-2026-11-05/runtime-sweep-120k.json) 的 top-1 與 expected log-probability
均與獨立後續腳本一致（log-probability 誤差不超過 0.002）。

「在 block k 後替換 residual」移植的是 donor 的整個前綴計算結果，涵蓋 embedding 和 block 0…k，
不能據此把變化定位在 block k。reading 的 layer 0 是 embedding；patch 的 layer 0 是第一個 block 的輸出。

## 可重現性與基準

- 原始 run：`run_f0e267f823016961`；後續 run：`run_03e5449a6b6dfda4`，版本 `version_bba096cb501b8c5d`。
- Python 3.14.8、torch 2.14.1、transformers 5.22.1、CPU、float32、SDPA、6 個執行緒、seed 0。
- 沿用原本 16 對名字、兩個順序、四個地點，共 128 個提示；Lena/Tom 的 8 題維持 scorer error，
  每個 checkpoint 實際評分 120 題。四個 checkpoint 合計 480 筆分數、32 筆 scorer error，無基礎設施錯誤。
- 100k：117/120；120k：103/120；130k：120/120；143k：113/120。每筆正誤與 top-1 均與原 run 一致，
  margin 與原 run 的四位小數相差不超過 0.002。
- 模型解析為不可變 Hugging Face commit，並記錄權重 SHA-256；完整規格與檔案雜湊見
  [manifest](name-tracking-2026-11-05/manifest.json) 與 [checksums](name-tracking-2026-11-05/checksums.json)。
- 每個失敗樣本都做 embedding、第一個 block、最後一個 block 的 self-patch，共 123 次全詞表檢查，
  最大 logit 差均為 0。這避免把 patch 自己製造的變化當成實驗結果。

最初一次 preflight 強制用 eager attention，無法在既定誤差內重現 SDPA 的原分數，於第 20 筆後停止。
該 run `run_bd837f4d40bff113` 保留為 failed，沒有產生介入結論。完成的 run 保留一條樣本數警告：它與
這次失敗的 20 筆 preflight 比較得到 128 對 20；本次的提示集並沒有因此改變。

## 11：Laura/David 的 embedding

130k → 143k，`" Laura"`（token 21960）的 input embedding 相對 L2 差為 0.14189、cosine 為 0.99076；
`" David"`（token 5119）分別為 0.11088、0.99487。全詞表相對 L2 的中位數為 0.14926，兩者約在第
32.26 與 3.83 百分位。output embedding 的相對差分別為 0.18554、0.18511，也接近詞表中位數 0.18648。
參考分布包含模型所有詞表列與 padding/未使用列，這些百分位只是描述，不是特異性檢定。

因果介入比向量距離更有用：保留 143k 的所有 blocks、final norm 與 output head，只把提示內名字 token
出現位置的 input embedding 換成 130k，四個 Laura 錯例的名字 margin 從：

- store：−3.2082 → +0.8074。
- park：−3.0535 → +0.3601。
- office：−3.0675 → +0.7911。
- school：−2.9760 → +0.5590。

四題均恢復名字分數，其中 store、office 也恢復全詞表 top-1；另外兩題仍以「the」為 top-1。
反向的 David 四題維持 4/4。相同介入在對照組 Mike/Sarah 維持 5/8，Mary/John 維持 8/8。
替換全部 input embeddings 也得到相同的四題正誤結果。

可支持的觀察：在這批固定提示上，舊版名字位置的 embedding 足以消除 Laura 對 David 的負 margin。
尚不能推出 Laura/David 的向量變動幅度異常，或只存在一個 embedding 缺陷；仍可能是 embedding 與
後續權重的相容性、方向上的細微改變，或其他交互作用。沒有測 necessity、反向 patch 或全資料集的泛化。

原始數據：[130k → 143k](name-tracking-2026-11-05/step130000-into-step143000.json)。

## 13：120k 的 17 個錯例

保留所有 17 個 target 錯例，分別用 100k、130k 當 donor。100k 在其中兩題本來也錯，130k 則 17 題全對；
不能把兩個 donor 的結果差別全部歸於機制位置。

以名字 margin 計，每個 block 後恢復的題數（block 0…11）：

- 100k → 120k：`3 4 8 10 12 7 16 15 11 15 15 13`，分母 17。
- 130k → 120k：`8 14 13 13 14 13 16 16 17 17 17 16`，分母 17。
- 130k → 143k：`4 5 5 6 7 5 7 7 7 7 7 7`，分母 7。

只替換全部 input embeddings，100k → 120k 恢復 2/17，130k → 120k 恢復 6/17；130k → 143k 恢復 4/7。
130k → 120k 在 block 8、9、10 後可恢復全部 17 題的名字 margin，但 top-1 分別只有 7、9、7 題恢復。
在最後一個 block 後換入 130k 的 residual，120k 的名字 margin 仍有 16/17 恢復，top-1 卻是 0/17。
這顯示替換後的 readout 與名字二選一分數需分開檢查，下一步可單獨介入 final norm 與 output head。

可支持的觀察：120k 與 143k 的失敗分布和介入反應不同，130k 的前綴狀態可以改善兩者。這不足以判定
它們一定是同一個或不同的機制，更不足以定位單一 circuit 或 block；整個 residual transplant
會同時替換很多資訊。需加入局部介入、保持正常樣本的檢查，才能繼續縮小解釋。

原始數據：[100k → 120k](name-tracking-2026-11-05/step100000-into-step120000.json)、
[130k → 120k](name-tracking-2026-11-05/step130000-into-step120000.json)。

## 12 與 14 的處理

143k 的 Mike/Sarah `sample-0031`，修正後在最後一個 block 後 patch 得到 top-1 `" Mike"`、margin +0.7192。
舊的錯位 patch 得到 top-1 `" the"`、margin +0.5972。原本「任何單層都救不回」的 top-1 結論因此不成立；
以原始 margin 評分，它在更早的 block 後就可恢復。

本次沒有加兩層區間模式。在目前對同一個完整提示替換全部 token residual 的定義下，於 block i 和 j
各貼入固定 donor 狀態，最後的 j 會覆蓋先前 i 的影響；不能藉此測兩層協同。若要檢查協同，需先定義
block 權重替換、局部 token patch，或 attention/MLP 分量介入。

已新增待驗假說 `hypothesis_0495a853f920d539`：晚期下滑可能包含名字 embedding 與後續計算/readout 的
不同來源。狀態維持 `undecided`；原先已 `refuted` 的假說不變。新的觀察要與舊的 sweep 解讀一起閱讀。
原專案另存三筆觀察：`finding_1ceddfcd479013bb` 更正舊 sweep，`finding_0faca306a23a6d20` 記錄
embedding 介入，`finding_f98a48c323aa32a8` 記錄 120k 的 sweep。

## 重跑與測試

以有 torch 與 transformers 的研究 Python 執行，模型四個 commit 需已在本機 Hugging Face 快取中。
腳本強制離線，沒有下載 fallback；輸出資料夾必須不存在。

```sh
python scripts/research/name_tracking_followup.py \
  --samples docs/research/name-tracking-2026-11-05/original-samples.jsonl \
  --models docs/research/name-tracking-2026-11-05/models.json \
  --output /tmp/pythia-followup-replay

python crates/saturn-core/tests/research_followup_test.py
cargo build -p saturn-server -p saturn-cli
node --test contract/research-inside.test.mjs
```

若用 Saturn 執行，省略 `--output`；baseline JSONL 寫入 `SATURN_RUN_SAMPLES`，介入證據另存
`SATURN_RUN_DIRECTORY/followup/`。不得把 baseline 與 patch 分數混成同一個平均。

本次通過 111 個研究契約／桌面規則測試、46 個 saturn-core／saturn-domain Rust 測試、6 個研究 Python
檢查，以及 `cargo fmt --all --check`、`cargo clippy --all-targets`、`cargo deny check`。
涉及行程與內層 shell sandbox 的測試在代理沙箱外，以隔離的暫存專案與假模型執行。

本次沒有驗證真實 Tauri 視窗、Claude Code/Codex 帳號或 Windows；也沒有處理清單中其他介面與環境管理項目。
