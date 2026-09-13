import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("mcp production modules do not import node:fs", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sourceFiles = readdirSync(directory).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  assert.ok(sourceFiles.length > 0, "expected MCP production modules");
  for (const name of sourceFiles) {
    // 驗收熱修補：原樣式只比對 `node:fs`，但 Node 同樣接受不帶前綴的 `fs`，解析到同一個
    // 內建模組——`import { readFileSync } from "fs"` 曾在守衛、eslint、tsc 三關全部放行。
    // 交付時的變異 8 已經因為漏掉 bare `import "node:fs"` 補強過一次；樣式比對的守衛
    // 就是會一直漏形態，所以這裡把前綴也收進同一條樣式，而不是再加第二條規則。
    assert.doesNotMatch(readFileSync(path.join(directory, name), "utf8"), /(?:from\s+|import\s*\(|import\s+)['"](?:node:)?fs(?:\/promises)?['"]/);
  }
});
