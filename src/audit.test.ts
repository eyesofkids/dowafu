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
  const result = auditSpoke(null, []);
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
  const result = auditSpoke(text, []);
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
  const result = auditSpoke(text, []);
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
  const result = auditSpoke(text, []);
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
  assert.equal(auditSpoke(withClosing(body), []).observationCount, 2);
});

test("auditSpoke：平鋪編號仍優先於標題編號樣式（新樣式排在最後，不得蓋掉既有判讀）", () => {
  const body = ["# 觀察", "", "## 背景", "1. 第一條", "2. 第二條", "3. 第三條"].join("\n");
  assert.equal(auditSpoke(withClosing(body), []).observationCount, 3);
});

test("auditSpoke：章節存在但內容為空 → observationCount 為 0（明確為零，不是數不出來）", () => {
  const text = withClosing(`# 觀察

# 無法驗證
無`);
  const result = auditSpoke(text, []);
  assert.equal(result.observationCount, 0);
});

test("auditSpoke：章節有內容但不符任何已知樣式 → observationCount 為 null（無法辨識）", () => {
  const text = withClosing(`# 觀察
這裡只有一段散文敘述，沒有用任何編號或標記列出個別觀察。

# 無法驗證
無`);
  const result = auditSpoke(text, []);
  assert.equal(result.observationCount, null);
});

test("auditSpoke：完全沒有「# 觀察」章節 → observationCount 為 null", () => {
  const text = withClosing(`# 無法驗證
無`);
  const result = auditSpoke(text, []);
  assert.equal(result.observationCount, null);
});

test("auditSpoke：收尾句與清單外引用路徑照舊運作，不受本輪變更影響", () => {
  const text = withClosing(`# 觀察
1. 引用了清單外的 src/secret.ts:10

# 無法驗證
無`);
  const result = auditSpoke(text, ["src/allowed.ts"]);
  assert.equal(result.finalLinePass, true);
  assert.ok(result.citedPathsOutsideAllowlist.includes("src/secret.ts"));
});

// plan_dispatch_v1.12.md §15：PATH_REGEX 的字元類 [\w.\-] 不匹配中括號，Next.js 動態路由
// 段（[id]、[...slug]、[[...slug]]）會被從中括號後截斷，導致清單內的合法引用被誤判為
// 清單外。素材取自首次外部派工的真實回報原文（issue_log_v1.md 同日條目）。
test("auditSpoke：含 [id] 動態路由段的路徑須完整抽出，比對清單內即不列為清單外（真實回報原文）", () => {
  const text = withClosing(`# 觀察
1. \`POST /api/todos/[id]/external/generate\` 的實際程式碼沒有驗證登入狀態。
   依據：\`app/api/todos/[id]/external/generate/route.ts:17-36\` 僅查詢 todo 是否存在。
2. expires 單位規格與實作不一致。
   依據：app/api/todos/[id]/external/route.ts:159-173，並比對 lib/hash.ts:15-16。

# 無法驗證
無`);
  const allowedRelativePaths = [
    "app/api/todos/[id]/external/route.ts",
    "app/api/todos/[id]/external/generate/route.ts",
    "lib/hash.ts",
  ];
  const result = auditSpoke(text, allowedRelativePaths);
  assert.ok(
    result.citedPaths.includes("app/api/todos/[id]/external/generate/route.ts"),
    `應完整抽出含 [id] 的路徑，實際抽出：${JSON.stringify(result.citedPaths)}`,
  );
  assert.ok(result.citedPaths.includes("app/api/todos/[id]/external/route.ts"));
  assert.deepEqual(
    result.citedPathsOutsideAllowlist,
    [],
    `全部三條引用都在允許清單內，不應有清單外路徑，實際：${JSON.stringify(result.citedPathsOutsideAllowlist)}`,
  );
});

