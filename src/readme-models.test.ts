import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

function modelsFromReadme(markdown: string, label: string): Set<string> {
  const heading = /^(?:### 可用型號|## Models)\s*$/m.exec(markdown);
  assert.ok(heading, `${label}: 找不到可辨識的型號表標題`);
  const afterHeading = markdown.slice((heading.index ?? 0) + heading[0].length);
  const nextHeading = /\n#{1,6}\s/.exec(afterHeading);
  const section = nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading;
  const models = new Set<string>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 3 || /^(?:型號|models?)$/i.test(cells[1]) || /^-+$/.test(cells[1])) continue;
    for (const model of cells[1].split(/(?:／|、|, )/u).map((model) => model.trim().replace(/^`|`$/g, "")).filter(Boolean)) models.add(model);
  }
  assert.ok(models.size > 0, `${label}: 型號表沒有可辨識的型號`);
  return models;
}

function modelsFromProvidersJson(text: string): Set<string> {
  const providers = JSON.parse(text) as { [provider: string]: unknown };
  const models = new Set<string>();
  for (const config of Object.values(providers)) {
    if (!config || typeof config !== "object" || !Array.isArray((config as { models?: unknown }).models)) continue;
    for (const model of (config as { models: unknown[] }).models) {
      if (typeof model !== "string") assert.fail("providers.json models 必須是字串");
      models.add(model);
    }
  }
  return models;
}

function assertSameModels(actual: Set<string>, expected: Set<string>, label: string): void {
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${label}: 型號表必須與 providers.json 雙向一致`);
}

test("README 型號表與 providers.json 的 models 雙向一致", () => {
  const root = process.cwd();
  const providerModels = modelsFromProvidersJson(readFileSync(path.join(root, "providers.json"), "utf8"));
  const readmes = readdirSync(root).filter((name) => /^README.*\.md$/.test(name));
  assert.ok(readmes.length > 0, "repo 根目錄必須有 README*.md");
  for (const name of readmes) {
    assertSameModels(modelsFromReadme(readFileSync(path.join(root, name), "utf8"), name), providerModels, name);
  }
});

test("README 型號表解析器涵蓋私有與公開 repo 的標題及三種分隔符", () => {
  const expected = new Set(["model-a", "model-b", "model-c"]);
  const fixtures = [
    ["private zh", "### 可用型號\n\n| Provider | 型號 | 預設 |\n| --- | --- | --- |\n| p | model-a／model-b | 開 |\n| | model-c | 關 |\n"],
    ["public en", "## Models\n\n| Provider | Models | Default |\n| --- | --- | --- |\n| p | model-a, model-b | on |\n| | model-c | off |\n"],
    ["public zh", "## Models\n\n| Provider | Models | Default |\n| --- | --- | --- |\n| p | model-a、model-b | 開 |\n| | model-c | 關 |\n"],
  ] as const;
  for (const [label, markdown] of fixtures) assertSameModels(modelsFromReadme(markdown, label), expected, label);
});
