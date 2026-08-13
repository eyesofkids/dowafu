// plan_dispatch_v1.4.md §15：確定性稽核，全部以程式判定，不經模型。純函式，吃 spoke 的
// finalText 與允許讀取清單，吐結構化稽核結果。「疑似」而非「fail」的界線見 §15 說明——
// 禁止內容關鍵詞必有誤判，故只標記交 hub 判讀，不得自動刪改 spoke 原文。

import { splitTopLevelSections } from "./ticket.js";

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

const SUSPECT_PHRASES = ["應該改成", "建議採用", "嚴重度", "高風險", "應廢止"];
// plan_i18n_v1.2.md §4.1／i18n_classification_t2.md §五 #8-12：英文回報若只比對中文詞，
// 稽核會靜默失效——不報錯、不變紅，只是什麼都抓不到。兩套並存同時比對，不隨 lang 切換
// （spoke 可能用另一種語言作答，稽核本來就不看工單語言）。summary.md 需要分開標示是
// 哪一套命中，供日後調整這份清單時有資料可依據，故 auditSpoke 分開回傳兩個陣列。
const SUSPECT_PHRASES_EN = ["should be changed to", "recommend adopting", "severity", "high risk", "should be deprecated"];

// 抓看起來像相對路徑的引用：至少一層目錄＋副檔名，容許前後有反引號與 :行號。
// plan_dispatch_v1.12.md §15：字元類須容許中括號，否則 Next.js 動態路由段（[id]、
// [...slug]、[[...slug]]）會把路徑從中括號後截斷——截斷後的字串當然不在允許清單內，
// 於是每一條合法引用都被誤判為清單外（首次外部派工實測：三個 spoke 全部誤報）。
// 比對方式維持精確集合比對不變，只改路徑抽取的容許字元。
const PATH_REGEX = /`?([\w.\-[\]]+(?:\/[\w.\-[\]]+)+\.[A-Za-z0-9]{1,10})(?::\d+)?`?/g;

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

// plan_dispatch_v2.0.md §15（二）：清單外引用附判斷依據——出現在哪個頂層章節、若為某允許
// 清單項目的後綴則標明疑似縮寫來源。是標註，不是放寬：比對方式維持 v1.12.md §15 訂的
// 精確集合比對，citedPathsOutsideAllowlist 本身不變，這裡只是給讀者多一點依據。
export type OutsideAllowlistCitation = {
  path: string;
  section: string | null; // 找不到所屬章節時為 null（例如出現在第一個標題前——已知邊界，見 issue_log_v1.1.md）
  suffixOf?: string; // 若 path 是某個允許清單項目的路徑後綴，該項目原始字串
};

export type AuditResult = {
  finalLinePass: boolean;
  observationCount: number | null;
  citedPaths: string[];
  citedPathsOutsideAllowlist: string[];
  citedPathsOutsideAllowlistDetail: OutsideAllowlistCitation[];
  cannotVerifySectionPresent: boolean;
  suspectPhrases: string[]; // 中英兩套命中的聯集，維持既有消費端（json-output.ts／output.ts）語意
  suspectPhrasesZh: string[];
  suspectPhrasesEn: string[];
};

// 找出 targetPath 第一次出現的頂層章節（依文件順序）。用同一個 PATH_REGEX 逐章節重新
// 抽取比對，而非對章節內文字做 includes 子字串比對，避免相近路徑互相誤判。
function findSection(sections: Map<string, string>, targetPath: string): string | null {
  for (const [heading, body] of sections) {
    const pathsInSection = new Set([...body.matchAll(PATH_REGEX)].map((m) => m[1]));
    if (pathsInSection.has(targetPath)) return heading;
  }
  return null;
}

