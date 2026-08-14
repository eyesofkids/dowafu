import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDispatchTable, parseSharedDoc, parseAgentTicket, loadTicket } from "./ticket.js";
import { DispatchError } from "./types.js";
import { m } from "./messages.js";

// plan_i18n_impl_tickets T4／plan_i18n_v1.2.md §5.5：這些函式現在依 lang 產出不同語言的
// 訊息。訊息斷言改比對 m(lang, key, ...args) 重建出的期望值（驗的是「用了正確的 key 與
// 參數」），不是寫死的中文子字串——理由同 T3（見 cli-args.test.ts 檔頭說明）。
//
// hub 裁決（2026-08-12）：§5.5 的二分法漏了第三個維度——用 m() 重建期望值驗不到「模板自己
// 的插值順序寫錯」（期望值與被測物出自同一個模板，一起錯、一起對）。實測：把 zh 版
// modelNotWhitelisted 的 ${model}／${provider} 對調，全用 m() 重建的 validate.test.ts
// 17 pass／0 fail，一條都沒紅。因此 2 個以上「同型」（皆 string）參數的 key，至少要有一條
// 手寫字面量斷言；單參數 key（只有一個插值洞，插錯不了）與跨型別參數的 key（如
// dispatchRowMissingFields 的 number/string，typecheck 擋得住）維持 m() 重建。
// 本檔涉及：formatMarkerMismatch（2 參）、agentFileNotFound（2 參）。

test("parseDispatchTable：正常表格解析出 agent/provider/model/effort", () => {
  const md = `<!-- format: v1 -->
# dispatch ticket-001

| agent | provider | model | effort |
| --- | --- | --- | --- |
| hole-finder-safety | openai | gpt-5.6-luna | high |
| hole-finder-cost | deepseek | deepseek-v4-flash | |
`;
  const rows = parseDispatchTable(md, "zh");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    agent: "hole-finder-safety",
    provider: "openai",
    model: "gpt-5.6-luna",
    effort: "high",
  });
  assert.deepEqual(rows[1], {
    agent: "hole-finder-cost",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    effort: undefined,
  });
});

// formatMarkerMismatch [marker, got]：2 個同型（string）參數，手寫字面量斷言（hub 裁決）。
test("parseDispatchTable：缺首行 format marker 即中止（exit 2），訊息依 lang（zh／en，手寫字面量）", () => {
  const md = `# dispatch ticket-001

| agent | provider | model | effort |
| --- | --- | --- | --- |
| a | openai | m | |
`;
  assert.throws(
    () => parseDispatchTable(md, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.exitCode, 2);
      assert.equal(err.message, "_dispatch.md 首行須為 <!-- format: v1 -->，實際為：# dispatch ticket-001");
      return true;
    },
  );
  assert.throws(
    () => parseDispatchTable(md, "en"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.message, "_dispatch.md's first line must be <!-- format: v1 -->, got: # dispatch ticket-001");
      return true;
    },
  );
});

test("parseDispatchTable：完全空白內容時，實際值顯示為 blankPlaceholder（zh／en）", () => {
  assert.throws(
    () => parseDispatchTable("", "zh"),
    (err: unknown) => {
      assert.equal(
        (err as DispatchError).message,
        m("zh", "formatMarkerMismatch", "<!-- format: v1 -->", m("zh", "blankPlaceholder")),
      );
      return true;
    },
  );
  assert.throws(
    () => parseDispatchTable("", "en"),
    (err: unknown) => {
      assert.equal(
        (err as DispatchError).message,
        m("en", "formatMarkerMismatch", "<!-- format: v1 -->", m("en", "blankPlaceholder")),
      );
      return true;
    },
  );
});

test("parseDispatchTable：找不到派工表表頭（zh／en）", () => {
  const md = `<!-- format: v1 -->
沒有表格
`;
  assert.throws(
    () => parseDispatchTable(md, "zh"),
    (err: unknown) => {
      assert.equal((err as DispatchError).message, m("zh", "dispatchTableMissingHeader"));
      return true;
    },
  );
  assert.throws(
    () => parseDispatchTable(md, "en"),
    (err: unknown) => {
      assert.equal((err as DispatchError).message, m("en", "dispatchTableMissingHeader"));
      return true;
    },
  );
});

