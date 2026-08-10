// plan_dispatch_v1.10.md §24.2/§24.3：套件出貨資源（providers.json、package.json 的
// version）皆相對於本檔（`src/pkg-info.ts` 編譯後為 `dist/pkg-info.ts`，與 `dist/cli.js`
// 同層）以 `import.meta.url` 解析——不假設 cwd，因為 v1 的目標是「從任意目錄執行」。
//
// §24.2：`new URL("../providers.json", import.meta.url)` 在 `pnpm link --global` 下
// 是否解析得到，是規劃書明訂「必須實跑確認」的一步（Node 對 symlink 預設解析 realpath，
// 但這是推論不是實測）——已實跑驗證通過，見 issue_log 2026-08-06。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// package root 相對於本檔的位置：src/pkg-info.ts 與 dist/pkg-info.ts 都在 rootDir 正下方
// 一層（tsconfig.build.json 的 rootDir:"src" 保證兩者深度一致），故 "../" 恆指向 package root。
function packageRootURL(relativePath: string): URL {
  return new URL(`../${relativePath}`, import.meta.url);
}

export function bundledProvidersPath(): string {
  return fileURLToPath(packageRootURL("providers.json"));
}

export function getPackageVersion(): string {
  const pkgPath = fileURLToPath(packageRootURL("package.json"));
  const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  return raw.version ?? "0.0.0";
}

// 指令名同樣取自 package.json，理由與上面一致：這份原始碼會在不同的套件名下出貨，
// 把名字寫死在說明文字裡，就會出現「--help 教你打 A、實際裝成 B」的落差——而那種落差
// 不會報錯，只會讓照做的人打不到指令。取 bin 的第一個 key；bin 是字串形式時它等於套件名。
export function getCommandName(): string {
  const pkgPath = fileURLToPath(packageRootURL("package.json"));
  const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    name?: string;
    bin?: Record<string, string> | string;
  };
  if (raw.bin && typeof raw.bin === "object") {
    const first = Object.keys(raw.bin)[0];
    if (first) return first;
  }
  return raw.name ?? "cli";
}