// 若 citedPath 是某個允許清單項目的路徑後綴（以 "/" 為界，非任意子字串），回傳該項目
// 原始字串——供讀者判斷是否為縮寫，而非臆測。
function findSuffixSource(citedPath: string, allowedRelativePaths: string[]): string | undefined {
  return allowedRelativePaths.find(
    (allowed) =>
      allowed.length > citedPath.length &&
      allowed.endsWith(citedPath) &&
      allowed[allowed.length - citedPath.length - 1] === "/",
  );
}

export function auditSpoke(finalText: string | null, allowedRelativePaths: string[]): AuditResult {
  if (!finalText) {
    return {
      finalLinePass: false,
      observationCount: null, // 完全沒有內容可數，不是「數出來是零」
      citedPaths: [],
      citedPathsOutsideAllowlist: [],
      citedPathsOutsideAllowlistDetail: [],
      cannotVerifySectionPresent: false,
      suspectPhrases: [],
      suspectPhrasesZh: [],
      suspectPhrasesEn: [],
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
  const allowedSet = new Set(allowedRelativePaths);

  // 熱修補（issue_log_v1.1.md）：「無法驗證」章節內的路徑必然在允許清單之外——§16 回報
  // 模板定義該欄為「需要但讀不到的檔案」，出現清單外路徑是模板要求的正確行為，不是 §15
  // 要防的「臆測或引用工單原文」。故清單外判定排除只出現在該章節的路徑；citedPaths 本身
  // 維持完整記錄不變，記錄（§12）與判定（§15）是不同職責。
  //
  // 「只出現在」是關鍵字——同一路徑若跨「觀察」與「無法驗證」兩節出現，觀察節那筆仍須被
  // 抓到（那正是 §15 要防的訊號：先在觀察節臆測引用，再於無法驗證節「自首」寫不在清單內，
  // 藉此讓臆測那筆連帶被放行）。故須先算出「無法驗證節以外」引用了哪些路徑，只有兩者皆
  // 不成立（在無法驗證節出現、且未在別處出現）才排除。
  //
  // 取捨：spoke 若在「無法驗證」欄裡編造一個不存在、且未在別處引用的路徑，此處抓不到。
  // 可接受——該欄本來就是列「讀不到的檔案」，單獨出現在那裡不構成 §15 要防的訊號。
  const cannotVerifySectionText = getSection(sections, CANNOT_VERIFY_SECTIONS) ?? "";
  const pathsCitedInCannotVerifySection = new Set(
    [...cannotVerifySectionText.matchAll(PATH_REGEX)].map((m) => m[1]),
  );
  const elsewhereText = [...sections.entries()]
    .filter(([heading]) => !CANNOT_VERIFY_SECTIONS.includes(heading))
    .map(([, body]) => body)
    .join("\n");
  const pathsCitedElsewhere = new Set([...elsewhereText.matchAll(PATH_REGEX)].map((m) => m[1]));
  const pathsOnlyInCannotVerify = new Set(
    [...pathsCitedInCannotVerifySection].filter((p) => !pathsCitedElsewhere.has(p)),
  );
  const citedPathsOutsideAllowlist = citedPaths.filter(
    (p) => !allowedSet.has(p) && !pathsOnlyInCannotVerify.has(p),
  );

  const suspectPhrasesZh = SUSPECT_PHRASES.filter((phrase) => finalText.includes(phrase));
  const suspectPhrasesEn = SUSPECT_PHRASES_EN.filter((phrase) => finalText.includes(phrase));
  const suspectPhrases = [...suspectPhrasesZh, ...suspectPhrasesEn];

  const citedPathsOutsideAllowlistDetail: OutsideAllowlistCitation[] = citedPathsOutsideAllowlist.map((p) => ({
    path: p,
    section: findSection(sections, p),
    suffixOf: findSuffixSource(p, allowedRelativePaths),
  }));

  return {
    finalLinePass,
    observationCount,
    citedPaths,
    citedPathsOutsideAllowlist,
    citedPathsOutsideAllowlistDetail,
    cannotVerifySectionPresent,
    suspectPhrases,
    suspectPhrasesZh,
    suspectPhrasesEn,
  };
}
