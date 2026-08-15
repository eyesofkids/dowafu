import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { auditSpoke, FIXED_CLOSING_LINE, FIXED_CLOSING_LINE_EN } from "./audit.js";

// plan_dispatch_v1.9.md §15：observationCount 放寬 regex，且「數不出來」記 null、「明確為零」
// 記 0——這是 v1.10 §25 的 --json 契約直接依賴的區分（序列化時降級為 0 就白改了）。
// audit.ts 先前完全沒有測試覆蓋，本輪一併補上基本案例。

function withClosing(body: string): string {
  return `${body}\n${FIXED_CLOSING_LINE}`;
}

test("auditSpoke：finalText 為 null → observationCount 為 null（無內容可數，不是數出來是零）", () => {
  const result = auditSpoke(null);
  assert.equal(result.observationCount, null);
  assert.equal(result.finalLinePass, false);
});

test("auditSpoke：頂層平鋪編號（範本原定格式）正確計數", () => {
  const text = withClosing(`# 觀察
1. 第一條觀察
   依據：a.ts:1
2. 第二條觀察
   依據：b.ts:2

# 無法驗證
無`);
  const result = auditSpoke(text);
  assert.equal(result.observationCount, 2);
});

test("auditSpoke：巢狀「**觀察 N.N**」標記正確計數（deepseek 真實回報的實際格式）", () => {
  const text = withClosing(`# 觀察

## 問題 1：第一類問題

**觀察 1.1**：第一條
依據：a.ts

**觀察 1.2**：第二條
依據：b.ts

## 問題 2：第二類問題

**觀察 2.1**：第三條
依據：c.ts

# 無法驗證
無`);
  const result = auditSpoke(text);
  assert.equal(result.observationCount, 3);
});

test("auditSpoke：「### 觀察 N」標題形式正確計數", () => {
  const text = withClosing(`# 觀察

### 觀察 1
內容一

### 觀察 2
內容二

### 觀察 3
內容三

# 無法驗證
無`);
  const result = auditSpoke(text);
  assert.equal(result.observationCount, 3);
});

// real-run-i18n-lang（2026-08-12）：`deepseek-v4-flash` 的中文格把觀察寫成
// `## 1. 「比照 tags 路由」…`——標題形式，但編號後面直接接內容、沒有「觀察」二字，
// 既有的兩條標題樣式都認不出來，於是整份判「無法計數」。同一份工單重跑改用平鋪編號就數得出來。
// **那是該次對照中唯一一項「中文格看起來比英文格差」的來源，而它與語言無關。**
test("auditSpoke：`## 1. 內容` 這種標題編號（無「觀察」二字）→ 數得出來，不是 null", () => {
  const body = [
    "# 觀察",
    "",
    "## 1. 「比照 tags 路由」的骨架成立，但呼叫形態與現檔不同",
    "依據：app/api/tags/route.ts:12",
    "",
    "## 2. 既有資料的 role 處理完全未涵蓋",
    "依據：推理",
    "",
    "# 無法驗證",
    "- 無",
  ].join("\n");
  assert.equal(auditSpoke(withClosing(body)).observationCount, 2);
});

test("auditSpoke：平鋪編號仍優先於標題編號樣式（新樣式排在最後，不得蓋掉既有判讀）", () => {
  const body = ["# 觀察", "", "## 背景", "1. 第一條", "2. 第二條", "3. 第三條"].join("\n");
  assert.equal(auditSpoke(withClosing(body)).observationCount, 3);
});

test("auditSpoke：章節存在但內容為空 → observationCount 為 0（明確為零，不是數不出來）", () => {
  const text = withClosing(`# 觀察

# 無法驗證
無`);
  const result = auditSpoke(text);
  assert.equal(result.observationCount, 0);
});

test("auditSpoke：章節有內容但不符任何已知樣式 → observationCount 為 null（無法辨識）", () => {
  const text = withClosing(`# 觀察
這裡只有一段散文敘述，沒有用任何編號或標記列出個別觀察。

# 無法驗證
無`);
  const result = auditSpoke(text);
  assert.equal(result.observationCount, null);
});

test("auditSpoke：完全沒有「# 觀察」章節 → observationCount 為 null", () => {
  const text = withClosing(`# 無法驗證
無`);
  const result = auditSpoke(text);
  assert.equal(result.observationCount, null);
});

// 工單 X1 v1.1 §六（使用者裁示 2026-08-15）：「清單外引用」判定拿掉，citedPaths 純記錄保留。
test("auditSpoke：收尾句判定與引用路徑記錄不受本輪變更影響", () => {
  const text = withClosing(`# 觀察
1. 引用了 src/secret.ts:10

# 無法驗證
無`);
  const result = auditSpoke(text);
  assert.equal(result.finalLinePass, true);
  assert.ok(result.citedPaths.includes("src/secret.ts"));
});

