// plan_dispatch_v1.4.md §4/§7/§18：工單與 providers.json 的交叉驗證，組出每個 spoke
// 執行所需的完整、已驗證資料（ResolvedSpoke）。第 1–5 步全部在任何 API 呼叫之前完成，
// 成本為零（§10）。

import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DispatchError, type Lang, type ProviderConfig, type ProvidersFile } from "./types.js";
import { stripFrontmatter, type Ticket } from "./ticket.js";
import { buildAllowSet } from "./whitelist.js";
import { m } from "./messages.js";

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
  lang: Lang; // plan_i18n_v1.3.md §一：run-level 注入（--lang > DISPATCH_LANG > 內建
  // 預設），與工單標記無關——見 resolveSpokes 的 lang 參數
};

function apiKeyEnvFor(provider: string): string {
  return `${provider.toUpperCase()}_API_KEY`;
}

async function readAgentBody(agentsDir: string, agent: string, lang: Lang): Promise<string> {
  const agentDefPath = path.join(agentsDir, `${agent}.md`);
  let text: string;
  try {
    text = await readFile(agentDefPath, "utf8");
  } catch {
    throw new DispatchError(m(lang, "agentDefNotFound", agentDefPath, agent), 2);
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
  // plan_i18n_v1.3.md §一之3 第 3 點：必填、不得有預設值——有預設值的話呼叫端漏傳會
  // 靜默回退成舊來源，連紅字都沒有，等同「傳了但傳的是舊來源」那種型別系統看不見的錯誤。
  lang: Lang,
  agentsDir: string = path.join(repoRoot, ".claude", "agents"),
): Promise<ResolvedSpoke[]> {
  const resolved: ResolvedSpoke[] = [];

  for (const row of ticket.rows) {
    const providerConfig = providers[row.provider];
    if (!providerConfig) {
      throw new DispatchError(m(lang, "providerUndefinedInRow", row.agent, row.provider), 2);
    }

    // §18：只檢查本次工單用到的 provider，缺即中止。
    const envName = apiKeyEnvFor(row.provider);
    if (!process.env[envName]) {
      throw new DispatchError(m(lang, "missingEnvVar", envName, row.agent, row.provider), 2);
    }

    // §5：model 須在 providers.json 的 models 白名單內；白名單為空 = 不做型號檢查。
    if (providerConfig.models.length > 0 && !providerConfig.models.includes(row.model)) {
      throw new DispatchError(
        m(lang, "modelNotWhitelisted", row.agent, row.model, row.provider, providerConfig.models.join(", ")),
        2,
      );
    }

    // §4：effort 填了但不在該 provider 的 allowed 內即中止（含 allowed 為空陣列）。
    if (row.effort !== undefined && !providerConfig.reasoning.allowed.includes(row.effort)) {
      const list =
        providerConfig.reasoning.allowed.length > 0
          ? providerConfig.reasoning.allowed.join(", ")
          : m(lang, "emptyAllowedNote");
      throw new DispatchError(m(lang, "effortNotAllowed", row.agent, row.effort, row.provider, list), 2);
    }

    // §5：「留白」不再是「不送任何 reasoning 參數」，而是送 reasoning.default。
    // allowed 為空時 default 不存在——該 provider 不可用，即使 effort 留白也中止。
    const effectiveEffort = row.effort ?? providerConfig.reasoning.default;
    if (effectiveEffort === undefined) {
      throw new DispatchError(m(lang, "effortBlankNoDefault", row.agent, row.provider), 2);
    }

    const agentTicket = ticket.perAgent.get(row.agent);
    if (!agentTicket) {
      // loadTicket() 已保證存在，此處為型別窄化與防禦
      throw new DispatchError(m(lang, "internalErrorTicketContentMissing", row.agent), 2);
    }

    // §4「針對 hub 會寫錯」：_docs/ 一律拒絕；允許清單逐一驗證存在，任一不存在即中止並指名。
    const allowedReadsResolved: string[] = [];
    for (const rel of agentTicket.allowedReads) {
      const resolvedPath = path.resolve(repoRoot, rel);
      if (isUnderDocsDir(repoRoot, resolvedPath)) {
        throw new DispatchError(m(lang, "allowedReadsUnderDocs", row.agent, rel), 2);
      }
      let real: string;
      try {
        real = fs.realpathSync(resolvedPath);
      } catch {
        throw new DispatchError(m(lang, "allowedReadsPathNotFound", row.agent, rel), 2);
      }
      allowedReadsResolved.push(real);
    }

    const agentBody = await readAgentBody(agentsDir, row.agent, lang);

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
      lang,
    });
  }

  return resolved;
}
