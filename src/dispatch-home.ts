// plan_dispatch_v1.10.md §24.4：API key 的載入順序與位置。ambient process.env 優先
// （CI、一次性覆寫），其次 $DISPATCH_HOME/.env；dotenv 預設不覆寫既有變數，故 ambient
// 優先自然成立，不需額外邏輯。
//
// 明文禁令：dispatch 不得讀取 cwd 的 `.env`——cwd 是被審專案，`import "dotenv/config"`
// 會把該專案的整份 `.env`（資料庫密碼、第三方 token、webhook secret）載入一個正對三家
// 外部 API 發請求的行程，而 §12 的遮蔽名單認不出那些秘密。此檔取代原本
// `src/cli.ts` 頂部的 `import "dotenv/config"`。

import dotenv from "dotenv";
import os from "node:os";
import path from "node:path";

export function resolveDispatchHome(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  if (env.DISPATCH_HOME) return env.DISPATCH_HOME;
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, "dispatch");
  return path.join(homedir(), ".config", "dispatch");
}

// 唯一允許呼叫 dotenv 的地方——`path` 一律明確指定為 dispatchHome 下的 `.env`，
// 絕不留白（留白即回退成 dotenv 預設讀 cwd 的 `.env`，正是本函式存在的目的所要杜絕的）。
export function loadDispatchEnv(dispatchHome: string): void {
  dotenv.config({ path: path.join(dispatchHome, ".env") });
}
