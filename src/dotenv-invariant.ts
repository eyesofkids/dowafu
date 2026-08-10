// plan_dispatch_v1.11.md §20：「不做某事」的規格，其測試必須在該事被做了時失敗。
// v1.10 §24.4 立的禁令（不得讀 cwd 的 .env）原本只靠 `dispatch-home.test.ts` 守住——但
// 那支測試守的是 `loadDispatchEnv` 這個函式的行為，不是禁令本身：`import "dotenv/config"`
// 是模組層級副作用，只有「載入該模組」才會觸發；沒有任何測試 import `cli.ts`，故把
// `import "dotenv/config"` 加回 `cli.ts` 頂部，既有測試依然全綠。
//
// 這裡改用靜態掃描：對 `src/**` 與 `scripts/**` 的原始碼逐行比對，不需執行、不需金鑰、
// 涵蓋所有現在與未來的檔案——子行程測試只能覆蓋被 spawn 的那一支入口，不取代此項。

import fs from "node:fs";
import path from "node:path";

// 唯一允許 `import dotenv from "dotenv"`（載入整個套件，而非 side-effect 的
// "dotenv/config" 子路徑）的檔案——它是 §24.4 明訂「唯一允許呼叫 dotenv 的地方」。
export const ALLOWED_BARE_DOTENV_IMPORT_FILE = path.join("src", "dispatch-home.ts");

// 只比對「行首（去除縮排後）即為 import 陳述式」的形式，故不會誤判 `//` 開頭、
// 說明這條禁令本身的註解行（本檔與 dispatch-home.ts／dispatch-home.test.ts／cli.ts
// 皆有這類註解，字面上含有 "dotenv/config" 字串，但不是真正的 import）。
//
// 已知涵蓋邊界（hub 驗收 2026-08-06 fixture 實測確認，刻意不擴大 regex 去堵）：
// 1. 動態 import——`const x = await import("dotenv/config")` 不會被偵測，因為它不是
//    行首的 `import` 陳述式。
// 2. 跨行 import——`import {\n  ...\n} from "dotenv/config"` 不會被偵測，因為比對
//    是逐「行」進行，模組指定字串沒有跟 `import` 出現在同一行。
// 不修的理由：要正確排除本檔自己這類說明註解會讓 regex 明顯變複雜，而這道防線要擋的
// 威脅模型是「有人為了方便把那一行原樣加回來」，不是刻意規避掃描——收益不成比例。
// 若日後真的出現這兩種寫法，判斷是否值得為此升級掃描邏輯（例如改成解析整個檔案而非
// 逐行比對），而不是預先做。
const DOTENV_CONFIG_IMPORT_PATTERN = /^\s*import\b.*["']dotenv\/config["']/;
const BARE_DOTENV_IMPORT_PATTERN = /^\s*import\b.*["']dotenv["']/;

export type DotenvViolation = {
  file: string; // 相對 repoRoot
  line: number; // 1-based
  text: string;
  kind: "dotenv/config" | "bare-dotenv-outside-allowed-file";
};

function listTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

export function scanDotenvInvariant(repoRoot: string): DotenvViolation[] {
  const files = ["src", "scripts"].flatMap((d) => listTsFiles(path.join(repoRoot, d)));
  const violations: DotenvViolation[] = [];

  for (const file of files) {
    const relFile = path.relative(repoRoot, file);
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (DOTENV_CONFIG_IMPORT_PATTERN.test(line)) {
        violations.push({ file: relFile, line: i + 1, text: line.trim(), kind: "dotenv/config" });
        return; // 一行不會同時命中兩種樣式（"dotenv/config" 與 "dotenv" 的引號內容不同）
      }
      if (BARE_DOTENV_IMPORT_PATTERN.test(line) && relFile !== ALLOWED_BARE_DOTENV_IMPORT_FILE) {
        violations.push({
          file: relFile,
          line: i + 1,
          text: line.trim(),
          kind: "bare-dotenv-outside-allowed-file",
        });
      }
    });
  }

  return violations;
}
