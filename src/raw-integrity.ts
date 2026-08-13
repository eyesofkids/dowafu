// plan_dispatch_v1.5.md §8「Adapter 的自我檢查：raw 完整性」。
//
// 送出請求前，adapter 必須驗證 conversation 中每個 assistant turn 的 raw 都完整出現在
// 該請求裡；不符即拋錯，標為實作缺陷（非 API 錯誤）。理由：實測（facts Test C）證實
// 「漏帶整個 item」不會被 API 偵測——模型照樣完成，只是靜默失去推理連續性，唯一線索是
// reasoning_tokens 異常偏低，不會進 errors[]。竄改會 400，漏帶不會；而漏帶恰好是過濾條件
// 寫錯一行就會發生的那種錯誤。偵測責任因此不能放在 API 回饋上，必須是 adapter 自己主動驗證。
//
// 兩種 raw 形狀，對應兩個 adapter：
// - responses（openai/deepseek）：assistant turn 的 raw 是「陣列」（該輪 response.output
//   整包），續接時逐一展開塞進 input 陣列——檢查「陣列中每個 item 是否都在 input 裡」。
// - gemini-native：assistant turn 的 raw 是「單一物件」（{role:"model", parts:[...]}），
//   續接時整個物件原樣放回 contents 陣列——檢查「這個物件是否整個出現在 contents 裡」。
//
// 判準是參照相等（===），不是結構相等：兩個 adapter 目前都是直接把 turn.raw 原樣塞入
// 請求，不做任何轉換，故參照相等是正確且唯一有意義的比對方式——它驗證的是「真的是同一個
// 物件被傳過去」，而非「長得像的東西存在」，後者會掩蓋掉真正的 bug（例如重新建構出一個
// 內容相似但簽章欄位被序列化過程改寫的複製品）。若未來 adapter 需要對 raw 做任何正規化，
// 這個判準本身就需要重新設計——那是規格問題，不是這裡的實作可以自行決定的。

import type { Conversation, Lang } from "./types.js";
import { m } from "./messages.js";

export class RawIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RawIntegrityError";
  }
}

export function checkRawArrayIntegrity(conv: Conversation, builtInput: readonly unknown[], lang: Lang): void {
  for (const turn of conv.turns) {
    if (turn.role !== "assistant") continue;
    if (!Array.isArray(turn.raw)) {
      throw new RawIntegrityError(m(lang, "rawIntegrityNotArray"));
    }
    for (const item of turn.raw) {
      if (!builtInput.includes(item)) {
        const type = (item as { type?: string })?.type ?? "?";
        throw new RawIntegrityError(m(lang, "rawIntegrityItemNotFound", type));
      }
    }
  }
}

export function checkRawObjectIntegrity(conv: Conversation, builtContents: readonly unknown[], lang: Lang): void {
  for (const turn of conv.turns) {
    if (turn.role !== "assistant") continue;
    if (!builtContents.includes(turn.raw)) {
      throw new RawIntegrityError(m(lang, "rawIntegrityObjectNotFound"));
    }
  }
}
