// plan_i18n_v1.2.md §5.1／plan_i18n_v1.3.md §四：使用者可見訊息（A 類）的機制層。
// 協定常數（B 類）與雙語常數（C 類，如 prompt 模板、收尾句、稽核偵測樣式）不進這裡——
// 前者不翻、後者由 spoke.lang 直接選用，見各自所在檔案。
//
// v1.0 的 Record<Lang, Record<MessageKey, string | ((...args: never[]) => string)>> 已作廢：
// 定義端可 assign，但 m() 內 v(...args) 對 unknown 參數會紅（不能指派給 never）。
// 這裡改用 per-key 精確型別——key → 參數 tuple 的對照——讓「key 齊全」與「參數個數
// （arity）」同時被型別系統擋住。arity 錯了會在執行期插出 undefined，那正是本版要消滅的
// 失敗形態。
//
// T2 只驗證這個機制本身能編譯、能用，當時的三個 key（unknownOption／missingProviders／
// dryRunNotice）是驗證 0／1／2 參數 arity 的範例，不是實際搬遷。T3 起 unknownOption／
// dryRunNotice 轉正（cli-args.ts／cli.ts 實際使用，見下方）；missingProviders 由 T4
// （providers.ts:loadProviders）接手轉正，型別骨架沿用，不重建。
//
// 遮蔽邊界（v1.2 §5.2／v1.3 §四之1，零機械強制力的文件約定）：maskString 一律留在呼叫端，
// 這裡的函式本體不得出現 String(err)，也不得自己呼叫遮蔽——已遮蔽過的字串才能作為參數傳入。
//
// 組裝原則（T3 起）：需要先組合再插入的片段（可用值清單、env 補充說明、cost 標籤、
// budgetTrigger 後綴…）一律由呼叫端組好、當作已完成的字串參數傳進來，MESSAGES 內的函式
// 本體不互相呼叫 m()——每個 key 只做「這一則訊息長什麼樣子」，組裝邏輯留在 cli-args.ts／
// cli.ts，兩者職責分開才好讀。

import type { BudgetTrigger, Lang } from "./types.js";

