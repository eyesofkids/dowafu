---
name: wrap
description: 實作收尾與驗收前置檢查：自檢專案的完成條件全綠、確認 report/runbook/issue_log 齊備、產出使用者手測清單與 diff 對照摘要、提示切 session（不 compact）。實作 session 完工或 context 吃緊時使用。
---

# wrap — 實作收尾

你是實作 spoke，正在收尾。先判定模式：

- **完工收尾**（預設）：工作項已完成 → 走第 1–4 節。
- **中途交接**：context 吃緊、工作未完 → 直接走第 5 節（不適用「全綠才收工」）。

## 1. 自檢全綠

完成條件**以該專案 AGENTS.md 訂的為準**。沒有訂就看 `package.json` 的 `scripts`，**有哪些跑哪些**（`test`／`lint`／`typecheck`／`build`）。

- **不要為了湊數字自行加工具**（例如專案沒有 lint 就別裝 ESLint）
- **也不要因為「看起來沒必要」跳過已存在的 script**

兩條執行細節：

- 測試**只跑本次改到的模組**，判定範圍見該專案 AGENTS.md 測試規範。禁止接 `| sort`／`| head`／`| tail`——那會吃掉失敗訊息
- `typecheck` 與 `build` 若是兩個獨立 script，**分開跑、不要合併**。build 設定常把測試檔排除在外，只有 typecheck 涵蓋得到；合併之後「建置失敗」與「測試型別錯」也會無法區分

任何一項不綠：先修好再繼續收尾，**不得帶紅收工**。

## 2. 文件檢查

- **report**：已產出？含「施工中修正」節（實作偏離規劃之處）？
- **runbook**：已產出？含機器測不到部分的手測步驟（環境、路徑、操作順序、預期結果）？
- **issue_log**：本輪 report 產出後的修正是否逐筆記錄？（report/runbook 不回頭改，見 AGENTS.md 文件紀律）

## 3. 產出驗收包（給使用者的最終訊息）

依序呈現：

1. **手測清單**：從 runbook 抽出使用者要親手驗的項目，逐條列（步驟＋預期結果），不要叫使用者自己去翻 runbook。
2. **diff 對照摘要**：實際改動檔案清單 vs 規劃書檔案清單，逐一對應；**超出規劃的改動明確標出**（夾帶是驗收紅線）。
3. **待決事項**：實作中發現但未處理的問題（記 issue_log 待後續，或需使用者裁決的）。

## 4. 收尾提醒

- **不建議 commit**——依 AGENTS.md Git 安全規範，先呈 diff 給使用者確認。
- **不用 compact**：若 context 已吃緊，明講「本 session 建議收工，後續修補可續用本 session（熱修補）；若本 session 已冷或被切割，開新 session 依 report＋issue_log 冷啟動」。
- 修補波期間：每修一筆 append issue_log。

## 5. 中途交接（context 吃緊、未完工）

**不 compact**——compact 後地圖已被有損壓縮，熱 session 的價值已死；改寫交接文後關 session。

1. 更新 todo 狀態（已完成／進行中／未動）。
2. 寫交接文 `_docs/<領域>/handoff_<主題>.md`（首份無版號，之後 `handoff_<主題>_v<n>.md`）。
   **一次一份新檔，不 append 到舊份**——舊份留著當歷史，不回頭改。
   表頭列出日期、交接原因、分支狀態，以及**前一份的連結與取代關係**
   （例：「前一份 `handoff_<主題>_v4.md`——內容已完成，本檔取代」），內容：
   - 規劃書路徑＋目前做到第幾個工作項
   - 改到一半的檔案清單＋各自狀態（例：「X.ts 已改完未測」「Y.ts 改一半，缺 Z」）
   - 目前紅綠狀態（哪些測試綠、哪些紅、為什麼）
   - 下一步（具體到「打開哪個檔做什麼」）
   - 環境備註與陷阱（dev server 埠、flaky 測試、workaround）
3. 本輪已完成的修正照常記 issue_log。
4. 給使用者一行接續指令：「新 session 開場：`依 <plan路徑> 續作，先讀 <handoff路徑> 與 issue_log`」。