test("parseDispatchTable：model 留白視為缺失（zh／en）", () => {
  const md = `<!-- format: v1 -->
| agent | provider | model | effort |
| --- | --- | --- | --- |
| a | openai |  | |
`;
  const lineText = "| a | openai |  | |";
  assert.throws(
    () => parseDispatchTable(md, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.message, m("zh", "dispatchRowMissingFields", 4, lineText));
      return true;
    },
  );
  assert.throws(
    () => parseDispatchTable(md, "en"),
    (err: unknown) => {
      assert.equal((err as DispatchError).message, m("en", "dispatchRowMissingFields", 4, lineText));
      return true;
    },
  );
});

test("parseDispatchTable：model 寫 default 視為缺失（不得套預設值）", () => {
  const md = `<!-- format: v1 -->
| agent | provider | model | effort |
| --- | --- | --- | --- |
| a | openai | default | |
`;
  assert.throws(() => parseDispatchTable(md, "zh"), DispatchError);
});

test("parseDispatchTable：派工表沒有任何資料列（zh／en）", () => {
  const md = `<!-- format: v1 -->
| agent | provider | model | effort |
| --- | --- | --- | --- |
`;
  assert.throws(
    () => parseDispatchTable(md, "zh"),
    (err: unknown) => {
      assert.equal((err as DispatchError).message, m("zh", "dispatchTableEmpty"));
      return true;
    },
  );
  assert.throws(
    () => parseDispatchTable(md, "en"),
    (err: unknown) => {
      assert.equal((err as DispatchError).message, m("en", "dispatchTableEmpty"));
      return true;
    },
  );
});

test("parseDispatchTable：agent 欄重複兩列即中止（exit 2），訊息含 agent 名", () => {
  const md = `<!-- format: v1 -->
| agent | provider | model | effort |
| --- | --- | --- | --- |
| hole-finder-safety | openai | gpt-5.6-luna | |
| hole-finder-safety | deepseek | deepseek-v4-flash | |
`;
  assert.throws(
    () => parseDispatchTable(md, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.exitCode, 2);
      assert.equal(err.message, m("zh", "duplicateAgentInDispatchTable", "hole-finder-safety", 2));
      return true;
    },
  );
});

test("parseDispatchTable：agent 欄重複三列時，次數印 3（數的是出現次數，不是有沒有重複）", () => {
  const md = `<!-- format: v1 -->
| agent | provider | model | effort |
| --- | --- | --- | --- |
| hole-finder-safety | openai | gpt-5.6-luna | |
| hole-finder-safety | deepseek | deepseek-v4-flash | |
| hole-finder-safety | gemini | gemini-3.6-flash | |
`;
  assert.throws(
    () => parseDispatchTable(md, "zh"),
    (err: unknown) => {
      assert.equal((err as DispatchError).message, m("zh", "duplicateAgentInDispatchTable", "hole-finder-safety", 3));
      return true;
    },
  );
});

test("parseDispatchTable：不同 agent 的兩列照常通過（回歸保護：不擋正常的多 lens 派工）", () => {
  const md = `<!-- format: v1 -->
| agent | provider | model | effort |
| --- | --- | --- | --- |
| hole-finder-safety | openai | gpt-5.6-luna | |
| hole-finder-cost | deepseek | deepseek-v4-flash | |
`;
  const rows = parseDispatchTable(md, "zh");
  assert.equal(rows.length, 2);
});

test("parseSharedDoc：待審段落缺失即中止（zh／en）", () => {
  const md = `# 前提（不受審）
- 一行結論
`;
  assert.throws(
    () => parseSharedDoc(md, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal((err as DispatchError).exitCode, 2);
      assert.equal(err.message, m("zh", "missingReviewSection"));
      return true;
    },
  );
  assert.throws(
    () => parseSharedDoc(md, "en"),
    (err: unknown) => {
      assert.equal((err as DispatchError).message, m("en", "missingReviewSection"));
      return true;
    },
  );
});

// issue_log_v2.1.md：實測撞過兩次的情境——規劃書自帶 `#` 標題，把待審段落切斷。
// 訊息必須指名兇手，不能只說「缺或內容為空」，否則讀的人會先去查自己有沒有寫。
test("parseSharedDoc：待審段落被內嵌規劃書的 # 標題切斷時，訊息須指名是哪個標題（zh／en）", () => {
  const md = `# 前提（不受審）
- 無

# 待審段落

# plan_dispatch — v2.2（差異版）
規劃書本體全部落在這裡，待審段落其實是空的。
`;
  assert.throws(
    () => parseSharedDoc(md, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal((err as DispatchError).exitCode, 2);
      assert.equal(err.message, m("zh", "strayHeadingsCutReviewSection", ["plan_dispatch — v2.2（差異版）"]));
      return true;
    },
  );
  assert.throws(
    () => parseSharedDoc(md, "en"),
    (err: unknown) => {
      assert.equal(
        (err as DispatchError).message,
        m("en", "strayHeadingsCutReviewSection", ["plan_dispatch — v2.2（差異版）"]),
      );
      return true;
    },
  );
});

