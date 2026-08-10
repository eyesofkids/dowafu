// plan_dispatch_v1.4.md §7：白名單判定，集中於核心，不下放 adapter（三套 adapter 各自
// 實作必然漂移）。精確路徑集合比對，非前綴比對。純函式，供單元測試，不需 mock 任何 provider。

import fs from "node:fs";
import path from "node:path";

export type AllowlistRejectReason = "not_found" | "not_in_allowlist" | "outside_repo";

export type AllowlistCheck =
  | { allowed: true; realPath: string }
  | { allowed: false; reason: AllowlistRejectReason };

// 入集端也做 realpath（§7）。呼叫前應已用 validateAllowedPathsExist 驗過存在性；
// 這裡若仍解析失敗就靜默略過——不在集合裡的路徑本來就會被拒絕，不需要另外報錯。
export function buildAllowSet(paths: string[]): Set<string> {
  const set = new Set<string>();
  for (const p of paths) {
    try {
      set.add(fs.realpathSync(path.resolve(p)));
    } catch {
      // 略過：不存在的路徑不會進集合，checkAllowlist 對它的判定自然是拒絕
    }
  }
  return set;
}

// 判定：allowSet.has(realpath(resolve(requested)))。路徑不存在時 realpathSync 拋錯——
// 視同拒絕，回傳「不存在或不在允許範圍」，不區分兩者（避免用錯誤訊息探測檔案系統）；
// reason 分類僅供 run.jsonl 記錄用，不影響回給 spoke 的訊息。
export function checkAllowlist(
  allowSet: Set<string>,
  requestedPath: string,
  repoRoot: string,
): AllowlistCheck {
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(repoRoot, requestedPath));
  } catch {
    return { allowed: false, reason: "not_found" };
  }

  if (allowSet.has(real)) {
    return { allowed: true, realPath: real };
  }

  const resolvedRoot = fs.realpathSync(path.resolve(repoRoot));
  const insideRepo = real === resolvedRoot || real.startsWith(resolvedRoot + path.sep);
  return { allowed: false, reason: insideRepo ? "not_in_allowlist" : "outside_repo" };
}

// 統一回給 spoke 的訊息：不區分「不存在」與「不在允許範圍」。
export const ALLOWLIST_REJECT_MESSAGE = "不存在或不在允許範圍";