// 熱修補（issue_log_v1.md 同日條目）：§15 引用路徑比對的第二類誤報——「無法驗證」章節
// 內的路徑必然在允許清單之外（§16 回報模板：該欄列「需要但讀不到的檔案」），不是
// §15 要防的「臆測或引用工單原文」。素材為某次外部派工 hole-finder-feasibility 的真實回報
// 原文（hub 驗收拿三份真實回報重跑後發現，PATH_REGEX 的中括號修正未涵蓋這類）。
test("auditSpoke：「無法驗證」章節內引用清單外路徑不列入 citedPathsOutsideAllowlist（真實回報原文，feasibility 允許清單無 lib/hash.ts）", () => {
  const text = withClosing(`# 觀察
1. **關於 POST /api/todos/[id]/external/generate 的 500 狀態碼描述**
   - 依據：\`app/api/todos/[id]/external/generate/route.ts:25-36\`。

2. **PUT 操作的 tag 處理機制**
   - 依據：\`app/api/todos/[id]/external/route.ts:159-173\`。

3. **Markdown 解析邏輯**
   - 依據：\`lib/markdown-todo.ts:60-120\`。

# 無法驗證
- \`lib/hash.ts\`：該檔案負責實際的 generateShareHash 與 verifyShareHash 邏輯，不在允許讀取清單中，無法驗證 180 天效期與 HMAC 簽名演算法實作細節。`);
  const allowedRelativePaths = [
    "app/api/todos/[id]/external/route.ts",
    "app/api/todos/[id]/external/generate/route.ts",
    "lib/markdown-todo.ts",
    "lib/types.ts",
  ];
  const result = auditSpoke(text, allowedRelativePaths);
  assert.deepEqual(
    result.citedPathsOutsideAllowlist,
    [],
    `「無法驗證」欄列出讀不到的檔案是回報模板要求的正確行為，不應被判清單外，實際：${JSON.stringify(result.citedPathsOutsideAllowlist)}`,
  );
  // citedPaths 是記錄用途（§12），不因清單外判定的排除而漏記
  assert.ok(result.citedPaths.includes("lib/hash.ts"), "citedPaths 須完整記錄，記錄與判定是不同職責");
});

// 反向測試：清單外路徑若出現在「觀察」節（不是「無法驗證」節），仍須被抓到——否則熱修補
// 會把整個「清單外引用」檢查關掉，而不是只排除「無法驗證」這一節。此測試在熱修補前後皆須綠。
test("auditSpoke：清單外路徑出現在「觀察」節（非「無法驗證」節）時仍須被抓到，熱修補不得關掉檢查", () => {
  const text = withClosing(`# 觀察
1. 引用了一個清單外的檔案 src/secret.ts:10，這條不該被放行。

# 無法驗證
無`);
  const result = auditSpoke(text, ["src/allowed.ts"]);
  assert.deepEqual(result.citedPathsOutsideAllowlist, ["src/secret.ts"]);
});

// 熱修補續（issue_log_v1.1.md）：上一輪的排除邏輯用「有沒有出現在無法驗證節」判斷，
// 沒檢查是否也出現在別處——變數名 pathsOnlyInCannotVerify 名實不符。同一路徑若跨「觀察」
// 與「無法驗證」兩節出現，觀察節那筆的清單外判定會被誤排除，而觀察節正是 §15 要看的
// 地方（spoke 在觀察節臆測引用一個讀不到的檔案，再於無法驗證節「自首」寫不在清單內，
// 藉此讓臆測那筆被連帶放行）。
test("auditSpoke：同一清單外路徑同時出現在「觀察」與「無法驗證」兩節時，觀察節那筆仍須被抓到", () => {
  const text = withClosing(`# 觀察
1. 依據：\`src/fabricated.ts:42\` 的實作有缺陷。

# 無法驗證
- \`src/fabricated.ts\`：不在允許清單，無法確認。`);
  const result = auditSpoke(text, []);
  assert.deepEqual(
    result.citedPathsOutsideAllowlist,
    ["src/fabricated.ts"],
    `跨兩節出現時，觀察節的臆測引用不該被無法驗證節連帶放行，實際：${JSON.stringify(result.citedPathsOutsideAllowlist)}`,
  );
});

