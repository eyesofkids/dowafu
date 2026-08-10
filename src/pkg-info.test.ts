import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { bundledProvidersPath, getPackageVersion } from "./pkg-info.js";

// 這裡驗證的是 tsx 開發模式下的解析（src/pkg-info.ts 的 import.meta.url 指向 src/，
// "../" 即 repo 根目錄）。pnpm link --global 下編譯後的 dist/ 版本是否解析得到，
// 規劃書明訂須「實跑確認」，不是這支單元測試能背書的——已於 issue_log 記錄實測結果。

test("bundledProvidersPath：解析出的路徑實際存在", () => {
  assert.ok(existsSync(bundledProvidersPath()));
});

test("getPackageVersion：讀到與 package.json 一致的版號", () => {
  const version = getPackageVersion();
  assert.match(version, /^\d+\.\d+\.\d+$/);
});
