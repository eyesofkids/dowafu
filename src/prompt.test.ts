import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFinalizeUserText, buildFirstUserText, buildSystemPrompt, REPORT_PLACEHOLDERS } from "./prompt.js";
import { FIXED_CLOSING_LINE, FIXED_CLOSING_LINE_EN } from "./audit.js";

// prompt.ts 先前無測試覆蓋。plan_dispatch_v2.0.md §16：回報模板追加「引用路徑須與允許讀取
// 清單逐字相同」的要求，從源頭消除 §15 稽核抓到的縮寫路徑噪音——本輪一併補上基本案例。
//
// plan_dispatch_v2.1.md §8：步驟 3 改命令句並列出允許清單路徑（§8（一））；組裝順序改為
// agent body → 工具說明 → 回報模板，工具說明補上允許清單也要讀（§8（二））。

test("buildSystemPrompt：回報模板要求引用路徑與允許清單逐字相同", () => {
  const prompt = buildSystemPrompt("你是測試用 spoke。", "zh");
  assert.match(prompt, /路徑須與「允許讀取」清單中的字串逐字相同，不得縮寫或只寫檔名/);
});

// issue_log_v2.1.md：行號漂移九次派工中出現四次，幅度隨檔案大小放大（68 行檔偏 6 行、
// 1,204 行檔偏 160+ 行），且跨模型一致——改不了。處置是繞過它：要求附逐字原文，讓 hub 能
// 用 grep 定位，行號降為輔助。這條要求通過「最便宜的滿足方式」判準——複製剛讀到的那一行
// 就是最省事的做法，同時堵死「乾脆不寫行號、改寫成明確推理」這條逃避路徑。
test("buildSystemPrompt：回報模板要求附逐字原文，且說明原文是主要依據、行號是輔助", () => {
  const prompt = buildSystemPrompt("你是測試用 spoke。", "zh");
  assert.match(prompt, /原文：/, "模板須有「原文」欄位");
  assert.match(prompt, /逐字複製該處的一行原文/, "須明令逐字複製，不得憑印象重寫");
  assert.match(prompt, /依據為推理時寫「推理」/, "須保留「明確推理」這種依據的寫法");
  assert.match(prompt, /原文是主要依據，行號是輔助/, "須說明理由——模型知道為什麼才會照做");
});

