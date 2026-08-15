// plan_dispatch_v1.4.md §15：確定性稽核，全部以程式判定，不經模型。純函式，吃 spoke 的
// finalText 與允許讀取清單，吐結構化稽核結果。「疑似」而非「fail」的界線見 §15 說明——
// 禁止內容關鍵詞必有誤判，故只標記交 hub 判讀，不得自動刪改 spoke 原文。

import { splitTopLevelSections } from "./ticket.js";
import { REPORT_PLACEHOLDERS } from "./prompt.js";

export const FIXED_CLOSING_LINE = "以上為觀察與問題，採用與否由 hub 與使用者裁決。";
// 英文工單走英文模板，收尾句與章節名也跟著換。稽核**兩套都認**且不看工單語言——spoke
// 偶爾會用另一種語言作答，那是產出品質的事，不該讓稽核整份判 fail 而蓋掉真正的訊號。
export const FIXED_CLOSING_LINE_EN =
  "These are observations and questions. Whether to adopt them is for the hub and the user to decide.";
const OBSERVATIONS_SECTIONS = ["觀察", "Observations"];
const CANNOT_VERIFY_SECTIONS = ["無法驗證", "Cannot verify"];

function getSection(sections: Map<string, string>, names: string[]): string | undefined {
  for (const n of names) {
    const body = sections.get(n);
    if (body !== undefined) return body;
  }
  return undefined;
}

// 抓看起來像相對路徑的引用：至少一層目錄＋副檔名，容許前後有反引號與 :行號。
// plan_dispatch_v1.12.md §15：字元類須容許中括號，否則 Next.js 動態路由段（[id]、
// [...slug]、[[...slug]]）會把路徑從中括號後截斷——截斷後的字串當然不在允許清單內，
// 於是每一條合法引用都被誤判為清單外（首次外部派工實測：三個 spoke 全部誤報）。
// 比對方式維持精確集合比對不變，只改路徑抽取的容許字元。
const PATH_REGEX = /`?([\w.\-[\]]+(?:\/[\w.\-[\]]+)+\.[A-Za-z0-9]{1,10})(?::\d+)?`?/g;

// 工單 X1 v1.1 §二：模板佔位符字面若留在回報裡（spoke 忘了填空），只有標題欄變成雜訊，
// 觀察計數不受影響——四格產物實測零標記。掃描不看語言，中英兩套一起查。
export type TemplatePlaceholderHit = { placeholder: string; count: number };

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let idx = 0;
  for (;;) {
    const found = text.indexOf(needle, idx);
    if (found === -1) return count;
    count++;
    idx = found + needle.length;
  }
}

// external-luna-high-r3 的實際形態：spoke 把 `<觀察>` 當成 XML 標籤，自創 `</觀察>` 收尾。
// 對每個佔位符一併查它的自創收尾標籤形態，不只查模板原樣的開標籤。
function countTemplatePlaceholders(finalText: string): TemplatePlaceholderHit[] {
  const hits: TemplatePlaceholderHit[] = [];
  for (const placeholder of REPORT_PLACEHOLDERS) {
    const openCount = countOccurrences(finalText, placeholder);
    if (openCount > 0) hits.push({ placeholder, count: openCount });
    const closingTag = `</${placeholder.slice(1)}`;
    const closingCount = countOccurrences(finalText, closingTag);
    if (closingCount > 0) hits.push({ placeholder: closingTag, count: closingCount });
  }
  return hits;
}

