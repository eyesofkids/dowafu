// `$DISPATCH_HOME` 的解析。**0.5.0 起本檔不再載入任何 `.env`**（使用者裁示，2026-09-06）：
// API key 的唯一來源是 DB 的 `provider_keys` 表，見 provider-key.ts 的檔頭。
//
// 原本這裡有一支 `loadDispatchEnv`，把 `$DISPATCH_HOME/.env` 灌進 process.env，並為了讓
// `--doctor` 分辨「ambient 填的」與「.env 填的」而在載入前後各拍一次快照。單一來源之後
// 那整段連同 dotenv 依賴一起退場——**沒有那段程式，就沒有優先序與來源分辨的問題**。
//
// v1.10 §24.4 的禁令（不得讀 cwd 的 `.env`）現在由「根本不依賴 dotenv」保證，比原本的
// 「只准讀指定路徑」更硬；`dotenv-invariant.test.ts` 的靜態掃描續留，防止有人加回來。

import os from "node:os";
import path from "node:path";

// plan_i18n_v1.3.md §三：這兩個函式現在跑在 parseArgs／--help 之前（見 cli.ts），任何
// 會拋的東西都會擋住求助路徑。因此各自包 try/catch，任何例外都降級為「沒有設定檔」，
// 不中止、不拋——包括 os.homedir() 在無 HOME／無 passwd 對應時拋錯。
export function resolveDispatchHome(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | null {
  try {
    if (env.DISPATCH_HOME) return env.DISPATCH_HOME;
    // v0.2.0：目錄名與 CLI 同名（`dowafu`），原本叫 `dispatch`。**不做舊路徑回退**
    // （乙案已否決）——回退那段程式碼一旦寫下就永遠刪不掉，而它要處理的是一次性的搬家。
    // 代價是搬家沒做完時 loadDispatchEnv 靜默降級（見下方註解），症狀要到派工當下才出現，
    // 所以 impl_tickets 的順序是「先複製目錄、再改這兩行」。
    if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, "dowafu");
    return path.join(homedir(), ".config", "dowafu");
  } catch {
    return null;
  }
}
