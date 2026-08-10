// plan_dispatch_v1.10.md §10：輸出目錄的 gitignore 三態檢查（使用者裁示：檢查並警告，
// 不擋執行）。判定用 `git check-ignore -q`，三態不得合併——「未忽略」是需要處理的狀態，
// 「無法判定」不是（§10「三態不得合併」）。
//
// plan_dispatch_v1.11.md §10：判定基準必須與 outDir 的解析基準一致——兩者皆為 cwd，
// 不是 --repo-root。v1.10 用 `-C <repoRoot>` 判定，但 outDir 是相對 cwd 解析的
// （v1.11 §24.5：工單目錄／輸出目錄屬呼叫端 cwd，白名單邊界／agents 才屬 repoRoot），
// cwd ≠ repoRoot 時等於問錯 repo——git 對工作樹外的路徑回 fatal（exit 128），被舊邏輯
// 吞成 unknown，防線恰好在唯一有價值的情境（跨專案）靜默失效。
// 一般化規則：任何「對某路徑做判定」的檢查，其基準必須與該路徑的解析基準相同。

import { spawnSync } from "node:child_process";

export type GitignoreStatus = "ignored" | "not_ignored" | "unknown";

// `cwd` 預設 `process.cwd()`——不接受呼叫端傳入 repoRoot 之類的其他基準；可覆寫純粹是
// 為了單元測試（例如以 temp git repo 取代真正的 process.cwd()），production 呼叫端
// （cli.ts）一律用預設值，不傳第二個參數，結構上就不會再誤傳 repoRoot。
export function checkGitignore(outDir: string, cwd: string = process.cwd()): GitignoreStatus {
  const result = spawnSync("git", ["check-ignore", "-q", outDir], { cwd });
  if (result.error) return "unknown"; // git 不存在或無法執行
  if (result.status === 0) return "ignored";
  if (result.status === 1) return "not_ignored";
  return "unknown"; // 其他 exit code：非 git repo（128）等，或路徑不在該 cwd 所屬的工作樹內
}
