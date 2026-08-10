// plan_dispatch_v1.4.md §4/§7/§18：工單與 providers.json 的交叉驗證，組出每個 spoke
// 執行所需的完整、已驗證資料（ResolvedSpoke）。第 1–5 步全部在任何 API 呼叫之前完成，
// 成本為零（§10）。

import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DispatchError, type ProviderConfig, type ProvidersFile } from "./types.js";
import type { Ticket, TicketLang } from "./ticket.js";
import { buildAllowSet } from "./whitelist.js";

export type ResolvedSpoke = {
  agent: string;
  provider: string;
  providerConfig: ProviderConfig;
  model: string;
  effort: string; // §4/§5：留白已解析為 providers.json 的 reasoning.default，不再是「不送參數」
  agentBody: string;
  questions: string;
  allowSet: Set<string>;
  allowedReadsResolved: string[]; // realpath，供 buildAllowSet 使用
  allowedReadsRelative: string[]; // 工單原文相對路徑，供稽核（§15 引用路徑比對）比對
  lang: TicketLang; // 由該 spoke 的工單標記決定，見 ticket.ts 的 TicketLang
};

function apiKeyEnvFor(provider: string): string {
  return `${provider.toUpperCase()}_API_KEY`;
}

function stripFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return (match ? match[1] : markdown).trim();
}

async function readAgentBody(agentsDir: string, agent: string): Promise<string> {
  const agentDefPath = path.join(agentsDir, `${agent}.md`);
  let text: string;
  try {
    text = await readFile(agentDefPath, "utf8");
  } catch {
    throw new DispatchError(`找不到 agent 定義檔 ${agentDefPath}（_dispatch.md 列了 "${agent}"）`, 2);
  }
  return stripFrontmatter(text);
}

function isUnderDocsDir(repoRoot: string, resolved: string): boolean {
  const docsRoot = path.resolve(repoRoot, "_docs");
  return resolved === docsRoot || resolved.startsWith(docsRoot + path.sep);
}

export async function resolveSpokes(
  ticket: Ticket,
  providers: ProvidersFile,
  repoRoot: string,
  agentsDir: string = path.join(repoRoot, ".claude", "agents"),
): Promise<ResolvedSpoke[]> {
  const resolved: ResolvedSpoke[] = [];

  for (const row of ticket.rows) {
    const providerConfig = providers[row.provider];
    if (!providerConfig) {
      throw new DispatchError(
        `_dispatch.md 的 "${row.agent}" 列引用了未定義於 providers.json 的 provider "${row.provider}"`,
        2,
      );
    }

    // §18：只檢查本次工單用到的 provider，缺即中止。
    const envName = apiKeyEnvFor(row.provider);
    if (!process.env[envName]) {
      throw new DispatchError(`缺少環境變數 ${envName}（"${row.agent}" 列需要 provider "${row.provider}"）`, 2);
    }

    // §5：model 須在 providers.json 的 models 白名單內；白名單為空 = 不做型號檢查。
    if (providerConfig.models.length > 0 && !providerConfig.models.includes(row.model)) {
      throw new DispatchError(
        `"${row.agent}" 列的 model "${row.model}" 不在 provider "${row.provider}" 的 models 白名單內` +
          `（允許：${providerConfig.models.join(", ")}）`,
        2,
      );
    }

    // §4：effort 填了但不在該 provider 的 allowed 內即中止（含 allowed 為空陣列）。
    if (row.effort !== undefined && !providerConfig.reasoning.allowed.includes(row.effort)) {
      throw new DispatchError(
        `"${row.agent}" 列的 effort "${row.effort}" 不在 provider "${row.provider}" 的允許值域內` +
          `（允許值：${providerConfig.reasoning.allowed.length > 0 ? providerConfig.reasoning.allowed.join(", ") : "（空——尚未驗證，任何值皆拒絕）"}）`,
        2,
      );
    }

    // §5：「留白」不再是「不送任何 reasoning 參數」，而是送 reasoning.default。
    // allowed 為空時 default 不存在——該 provider 不可用，即使 effort 留白也中止。
    const effectiveEffort = row.effort ?? providerConfig.reasoning.default;
    if (effectiveEffort === undefined) {
      throw new DispatchError(
        `"${row.agent}" 列的 effort 留白，但 provider "${row.provider}" 未設 reasoning.default` +
          `（allowed 為空 = 尚未驗證，該 provider 不可用）`,
        2,
      );
    }

    const agentTicket = ticket.perAgent.get(row.agent);
    if (!agentTicket) {
      // loadTicket() 已保證存在，此處為型別窄化與防禦
      throw new DispatchError(`內部錯誤：找不到 "${row.agent}" 的工單內容`, 2);
    }

    // §4「針對 hub 會寫錯」：_docs/ 一律拒絕；允許清單逐一驗證存在，任一不存在即中止並指名。
    const allowedReadsResolved: string[] = [];
    for (const rel of agentTicket.allowedReads) {
      const resolvedPath = path.resolve(repoRoot, rel);
      if (isUnderDocsDir(repoRoot, resolvedPath)) {
        throw new DispatchError(`"${row.agent}" 的允許讀取清單指向 _docs/（spoke 禁區）：${rel}`, 2);
      }
      let real: string;
      try {
        real = fs.realpathSync(resolvedPath);
      } catch {
        throw new DispatchError(`"${row.agent}" 的允許讀取清單指向不存在的路徑：${rel}`, 2);
      }
      allowedReadsResolved.push(real);
    }

    const agentBody = await readAgentBody(agentsDir, row.agent);

    const sharedPath = path.join(ticket.ticketDir, "_shared.md");
    const ownAgentPath = path.join(ticket.ticketDir, `${row.agent}.md`);
    const allowSet = buildAllowSet([sharedPath, ownAgentPath, ...allowedReadsResolved]);

    resolved.push({
      agent: row.agent,
      provider: row.provider,
      providerConfig,
      model: row.model,
      effort: effectiveEffort,
      agentBody,
      questions: agentTicket.questions,
      allowSet,
      allowedReadsResolved,
      allowedReadsRelative: agentTicket.allowedReads,
      lang: agentTicket.lang,
    });
  }

  return resolved;
}