// plan_dispatch_v1.12.md §15：PATH_REGEX 的字元類 [\w.\-] 不匹配中括號，Next.js 動態路由
// 段（[id]、[...slug]、[[...slug]]）會被從中括號後截斷，導致清單內的合法引用被誤判為
// 清單外。素材取自首次外部派工的真實回報原文（issue_log_v1.md 同日條目）。
test("auditSpoke：含 [id] 動態路由段的路徑須完整抽出（真實回報原文）", () => {
  const text = withClosing(`# 觀察
1. \`POST /api/todos/[id]/external/generate\` 的實際程式碼沒有驗證登入狀態。
   依據：\`app/api/todos/[id]/external/generate/route.ts:17-36\` 僅查詢 todo 是否存在。
2. expires 單位規格與實作不一致。
   依據：app/api/todos/[id]/external/route.ts:159-173，並比對 lib/hash.ts:15-16。

# 無法驗證
無`);
  const result = auditSpoke(text);
  assert.ok(
    result.citedPaths.includes("app/api/todos/[id]/external/generate/route.ts"),
    `應完整抽出含 [id] 的路徑，實際抽出：${JSON.stringify(result.citedPaths)}`,
  );
  assert.ok(result.citedPaths.includes("app/api/todos/[id]/external/route.ts"));
});

// 熱修補（issue_log_v1.md 同日條目）：「無法驗證」章節內的路徑同樣須記錄——§16 回報模板
// 定義該欄為「需要但讀不到的檔案」，出現在該欄的路徑也是「引用過」的事實，citedPaths 是
// 純記錄，不因欄位而漏記。素材為某次外部派工 hole-finder-feasibility 的真實回報原文。
test("auditSpoke：「無法驗證」章節內引用的路徑同樣記入 citedPaths（真實回報原文）", () => {
  const text = withClosing(`# 觀察
1. **關於 POST /api/todos/[id]/external/generate 的 500 狀態碼描述**
   - 依據：\`app/api/todos/[id]/external/generate/route.ts:25-36\`。

2. **PUT 操作的 tag 處理機制**
   - 依據：\`app/api/todos/[id]/external/route.ts:159-173\`。

3. **Markdown 解析邏輯**
   - 依據：\`lib/markdown-todo.ts:60-120\`。

# 無法驗證
- \`lib/hash.ts\`：該檔案負責實際的 generateShareHash 與 verifyShareHash 邏輯，不在允許讀取清單中，無法驗證 180 天效期與 HMAC 簽名演算法實作細節。`);
  const result = auditSpoke(text);
  assert.ok(result.citedPaths.includes("lib/hash.ts"), "citedPaths 須完整記錄，記錄與判定是不同職責");
});

// 同一路徑跨「觀察」與「無法驗證」兩節出現時，citedPaths 去重後仍只有一筆——記錄職責是
// 「出現過哪些路徑」，不是「出現幾次」。
test("auditSpoke：同一路徑同時出現在「觀察」與「無法驗證」兩節時，citedPaths 去重後仍記錄一筆", () => {
  const text = withClosing(`# 觀察
1. 依據：\`src/fabricated.ts:42\` 的實作有缺陷。

# 無法驗證
- \`src/fabricated.ts\`：不在允許清單，無法確認。`);
  const result = auditSpoke(text);
  assert.deepEqual(result.citedPaths, ["src/fabricated.ts"]);
});

test("auditSpoke：[...slug]／[[...slug]] 兩種 catch-all 動態路由段同樣須完整抽出", () => {
  const text = withClosing(`# 觀察
1. 兩種 catch-all 路由的比對。
   依據：app/blog/[...slug]/page.tsx 與 app/shop/[[...slug]]/page.tsx。

# 無法驗證
無`);
  const result = auditSpoke(text);
  assert.ok(result.citedPaths.includes("app/blog/[...slug]/page.tsx"));
  assert.ok(result.citedPaths.includes("app/shop/[[...slug]]/page.tsx"));
});

// plan_fixes_v1.0.md §1：兩份實際落檔的報告，條目用 "**N. 內容**"（粗體包住編號）——
// 改前 OBSERVATION_PATTERNS 一種都不命中，判「無法計數」。素材是真實派工產物，不是手造案例。
//
// fixture 是那兩份報告的**結構**，內容已去識別化：標題文字、依據路徑、原文區塊一律換掉，
// 條數、章節與收尾句逐一保留——被測的正是結構。未處理的原件含被審專案的原始碼與規劃書
// 內容，不進版控。
function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/audit/${name}`, import.meta.url)), "utf8");
}

test("auditSpoke：真實報告的結構（粗體編號格式）數出 13 條", () => {
  const text = readFixture("bold-numbered-13.md");
  const result = auditSpoke(text);
  assert.equal(result.observationCount, 13);
});

test("auditSpoke：真實報告的結構（粗體編號格式）數出 19 條", () => {
  const text = readFixture("bold-numbered-19.md");
  const result = auditSpoke(text);
  assert.equal(result.observationCount, 19);
});

// 英文工單的回報：章節名、收尾句、觀察計數三處都要認得。認不得的後果不是漏一欄，是
// 「收尾句 fail ＋ 觀察無法計數 ＋ 無法驗證欄缺失」全紅，而產出其實完全正常。
test("auditSpoke：英文回報的收尾句、章節與計數都認得", () => {
  const text = `# Observations