// plan_dispatch_v1.9.md §15：稽核的職責是記錄，不是規範 spoke 的表達結構。原本只認
// 範本的平鋪編號（"1. "），deepseek 用「## 問題 N」＋「**觀察 N.N**」的巢狀結構時被判成
// 0 條——而那次是三份回報中最豐富的一份。放寬為多種常見形式皆計入，依序嘗試、採第一個
// 有命中的樣式；一種都沒命中時記 null（「數不出來」），不得降級為 0（「沒有」）。
const OBSERVATION_PATTERNS: RegExp[] = [
  /^\d+\.\s/, // 頂層有序清單："1. "（範本原定格式）
  /^\*\*\d+\.\s/, // 粗體包住編號："**1. 內容**"（plan_fixes_v1.0.md §1：兩輪各中一次，數不出來時誤判「無法計數」）
  /^(?:\*\*)?觀察\s*\d+(?:\.\d+)?(?:\*\*)?[:：]/, // 巢狀觀察標記："**觀察 1.1**：" 或 "觀察 1："
  /^#{2,4}\s*觀察\s*\d+/, // 標題形式："### 觀察 1"
  /^(?:\*\*)?Observation\s*\d+(?:\.\d+)?(?:\*\*)?[:：]/i, // 英文模板的巢狀標記
  /^#{2,4}\s*Observation\s*\d+/i, // 英文模板的標題形式
  // real-run-i18n-lang（2026-08-12）：`deepseek-v4-flash` 的中文格寫成 `## 1. 「比照 tags 路由」…`
  // ——標題形式但編號後面直接是內容，沒有「觀察」二字，上面兩條標題樣式都認不出來，於是整份
  // 判「無法計數」。**那是本次唯一一項「中文格看起來比英文格差」的來源，而它與語言無關。**
  // 放在最後：前面任何一條命中就不會走到這裡，所以不會蓋掉既有判讀。
  /^#{2,4}\s*\d+[.、]/,
];

function countObservations(observationsBody: string): number | null {
  if (observationsBody.trim().length === 0) return 0; // 章節存在但確實空白＝明確的零，不是數不出來
  const lines = observationsBody.split(/\r?\n/).map((l) => l.trim());
  for (const pattern of OBSERVATION_PATTERNS) {
    const count = lines.filter((l) => pattern.test(l)).length;
    if (count > 0) return count;
  }
  return null; // 章節有內容，但沒有一種已知樣式命中——無法辨識，不是沒有
}

export type AuditResult = {
  finalLinePass: boolean;
  observationCount: number | null;
  citedPaths: string[];
  cannotVerifySectionPresent: boolean;
  templatePlaceholdersFound: TemplatePlaceholderHit[];
};

// 工單 X1 v1.1 §六（使用者裁示 2026-08-15）：「清單外引用」欄拿掉的是判定，citedPaths 這個
// 記錄本身保留——它是純資料，不含判斷，供日後「引用 vs 實際讀取」的交叉分析使用。
export function auditSpoke(finalText: string | null): AuditResult {
  if (!finalText) {
    return {
      finalLinePass: false,
      observationCount: null, // 完全沒有內容可數，不是「數出來是零」
      citedPaths: [],
      cannotVerifySectionPresent: false,
      templatePlaceholdersFound: [],
    };
  }

  const lines = finalText.split(/\r?\n/).map((l) => l.trim());
  const lastNonEmpty = [...lines].reverse().find((l) => l.length > 0) ?? "";
  const finalLinePass = lastNonEmpty === FIXED_CLOSING_LINE || lastNonEmpty === FIXED_CLOSING_LINE_EN;

  const sections = splitTopLevelSections(finalText);
  const observationsSection = getSection(sections, OBSERVATIONS_SECTIONS);
  const observationCount = observationsSection !== undefined ? countObservations(observationsSection) : null;

  const cannotVerifySectionPresent = CANNOT_VERIFY_SECTIONS.some((n) => sections.has(n));

  const citedPaths = [...new Set([...finalText.matchAll(PATH_REGEX)].map((m) => m[1]))];

  const templatePlaceholdersFound = countTemplatePlaceholders(finalText);

  return {
    finalLinePass,
    observationCount,
    citedPaths,
    cannotVerifySectionPresent,
    templatePlaceholdersFound,
  };
}