type MessageArgs = {
  // T2 範例、T3 起正式使用
  unknownOption: [arg: string, helpText: string];
  missingProviders: [path: string]; // T4（providers.ts）使用，T3 不動
  dryRunNotice: [];

  // T3：cli-args.ts——HELP_TEXT 與 parseArgs 的解析期訊息
  helpText: [cmd: string];
  availableLangValues: [];
  availableValuesSuffix: [values: string];
  numberFlagInvalid: [name: string, value: string];
  missingFlagValue: [name: string, suffix: string];
  tooManyArgs: [arg: string, ticketDir: string, helpText: string];
  invalidLangFlag: [value: string, availableSuffix: string, envNote: string];
  invalidEnvAlsoNote: [envValue: string | undefined];
  invalidEnvLang: [value: string | undefined, availableSuffix: string];

  // T3：cli-args.ts——formatEvent（跟 run-level lang，不是 env lang）
  noPricingData: [];
  eventSpokeStart: [agent: string, provider: string, model: string];
  eventUnknownUsageKeys: [agent: string, round: number, keys: string];
  eventToolCall: [agent: string, path: string, allowed: boolean, reason: string | undefined];
  eventRateLimitWait: [agent: string, seconds: number, source: string];
  eventRoundError: [agent: string, round: number, status: string, message: string];
  eventSpokeEnd: [
    agent: string,
    status: string,
    latencyMs: number,
    totalTokens: number,
    costLabel: string,
    budgetSuffix: string,
  ];

  // T3：cli.ts
  apiKeyMissing: [provider: string];
  confirmPrompt: [];
  cancelledInteractive: [];
  cancelledNonInteractive: [];
  outDirNotWritable: [outDir: string];
  outDirNotEmptyAbort: [outDir: string];
  outDirNotEmptyDryRunWarning: [outDir: string];
  outDirWritten: [outDir: string];
  outDirFallbackStderr: [];
  stdoutSummaryLine: [
    agent: string,
    status: string,
    model: string,
    tokens: number,
    costLabel: string,
    latencyMs: number,
  ];

  // T4：ticket.ts——_dispatch.md／_shared.md／<agent>.md 解析期訊息。B 類區塊鍵
  // （"待審段落"／"前提"／"具體問題"／"允許讀取" 及其英文對應）不在此列——那些是
  // sections.get() 的協定常數，不翻、不進這裡，見 ticket.ts 內對應註解。
  formatMarkerMismatch: [marker: string, got: string];
  blankPlaceholder: [];
  dispatchTableMissingHeader: [];
  dispatchRowMissingFields: [n: number, line: string];
  duplicateAgentInDispatchTable: [agent: string, n: number];
  dispatchTableEmpty: [];
  strayHeadingsCutReviewSection: [strayNames: string[]];
  missingReviewSection: [];
  missingQuestionsSection: [];
  fileNotFound: [path: string]; // ticket.ts:197／:203 共用（_dispatch.md／_shared.md 找不到，同型訊息）
  agentFileNotFound: [agentPath: string, agent: string];

  // T4：validate.ts——resolveSpokes／readAgentBody
  agentDefNotFound: [path: string, agent: string];
  providerUndefinedInRow: [agent: string, provider: string];
  missingEnvVar: [envName: string, agent: string, provider: string];
  modelNotWhitelisted: [agent: string, model: string, provider: string, list: string];
  effortNotAllowed: [agent: string, effort: string, provider: string, list: string];
  emptyAllowedNote: [];
  effortBlankNoDefault: [agent: string, provider: string];
  internalErrorTicketContentMissing: [agent: string];
  allowedReadsUnderDocs: [agent: string, rel: string];
  allowedReadsPathNotFound: [agent: string, rel: string];

  // T4：providers.ts——providers.json 載入與驗證
  reasoningStyleInvalid: [providerName: string, style: string];
  reasoningDefaultNotString: [providerName: string];
  reasoningDefaultMissing: [providerName: string];
  reasoningDefaultNotAllowed: [providerName: string, def: string, list: string];
  emptyList: [];
  positiveNumberRequired: [label: string, value: string];
  pricingNotObject: [providerName: string];
  pricingModelNotObject: [providerName: string, model: string];
  providerConfigNotObject: [name: string];
  providerApiInvalid: [name: string, value: string];
  providerStoreTrue: [name: string];
  providerBaseUrlMissing: [name: string];
  providerCharsPerTokenInvalid: [name: string];
  providersFileNotObject: [];
  providersFormatVersionMismatch: [want: number, got: string];
  providersFileInvalidJson: [msg: string];
  providerUndefined: [name: string];

  // T5：output.ts——RunLogWriter／persistSpokeResult／writeSpokeText／buildSummaryMarkdown
  // 家族。四則「消費者是 spoke」的訊息（runner.ts 200KB 截斷、--max-tool-calls 上限、
  // whitelist.ts 的 ALLOWLIST_REJECT_MESSAGE、三支 adapter 的 read_file description）不在
  // 此列——i18n_classification_t2.md §三：歸 C 類，改建雙語常數由 spoke.lang 直接選用，
  // 見各自所在檔案。
  runLogWriteFailed: [maskedErr: string];
  noFullReportAvailable: [status: string];
  persistTextFailed: [agent: string, maskedErr: string];
  persistRawFailed: [agent: string, maskedErr: string];
  budgetTriggerLabel: [trigger: BudgetTrigger];
  anomalySpikeFlag: [];
  noneLabel: [];
  outsideAllowlistSection: [section: string];
  outsideAllowlistNoSection: [];
  outsideAllowlistSuffixNote: [suffixOf: string];
  outsideAllowlistEntry: [path: string, detail: string];
  unknownUsageKeysWarning: [provider: string, keys: string];
  zeroSourceReadWarning: [n: number];
  toolCallStats: [total: number, allowed: number, rejected: number];
  closingLineCell: [passFail: string];
  observationCountCell: [display: string];
  cannotCountObservations: [];
  outsideAllowlistCell: [detail: string];
  cannotVerifySectionCell: [passFail: string];
  suspectPhrasesCell: [detail: string];
  auditUnavailable: [];
  summaryHeader: [ticketId: string];

  // T5：report.ts——buildReport
  providersBundled: [formatVersion: number];
  providersExplicit: [path: string, formatVersion: number];
  gitignoreNotIgnored: [outDir: string];
  gitignoreUnknown: [outDir: string];
  aboutToDispatch: [ticketId: string];
  initialPromptEstimate: [totalEst: string, maxTokens: string];
  allowlistTotalEstimate: [tokens: string, files: number];
  allowlistEstimateCaveat: [];
  sequentialReadAmplification: [n: string];
  sequentialReadCanReduce: [n: string, pct: number];
  sequentialReadNearOptimal: [pct: number];
  sequentialReadCostNote: [];
  worstCaseTotal: [n: string];
  concurrencyLine: [n: number];
  tpmPeakLine: [provider: string, limit: string, peak: string];
  tpmPeakCaveat: [];
  allowedReadsSummary: [n: number, outDir: string];

  // T7a〈B. 乾跑提示〉：lens 收尾句落在哪一個 FIXED_CLOSING_LINE*，乾跑與實跑都印，只提示不擋。
  // 沒有收尾句的 lens（如 explore-haiku.md）不在此列——那種情況不印任何東西，見 report.ts
  // 的 formatLensClosingLineNotice。
  lensClosingLineZh: [agent: string];
  lensClosingLineEn: [agent: string];
  modelPricing: [inputPerM: number, outputPerM: number, cachedSuffix: string, asOfSuffix: string];
  modelPricingCachedSuffix: [cachedInputPerM: number];
  modelPricingAsOfSuffix: [asOf: string];
  modelPricingMissing: [model: string];

  // T5：runner.ts——runSpoke／sendWithResilience（A 類五則，用 spoke.lang；200KB 截斷與
  // --max-tool-calls 上限兩則消費者是 spoke，不在此列，見 runner.ts 本地雙語常數）
  rawIntegrityCheckFailed: [msg: string];
  rateLimitRetriesExceeded: [n: number];
  rateLimitWaitExceeded: [s: number, cap: number];
  usageUnavailableRound: [n: number];
  finalizeToolCallIgnored: [n: number];

  // T7a〈D. 全域中文字串最終覆核〉：i18n_classification_t2.md 未涵蓋 adapters/ 的遺漏之一。
  // adapters/responses.ts——OpenAI SDK 拋出的錯誤物件缺 .message 時的回退文字，流進
  // errors[]／rawErrors[]，消費者是人類，判定為 A 類。
  responsesAdapterCallFailed: [];

  // T7a2：gate.ts／raw-integrity.ts——T2 分類清單 §六明列為 A 類，但兩支檔案不在
  // T3／T4／T5 任何一張工單的〈動到〉清單內（工單按檔案分組時漏了這兩支），T7a 的全域
  // 覆核也只處理了 issue_log 指名的 adapters 三則，這 4 則直到 hub 交叉核對才被抓到。
  gateOneExceeded: [total: number, maxTokens: number, detail: string];
  rawIntegrityNotArray: [];
  rawIntegrityItemNotFound: [type: string];
  rawIntegrityObjectNotFound: [];

  // 工單 W1 §一：doctor.ts——`--doctor` 五列報表。行本身（label＋固定縮排）與其內容值
  // 分開建鍵，縮排照工單〈輸出形狀〉裁定的字元數，不可自行調整。
  doctorHeader: [cmd: string];
  doctorConfigDirLine: [value: string];
  doctorConfigDirSourceDispatchHome: [dir: string];
  doctorConfigDirSourceXdgConfigHome: [dir: string];
  doctorConfigDirSourceDefault: [dir: string];
  doctorConfigDirUnresolved: [];
  doctorEnvLine: [value: string];
  doctorEnvPresentValue: [];
  doctorEnvMissingValue: [path: string];
  doctorEnvUnresolvedValue: [];
  doctorApiKeyLine: [value: string];
  doctorProviderCountItem: [name: string, count: number];
  doctorModelListLine: [value: string];
  doctorModelListValue: [formatVersion: number, items: string];
  doctorModelListLoadFailedValue: [reason: string];
  doctorLensLine: [value: string];
  doctorLensFoundValue: [dirPath: string, count: number, names: string];
  doctorLensDirMissingValue: [dirPath: string];
  doctorFooter: [];
};

type MessageDefs = {
  [K in keyof MessageArgs]: (...args: MessageArgs[K]) => string;
};