// 標題根本沒寫時，仍走原本的訊息——兩種成因不可混為一談。
test("parseSharedDoc：待審段落完全沒寫時，維持原訊息（不誤報為被切斷）", () => {
  const md = `# 前提（不受審）
- 無
`;
  assert.throws(
    () => parseSharedDoc(md, "zh"),
    (err: unknown) => {
      assert.equal((err as DispatchError).message, m("zh", "missingReviewSection"));
      return true;
    },
  );
});

test("parseSharedDoc：前提缺失時合法（空前提，警告不中止）", () => {
  const md = `# 待審段落
規劃書原文逐字內嵌
`;
  const shared = parseSharedDoc(md, "zh");
  assert.deepEqual(shared.premises, []);
  assert.equal(shared.reviewText, "規劃書原文逐字內嵌");
});

test("parseSharedDoc：前提解析為條列陣列", () => {
  const md = `# 前提（不受審）
- 前提一
- 前提二

# 待審段落
內容
`;
  const shared = parseSharedDoc(md, "zh");
  assert.deepEqual(shared.premises, ["前提一", "前提二"]);
});

test("parseAgentTicket：具體問題缺失即中止（zh／en）", () => {
  const md = `# 允許讀取
- src/foo.ts
`;
  assert.throws(
    () => parseAgentTicket(md, "zh"),
    (err: unknown) => {
      assert.equal((err as DispatchError).message, m("zh", "missingQuestionsSection"));
      return true;
    },
  );
  assert.throws(
    () => parseAgentTicket(md, "en"),
    (err: unknown) => {
      assert.equal((err as DispatchError).message, m("en", "missingQuestionsSection"));
      return true;
    },
  );
});

test("parseAgentTicket：允許讀取缺失時合法（空清單）", () => {
  const md = `# 具體問題
1. 問題一
`;
  const t = parseAgentTicket(md, "zh");
  assert.deepEqual(t.allowedReads, []);
  assert.match(t.questions, /問題一/);
});

test("parseAgentTicket：允許讀取解析為相對路徑陣列", () => {
  const md = `# 具體問題
1. 問題一

# 允許讀取
- src/foo.ts
- src/bar.ts
`;
  const t = parseAgentTicket(md, "zh");
  assert.deepEqual(t.allowedReads, ["src/foo.ts", "src/bar.ts"]);
});

// plan_i18n_v1.3.md §一之5：語言不再由工單標記決定（推翻使用者 2026-08-10 的舊裁示，
// 改為 run-level `--lang` 決定，見 validate.ts 的 resolveSpokes）。但中英兩套區塊標記
// 仍要並存解析——那是選欄位鍵用的別名，拿掉英文那套，英文工單會直接解析失敗。
// 這兩條守的是「兩套標記都解析得出 questions／allowedReads」，不再斷言 lang。
// 呼叫時傳的 lang 是「訊息語言」，與工單本身用哪套標記書寫無關——刻意用 lang="en" 配中文
// 標記工單（及下一條用 lang="zh" 配英文標記工單），證明兩者互不影響。
test("parseAgentTicket：英文標記（Questions／Allowed reads）照樣解析，即使訊息語言是 zh", () => {
  const md = `# Questions
1. Does the permission check hold under concurrent requests?

# Allowed reads
- lib/auth-guard.ts
- prisma/schema.prisma
`;
  const t = parseAgentTicket(md, "zh");
  assert.match(t.questions, /concurrent requests/);
  assert.deepEqual(t.allowedReads, ["lib/auth-guard.ts", "prisma/schema.prisma"]);
});

test("parseAgentTicket：中文標記（具體問題／允許讀取）照樣解析，即使訊息語言是 en（既有工單不受影響）", () => {
  const md = `# 具體問題
1. 這段的權限檢查在並行下成立嗎？

# 允許讀取
- lib/auth-guard.ts
`;
  const t = parseAgentTicket(md, "en");
  assert.match(t.questions, /這段的權限檢查在並行下成立嗎/);
  assert.deepEqual(t.allowedReads, ["lib/auth-guard.ts"]);
});

