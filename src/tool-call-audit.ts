// plan_dispatch_v2.0.md §15（一）：稽核表補「tool 呼叫」欄。這是對執行資料（run.jsonl 的
// toolCalls[]）的判定，刻意獨立於 audit.ts 之外——audit.ts 的 auditSpoke 是對 spoke 產出
// 文字的確定性判定，純函式吃 finalText，不吃執行資料，這個純度是它現有測試的基礎。
// tool 呼叫記錄不是文字，不塞進 auditSpoke。

import path from "node:path";
import type { ToolCallLog } from "./types.js";

export type ToolCallAudit = {
  total: number;
  allowed: number;
  rejected: number;
  allowedReadsCount: number; // 該 spoke 允許讀取清單的檔案數，供「允許 N 檔」顯示
  // 「toolCalls 全部落在工單目錄內（_shared.md／<agent>.md），而該 spoke 的允許讀取清單
  // 非空」——沒看程式碼就作答的簽名（issue_log_v2.0.md 2026-08-07：igopms 兩支 spoke
  // 零讀取，稽核卻全過）。
  zeroSourceRead: boolean;
};

function isTicketFile(requestedPath: string, agent: string): boolean {
  const base = path.basename(requestedPath);
  return base === "_shared.md" || base === `${agent}.md`;
}

export function auditToolCalls(agent: string, toolCalls: ToolCallLog[], allowedReadsCount: number): ToolCallAudit {
  const total = toolCalls.length;
  const allowed = toolCalls.filter((t) => t.allowed).length;
  const rejected = total - allowed;
  // total > 0 護欄：空陣列的 .every() 恆真，避免「一次 tool 都沒呼叫」被誤判為「只讀了
  // 工單檔」——兩者是不同訊號，前者連工單都沒讀，非本項要抓的「讀了工單卻不讀程式碼」。
  const allTicketFiles = total > 0 && toolCalls.every((t) => isTicketFile(t.path, agent));
  const zeroSourceRead = allTicketFiles && allowedReadsCount > 0;
  return { total, allowed, rejected, allowedReadsCount, zeroSourceRead };
}