const MESSAGES: Record<Lang, MessageDefs> = {
  zh: {
    unknownOption: (arg, helpText) => `未知選項：${arg}\n\n${helpText}`,
    missingProviders: (path) => `找不到 providers.json：${path}`,
    dryRunNotice: () => "--dry-run：僅解析／驗證／估算／印報表，未呼叫任何 API。",

    helpText: (cmd) => `用法：${cmd} <ticket-dir> [options]

  --lang <en|zh-tw>        CLI 輸出與 spoke prompt 的語言，預設 en
  --repo-root <dir>        白名單邊界與 .claude/agents 的根，預設 cwd
  --providers <path>       整檔取代出貨的 providers.json
  --json                   stdout 只印結果 JSON，其餘輸出改走 stderr
  --out <dir>              落檔目錄，預設 tmp/spoke/
  --concurrency <n>        同時執行的 spoke 數，預設 2
  --max-tokens <n>         呼叫前估算閘門（各 spoke 初始 prompt 總和），預設 200000
  --max-spoke-tokens <n>   單一 spoke 執行期累積上限（實際 usage），預設 400000
  --timeout <sec>          單次 API 呼叫逾時（不是整支 spoke），預設 600
  --retries <n>            單輪呼叫的重試次數（僅暫時性錯誤），預設 2
  --chars-per-token <n>    閘門一估算係數，預設 1.0（可由 providers.json 逐家覆寫）
  --max-spoke-reasoning-tokens <n>  單一 spoke 的推理 token 累積上限，預設 50000
  --max-round-reasoning-tokens <n>  單輪推理 token 上限，預設 null（不檢查）
  --rate-limit-retries <n> 429 專用重試次數，預設 5（不計入 --retries）
  --max-rate-wait <sec>    單次 429 等待上限，預設 30
  --max-tool-calls <n>     單一 spoke 的 read_file 呼叫上限，預設 30
  --dry-run                解析、驗證、估算、印報表，不呼叫 API
  --yes                    略過派工確認。非互動環境（stdin 不是 TTY）沒帶就中止
  --doctor                 印出設定自檢（不呼叫 API、不花錢）後結束（exit 0）
  --help, -h               印本說明後結束（exit 0）
  --version, -V            印版本號後結束（exit 0）`,
    availableLangValues: () => "en、zh-tw、zh",
    availableValuesSuffix: (values) => `（可用值：${values}）`,
    numberFlagInvalid: (name, value) => `--${name} 需要數字，收到：${value}`,
    missingFlagValue: (name, suffix) => `--${name} 缺少值${suffix}`,
    tooManyArgs: (arg, ticketDir, helpText) =>
      `多餘的引數：${arg}（工單目錄已是 "${ticketDir}"）\n\n${helpText}`,
    invalidLangFlag: (value, availableSuffix, envNote) => `--lang 值無效：${value}${availableSuffix}${envNote}`,
    invalidEnvAlsoNote: (envValue) => `；環境變數 DISPATCH_LANG 目前也是無效值：${envValue}`,
    invalidEnvLang: (value, availableSuffix) => `環境變數 DISPATCH_LANG 值無效：${value}${availableSuffix}`,

    noPricingData: () => "無價目資料",
    eventSpokeStart: (agent, provider, model) => `[${agent}] 開始 → ${provider}/${model}`,
    eventUnknownUsageKeys: (agent, round, keys) => `[${agent}] ⚠ round ${round} 出現未知 usage 欄位：${keys}`,
    eventToolCall: (agent, path, allowed, reason) =>
      `[${agent}] read_file(${path}) ${allowed ? "允許" : `拒絕(${reason})`}`,
    eventRateLimitWait: (agent, seconds, source) => `[${agent}] 429，等待 ${seconds}s（來源：${source}）`,
    eventRoundError: (agent, round, status, message) =>
      `[${agent}] ⚠ round ${round} 錯誤 status=${status}：${message}`,
    eventSpokeEnd: (agent, status, latencyMs, totalTokens, costLabel, budgetSuffix) =>
      `[${agent}] 結束 status=${status} latency=${latencyMs}ms totalTokens=${totalTokens} cost=${costLabel}${budgetSuffix}`,

    apiKeyMissing: (provider) => `內部錯誤：${provider} 的 API key 遺失`,
    confirmPrompt: () => "繼續？[y/N] ",
    cancelledInteractive: () => "已取消，未呼叫任何 API。",
    cancelledNonInteractive: () =>
      "非互動環境（stdin 不是 TTY）無人可確認，已取消，未呼叫任何 API。要在此環境派工請明確加上 --yes。",
    outDirNotWritable: (outDir) => `落檔目錄不可寫：${outDir}`,
    // 護欄：舊產物是花過錢的東西，覆蓋掉之前沒有人會被問到。換一個 ticket-id 零成本，
    // 所以這裡不提供 --overwrite 之類的旗標——有旗標就會有人直接加上去。
    outDirNotEmptyAbort: (outDir) =>
      `輸出目錄已有產物，未派工、未呼叫任何 API：${outDir}\n` +
      `那是上一次跑出來的東西，覆蓋掉就沒了。兩條路：\n` +
      `  1. 換一個沒用過的 ticket-id 再派（建議，零成本）\n` +
      `  2. 由使用者自行清掉那個目錄之後重跑——這是他的決定，不是你的\n` +
      `  * 上一次若是失敗收場（summary 全 failed、token 0），那底下沒有花過錢的東西，\n` +
      `    換 id 或請使用者清掉都行——但仍然由使用者決定要不要清`,
    outDirNotEmptyDryRunWarning: (outDir) =>
      `⚠ 輸出目錄已有產物：${outDir}\n  乾跑不受影響，但實跑會被擋下。換一個 ticket-id 即可。`,
    outDirWritten: (outDir) => `落檔完成：${outDir}/`,
    outDirFallbackStderr: () => "落檔目錄不可寫，完整報告已改印於 stderr：",
    stdoutSummaryLine: (agent, status, model, tokens, costLabel, latencyMs) =>
      `${agent}: ${status}  model=${model}  token=${tokens}  cost=${costLabel}  耗時=${latencyMs}ms`,

    formatMarkerMismatch: (marker, got) => `_dispatch.md 首行須為 ${marker}，實際為：${got}`,
    blankPlaceholder: () => "(空白)",
    dispatchTableMissingHeader: () => "_dispatch.md 找不到派工表（缺 | agent | ... | 表頭或分隔列）",
    dispatchRowMissingFields: (n, line) =>
      `_dispatch.md 第 ${n} 行缺 agent/provider/model 必填欄位（留白或寫 "default" 視為缺失）：${line}`,
    duplicateAgentInDispatchTable: (agent, n) =>
      `_dispatch.md 的 agent 欄重複：「${agent}」出現 ${n} 次。未派工、未呼叫任何 API。\n` +
      `同一份 _dispatch.md 裡一個 agent 只能有一列。兩列同名會兩支都派出去、都計費，\n` +
      `而 ${agent}.md 與 raw/${agent}.* 由後完成的那支覆蓋先完成的——留下哪一支不可控。\n` +
      `要用同一個 lens 跑多個型號，拆成多個工單目錄（例如 <ticket-id>-luna、<ticket-id>-ds），各派一次。`,
    dispatchTableEmpty: () => "_dispatch.md 派工表沒有任何資料列",
    strayHeadingsCutReviewSection: (strayNames) =>
      `_shared.md 的「# 待審段落」有標題但內容為空——被後面這些 \`#\` 標題切斷了：` +
      `${strayNames.map((s) => `「# ${s}」`).join("、")}。` +
      `工單以 \`#\` 切分區塊，內嵌的規劃書若自帶 \`#\` 標題請降成 \`##\`。` +
      `（注意：在「# 待審段落」下面補一行文字雖然能通過檢查，但規劃書本體仍會留在` +
      `後面那個區塊裡，spoke 收到的待審段落等於是空的。）`,
    missingReviewSection: () => '_shared.md 缺「# 待審段落」（或英文工單的「# Under review」）或內容為空',
    missingQuestionsSection: () => '<agent>.md 缺「# 具體問題」（或英文工單的「# Questions」）或內容為空',
    fileNotFound: (path) => `找不到 ${path}`,
    agentFileNotFound: (agentPath, agent) => `找不到 ${agentPath}（_dispatch.md 列了 agent "${agent}"）`,

    agentDefNotFound: (path, agent) => `找不到 agent 定義檔 ${path}（_dispatch.md 列了 "${agent}"）`,
    providerUndefinedInRow: (agent, provider) =>
      `_dispatch.md 的 "${agent}" 列引用了未定義於 providers.json 的 provider "${provider}"`,
    missingEnvVar: (envName, agent, provider) => `缺少環境變數 ${envName}（"${agent}" 列需要 provider "${provider}"）`,
    modelNotWhitelisted: (agent, model, provider, list) =>
      `"${agent}" 列的 model "${model}" 不在 provider "${provider}" 的 models 白名單內（允許：${list}）`,
    effortNotAllowed: (agent, effort, provider, list) =>
      `"${agent}" 列的 effort "${effort}" 不在 provider "${provider}" 的允許值域內（允許值：${list}）`,
    emptyAllowedNote: () => "（空——尚未驗證，任何值皆拒絕）",
    effortBlankNoDefault: (agent, provider) =>
      `"${agent}" 列的 effort 留白，但 provider "${provider}" 未設 reasoning.default（allowed 為空 = 尚未驗證，該 provider 不可用）`,
    internalErrorTicketContentMissing: (agent) => `內部錯誤：找不到 "${agent}" 的工單內容`,
    allowedReadsUnderDocs: (agent, rel) => `"${agent}" 的允許讀取清單指向 _docs/（spoke 禁區）：${rel}`,
    allowedReadsPathNotFound: (agent, rel) => `"${agent}" 的允許讀取清單指向不存在的路徑：${rel}`,

    reasoningStyleInvalid: (providerName, style) => `providers.json: ${providerName}.reasoning.style 值不合法："${style}"`,
    reasoningDefaultNotString: (providerName) => `providers.json: ${providerName}.reasoning.default 須為字串`,
    reasoningDefaultMissing: (providerName) =>
      `providers.json: ${providerName}.reasoning.default 缺失——allowed 非空時必填，不得回退到「不送參數」`,
    reasoningDefaultNotAllowed: (providerName, def, list) =>
      `providers.json: ${providerName}.reasoning.default "${def}" 不在 allowed 內（${list}）`,
    emptyList: () => "（空）",
    positiveNumberRequired: (label, value) => `providers.json: ${label} 須為正數，實際為 ${value}`,
    pricingNotObject: (providerName) => `providers.json: ${providerName}.pricing 不是物件`,
    pricingModelNotObject: (providerName, model) => `providers.json: ${providerName}.pricing.${model} 不是物件`,
    providerConfigNotObject: (name) => `providers.json: provider "${name}" 的設定不是物件`,
    providerApiInvalid: (name, value) =>
      `providers.json: ${name}.api 缺失或不合法（須為 "responses"、"gemini-native" 或 "anthropic-messages"），實際為 ${value}`,
    providerStoreTrue: (name) =>
      `providers.json: ${name}.store 為 true，違反設計原則 6（零留存）。載入即中止，不得依賴伺服器端狀態。`,
    providerBaseUrlMissing: (name) => `providers.json: ${name}.baseURL 缺失`,
    providerCharsPerTokenInvalid: (name) => `providers.json: ${name}.charsPerToken 須為正數`,
    providersFileNotObject: () => "providers.json 格式不是物件",
    providersFormatVersionMismatch: (want, got) =>
      `providers.json: formatVersion 不符（預期 ${want}，實際 ${got}）。這通常代表 --providers 指向了舊版或不相容的檔案。`,
    providersFileInvalidJson: (msg) => `providers.json 不是合法 JSON：${msg}`,
    providerUndefined: (name) => `providers.json 未定義 provider "${name}"`,

    runLogWriteFailed: (maskedErr) => `run.jsonl 寫入失敗：${maskedErr}`,
    noFullReportAvailable: (status) => `(無法取得完整回報，執行狀態：${status})`,
    persistTextFailed: (agent, maskedErr) => `落檔失敗（${agent}.md）：${maskedErr}`,
    persistRawFailed: (agent, maskedErr) => `落檔失敗（${agent} raw/）：${maskedErr}`,
    budgetTriggerLabel: (trigger) =>
      ({ total: "總量", reasoning: "推理累積", reasoning_round: "推理單輪尖峰" })[trigger],
    anomalySpikeFlag: () => "⚠ 異常尖峰・",
    noneLabel: () => "無",
    outsideAllowlistSection: (section) => `「${section}」節`,
    outsideAllowlistNoSection: () => "章節外",
    outsideAllowlistSuffixNote: (suffixOf) => `；疑似 ${suffixOf} 的縮寫`,
    outsideAllowlistEntry: (path, detail) => `${path}（${detail}）`,
    unknownUsageKeysWarning: (provider, keys) => `⚠ 未知 usage 欄位：${provider} ${keys}`,
    zeroSourceReadWarning: (n) => `⚠ 零原始碼讀取（允許 ${n} 檔）`,
    toolCallStats: (total, allowed, rejected) => `工具呼叫:${total}（允許 ${allowed}／拒絕 ${rejected}）`,
    closingLineCell: (passFail) => `收尾句:${passFail}`,
    observationCountCell: (display) => `觀察:${display}`,
    cannotCountObservations: () => "無法計數",
    outsideAllowlistCell: (detail) => `清單外引用:${detail}`,
    cannotVerifySectionCell: (passFail) => `無法驗證欄:${passFail}`,
    suspectPhrasesCell: (detail) => `疑似禁止內容:${detail}`,
    auditUnavailable: () => "(無法稽核)",
    summaryHeader: (ticketId) => `# dispatch summary — ${ticketId}

| agent | provider | api | model(請求) | model(回傳) | effort | store | status | 耗時 | token | 估算成本 | 稽核 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,

    providersBundled: (formatVersion) => `出貨（formatVersion ${formatVersion}）`,
    providersExplicit: (path, formatVersion) => `外部檔 ${path}（formatVersion ${formatVersion}）`,
    gitignoreNotIgnored: (outDir) => `  ⚠ 輸出目錄 ${outDir} 未被輸出目錄所在的 git repo 忽略`,
    gitignoreUnknown: (outDir) =>
      `  ℹ 無法判定輸出目錄 ${outDir} 是否被 .gitignore 涵蓋（非 git repo 或 git 不可用）`,
    aboutToDispatch: (ticketId) => `即將派工 ${ticketId}：`,
    initialPromptEstimate: (totalEst, maxTokens) =>
      `  初始 prompt 估算 ${totalEst} tokens（僅 system prompt＋首則訊息，不含工單與允許清單；本閘門的估算上限 ${maxTokens}）`,
    allowlistTotalEstimate: (tokens, files) => `  允許清單總量估算 ${tokens} tokens（${files} 檔）`,
    allowlistEstimateCaveat: () => "    └ 上限估計，不去重；實測程式碼素材約 3.5 字元／token，實際消耗通常遠低於此數",
    sequentialReadAmplification: (n) =>
      `  逐個讀的順序放大量 ${n} tokens（清單內容被重送的總量；此為逐個讀假設下的上限，批次讀的廠牌不適用）`,
    sequentialReadCanReduce: (n, pct) => `    └ ⚠ 大檔排清單最後可降至 ${n}（本項省 ${pct}%）`,
    sequentialReadNearOptimal: (pct) => `    └ 目前順序已接近最佳（重排最多再省 ${pct}%）`,
    sequentialReadCostNote: () => "      本項不含初始 prompt 與工單（不受排序影響），故總成本的節省比例低於此數",
    worstCaseTotal: (n) => `  最壞總消耗 ≈ ${n} tokens（各 spoke 之 cap 加總）`,
    concurrencyLine: (n) => `  並行度 ${n}`,
    tpmPeakLine: (provider, limit, peak) => `  ${provider} tpmLimit ${limit}，靜態估算峰值 ${peak}`,
    tpmPeakCaveat: () => "    └ 僅為靜態指標，不預測執行中的 TPM 曲線（429 等待會改變實際並行數）",
    allowedReadsSummary: (n, outDir) => `  允許讀取 ${n} 個檔案，輸出至 ${outDir}/`,

    lensClosingLineZh: (agent) => `ℹ ${agent} 的 lens 收尾句符合中文版固定收尾句`,
    lensClosingLineEn: (agent) => `ℹ ${agent} 的 lens 收尾句符合英文版固定收尾句`,
    modelPricing: (input, output, cachedSuffix, asOfSuffix) =>
      `    └ 單價 每 M token：input $${input}／output $${output}${cachedSuffix}${asOfSuffix}`,
    modelPricingCachedSuffix: (cached) => `／cached input $${cached}`,
    modelPricingAsOfSuffix: (asOf) => `；價目查證日 ${asOf}`,
    modelPricingMissing: (model) => `    └ ⚠ providers.json 沒有 "${model}" 的價目，本型號無法估算成本`,

    rawIntegrityCheckFailed: (msg) => `raw 完整性檢查失敗（實作缺陷，不重試）：${msg}`,
    rateLimitRetriesExceeded: (n) => `429 撞牆次數超過 --rate-limit-retries (${n})`,
    rateLimitWaitExceeded: (s, cap) => `429 要求等待 ${s}s，超過 --max-rate-wait ${cap}s`,
    usageUnavailableRound: (n) => `round ${n}: usage 不可用（usageMissing），保守收束`,
    finalizeToolCallIgnored: (n) => `round ${n}: 收束呼叫仍回傳 tool call，忽略`,

    responsesAdapterCallFailed: () => "responses adapter 呼叫失敗",

    gateOneExceeded: (total, maxTokens, detail) =>
      `閘門一超限：合計初始估算 ${total} tokens 超過 --max-tokens ${maxTokens}\n${detail}`,
    rawIntegrityNotArray: () =>
      "raw 完整性檢查失敗：assistant turn 的 raw 不是陣列（responses adapter 預期 raw 為上一輪 response.output 陣列）",
    rawIntegrityItemNotFound: (type) =>
      `raw 完整性檢查失敗：assistant turn 有一個 item（type=${type}）未以原樣出現在送出的請求中，疑似續接時被過濾掉`,
    rawIntegrityObjectNotFound: () =>
      "raw 完整性檢查失敗：assistant turn 的 raw 未以原樣出現在送出的 contents 中，疑似續接時被重建或漏帶",

    doctorHeader: (cmd) => `${cmd} doctor`,
    doctorConfigDirLine: (value) => `  設定目錄    ${value}`,
    doctorConfigDirSourceDispatchHome: (dir) => `${dir}（來源：DISPATCH_HOME）`,
    doctorConfigDirSourceXdgConfigHome: (dir) => `${dir}（來源：XDG_CONFIG_HOME）`,
    doctorConfigDirSourceDefault: (dir) => `${dir}（來源：預設；DISPATCH_HOME 與 XDG_CONFIG_HOME 都沒設）`,
    doctorConfigDirUnresolved: () => "無法解析（沒有 HOME）",
    doctorEnvLine: (value) => `  .env        ${value}`,
    doctorEnvPresentValue: () => "有（不讀內容）",
    doctorEnvMissingValue: (path) => `沒有：${path}`,
    doctorEnvUnresolvedValue: () => "無法判定（設定目錄無法解析）",
    doctorApiKeyLine: (value) => `  API key     ${value}（只看有沒有值，不看內容）`,
    doctorProviderCountItem: (name, count) => `${name} ${count} 個`,
    doctorModelListLine: (value) => `  型號白名單  ${value}`,
    doctorModelListValue: (formatVersion, items) => `providers.json formatVersion ${formatVersion}：${items}`,
    doctorModelListLoadFailedValue: (reason) => `無法載入：${reason}`,
    doctorLensLine: (value) => `  lens 定義   ${value}`,
    doctorLensFoundValue: (dirPath, count, names) => `${dirPath} 找到 ${count} 支：${names}`,
    doctorLensDirMissingValue: (dirPath) => `目錄不存在：${dirPath}`,
    doctorFooter: () => "本指令不呼叫任何 API，不會花錢。缺的項目怎麼補，見 README 的〈API keys〉一節。",
  },
  en: {
    unknownOption: (arg, helpText) => `Unknown option: ${arg}\n\n${helpText}`,
    missingProviders: (path) => `providers.json not found: ${path}`,
    dryRunNotice: () => "--dry-run: parsed, validated, estimated, and reported only; no API calls were made.",

    helpText: (cmd) => `Usage: ${cmd} <ticket-dir> [options]

  --lang <en|zh-tw>        Language for CLI output and spoke prompts, default en
  --repo-root <dir>        Root for the allowlist boundary and .claude/agents, default cwd
  --providers <path>       Replace the bundled providers.json entirely
  --json                   stdout prints only the result JSON; all other output goes to stderr
  --out <dir>              Output directory, default tmp/spoke/
  --concurrency <n>        Number of spokes to run concurrently, default 2
  --max-tokens <n>         Pre-call estimation gate (sum of each spoke's initial prompt), default 200000
  --max-spoke-tokens <n>   Per-spoke runtime cumulative cap (actual usage), default 400000
  --timeout <sec>          Timeout for a single API call (not the whole spoke), default 600
  --retries <n>            Retries per round (transient errors only), default 2
  --chars-per-token <n>    Gate-one estimation coefficient, default 1.0 (overridable per provider in providers.json)
  --max-spoke-reasoning-tokens <n>  Per-spoke cumulative reasoning-token cap, default 50000
  --max-round-reasoning-tokens <n>  Per-round reasoning-token cap, default null (no check)
  --rate-limit-retries <n> Retries dedicated to 429s, default 5 (not counted in --retries)
  --max-rate-wait <sec>    Max wait for a single 429, default 30
  --max-tool-calls <n>     Per-spoke read_file call cap, default 30
  --dry-run                Parse, validate, estimate, and print the report only; no API calls
  --yes                    Skip the dispatch confirmation. Aborts in non-interactive environments (stdin not a TTY) unless given
  --doctor                 Print the configuration self-check (no API call, no cost) and exit (exit 0)
  --help, -h               Print this help and exit (exit 0)
  --version, -V            Print the version and exit (exit 0)`,
    availableLangValues: () => "en, zh-tw, zh",
    availableValuesSuffix: (values) => ` (available: ${values})`,
    numberFlagInvalid: (name, value) => `--${name} requires a number, got: ${value}`,
    missingFlagValue: (name, suffix) => `--${name} is missing a value${suffix}`,
    tooManyArgs: (arg, ticketDir, helpText) =>
      `Unexpected extra argument: ${arg} (ticket directory is already "${ticketDir}")\n\n${helpText}`,
    invalidLangFlag: (value, availableSuffix, envNote) =>
      `--lang value is invalid: ${value}${availableSuffix}${envNote}`,
    invalidEnvAlsoNote: (envValue) => `; DISPATCH_LANG is also currently invalid: ${envValue}`,
    invalidEnvLang: (value, availableSuffix) =>
      `Environment variable DISPATCH_LANG is invalid: ${value}${availableSuffix}`,

    noPricingData: () => "No pricing data",
    eventSpokeStart: (agent, provider, model) => `[${agent}] started → ${provider}/${model}`,
    eventUnknownUsageKeys: (agent, round, keys) => `[${agent}] ⚠ round ${round} has unknown usage field(s): ${keys}`,
    eventToolCall: (agent, path, allowed, reason) =>
      `[${agent}] read_file(${path}) ${allowed ? "allowed" : `rejected(${reason})`}`,
    eventRateLimitWait: (agent, seconds, source) => `[${agent}] 429, waiting ${seconds}s (source: ${source})`,
    eventRoundError: (agent, round, status, message) =>
      `[${agent}] ⚠ round ${round} error status=${status}: ${message}`,
    eventSpokeEnd: (agent, status, latencyMs, totalTokens, costLabel, budgetSuffix) =>
      `[${agent}] finished status=${status} latency=${latencyMs}ms totalTokens=${totalTokens} cost=${costLabel}${budgetSuffix}`,

    apiKeyMissing: (provider) => `Internal error: missing API key for ${provider}`,
    confirmPrompt: () => "Continue? [y/N] ",
    cancelledInteractive: () => "Cancelled; no API calls were made.",
    cancelledNonInteractive: () =>
      "Non-interactive environment (stdin is not a TTY); nobody could confirm. Cancelled; no API calls were made. To dispatch in this environment, pass --yes explicitly.",
    outDirNotWritable: (outDir) => `Output directory is not writable: ${outDir}`,
    outDirNotEmptyAbort: (outDir) =>
      `The output directory already holds artifacts. Nothing was dispatched; no API was called: ${outDir}\n` +
      `Those came from a previous run, and overwriting them loses them. Two ways forward:\n` +
      `  1. Pick a ticket-id you have not used and dispatch under that (recommended; it costs nothing)\n` +
      `  2. Have the user clear that directory themselves, then rerun — that call is theirs, not yours\n` +
      `  * If the previous run ended in failure (all failed, zero tokens), nothing under there was\n` +
      `    paid for — a new id or the user clearing it are both fine, but it is still their call to clear`,
    outDirNotEmptyDryRunWarning: (outDir) =>
      `⚠ The output directory already holds artifacts: ${outDir}\n  The dry run is unaffected, but the real run will be stopped. Pick a different ticket-id.`,
    outDirWritten: (outDir) => `Files written to: ${outDir}/`,
    outDirFallbackStderr: () => "Output directory is not writable; the full report was printed to stderr instead:",
    stdoutSummaryLine: (agent, status, model, tokens, costLabel, latencyMs) =>
      `${agent}: ${status}  model=${model}  token=${tokens}  cost=${costLabel}  elapsed=${latencyMs}ms`,

    formatMarkerMismatch: (marker, got) => `_dispatch.md's first line must be ${marker}, got: ${got}`,
    blankPlaceholder: () => "(blank)",
    dispatchTableMissingHeader: () => "_dispatch.md: dispatch table not found (missing | agent | ... | header or separator row)",
    dispatchRowMissingFields: (n, line) =>
      `_dispatch.md line ${n} is missing required field(s) agent/provider/model (blank or "default" counts as missing): ${line}`,
    duplicateAgentInDispatchTable: (agent, n) =>
      `Duplicate agent in _dispatch.md: "${agent}" appears ${n} times. Nothing was dispatched; no API was called.\n` +
      `One agent gets one row per _dispatch.md. Two rows with the same name dispatch both spokes and bill for both,\n` +
      `while ${agent}.md and raw/${agent}.* are overwritten by whichever finishes last — which one survives is not\n` +
      `under your control.\n` +
      `To run one lens across several models, split it into separate ticket directories\n` +
      `(for example <ticket-id>-luna and <ticket-id>-ds) and dispatch each once.`,
    dispatchTableEmpty: () => "_dispatch.md's dispatch table has no data rows",
    strayHeadingsCutReviewSection: (strayNames) =>
      `_shared.md's "# Under review" heading exists but its content is empty — it was cut off by these ` +
      `\`#\` headings that follow: ${strayNames.map((s) => `"# ${s}"`).join(", ")}. ` +
      `The ticket splits into sections by \`#\`; if an embedded plan document itself has \`#\` headings, ` +
      `demote them to \`##\`. ` +
      `(Note: adding a line of text right under "# Under review" will pass this check, but the plan body ` +
      `still lives in the section after it — the spoke's review section would effectively be empty.)`,
    missingReviewSection: () =>
      '_shared.md is missing "# Under review" (or "# 待審段落" in a Chinese-language ticket) or its content is empty',
    missingQuestionsSection: () =>
      '<agent>.md is missing "# Questions" (or "# 具體問題" in a Chinese-language ticket) or its content is empty',
    fileNotFound: (path) => `Not found: ${path}`,
    agentFileNotFound: (agentPath, agent) => `Not found: ${agentPath} (_dispatch.md lists agent "${agent}")`,

    agentDefNotFound: (path, agent) => `Agent definition file not found: ${path} (_dispatch.md lists "${agent}")`,
    providerUndefinedInRow: (agent, provider) =>
      `_dispatch.md's "${agent}" row references provider "${provider}", which is not defined in providers.json`,
    missingEnvVar: (envName, agent, provider) =>
      `Missing environment variable ${envName} (the "${agent}" row requires provider "${provider}")`,
    modelNotWhitelisted: (agent, model, provider, list) =>
      `The "${agent}" row's model "${model}" is not in provider "${provider}"'s models whitelist (allowed: ${list})`,
    effortNotAllowed: (agent, effort, provider, list) =>
      `The "${agent}" row's effort "${effort}" is not in provider "${provider}"'s allowed range (allowed: ${list})`,
    emptyAllowedNote: () => "(empty — not yet verified, any value is rejected)",
    effortBlankNoDefault: (agent, provider) =>
      `The "${agent}" row's effort is blank, but provider "${provider}" has no reasoning.default set ` +
      `(empty allowed = not yet verified; this provider is unavailable)`,
    internalErrorTicketContentMissing: (agent) => `Internal error: ticket content for "${agent}" not found`,
    allowedReadsUnderDocs: (agent, rel) =>
      `The "${agent}" allowed-reads list points into _docs/ (a spoke-restricted area): ${rel}`,
    allowedReadsPathNotFound: (agent, rel) =>
      `The "${agent}" allowed-reads list points to a path that does not exist: ${rel}`,

    reasoningStyleInvalid: (providerName, style) =>
      `providers.json: ${providerName}.reasoning.style is invalid: "${style}"`,
    reasoningDefaultNotString: (providerName) => `providers.json: ${providerName}.reasoning.default must be a string`,
    reasoningDefaultMissing: (providerName) =>
      `providers.json: ${providerName}.reasoning.default is missing — required when allowed is non-empty, ` +
      `must not fall back to "send no parameter"`,
    reasoningDefaultNotAllowed: (providerName, def, list) =>
      `providers.json: ${providerName}.reasoning.default "${def}" is not in allowed (${list})`,
    emptyList: () => "(empty)",
    positiveNumberRequired: (label, value) => `providers.json: ${label} must be a positive number, got ${value}`,
    pricingNotObject: (providerName) => `providers.json: ${providerName}.pricing is not an object`,
    pricingModelNotObject: (providerName, model) => `providers.json: ${providerName}.pricing.${model} is not an object`,
    providerConfigNotObject: (name) => `providers.json: the configuration for provider "${name}" is not an object`,
    providerApiInvalid: (name, value) =>
      `providers.json: ${name}.api is missing or invalid (must be "responses", "gemini-native", or "anthropic-messages"), got ${value}`,
    providerStoreTrue: (name) =>
      `providers.json: ${name}.store is true, which violates design principle 6 (zero retention). ` +
      `Aborting on load; server-side state must not be relied upon.`,
    providerBaseUrlMissing: (name) => `providers.json: ${name}.baseURL is missing`,
    providerCharsPerTokenInvalid: (name) => `providers.json: ${name}.charsPerToken must be a positive number`,
    providersFileNotObject: () => "providers.json format is not an object",
    providersFormatVersionMismatch: (want, got) =>
      `providers.json: formatVersion mismatch (expected ${want}, got ${got}). ` +
      `This usually means --providers points to an old or incompatible file.`,
    providersFileInvalidJson: (msg) => `providers.json is not valid JSON: ${msg}`,
    providerUndefined: (name) => `providers.json does not define provider "${name}"`,

    runLogWriteFailed: (maskedErr) => `Failed to write run.jsonl: ${maskedErr}`,
    noFullReportAvailable: (status) => `(Full report unavailable; execution status: ${status})`,
    persistTextFailed: (agent, maskedErr) => `Failed to write file (${agent}.md): ${maskedErr}`,
    persistRawFailed: (agent, maskedErr) => `Failed to write file (${agent} raw/): ${maskedErr}`,
    budgetTriggerLabel: (trigger) =>
      ({ total: "total", reasoning: "cumulative reasoning", reasoning_round: "single-round reasoning spike" })[
        trigger
      ],
    anomalySpikeFlag: () => "⚠ anomalous spike - ",
    noneLabel: () => "none",
    outsideAllowlistSection: (section) => `the "${section}" section`,
    outsideAllowlistNoSection: () => "outside any section",
    outsideAllowlistSuffixNote: (suffixOf) => `; possibly an abbreviation of ${suffixOf}`,
    outsideAllowlistEntry: (path, detail) => `${path} (${detail})`,
    unknownUsageKeysWarning: (provider, keys) => `⚠ Unknown usage field(s): ${provider} ${keys}`,
    zeroSourceReadWarning: (n) => `⚠ Zero source reads (allowed ${n} file(s))`,
    toolCallStats: (total, allowed, rejected) => `Tool calls:${total} (allowed ${allowed} / rejected ${rejected})`,
    closingLineCell: (passFail) => `Closing line:${passFail}`,
    observationCountCell: (display) => `Observations:${display}`,
    cannotCountObservations: () => "uncountable",
    outsideAllowlistCell: (detail) => `Citations outside allowlist:${detail}`,
    cannotVerifySectionCell: (passFail) => `Cannot-verify section:${passFail}`,
    suspectPhrasesCell: (detail) => `Suspect phrases:${detail}`,
    auditUnavailable: () => "(audit unavailable)",
    summaryHeader: (ticketId) => `# dispatch summary — ${ticketId}

| agent | provider | api | model(requested) | model(returned) | effort | store | status | latency | token | est. cost | audit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,

    providersBundled: (formatVersion) => `bundled (formatVersion ${formatVersion})`,
    providersExplicit: (path, formatVersion) => `external file ${path} (formatVersion ${formatVersion})`,
    gitignoreNotIgnored: (outDir) => `  ⚠ Output directory ${outDir} is not ignored by the git repo it lives in`,
    gitignoreUnknown: (outDir) =>
      `  ℹ Cannot determine whether output directory ${outDir} is covered by .gitignore (not a git repo, or git unavailable)`,
    aboutToDispatch: (ticketId) => `About to dispatch ${ticketId}:`,
    initialPromptEstimate: (totalEst, maxTokens) =>
      `  Initial prompt estimate ${totalEst} tokens (system prompt + first message only; excludes the ticket and allowlist; this gate's cap is ${maxTokens})`,
    allowlistTotalEstimate: (tokens, files) => `  Allowlist total estimate ${tokens} tokens (${files} file(s))`,
    allowlistEstimateCaveat: () =>
      "    └ Upper-bound estimate, not deduplicated; measured code material is roughly 3.5 chars/token, so actual usage is usually well below this",
    sequentialReadAmplification: (n) =>
      `  Sequential-read order amplification ${n} tokens (total from re-sending list content; an upper bound that assumes sequential reads, and does not apply to providers that batch)`,
    sequentialReadCanReduce: (n, pct) =>
      `    └ ⚠ Sorting large files last could bring this down to ${n} (saves ${pct}% here)`,
    sequentialReadNearOptimal: (pct) =>
      `    └ Current order is already close to optimal (reordering saves at most ${pct}%)`,
    sequentialReadCostNote: () =>
      "      This figure excludes the initial prompt and the ticket (unaffected by ordering), so the total-cost savings are lower than this",
    worstCaseTotal: (n) => `  Worst-case total ≈ ${n} tokens (sum of each spoke's cap)`,
    concurrencyLine: (n) => `  Concurrency ${n}`,
    tpmPeakLine: (provider, limit, peak) => `  ${provider} tpmLimit ${limit}, statically estimated peak ${peak}`,
    tpmPeakCaveat: () =>
      "    └ Static indicator only; does not predict the in-flight TPM curve (429 waits change actual concurrency)",
    allowedReadsSummary: (n, outDir) => `  Allowed reads: ${n} file(s), output to ${outDir}/`,

    lensClosingLineZh: (agent) => `ℹ ${agent}'s lens closing line matches the Chinese fixed closing line`,
    lensClosingLineEn: (agent) => `ℹ ${agent}'s lens closing line matches the English fixed closing line`,
    modelPricing: (input, output, cachedSuffix, asOfSuffix) =>
      `    └ Price per M tokens: input $${input} / output $${output}${cachedSuffix}${asOfSuffix}`,
    modelPricingCachedSuffix: (cached) => ` / cached input $${cached}`,
    modelPricingAsOfSuffix: (asOf) => `; priced as of ${asOf}`,
    modelPricingMissing: (model) =>
      `    └ ⚠ providers.json has no pricing for "${model}"; cost cannot be estimated for it`,

    rawIntegrityCheckFailed: (msg) => `Raw integrity check failed (implementation defect, not retried): ${msg}`,
    rateLimitRetriesExceeded: (n) => `429 retry count exceeded --rate-limit-retries (${n})`,
    rateLimitWaitExceeded: (s, cap) => `429 requested a ${s}s wait, exceeding --max-rate-wait ${cap}s`,
    usageUnavailableRound: (n) => `round ${n}: usage unavailable (usageMissing), conservatively finalizing`,
    finalizeToolCallIgnored: (n) => `round ${n}: finalize call still returned a tool call; ignored`,

    responsesAdapterCallFailed: () => "responses adapter call failed",

    gateOneExceeded: (total, maxTokens, detail) =>
      `Gate one exceeded: total initial estimate ${total} tokens exceeds --max-tokens ${maxTokens}\n${detail}`,
    rawIntegrityNotArray: () =>
      "Raw integrity check failed: assistant turn's raw is not an array (the responses adapter expects raw to be the prior round's response.output array)",
    rawIntegrityItemNotFound: (type) =>
      `Raw integrity check failed: an assistant-turn item (type=${type}) was not found verbatim in the outgoing request — possibly filtered out during continuation`,
    rawIntegrityObjectNotFound: () =>
      "Raw integrity check failed: assistant turn's raw was not found verbatim in the outgoing contents — possibly rebuilt or dropped during continuation",

    doctorHeader: (cmd) => `${cmd} doctor`,
    doctorConfigDirLine: (value) => `  Config dir   ${value}`,
    doctorConfigDirSourceDispatchHome: (dir) => `${dir} (source: DISPATCH_HOME)`,
    doctorConfigDirSourceXdgConfigHome: (dir) => `${dir} (source: XDG_CONFIG_HOME)`,
    doctorConfigDirSourceDefault: (dir) =>
      `${dir} (source: default; neither DISPATCH_HOME nor XDG_CONFIG_HOME is set)`,
    doctorConfigDirUnresolved: () => "could not resolve (no HOME)",
    doctorEnvLine: (value) => `  .env         ${value}`,
    doctorEnvPresentValue: () => "present (contents not read)",
    doctorEnvMissingValue: (path) => `not found: ${path}`,
    doctorEnvUnresolvedValue: () => "cannot determine (config directory could not resolve)",
    doctorApiKeyLine: (value) => `  API keys     ${value} (presence only; values are never read)`,
    doctorProviderCountItem: (name, count) => `${name} ${count}`,
    doctorModelListLine: (value) => `  Model list   ${value}`,
    doctorModelListValue: (formatVersion, items) => `providers.json formatVersion ${formatVersion}: ${items}`,
    doctorModelListLoadFailedValue: (reason) => `failed to load: ${reason}`,
    doctorLensLine: (value) => `  Lens defs    ${value}`,
    doctorLensFoundValue: (dirPath, count, names) => `${dirPath} holds ${count}: ${names}`,
    doctorLensDirMissingValue: (dirPath) => `directory not found: ${dirPath}`,
    doctorFooter: () =>
      'This command calls no API and costs nothing. To fill in what is missing, see "API keys" in the README.',
  },
};

export function m<K extends keyof MessageArgs>(lang: Lang, key: K, ...args: MessageArgs[K]): string {
  return MESSAGES[lang][key](...args);
}