test("buildSystemPrompt：固定收尾句與無法驗證章節仍在（新增句子不得破壞既有模板結構）", () => {
  const prompt = buildSystemPrompt("agent body", "zh");
  assert.match(prompt, /# 觀察/);
  assert.match(prompt, /# 無法驗證/);
  assert.match(prompt, /以上為觀察與問題，採用與否由 hub 與使用者裁決。/);
});

test("buildSystemPrompt：agent body 置於模板之前，且保留 trim 後原文", () => {
  const prompt = buildSystemPrompt("  agent body 有前後空白  ", "zh");
  assert.ok(prompt.startsWith("agent body 有前後空白"));
});

// plan_dispatch_v2.1.md §8（二）：順序是規格，須被鎖住——只驗「三段都在」的話，改回舊順序
// （agent body → 回報模板 → 工具說明）測試照樣綠，抓不到迴歸。
test("buildSystemPrompt：組裝順序為 agent body → 工具說明 → 回報模板", () => {
  const prompt = buildSystemPrompt("agent body 標記", "zh");
  const bodyIdx = prompt.indexOf("agent body 標記");
  const toolNoteIdx = prompt.indexOf("你有一個工具");
  const reportTemplateIdx = prompt.indexOf("# 觀察");
  assert.ok(bodyIdx >= 0 && toolNoteIdx > bodyIdx, "工具說明須在 agent body 之後");
  assert.ok(reportTemplateIdx > toolNoteIdx, "回報模板須在工具說明之後——固定收尾句才不會掉在工具說明前面");
});

test("buildSystemPrompt：工具說明提及允許讀取的程式碼檔案，且要求未讀過的檔案不得出現在依據中（零讀取的第二個成因）", () => {
  const prompt = buildSystemPrompt("agent body", "zh");
  assert.match(prompt, /工單與允許讀取的程式碼檔案都不在本 prompt 中/);
  assert.match(prompt, /未讀過的檔案不得出現在「依據」中/);
});

test("buildFirstUserText：依序讀 _shared.md 與 <agent>.md，且說明允許清單路徑基準", () => {
  const text = buildFirstUserText("/tmp/ticket", "hole-finder-safety", [], undefined, "zh");
  assert.match(text, /read_file\("\/tmp\/ticket\/_shared\.md"\)/);
  assert.match(text, /read_file\("\/tmp\/ticket\/hole-finder-safety\.md"\)/);
  assert.match(text, /相對於 repo 根目錄，不是相對於工單目錄/);
});

// plan_dispatch_v2.1.md §8（一）核心：步驟 3 從「需要時讀取」的條件句改為與步驟 1、2
// 同句型的命令句，且逐條列出允許清單路徑——provider log 顯示模型嚴格照句型行事，
// 命令句會執行、條件句不會（issue_log_v2.0.md 2026-08-07）。
test("buildFirstUserText：允許清單非空時，步驟 3 為命令句並逐條列出路徑", () => {
  const text = buildFirstUserText("/tmp/ticket", "hole-finder-safety", ["src/a.ts", "lib/b.ts"], undefined, "zh");
  const lines = text.split("\n");
  const step3Index = lines.findIndex((l) => l.startsWith("3."));
  assert.ok(step3Index >= 0, "應有步驟 3");
  assert.match(lines[step3Index], /^3\. 逐一 read_file 下列檔案/, "步驟 3 須為命令句，不是「需要時」的條件句");
  assert.doesNotMatch(lines[step3Index], /需要時/, "不得殘留條件句措辭");
  assert.match(text, /- src\/a\.ts/);
  assert.match(text, /- lib\/b\.ts/);
});

test("buildFirstUserText：允許清單為空時給明確說明，不留條件句", () => {
  const text = buildFirstUserText("/tmp/ticket", "hole-finder-safety", [], undefined, "zh");
  assert.match(text, /3\. 本次無允許讀取檔案，僅依待審段落作答。/);
  assert.doesNotMatch(text, /需要時/, "空清單時不得留下語意模糊的條件句");
});

// issue_log_v2.1.md：步驟 1、2 絕對、步驟 3 相對，spoke 混用後引用寫成絕對路徑，被稽核判為
// 「清單外引用」——第 7 次 11 筆、第 9 次 7 筆都是這種噪音，而第 9 次同欄還混著 2 筆真的漏檔。
test("buildFirstUserText：工單目錄在 repoRoot 內時，步驟 1、2 用相對路徑（與步驟 3 同一種格式）", () => {
  const text = buildFirstUserText("/repo/tmp/dispatch/t1", "hole-finder-safety", ["src/a.ts"], "/repo", "zh");
  assert.match(text, /read_file\("tmp\/dispatch\/t1\/_shared\.md"\)/);
  assert.match(text, /read_file\("tmp\/dispatch\/t1\/hole-finder-safety\.md"\)/);
  assert.doesNotMatch(text, /read_file\("\/repo/, "不得再出現絕對路徑，否則 spoke 又會看到兩種格式");
});

// cli.ts 明文「工單目錄仍相對 cwd 解析，不要求位於 repoRoot 內」——在外時轉相對會得到 ../..
// 這種更難讀的字串，故維持絕對。
test("buildFirstUserText：工單目錄在 repoRoot 外時維持絕對路徑，不產生 ../..", () => {
  const text = buildFirstUserText("/elsewhere/t1", "hole-finder-safety", ["src/a.ts"], "/repo", "zh");
  assert.match(text, /read_file\("\/elsewhere\/t1\/_shared\.md"\)/);
  assert.doesNotMatch(text, /\.\.\//, "不得出現 ../.. 形式的路徑");
});

test("buildFirstUserText：repoRoot 為 undefined 時維持絕對路徑（向後相容）", () => {
  const text = buildFirstUserText("/repo/tmp/dispatch/t1", "hole-finder-safety", ["src/a.ts"], undefined, "zh");
  assert.match(text, /read_file\("\/repo\/tmp\/dispatch\/t1\/_shared\.md"\)/);
});

test("buildFirstUserText：步驟 4（依回報模板產出）仍在步驟 3 之後，不因路徑清單長度而錯位", () => {
  const text = buildFirstUserText("/tmp/ticket", "hole-finder-safety", ["a.ts", "b.ts", "c.ts"], undefined, "zh");
  assert.match(text, /- c\.ts\n4\. 依 system prompt 的回報模板產出/);
});

test("buildFinalizeUserText：收束呼叫文字要求不再呼叫工具", () => {
  assert.match(buildFinalizeUserText("zh"), /不要再呼叫工具/);
});

// 英文工單的 prompt：模板、工具說明、四個步驟都要換過去，而且**收尾句必須與稽核那側
// 逐字相同**——那是稽核判斷「回報有沒有寫完」的唯一依據，兩邊各寫各的就永遠 fail。
test("buildSystemPrompt：lang=en 時給英文回報模板與英文工具說明", () => {
  const p = buildSystemPrompt("You are a reviewer.", "en");
  assert.match(p, /# Observations/);
  assert.match(p, /# Cannot verify/);
  assert.match(p, /read_file\(path\)/);
  assert.doesNotMatch(p, /觀察/);
});

test("buildSystemPrompt：英文模板的收尾句與 audit 的 FIXED_CLOSING_LINE_EN 逐字相同", () => {
  const p = buildSystemPrompt("You are a reviewer.", "en");
  assert.ok(
    p.trimEnd().endsWith(FIXED_CLOSING_LINE_EN),
    `英文模板結尾必須是稽核認得的那一句，實際結尾：${JSON.stringify(p.trimEnd().slice(-80))}`,
  );
});

// plan_i18n_v1.3.md §一之2：lang 不再有預設值（防未來新增呼叫端靜默拿到與產品預設相反
// 的值），呼叫端一律顯式傳入——這裡驗證顯式傳 "zh" 仍是既有工單的行為，不受影響。
test("buildSystemPrompt：顯式傳 lang=\"zh\" 維持中文，既有工單不受影響", () => {
  const p = buildSystemPrompt("你是審查者。", "zh");
  assert.match(p, /# 觀察/);
  assert.ok(p.trimEnd().endsWith(FIXED_CLOSING_LINE));
});

test("buildFirstUserText：lang=en 時四個步驟與清單說明都是英文", () => {
  const t = buildFirstUserText("/repo/tmp/dispatch/x", "hole-finder-safety", ["lib/a.ts"], "/repo", "en");
  assert.match(t, /Do these in order/);
  assert.match(t, /read_file\("tmp\/dispatch\/x\/_shared\.md"\)/);
  assert.match(t, /- lib\/a\.ts/);
  assert.match(t, /Cannot verify/);
  assert.doesNotMatch(t, /依序執行/);
});

test("buildFinalizeUserText：lang=en 時給英文收束指示", () => {
  assert.match(buildFinalizeUserText("en"), /do not call any more tools/);
  assert.match(buildFinalizeUserText("zh"), /不要再呼叫工具/);
});

// 工單 X1 v1.1 §二驗收補件：REPORT_PLACEHOLDERS 是從 REPORT_TEMPLATE／REPORT_TEMPLATE_EN
// 手打出來的第二份清單，兩者之間沒有任何機制強制同源——改模板的人要自己記得同步改常數，
// 沒有東西會擋。這裡把雙向一致性鎖住，兩個方向都要測：
//   方向一：清單裡的每一條都真的在模板裡（清單多寫、模板沒有 → 紅）
//   方向二：模板裡用到的每一個佔位符都在清單裡（模板加了新的、清單沒跟上 → 紅，這是重點）
// 刻意不重構 REPORT_TEMPLATE／REPORT_TEMPLATE_EN 字面（prompt.ts:10-12：那些措辭對 spoke
// 的行為敏感，實測描述句會被當建議略過），也不把模板常數另外 export 出來給測試用——
// buildSystemPrompt("", lang) 用空字串 agent body 就能拿到「工具說明＋回報模板」的完整文本，
// 不必擴大對外 API。

test("REPORT_PLACEHOLDERS：清單裡每一條都真的出現在其中一份 system prompt 裡（清單有、模板沒有 → 紅）", () => {
  const zhPrompt = buildSystemPrompt("", "zh");
  const enPrompt = buildSystemPrompt("", "en");
  for (const placeholder of REPORT_PLACEHOLDERS) {
    assert.ok(
      zhPrompt.includes(placeholder) || enPrompt.includes(placeholder),
      `REPORT_PLACEHOLDERS 裡的 "${placeholder}" 沒有出現在任何一份 system prompt 裡——清單與模板已經不同源`,
    );
  }
});

// 尖括號形態 <…> 在 system prompt 裡只有回報模板的佔位符會用到——agent body 這裡傳空字串，
// TOOL_NOTE／TOOL_NOTE_EN 本身完全不含尖括號（見上面「工具說明」相關測試比對的字串）。
// 所以直接從組好的完整文本抽取 <…> 子字串，就是「模板實際用了哪些佔位符」的權威來源，
// 不必另外把模板字串剝出來比對。這個方向是重點：方向一測不出模板加了新佔位符這件事
// （清單裡沒有的東西，模板有沒有跟著加，方向一無從得知），只有反過來從模板抽取才抓得到。
test("REPORT_PLACEHOLDERS：兩份 system prompt 裡出現的每一個 <…> 形態都要在清單裡（模板加了新佔位符、清單沒跟上 → 紅）", () => {
  const zhPrompt = buildSystemPrompt("", "zh");
  const enPrompt = buildSystemPrompt("", "en");
  const angleBracketPattern = /<[^<>]+>/g;
  const found = new Set(
    [...zhPrompt.matchAll(angleBracketPattern), ...enPrompt.matchAll(angleBracketPattern)].map((m) => m[0]),
  );
  assert.ok(found.size > 0, "抽取邏輯本身要先抓到東西，抓到 0 個代表抽取方式壞了，不是模板真的沒有佔位符");
  for (const literal of found) {
    assert.ok(
      REPORT_PLACEHOLDERS.includes(literal),
      `system prompt 裡出現了 "${literal}"，但 REPORT_PLACEHOLDERS 沒有這一條——清單與模板已經不同源`,
    );
  }
});