// plan_dispatch_v2.0.md §15（二）：清單外引用附出現章節與疑似縮寫來源。素材為
// issue_log_v2.0.md 2026-08-07 的真實案例——某次派工的 feasibility 在「觀察」節寫了縮寫路徑
// [id]/sync/route.ts，允許清單內有完整路徑 app/api/property-management/external-ics/[id]/sync/route.ts。
test("auditSpoke：清單外路徑標明出現章節，且為允許清單項目後綴時標明疑似縮寫來源（真實案例）", () => {
  const text = withClosing(`# 觀察
1. [id]/sync/route.ts 的 POST 存在此問題
   依據：app/api/property-management/external-ics/[id]/sync/route.ts:14

# 無法驗證
無`);
  const allowedRelativePaths = ["app/api/property-management/external-ics/[id]/sync/route.ts"];
  const result = auditSpoke(text, allowedRelativePaths);
  assert.deepEqual(result.citedPathsOutsideAllowlist, ["[id]/sync/route.ts"]);
  assert.deepEqual(result.citedPathsOutsideAllowlistDetail, [
    {
      path: "[id]/sync/route.ts",
      section: "觀察",
      suffixOf: "app/api/property-management/external-ics/[id]/sync/route.ts",
    },
  ]);
});

test("auditSpoke：清單外路徑不是任何允許清單項目的後綴時，suffixOf 為 undefined", () => {
  const text = withClosing(`# 觀察
1. 引用了清單外的 src/secret.ts:10

# 無法驗證
無`);
  const result = auditSpoke(text, ["src/allowed.ts"]);
  assert.deepEqual(result.citedPathsOutsideAllowlistDetail, [{ path: "src/secret.ts", section: "觀察", suffixOf: undefined }]);
});

test("auditSpoke：任意子字串不算後綴——只在允許清單項目以 \"/\" + 該路徑結尾時才判定為縮寫來源", () => {
  const text = withClosing(`# 觀察
1. 引用了 byte.ts:1

# 無法驗證
無`);
  // "allowed/byte.ts" 以 "byte.ts" 結尾且前一字元是 "/"，這個該算後綴；
  // 但 "some-byte.ts" 雖然子字串包含 "byte.ts"，前一字元不是 "/"，不該算。
  const result = auditSpoke(text, ["some-byte.ts"]);
  assert.equal(result.citedPathsOutsideAllowlistDetail[0]?.suffixOf, undefined);
});

test("auditSpoke：[...slug]／[[...slug]] 兩種 catch-all 動態路由段同樣須完整抽出", () => {
  const text = withClosing(`# 觀察
1. 兩種 catch-all 路由的比對。
   依據：app/blog/[...slug]/page.tsx 與 app/shop/[[...slug]]/page.tsx。

# 無法驗證
無`);
  const allowedRelativePaths = ["app/blog/[...slug]/page.tsx", "app/shop/[[...slug]]/page.tsx"];
  const result = auditSpoke(text, allowedRelativePaths);
  assert.deepEqual(result.citedPathsOutsideAllowlist, []);
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
  const result = auditSpoke(text, []);
  assert.equal(result.observationCount, 13);
});

test("auditSpoke：真實報告的結構（粗體編號格式）數出 19 條", () => {
  const text = readFixture("bold-numbered-19.md");
  const result = auditSpoke(text, []);
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
  const result = auditSpoke(text, ["lib/auth-guard.ts"]);
  assert.equal(result.finalLinePass, true, "英文收尾句須 pass");
  assert.equal(result.observationCount, 2);
  assert.equal(result.cannotVerifySectionPresent, true);
});

test("auditSpoke：英文「Cannot verify」節內的清單外路徑同樣不列入清單外引用", () => {
  const text = `# Observations
1. Something.
   Evidence: lib/auth-guard.ts:17

# Cannot verify
- \`lib/hash.ts\`: not in the allowed list.

${FIXED_CLOSING_LINE_EN}`;
  const result = auditSpoke(text, ["lib/auth-guard.ts"]);
  assert.deepEqual(result.citedPathsOutsideAllowlist, []);
  assert.ok(result.citedPaths.includes("lib/hash.ts"), "記錄與判定是不同職責");
});

test("auditSpoke：中文回報不受英文支援影響", () => {
  const text = `# 觀察
1. 一條觀察
   依據：lib/auth-guard.ts:17

# 無法驗證
無

${FIXED_CLOSING_LINE}`;
  const result = auditSpoke(text, ["lib/auth-guard.ts"]);
  assert.equal(result.finalLinePass, true);
  assert.equal(result.observationCount, 1);
});