test("parseSharedDoc：英文標記的 _shared.md 解析得出待審段落與前提", () => {
  const md = `# Premises
- Auth is settled: stateless JWT

# Under review
The section under review, verbatim.
`;
  const shared = parseSharedDoc(md, "zh");
  assert.deepEqual(shared.premises, ["Auth is settled: stateless JWT"]);
  assert.match(shared.reviewText, /verbatim/);
});

test("parseAgentTicket：兩套標記都沒有時，錯誤訊息同時列出中英兩種（zh／en 訊息本身皆同時列出兩種標記名）", () => {
  assert.throws(
    () => parseAgentTicket("# Something else\n內容\n", "zh"),
    (err: unknown) => {
      const msg = (err as DispatchError).message;
      assert.equal(msg, m("zh", "missingQuestionsSection"));
      assert.match(msg, /具體問題/);
      assert.match(msg, /Questions/);
      return true;
    },
  );
  assert.throws(
    () => parseAgentTicket("# Something else\n內容\n", "en"),
    (err: unknown) => {
      const msg = (err as DispatchError).message;
      assert.equal(msg, m("en", "missingQuestionsSection"));
      assert.match(msg, /具體問題/);
      assert.match(msg, /Questions/);
      return true;
    },
  );
});

// loadTicket()：檔案系統存取層，先前完全沒有測試（fileNotFound／agentFileNotFound 兩個 key
// 零覆蓋）。三則情境都要一個乾淨的臨時工單目錄。

function mkTicketDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "dispatch-ticket-"));
}

test("loadTicket：_dispatch.md 不存在 → fileNotFound（zh／en）", async () => {
  const dir = mkTicketDir();
  try {
    const dispatchPath = path.join(dir, "_dispatch.md");
    await assert.rejects(
      loadTicket(dir, "zh"),
      (err: unknown) => {
        assert.ok(err instanceof DispatchError);
        assert.equal(err.message, m("zh", "fileNotFound", dispatchPath));
        return true;
      },
    );
    await assert.rejects(
      loadTicket(dir, "en"),
      (err: unknown) => {
        assert.equal((err as DispatchError).message, m("en", "fileNotFound", dispatchPath));
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadTicket：_shared.md 不存在 → fileNotFound（zh／en）", async () => {
  const dir = mkTicketDir();
  try {
    writeFileSync(
      path.join(dir, "_dispatch.md"),
      `<!-- format: v1 -->\n| agent | provider | model | effort |\n| --- | --- | --- | --- |\n| a | openai | m | |\n`,
    );
    const sharedPath = path.join(dir, "_shared.md");
    await assert.rejects(
      loadTicket(dir, "zh"),
      (err: unknown) => {
        assert.ok(err instanceof DispatchError);
        assert.equal(err.message, m("zh", "fileNotFound", sharedPath));
        return true;
      },
    );
    await assert.rejects(
      loadTicket(dir, "en"),
      (err: unknown) => {
        assert.equal((err as DispatchError).message, m("en", "fileNotFound", sharedPath));
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// agentFileNotFound [agentPath, agent]：2 個同型（string）參數，手寫字面量斷言（hub 裁決）。
test("loadTicket：<agent>.md 不存在 → agentFileNotFound，手寫字面量斷言（zh／en）", async () => {
  const dir = mkTicketDir();
  try {
    writeFileSync(
      path.join(dir, "_dispatch.md"),
      `<!-- format: v1 -->\n| agent | provider | model | effort |\n| --- | --- | --- | --- |\n| agent-Q | openai | m | |\n`,
    );
    writeFileSync(path.join(dir, "_shared.md"), `# 待審段落\n內容\n`);
    const agentPath = path.join(dir, "agent-Q.md");
    await assert.rejects(
      loadTicket(dir, "zh"),
      (err: unknown) => {
        assert.ok(err instanceof DispatchError);
        assert.equal(err.message, `找不到 ${agentPath}（_dispatch.md 列了 agent "agent-Q"）`);
        return true;
      },
    );
    await assert.rejects(
      loadTicket(dir, "en"),
      (err: unknown) => {
        assert.equal((err as DispatchError).message, `Not found: ${agentPath} (_dispatch.md lists agent "agent-Q")`);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
