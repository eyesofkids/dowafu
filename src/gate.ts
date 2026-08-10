// plan_dispatch_v1.4.md §14 閘門一：呼叫前估算，擋量級錯誤。chars/4 粗估，刻意不精算——
// 目的是攔截「把整個 repo 塞進允許清單」這類量級錯誤，非精算成本。超限即中止（exit 3），
// 此檢查在任何 API 呼叫之前，成本為零。

import fs from "node:fs";
import { DispatchError } from "./types.js";

// §14：charsPerToken 預設 1.0（不是 chars/4）——實測 chars/4 對中文系統性低估 2.7–4 倍，
// 低估比高估危險，此閘門寧可誤報。providers.json 可逐家覆寫（見 cli.ts 呼叫端）。
function estimateTokensFromChars(chars: number, charsPerToken: number): number {
  return Math.ceil(chars / charsPerToken);
}

export function estimateTokens(text: string, charsPerToken: number): number {
  return estimateTokensFromChars(text.length, charsPerToken);
}

export type SpokeEstimate = {
  agent: string;
  estimatedTokens: number;
};

// plan_dispatch_v2.0.md §14：閘門一只估 system prompt ＋ 第一個 user turn，允許清單與工單
// 內容不在裡面（那些由 spoke 事後 read_file 逐一取得）——v1.8 §14 稱閘門一「擋整個 repo
// 塞進允許清單」是辦不到的（issue_log_v2.0.md 2026-08-07：實測估算值與允許清單大小無關）。
// 這裡新增獨立的允許清單總量估算，只呈現、不設閘門（門檻需推導，目前無樣本）。
// filePaths 須為已驗證存在的絕對路徑（ResolvedSpoke.allowedReadsResolved）。
export type AllowlistEstimate = {
  agent: string;
  estimatedTokens: number;
  fileCount: number;
  sequential: SequentialReadEstimate;
};

export function estimateAllowlistTokens(filePaths: string[], charsPerToken: number): number {
  const totalChars = filePaths.reduce((sum, p) => sum + fs.readFileSync(p, "utf8").length, 0);
  return estimateTokensFromChars(totalChars, charsPerToken);
}

// issue_log_v2.1.md（第 8、9 次派工）：多數模型**一輪只叫一個檔**，而每一輪都會重送先前
// 讀過的全部內容。所以第 i 個檔（依清單順序）會被計費 (n+1-i) 次——**排越前面，重送越多次**。
//
// 實測驗證：第 8 次 feasibility 六檔、schema.prisma 排第一，用
// (n+2)·P + (n+1)·T + Σ(n+1-i)·sᵢ 算出 142,282，與該次 input 總和完全吻合。
//
// 這裡只計算「允許清單造成的放大量」Σ(n+1-i)·sᵢ，**刻意不含初始 prompt 與工單**——那兩項
// 不受排序影響，略去不會影響「排序能省多少」這個唯一有行動意義的數字，卻能省掉一路把工單
// 大小傳進來的改動。
//
// 絕對值仍受 charsPerToken 1.0 高估約 3.5 倍的影響（實測），但**省下的百分比不受影響**
// ——同一個係數在分子分母都出現，會抵銷。
export type SequentialReadEstimate = {
  asListed: number; // 依目前清單順序
  sorted: number; // 依檔案大小遞增排序（大檔排最後）
};

export function estimateSequentialRead(filePaths: string[], charsPerToken: number): SequentialReadEstimate {
  const sizes = filePaths.map((p) => fs.readFileSync(p, "utf8").length);
  const amplify = (ordered: number[]): number => {
    const n = ordered.length;
    const chars = ordered.reduce((sum, s, i) => sum + s * (n - i), 0);
    return estimateTokensFromChars(chars, charsPerToken);
  };
  return {
    asListed: amplify(sizes),
    sorted: amplify([...sizes].sort((a, b) => a - b)),
  };
}

export function checkGateOne(estimates: SpokeEstimate[], maxTokens: number): number {
  const total = estimates.reduce((sum, e) => sum + e.estimatedTokens, 0);
  if (total > maxTokens) {
    const detail = estimates.map((e) => `  ${e.agent}: ${e.estimatedTokens}`).join("\n");
    throw new DispatchError(
      `閘門一超限：合計初始估算 ${total} tokens 超過 --max-tokens ${maxTokens}\n${detail}`,
      3,
    );
  }
  return total;
}