1. The permission check is not atomic.
   Evidence: lib/auth-guard.ts:17
2. The rate limit comparison does not hold.
   Evidence: reasoning

# Cannot verify
- \`lib/hash.ts\`: not in the allowed list.

${FIXED_CLOSING_LINE_EN}`;
  const result = auditSpoke(text);
  assert.equal(result.finalLinePass, true, "英文收尾句須 pass");
  assert.equal(result.observationCount, 2);
  assert.equal(result.cannotVerifySectionPresent, true);
});

test("auditSpoke：英文「Cannot verify」節內的路徑同樣記入 citedPaths", () => {
  const text = `# Observations
1. Something.
   Evidence: lib/auth-guard.ts:17

# Cannot verify
- \`lib/hash.ts\`: not in the allowed list.

${FIXED_CLOSING_LINE_EN}`;
  const result = auditSpoke(text);
  assert.ok(result.citedPaths.includes("lib/hash.ts"), "記錄與判定是不同職責");
});

test("auditSpoke：中文回報不受英文支援影響", () => {
  const text = `# 觀察
1. 一條觀察
   依據：lib/auth-guard.ts:17

# 無法驗證
無

${FIXED_CLOSING_LINE}`;
  const result = auditSpoke(text);
  assert.equal(result.finalLinePass, true);
  assert.equal(result.observationCount, 1);
});

// 工單 X1 v1.1 §二：回報模板送給 spoke 的是帶佔位符的骨架，模板要求填空卻沒檢查空有沒有
// 被填——四格產物實測中過招（README.md 十六格基準線之外的產物清查一併發現）。

test("auditSpoke：回報含 `1. <觀察>` → 命中，列出該佔位符", () => {
  const text = withClosing(`# 觀察
1. <觀察>：內容

# 無法驗證
無`);
  const result = auditSpoke(text);
  const hit = result.templatePlaceholdersFound.find((h) => h.placeholder === "<觀察>");
  assert.ok(hit, `應命中 <觀察>，實際：${JSON.stringify(result.templatePlaceholdersFound)}`);
  assert.equal(hit?.count, 1);
});

test("auditSpoke：回報含英文 `<observation>` → 同樣命中", () => {
  const text = `# Observations
1. <observation>
   Evidence: reasoning

# Cannot verify
- none

${FIXED_CLOSING_LINE_EN}`;
  const result = auditSpoke(text);
  const hit = result.templatePlaceholdersFound.find((h) => h.placeholder === "<observation>");
  assert.ok(hit, `應命中 <observation>，實際：${JSON.stringify(result.templatePlaceholdersFound)}`);
  assert.equal(hit?.count, 1);
});

// external-luna-high-r3 的實際形態：spoke 把 <觀察> 當成 XML 標籤，自創 </觀察> 收尾。
test("auditSpoke：`</觀察>` 這種自創收尾標籤也要抓到", () => {
  const text = withClosing(`# 觀察
1. <觀察>現有 tags 路由提供了可對照的 CRUD 骨架。</觀察>

# 無法驗證
無`);
  const result = auditSpoke(text);
  const openHit = result.templatePlaceholdersFound.find((h) => h.placeholder === "<觀察>");
  const closeHit = result.templatePlaceholdersFound.find((h) => h.placeholder === "</觀察>");
  assert.ok(openHit, "應命中開標籤 <觀察>");
  assert.ok(closeHit, "應命中自創收尾標籤 </觀察>");
});

test("auditSpoke：同一佔位符出現多次 → 次數正確", () => {
  const text = withClosing(`# 觀察
1. <觀察>第一條
2. <觀察>第二條
3. <觀察>第三條

# 無法驗證
無`);
  const result = auditSpoke(text);
  const hit = result.templatePlaceholdersFound.find((h) => h.placeholder === "<觀察>");
  assert.equal(hit?.count, 3);
});

test("auditSpoke：回歸——正常回報（無佔位符）→ templatePlaceholdersFound 為空，其餘稽核結果不變", () => {
  const text = withClosing(`# 觀察
1. 一條正常觀察
   依據：lib/auth-guard.ts:17

# 無法驗證
無`);
  const result = auditSpoke(text);
  assert.deepEqual(result.templatePlaceholdersFound, []);
  assert.equal(result.finalLinePass, true);
  assert.equal(result.observationCount, 1);
});
