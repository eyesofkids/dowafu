// plan_i18n_impl_tickets T5／i18n_classification_t2.md §三之3：三支 adapter 的 read_file
// 工具 description 逐字相同，是 function-calling schema 送給模型看的說明，會原樣進 API
// 請求，消費者是 spoke／provider 不是人類——歸 C 類，不進 messages.ts，由 spoke.lang
// 直接選用。三支 adapter 共用同一組雙語常數，不要各自維護一份。
import type { Lang } from "../types.js";

const READ_FILE_TOOL_DESCRIPTION = "讀取指定路徑的檔案內容";
const READ_FILE_TOOL_DESCRIPTION_EN = "Read the contents of the file at the given path.";

export function readFileToolDescription(lang: Lang): string {
  return lang === "en" ? READ_FILE_TOOL_DESCRIPTION_EN : READ_FILE_TOOL_DESCRIPTION;
}
