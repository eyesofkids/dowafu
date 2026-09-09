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
  resultsExistAbort: [resultId: string];
  resultsExistDryRunWarning: [resultId: string];
  // D1 之後產物只在 DB，沒有「落檔目錄」這種東西。訊息要講得出「東西在哪、怎麼讀回來」
  // ——`dowafu result <id>` 是唯一的讀回管道（CLI 這條路）。
  resultsSaved: [resultId: string];
  outDirFallbackStderr: [];
  stdoutSummaryLine: [
    agent: string,
    status: string,
    model: string,
    tokens: number,
    costLabel: string,
    latencyMs: number,
  ];
  dbResultPersistenceFailed: [agent: string, maskedErr: string];
  dbSchemaTooNew: [found: number, supported: number];
  approveHelp: [cmd: string];
  resultHelp: [cmd: string];
  resultNotFound: [id: string];
  resultPrefixAmbiguous: [prefix: string, count: number];
  resultCandidate: [shortId: string, ticket: string, status: string];
  approveNoPending: [];
  approveMultiplePending: [count: number];
  approvePrefixAmbiguous: [prefix: string, count: number];
  approvePendingCandidate: [shortId: string, ticket: string, createdAt: string];
  jobNotFound: [jobId: string];
  mcpJobPrefixAmbiguous: [prefix: string, count: number];
  jobNotApprovable: [jobId: string, status: string];
  jobApproved: [jobId: string];
  daemonStarted: [];
  daemonStartFailed: [detail: string];
  daemonWorkerSpawnFailed: [detail: string];
  daemonWorkerExited: [exitCode: number | string];
  daemonWorkerExitedDetail: [exitCode: number | string, detail: string];
  daemonWorkerTerminated: [signal: string];
  daemonWorkerTerminatedDetail: [signal: string, detail: string];
  stopRequiresServe: [];
  daemonStopRunningWarning: [count: number];
  daemonStopConfirmPrompt: [];
  daemonStopCancelled: [];
  daemonStopNotRunning: [reason: string];
  daemonStopPidNotDowafu: [pid: number];
  daemonStopSignalFailed: [pid: number];
  daemonStopSucceeded: [pid: number];
  daemonStopRestarted: [pid: number];
  doctorDaemonLine: [value: string];
  doctorDaemonAlive: [pid: number];
  doctorDaemonMissing: [reason: string];
  daemonOfflineWarning: [reason: string];
  mcpTicketsEmpty: [];
  mcpTicketsTitle: [];
  mcpTicketsRow: [ticket: string, spokeCount: number];
  mcpTicketsSpoke: [agent: string, provider: string, model: string, allowCount: number];
  mcpKeysTitle: [];
  mcpKeysRow: [provider: string, status: string];
  mcpEnabledModelsTitle: [];
  mcpEnabledModelRow: [provider: string, model: string];
  mcpSubmitQueued: [jobId: string];
  mcpSubmitInvalidLang: [value: string, available: string];
  mcpPriorResultsReminder: [runs: number];
  mcpApproveCommand: [command: string];
  mcpJobStarted: [at: string];
  mcpJobFinished: [at: string];
  mcpJobError: [detail: string];
  // B（gaps #6）：running 期間的兩則。progress 回答「有在往前走嗎」，
  // stalled 回答「worker 還活著嗎」——兩個不同的問題，不要合成一句。
  mcpJobProgress: [agent: string, lastRound: number, tokensIn: number, tokensOut: number, lastAt: string];
  mcpJobNoProgressYet: [];
  mcpJobHeartbeatStale: [seconds: number];
  // 工單 status-stdin §A-3：completed／failed 的 job 對「三支死一支」不加區分——只印
  // job 本身的終態，看不出哪幾支付了錢卻沒拿到東西。failedAgentsSuffix 由呼叫端組好
  // （組裝原則：MESSAGES 內不互相呼叫 m()），全部成功時傳空字串，不附加任何後綴。
  mcpJobOutcome: [succeeded: number, failed: number, failedAgentsSuffix: string];
  mcpJobFailedAgentsSuffix: [agents: string];
  mcpResultPending: [jobId: string, status: string];
  mcpResultComplete: [jobId: string];
  mcpResultEmpty: [];

  // 工單 approve-tool §A：dispatch_approve 這個 MCP tool 專用的訊息。金額必須顯式帶在
  // 訊息裡（不是只講「金額不符」）——使用者的同意基於「這次最壞多少錢」，見工單 §零之一。
  mcpApproveAmountMismatch: [jobId: string, providedUsd: string, expectedUsd: string];
  mcpApproveNoPricing: [jobId: string];

  // 工單 C：daemon.ts serve() 的 HTTP binding 啟動訊息，與 src/api-token.ts 的
  // `token issue/list/revoke` CLI 輸出。HTTP 傳輸層本身（404/405/401/406/413/429 等
  // wire-level 回應）比照 protocol.ts 既有慣例不進這裡——那些是協定層錯誤，不是 A 類。
  httpServerStarted: [port: number];
  httpNoTokensWarning: [];
  tokenHelp: [cmd: string];
  tokenIssued: [id: string, plaintext: string];
  tokenListEmpty: [];
  tokenListRow: [id: string, label: string, createdAt: string, revoked: boolean];
  tokenRevoked: [id: string];
  tokenNotFoundOrRevoked: [id: string];

  // 工單 key-db（E12）：`dowafu key`（互動）／`key list`／`key rm`／`key test`。
  // 貼上的明文本身從不進這裡（本檔的函式本體不得經手未遮蔽字串，見檔頭「遮蔽邊界」）。
  keyHelp: [cmd: string];
  keyInteractiveRequiresTty: [];
  keyMenuHeader: [];
  keyMenuRow: [num: number, providerPadded: string, status: string];
  keyMenuPrompt: [max: number];
  keyMenuInvalidChoice: [];
  keyMenuQuit: [];
  keyPastePrompt: [provider: string];
  keyPasteEmpty: [];
  keySavedTail: [tail: string];
  keyVerifyPrompt: [provider: string];
  keyListRow: [provider: string, status: string];
  keyRemoved: [provider: string];
  keyRemovedNotFound: [provider: string];
  keyUnknownProvider: [provider: string, list: string];
  keyStatusDb: [tail: string, date: string];
  keyStatusMissing: [];
  keyStatusUntested: [];
  keyStatusTestSucceeded: [model: string, at: string];
  keyStatusTestFailed: [model: string, at: string];
  keyTestHelp: [cmd: string];
  keyTestKeyMissing: [provider: string];
  keyTestNoEnabledModel: [provider: string];
  keyTestCostWarning: [provider: string];
  keyTestConfirmPrompt: [];
  keyTestCancelled: [];
  keyTestSucceeded: [provider: string, model: string];
  keyTestFailed: [provider: string, detail: string];

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
  ticketNotFound: [name: string];
  ticketCorrupt: [name: string];
  ticketNameInvalid: [name: string];
  ticketAlreadyExists: [name: string];
  ticketSpokeNotFound: [name: string, agent: string];
  ticketShowHeader: [name: string];
  ticketEstimateTokens: [tokens: number];
  ticketCompletedRuns: [runs: number, total: string, last: string];
  ticketCompletedRunsNoPricing: [runs: number, last: string];
  ticketHelp: [cmd: string];
  // 工單 status-stdin §B：create／add-spoke 的 <shared-file>／<body-file> 用 "-" 代表從
  // stdin 讀本文。stdin 是互動式終端機（沒有東西被導進來）時必須講人話並中止，不得掛住
  // 等輸入。
  ticketStdinRequiresPipe: [];

  // T4：validate.ts——resolveSpokes／readAgentBody
  agentDefNotFound: [path: string, agent: string];
  providerUndefinedInRow: [agent: string, provider: string];
  apiKeyNotConfigured: [agent: string, provider: string, cmd: string];
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
  providerModelsRequired: [name: string];
  pricingModelNotWhitelisted: [providerName: string, model: string];
  providersDbCorrupt: [name: string];
  modelDisabled: [model: string, cmd: string];
  providerModelNotFound: [model: string];
  providerModelAmbiguous: [model: string, providers: string];
  providersHelp: [cmd: string];
  providersListEmpty: [];
  providersListRow: [provider: string, model: string, input: string, output: string, enabled: boolean];
  providersImported: [path: string];
  providersSeeded: [path: string];
  providersDbEmpty: [cmd: string];
  providersEnabled: [model: string];
  providersDisabled: [model: string];
  providersFileNotObject: [];
  providersFormatVersionMismatch: [want: number, got: string];
  providersFileInvalidJson: [msg: string];
  providerUndefined: [name: string];

  // T5：output.ts——persistSpokeResult／writeSpokeText／buildSummaryMarkdown
  // 家族。四則「消費者是 spoke」的訊息（runner.ts 200KB 截斷、--max-tool-calls 上限、
  // whitelist.ts 的 ALLOWLIST_REJECT_MESSAGE、三支 adapter 的 read_file description）不在
  // 此列——i18n_classification_t2.md §三：歸 C 類，改建雙語常數由 spoke.lang 直接選用，
  // 見各自所在檔案。
  noFullReportAvailable: [status: string];
  persistTextFailed: [agent: string, maskedErr: string];
  persistRawFailed: [agent: string, maskedErr: string];
  budgetTriggerLabel: [trigger: BudgetTrigger];
  anomalySpikeFlag: [];
  noneLabel: [];
  unknownUsageKeysWarning: [provider: string, keys: string];
  zeroSourceReadWarning: [n: number];
  // 工單 status-stdin §A-2：provider 自己回報的截斷（finishReason，如 incomplete／
  // MAX_TOKENS／max_tokens），與我們自己的 truncated:budget 預算截斷（formatStatusCell）
  // 分開顯示——只在有東西可講（provider 明確給了非 stop 的原因）時才印，正常結束不印。
  finishReasonWarningCell: [reason: string];
  toolCallStats: [total: number, allowed: number, rejected: number];
  closingLineCell: [passFail: string];
  observationCountCell: [display: string];
  cannotCountObservations: [];
  cannotVerifySectionCell: [passFail: string];
  // 工單 report-format §三 B：佔位符是交付前需清理的稽核失敗，不改 job status。
  templatePlaceholdersPassCell: [];
  templatePlaceholdersFailCell: [count: number];
  auditUnavailable: [];
  summaryHeader: [ticketId: string];

  // T5：report.ts——buildReport
  providersDatabase: [];
  // 2026-08-15：待審段落非空、但另有可疑頂層章節——切在段落中間的形態。中止路徑的
  // strayHeadingsCutReviewSection 只涵蓋「整段被切光」，這一則是警告不是錯誤。
  strayHeadingsWarning: [reviewChars: number, strayNames: string[]];
  gitignoreNotIgnored: [dbPath: string];
  gitignoreUnknown: [dbPath: string];
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
  allowedReadsSummary: [n: number];
  allowedReadsListEntry: [path: string];
  allowedReadsListFolded: [n: number];
  allowedReadsListEmpty: [];

  // T7a〈B. 乾跑提示〉：lens 收尾句落在哪一個 FIXED_CLOSING_LINE*，乾跑與實跑都印，只提示不擋。
  // 沒有收尾句的 lens（如 explore-haiku.md）不在此列——那種情況不印任何東西，見 report.ts
  // 的 formatLensClosingLineNotice。
  lensClosingLineZh: [agent: string];
  lensClosingLineEn: [agent: string];
  modelPricing: [inputPerM: number, outputPerM: number, cachedSuffix: string, asOfSuffix: string];
  modelPricingCachedSuffix: [cachedInputPerM: number];
  modelPricingAsOfSuffix: [asOf: string];
  modelPricingMissing: [model: string];

  // 票 cost-cap §C：付費前摘要要印金額，report.ts 與 ticket-store.ts 的 formatTicket 共用。
  // hardCapLine：只印硬上限（新工單、或無法算出「典型」時）。hardCapWithTypicalLine：
  // 過去有 completed 的重跑資料時，典型與硬上限一起印（僅 ticket-store.ts 使用）。
  // hardCapMissingPricing：硬上限本身因缺價目資料而算不出來時的替代訊息，不印 $0。
  hardCapLine: [hardCapUsd: string];
  hardCapWithTypicalLine: [typicalUsd: string, runs: number, hardCapUsd: string];
  hardCapMissingPricing: [];

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
  // A（gaps #1／#2）：doctor 現在也印 DB 檔在哪——金鑰／工單／結果全在那個檔裡，
  // 而先前整份報表從頭到尾沒印過它。
  doctorDbLine: [path: string];
  doctorEnvLine: [value: string];
  doctorEnvPresentValue: [];
  // 工單 key-db §B-3 #6：doctor 逐 provider 印出實際生效的是哪一層（DB／env／未設定），
  // 不再只印 process.env 的 ✓／✗——後者看不出「DB 改了卻沒生效，因為 env 還躺著舊值」。
  doctorApiKeyLine: [value: string];
  doctorApiKeyRow: [provider: string, status: string];
  doctorApiKeySourceDb: [tail: string, date: string];
  doctorApiKeySourceMissing: [];
  doctorProviderCountItem: [name: string, count: number];
  doctorModelListLine: [value: string];
  doctorModelListValue: [enabled: number, total: number, mostExpensive: string];
  doctorModelListLoadFailedValue: [reason: string];
  doctorLensLine: [value: string];
  // 工單 X1 v1.1 §三：三段式（總數／有收尾句清單／無收尾句一段，命中才附加）取代舊版
  // 「只算 hole-finder 開頭」的單段式。
  doctorLensFoundValue: [dirPath: string, total: number, closingCount: number, closingNames: string, noClosingSuffix: string];
  doctorLensNoClosingSuffix: [count: number, names: string];
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

    helpText: (cmd) => `用法：${cmd} <ticket-id> [options]

子指令（各自有自己的 --help／用法訊息）：
  ${cmd} ticket ...        建立、匯入、檢視工單
  ${cmd} result <id>       印出一次派工的結果（各 spoke 原文與稽核表）
  ${cmd} key               設定 provider API key（互動選單）
  ${cmd} providers ...     型號白名單與啟用狀態
  ${cmd} token ...         入站 HTTP 憑證的發／列／撤銷
  ${cmd} approve [jobId]   核准佇列中等待的派工
  ${cmd} serve             啟動常駐 daemon（含 MCP 的 HTTP binding）
  ${cmd} serve --stop [--yes] 停止常駐 daemon；有執行中的 job 時會先確認
  ${cmd} mcp               以 stdio 提供 MCP server

  --lang <en|zh-tw>        CLI 輸出與 spoke prompt 的語言，預設 en
  --repo-root <dir>        白名單邊界與 .claude/agents 的根，預設 cwd
  --db <path>              SQLite 工單與產物資料庫，預設 DISPATCH_HOME/dowafu.db
  --http-port <port>       serve 模式的 HTTP binding 埠，僅綁 127.0.0.1，預設 7391
  --json                   stdout 只印結果 JSON，其餘輸出改走 stderr
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
  --max-tool-calls <n>     單一 spoke 的 read_file 呼叫上限，預設 20
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
    resultsExistAbort: (resultId) =>
      `這個 id 已經有派工結果，未派工、未呼叫任何 API：${resultId}\n` +
      `那是上一次跑出來的東西，覆蓋掉就沒了。先看它：dowafu result ${resultId}\n` +
      `兩條路：\n` +
      `  1. 換一個沒用過的 ticket-id 再派（建議，零成本）\n` +
      `  2. 由使用者自行把那筆結果從資料庫刪掉之後重跑——這是他的決定，不是你的\n` +
      `  * 上一次若是失敗收場（全部 failed、token 0），那筆沒有花過錢的東西，\n` +
      `    換 id 或請使用者刪掉都行——但仍然由使用者決定要不要刪`,
    resultsExistDryRunWarning: (resultId) =>
      `⚠ 這個 id 已經有派工結果：${resultId}\n  乾跑不受影響，但實跑會被擋下。換一個 ticket-id 即可；要先看上一次的結果用 dowafu result ${resultId}。`,
    resultsSaved: (resultId) => `結果已存入資料庫。讀回來：dowafu result ${resultId}`,
    outDirFallbackStderr: () => "落檔目錄不可寫，完整報告已改印於 stderr：",
    stdoutSummaryLine: (agent, status, model, tokens, costLabel, latencyMs) =>
      `${agent}: ${status}  model=${model}  token=${tokens}  cost=${costLabel}  耗時=${latencyMs}ms`,
    dbResultPersistenceFailed: (agent, maskedErr) => `DB 結果寫入失敗（${agent}）：${maskedErr}`,
    dbSchemaTooNew: (found, supported) =>
      `這個資料庫是較新版本的 dowafu 建立的（schema 版本 ${found}，本版最高支援 ${supported}）。請升級 dowafu，不要用舊版開啟它。`,
    approveHelp: (cmd) => `用法：${cmd} approve [jobId 前綴] [--db <path>]`,
    resultHelp: (cmd) => `用法：${cmd} result <ticket-id 或 jobId／前綴> [--db <path>]`,
    resultNotFound: (id) => `找不到 "${id}" 的結果。派工尚未完成，或該 ticket-id／jobId 不存在。`,
    resultPrefixAmbiguous: (prefix, count) => `前綴 ${prefix} 命中 ${count} 張 job；請提供更長的 id。`,
    resultCandidate: (shortId, ticket, status) => `  ${shortId}  ${ticket}  ${status}`,
    approveNoPending: () => "目前沒有待核准的 job。",
    approveMultiplePending: (count) => `有 ${count} 張待核准 job；請指定其中一個短 id。`,
    approvePrefixAmbiguous: (prefix, count) => `前綴 ${prefix} 命中 ${count} 張 job；請提供更長的 id。`,
    approvePendingCandidate: (shortId, ticket, createdAt) => `  ${shortId}  ${ticket}  ${createdAt}`,
    jobNotFound: (jobId) => `找不到 job：${jobId}`,
    mcpJobPrefixAmbiguous: (prefix, count) => `前綴 ${prefix} 命中 ${count} 個 job，請改用完整 id：`,
    jobNotApprovable: (jobId, status) => `job ${jobId} 目前是 ${status}，不能核准`,
    jobApproved: (jobId) => `已核准 job：${jobId}`,
    daemonStarted: () => "daemon 已啟動。收到 SIGINT 時會乾淨退出；進行中的 job 下次啟動會被回收。",
    daemonStartFailed: (detail) => `daemon 無法啟動：${detail}`,
    daemonWorkerSpawnFailed: (detail) => `worker 無法啟動：${detail}`,
    daemonWorkerExited: (exitCode) => `worker 以 exit code ${exitCode} 結束`,
    daemonWorkerExitedDetail: (exitCode, detail) => `worker 以 exit code ${exitCode} 結束：${detail}`,
    daemonWorkerTerminated: (signal) => `worker 被訊號 ${signal} 終止`,
    daemonWorkerTerminatedDetail: (signal, detail) => `worker 被訊號 ${signal} 終止：${detail}`,
    stopRequiresServe: () => "--stop 只能與 serve 一起使用。",
    daemonStopRunningWarning: (count) => `目前有 ${count} 張 job 正在執行；停止 daemon 不會停止正在跑的 spoke，它們會繼續跑完，之後結果與 API 成本仍會被認列。`,
    daemonStopConfirmPrompt: () => "確定要停止 daemon 嗎？[y/N] ",
    daemonStopCancelled: () => "已取消，daemon 仍在執行。",
    daemonStopNotRunning: (reason) => `daemon 未在執行（${reason}）。`,
    daemonStopPidNotDowafu: (pid) => `pid ${pid} 的行程不是 dowafu，為避免誤殺未送出訊號。`,
    daemonStopSignalFailed: (pid) => `已向 pid ${pid} 送出停止訊號，但它沒有停止。`,
    daemonStopSucceeded: (pid) => `daemon（pid ${pid}）已停止。`,
    daemonStopRestarted: (pid) => `daemon（原 pid ${pid}）停止後又恢復運行；看起來有 OS 層服務管理在重拉它。要真的停下來請用 launchctl 或 systemctl。`,
    doctorDaemonLine: (value) => `  daemon      ${value}`,
    doctorDaemonAlive: (pid) => `運行中（pid ${pid}）`,
    doctorDaemonMissing: (reason) => `未運行（${reason}）`,
    daemonOfflineWarning: (reason) => `⚠ worker daemon 未運行（${reason}）；job 已排入但不會執行。請先執行 dowafu serve。`,
    mcpTicketsEmpty: () => "沒有可派的 DB 工單。",
    mcpTicketsTitle: () => "可派工單：",
    mcpTicketsRow: (ticket, spokeCount) => `- ${ticket}：${spokeCount} 個 spoke`,
    mcpTicketsSpoke: (agent, provider, model, allowCount) =>
      `  ${agent}：${provider}/${model}；允許清單檔 ${allowCount} 個`,
    mcpKeysTitle: () => "API key 狀態：",
    mcpKeysRow: (provider, status) => `  ${provider}：${status}`,
    mcpEnabledModelsTitle: () => "已啟用型號白名單：",
    mcpEnabledModelRow: (provider, model) => `  ${provider}/${model}`,
    mcpSubmitQueued: (jobId) => `已排入佇列，job id = ${jobId}，狀態 pending_approval。尚未執行，須由人在終端機核准。`,
    mcpSubmitInvalidLang: (value, available) => `dispatch_submit 的 lang 無效：${value}（可用值：${available}）。未建立 job。`,
    mcpPriorResultsReminder: (runs) => `提醒：這張工單已有 ${runs} 次結果；這不是錯誤，仍可照常排入佇列。`,
    mcpApproveCommand: (command) => `請在終端機執行：${command}`,
    mcpJobStarted: (at) => `開始於 ${at}`,
    mcpJobFinished: (at) => `結束於 ${at}`,
    mcpJobError: (detail) => `錯誤：${detail}`,
    mcpJobProgress: (agent, lastRound, tokensIn, tokensOut, lastAt) =>
      `  ${agent}：第 ${lastRound} 輪，累計 in ${tokensIn}／out ${tokensOut} tokens，最後更新 ${lastAt}`,
    mcpJobNoProgressYet: () => "  （還沒有任何一輪完成）",
    mcpJobHeartbeatStale: (seconds) =>
      `⚠ worker 的心跳已經 ${seconds} 秒沒有更新，這支 job 很可能已經死了。` +
      `下一次 daemon 跑 reap 時會把它標成 interrupted；daemon 沒開的話它會一直停在 running。`,
    mcpJobOutcome: (succeeded, failed, failedAgentsSuffix) =>
      `spoke 結果：成功 ${succeeded}／失敗 ${failed}${failedAgentsSuffix}`,
    mcpJobFailedAgentsSuffix: (agents) => `（失敗：${agents}）`,
    mcpResultPending: (jobId, status) => `job ${jobId} 目前是 ${status}，還沒有結果。`,
    mcpResultComplete: (jobId) => `job ${jobId} 結果：`,
    mcpResultEmpty: () => "（沒有儲存的 spoke 結果）",
    mcpApproveAmountMismatch: (jobId, providedUsd, expectedUsd) =>
      `核准遭拒：金額不符。job ${jobId} 的硬上限是 $${expectedUsd}，你給的是 ${providedUsd}。未核准，未呼叫任何 API。`,
    mcpApproveNoPricing: (jobId) => `核准遭拒：job ${jobId} 對應的工單缺少價目資料，無法核對金額，未核准。`,

    httpServerStarted: (port) => `HTTP binding 已啟動：127.0.0.1:${port}/mcp（僅本機，公開交給 tunnel）`,
    httpNoTokensWarning: () =>
      "⚠ 尚未發過任何 token（dowafu token issue）。端點已經活著，但沒有任何請求進得來——不是壞掉，是還沒發 token。",
    tokenHelp: (cmd) => `${cmd} token issue [--label <說明>]\n${cmd} token list\n${cmd} token revoke <id>`,
    tokenIssued: (id, plaintext) =>
      `已發出 token，id = ${id}\n明文（只顯示這一次，之後拿不回來）：${plaintext}`,
    tokenListEmpty: () => "尚未發過任何 token。",
    tokenListRow: (id, label, createdAt, revoked) => `${id}\t${label}\t${createdAt}\t${revoked ? "已撤銷" : "有效"}`,
    tokenRevoked: (id) => `已撤銷 token：${id}`,
    tokenNotFoundOrRevoked: (id) => `找不到 token 或已經撤銷過了：${id}`,

    keyHelp: (cmd) =>
      `${cmd} key                 互動式設定（選單選 provider，貼上 key，不吃命令列參數）\n${cmd} key list            列出各 provider 目前生效的來源（不含明文）\n${cmd} key rm <provider>    移除 DB 那把\n${cmd} key test <provider>  呼叫一次真實 API 驗證這把 key（會花錢）`,
    keyInteractiveRequiresTty: () =>
      "dowafu key 需要互動式終端機（stdin 不是 TTY），不會掛住等輸入、也不會讀管道內容。請在互動式終端機執行 dowafu key 設定 API key。",
    keyMenuHeader: () => "  provider      狀態",
    keyMenuRow: (num, providerPadded, status) => `  ${num}) ${providerPadded} ${status}`,
    keyMenuPrompt: (max) => `選擇要設定的 provider（1-${max}，q 離開）：`,
    keyMenuInvalidChoice: () => "無效的選擇。",
    keyMenuQuit: () => "已離開，未變更任何設定。",
    keyPastePrompt: (provider) => `貼上 ${provider} 的 API key（不會顯示）：`,
    keyPasteEmpty: () => "沒有貼到任何內容，已取消。",
    keySavedTail: (tail) => `✓ 已存入 DB（${tail}）。`,
    keyVerifyPrompt: (provider) => `要現在驗證這把 key 嗎？會呼叫一次 ${provider} 的 API，會花錢（y/N）：`,
    keyListRow: (provider, status) => `${provider}\t${status}`,
    keyRemoved: (provider) => `已從 DB 移除 ${provider} 的 key。`,
    keyRemovedNotFound: (provider) => `DB 沒有 ${provider} 的 key，無需移除。`,
    keyUnknownProvider: (provider, list) => `不認得的 provider：${provider}（已知：${list}）`,
    keyStatusDb: (tail, date) => `✓ 已設定（${tail}，DB，${date}）`,
    keyStatusMissing: () => "✗ 未設定",
    keyStatusUntested: () => "；未測",
    keyStatusTestSucceeded: (model, at) => `；最近驗證成功（${model}，${at}）`,
    keyStatusTestFailed: (model, at) => `；最近驗證失敗（${model}，${at}）`,
    keyTestHelp: (cmd) => `用法：${cmd} key test <provider>`,
    keyTestKeyMissing: (provider) => `${provider} 尚未設定任何 API key（DB／環境變數皆無），先用 \`dowafu key\` 設定。`,
    keyTestNoEnabledModel: (provider) => `${provider} 沒有任何已啟用的型號，無法驗證（見 \`dowafu providers enable\`）。`,
    keyTestCostWarning: (provider) => `即將呼叫一次 ${provider} 的 API 做最小驗證，會花錢。`,
    keyTestConfirmPrompt: () => "確定要繼續嗎？[y/N] ",
    keyTestCancelled: () => "已取消，未呼叫任何 API。",
    keyTestSucceeded: (provider, model) => `✓ ${provider}/${model} 驗證成功，這把 key 可用。`,
    keyTestFailed: (provider, detail) => `✗ ${provider} 驗證失敗：${detail}`,

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
    ticketNotFound: (name) => `找不到 DB 工單：${name}`,
    ticketCorrupt: (name) => `DB 工單內容損毀：${name}`,
    ticketNameInvalid: (name) => `工單名稱無效：${name}`,
    ticketAlreadyExists: (name) => `DB 工單已存在：${name}`,
    ticketSpokeNotFound: (name, agent) => `DB 工單 "${name}" 沒有 agent "${agent}"`,
    ticketShowHeader: (name) => `DB 工單 ${name}:`,
    ticketEstimateTokens: (tokens) => `估算 ${tokens} tokens`,
    ticketCompletedRuns: (runs, total, last) => `已完成 ${runs} 次；累計 $${total}；最近一次 ${last}`,
    ticketCompletedRunsNoPricing: (runs, last) => `已完成 ${runs} 次；累計無價目資料；最近一次 ${last}`,
    ticketHelp: (cmd) => `${cmd} ticket create <name> <shared-file>\n${cmd} ticket add-spoke <name> <agent> <provider> <model> <body-file> [effort]\n${cmd} ticket add-allow <name> <agent> <repo-relative-path> [--repo-root <dir>]\n${cmd} ticket import <existing-ticket-dir> [name] [--repo-root <dir>]\n${cmd} ticket show <name>\n  <shared-file>／<body-file> 可用 - 代表從 stdin 讀取本文（stdin 須為管道／重導向，不得是互動式終端機）`,
    ticketStdinRequiresPipe: () =>
      `此指令用 - 讀取 stdin 本文，但目前 stdin 是互動式終端機，沒有東西被導進來。` +
      `請改用管道／重導向提供內容（例如 echo "..." | dowafu ticket create <name> -），或改用一般檔案路徑。`,

    agentDefNotFound: (path, agent) => `找不到 agent 定義檔 ${path}（_dispatch.md 列了 "${agent}"）`,
    providerUndefinedInRow: (agent, provider) =>
      `_dispatch.md 的 "${agent}" 列引用了未定義於 providers.json 的 provider "${provider}"`,
    apiKeyNotConfigured: (agent, provider, cmd) =>
      `尚未設定 provider "${provider}" 的 API key（"${agent}" 列需要它）。\n`
      + `  本版的 API key 已併入資料庫設定，不再讀取 .env 或環境變數；請執行 \`${cmd} key\` 設定。`,
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
    providerModelsRequired: (name) => `providers.json: ${name}.models 必須列出至少一個型號`,
    pricingModelNotWhitelisted: (providerName, model) => `providers.json: ${providerName}.pricing.${model} 不在 models 白名單內`,
    providersDbCorrupt: (name) => `providers DB 損毀：${name} 缺少型號資料或 JSON 無法解析`,
    modelDisabled: (model, cmd) => `型號 "${model}" 已停用；請先執行 ${cmd} providers enable ${model}`,
    providerModelNotFound: (model) => `找不到型號：${model}`,
    providerModelAmbiguous: (model, providers) => `型號 "${model}" 同時存在於：${providers}。請用 ${"dowafu"} providers enable <provider> ${model} 指定目標；可先看 providers list。`,
    providersHelp: (cmd) => `${cmd} providers list [--db <path>]\n${cmd} providers enable <model> [--db <path>]\n${cmd} providers enable <provider> <model> [--db <path>]\n${cmd} providers disable <model> [--db <path>]\n${cmd} providers disable <provider> <model> [--db <path>]\n${cmd} providers import <path> [--db <path>]`,
    providersListEmpty: () => "providers DB 尚無型號；請明確執行 providers import。",
    providersListRow: (provider, model, input, output, enabled) => `${provider}\t${model}\tinput $${input}/M\toutput $${output}/M\t${enabled ? "enabled" : "disabled"}`,
    providersImported: (path) => `已合流匯入 providers：${path}`,
    providersSeeded: (path) => `providers 表原本是空的，已自動從出貨檔播種：${path}（貴的型號預設關閉，用 providers list 查看）`,
    providersDbEmpty: (cmd) => `providers 表沒有任何型號，所以沒有型號可用。這通常表示出貨的 providers.json 讀不到；執行 \`${cmd} providers import <出貨的 providers.json>\` 匯入，或用 \`${cmd} --doctor\` 查看來源。`,
    providersEnabled: (model) => `已啟用型號：${model}`,
    providersDisabled: (model) => `已停用型號：${model}`,
    providersFileNotObject: () => "providers.json 格式不是物件",
    providersFormatVersionMismatch: (want, got) =>
      `providers.json: formatVersion 不符（預期 ${want}，實際 ${got}）。這通常代表匯入了舊版或不相容的檔案。`,
    providersFileInvalidJson: (msg) => `providers.json 不是合法 JSON：${msg}`,
    providerUndefined: (name) => `providers.json 未定義 provider "${name}"`,

    noFullReportAvailable: (status) => `(無法取得完整回報，執行狀態：${status})`,
    persistTextFailed: (agent, maskedErr) => `落檔失敗（${agent}.md）：${maskedErr}`,
    persistRawFailed: (agent, maskedErr) => `落檔失敗（${agent} raw/）：${maskedErr}`,
    budgetTriggerLabel: (trigger) =>
      ({ total: "總量", reasoning: "推理累積", reasoning_round: "推理單輪尖峰" })[trigger],
    anomalySpikeFlag: () => "⚠ 異常尖峰・",
    noneLabel: () => "無",
    unknownUsageKeysWarning: (provider, keys) => `⚠ 未知 usage 欄位：${provider} ${keys}`,
    zeroSourceReadWarning: (n) => `⚠ 零原始碼讀取（允許 ${n} 檔）`,
    finishReasonWarningCell: (reason) => `provider 回報截斷:${reason}`,
    toolCallStats: (total, allowed, rejected) => `工具呼叫:${total}（允許 ${allowed}／拒絕 ${rejected}）`,
    closingLineCell: (passFail) => `收尾句:${passFail}`,
    observationCountCell: (display) => `觀察:${display}`,
    cannotCountObservations: () => "無法計數",
    cannotVerifySectionCell: (passFail) => `無法驗證欄:${passFail}`,
    templatePlaceholdersPassCell: () => "佔位符:pass",
    templatePlaceholdersFailCell: (count) => `佔位符:fail（內容可用，但含 ${count} 處佔位符標記，交付前請清理）`,
    auditUnavailable: () => "(無法稽核)",
    summaryHeader: (ticketId) => `# dispatch summary — ${ticketId}

| agent | provider | api | model(請求) | model(回傳) | effort | store | status | 耗時 | token | 估算成本 | 稽核 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,

    // 熱修補（票 C 手測）：原本寫「明確 providers import 合流」。那在寫下的當時是準的
    // ——當時填 DB 的唯一途徑就是明確 import。票 A 的熱修補加了空表自動播種之後這句就變成
    // 假的，而且它假的地方正好是「這些數字哪來的」，是這個欄位存在的唯一理由。
    // 播種與 import 目前沒有分開記錄，所以這裡只講查得證的那半：來源是 DB。
    providersDatabase: () => "SQLite DB",
    strayHeadingsWarning: (reviewChars, strayNames) =>
      `  ⚠ _shared.md 的「# 待審段落」只有 ${reviewChars} 字，另有 ${strayNames.length} 個頂層章節：` +
      `${strayNames.map((s) => `「# ${s}」`).join("、")}` +
      `——待審段落可能被它們切斷了。工單以 \`#\` 切分區塊，內嵌文件若自帶 \`#\` 標題請降成 \`##\`，` +
      `或用 \`\`\` 圍籬包起來。確認過是刻意的就忽略本行`,
    gitignoreNotIgnored: (dbPath) => `  ⚠ 資料庫檔案 ${dbPath} 未被其所在的 git repo 忽略`,
    gitignoreUnknown: (dbPath) =>
      `  ℹ 無法判定資料庫檔案 ${dbPath} 是否被 .gitignore 涵蓋（它不在目前目錄所屬的 git 工作樹內、目前目錄非 git repo，或 git 不可用）`,
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
    allowedReadsSummary: (n) => `  允許讀取 ${n} 個檔案，結果存入資料庫`,
    allowedReadsListEntry: (path) => `    ${path}`,
    allowedReadsListFolded: (n) => `    …另 ${n} 個`,
    allowedReadsListEmpty: () => "    （允許清單為空）",

    lensClosingLineZh: (agent) => `ℹ ${agent} 的 lens 收尾句符合中文版固定收尾句`,
    lensClosingLineEn: (agent) => `ℹ ${agent} 的 lens 收尾句符合英文版固定收尾句`,
    modelPricing: (input, output, cachedSuffix, asOfSuffix) =>
      `    └ 單價 每 M token：input $${input}／output $${output}${cachedSuffix}${asOfSuffix}`,
    modelPricingCachedSuffix: (cached) => `／cached input $${cached}`,
    modelPricingAsOfSuffix: (asOf) => `；價目查證日 ${asOf}`,
    modelPricingMissing: (model) => `    └ ⚠ DB 沒有 "${model}" 的價目資料，本型號無法估算成本`,
    hardCapLine: (hardCapUsd) => `硬上限 $${hardCapUsd}（絕對上界，非預測）`,
    hardCapWithTypicalLine: (typicalUsd, runs, hardCapUsd) =>
      `典型 $${typicalUsd}（過去 ${runs} 次）／硬上限 $${hardCapUsd}（絕對上界，非預測）`,
    hardCapMissingPricing: () => "硬上限：無價目資料",

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
    doctorDbLine: (dbPath) => `  資料庫      ${dbPath}`,
    doctorEnvLine: (value) => `  .env        ${value}`,
    doctorEnvPresentValue: () => "有，但本版不讀取（API key 請用 `dowafu key` 設定進 DB）",
    doctorApiKeyLine: (value) => `  API key     ${value}`,
    doctorApiKeyRow: (provider, status) => `${provider} ${status}`,
    doctorApiKeySourceDb: (tail, date) => `DB（${tail}，${date}）`,
    doctorApiKeySourceMissing: () => "未設定",
    doctorProviderCountItem: (name, count) => `${name} ${count} 個`,
    doctorModelListLine: (value) => `  型號白名單  ${value}`,
    doctorModelListValue: (enabled, total, mostExpensive) => `啟用 ${enabled}/${total}；最貴啟用型號 ${mostExpensive}；來源 SQLite DB`,
    doctorModelListLoadFailedValue: (reason) => `無法載入：${reason}`,
    doctorLensLine: (value) => `  lens 定義   ${value}`,
    doctorLensFoundValue: (dirPath, total, closingCount, closingNames, noClosingSuffix) =>
      `${dirPath} 找到 ${total} 個定義檔，其中 ${closingCount} 個具備固定收尾句：\n${" ".repeat(14)}${closingNames}${noClosingSuffix}`,
    doctorLensNoClosingSuffix: (count, names) => `\n${" ".repeat(14)}（另有 ${count} 個不是 lens：${names}）`,
    doctorLensDirMissingValue: (dirPath) => `目錄不存在：${dirPath}`,
    doctorFooter: () => "本指令不呼叫任何 API，不會花錢。缺的項目怎麼補，見 README 的〈API keys〉一節。",
  },
  en: {
    unknownOption: (arg, helpText) => `Unknown option: ${arg}\n\n${helpText}`,
    missingProviders: (path) => `providers.json not found: ${path}`,
    dryRunNotice: () => "--dry-run: parsed, validated, estimated, and reported only; no API calls were made.",

    helpText: (cmd) => `Usage: ${cmd} <ticket-id> [options]

Subcommands (each has its own usage message):
  ${cmd} ticket ...        Create, import and inspect tickets
  ${cmd} result <id>       Print the results of one dispatch (spoke output and audit table)
  ${cmd} key               Set provider API keys (interactive menu)
  ${cmd} providers ...     Model whitelist and enabled state
  ${cmd} token ...         Issue, list and revoke inbound HTTP tokens
  ${cmd} approve [jobId]   Approve a dispatch waiting in the queue
  ${cmd} serve             Run the daemon (includes the MCP HTTP binding)
  ${cmd} serve --stop [--yes] Stop the daemon; asks first if jobs are running
  ${cmd} mcp               Serve MCP over stdio

  --lang <en|zh-tw>        Language for CLI output and spoke prompts, default en
  --repo-root <dir>        Root for the allowlist boundary and .claude/agents, default cwd
  --db <path>              SQLite ticket/result database, default DISPATCH_HOME/dowafu.db
  --http-port <port>       HTTP binding port for serve mode, loopback (127.0.0.1) only, default 7391
  --json                   stdout prints only the result JSON; all other output goes to stderr
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
  --max-tool-calls <n>     Per-spoke read_file call cap, default 20
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
    resultsExistAbort: (resultId) =>
      `This id already has results. Nothing was dispatched; no API was called: ${resultId}\n` +
      `Those came from a previous run, and overwriting them loses them. Read them first: dowafu result ${resultId}\n` +
      `Two ways forward:\n` +
      `  1. Pick a ticket-id you have not used and dispatch under that (recommended; it costs nothing)\n` +
      `  2. Have the user delete those results from the database themselves, then rerun — that call is theirs, not yours\n` +
      `  * If the previous run ended in failure (all failed, zero tokens), nothing there was paid for\n` +
      `    — a new id or the user deleting it are both fine, but it is still their call to delete`,
    resultsExistDryRunWarning: (resultId) =>
      `⚠ This id already has results: ${resultId}\n  The dry run is unaffected, but the real run will be stopped. Pick a different ticket-id; to read the previous run first, use dowafu result ${resultId}.`,
    resultsSaved: (resultId) => `Results saved to the database. Read them back with: dowafu result ${resultId}`,
    outDirFallbackStderr: () => "Output directory is not writable; the full report was printed to stderr instead:",
    stdoutSummaryLine: (agent, status, model, tokens, costLabel, latencyMs) =>
      `${agent}: ${status}  model=${model}  token=${tokens}  cost=${costLabel}  elapsed=${latencyMs}ms`,
    dbResultPersistenceFailed: (agent, maskedErr) => `DB result persistence failed (${agent}): ${maskedErr}`,
    dbSchemaTooNew: (found, supported) =>
      `This database was created by a newer dowafu (schema version ${found}; this build supports up to ${supported}). Upgrade dowafu instead of opening it with an older build.`,
    approveHelp: (cmd) => `Usage: ${cmd} approve [jobId prefix] [--db <path>]`,
    resultHelp: (cmd) => `Usage: ${cmd} result <ticket-id or jobId/prefix> [--db <path>]`,
    resultNotFound: (id) => `No results found for "${id}". The dispatch has not finished, or that ticket-id/jobId does not exist.`,
    resultPrefixAmbiguous: (prefix, count) => `Prefix ${prefix} matches ${count} jobs; provide a longer id.`,
    resultCandidate: (shortId, ticket, status) => `  ${shortId}  ${ticket}  ${status}`,
    approveNoPending: () => "There are no jobs awaiting approval.",
    approveMultiplePending: (count) => `${count} pending approvals found; specify one short id.`,
    approvePrefixAmbiguous: (prefix, count) => `Prefix ${prefix} matches ${count} jobs; provide a longer id.`,
    approvePendingCandidate: (shortId, ticket, createdAt) => `  ${shortId}  ${ticket}  ${createdAt}`,
    jobNotFound: (jobId) => `Job not found: ${jobId}`,
    mcpJobPrefixAmbiguous: (prefix, count) => `Prefix ${prefix} matches ${count} jobs; use the full id:`,
    jobNotApprovable: (jobId, status) => `Job ${jobId} is ${status} and cannot be approved`,
    jobApproved: (jobId) => `Approved job: ${jobId}`,
    daemonStarted: () => "Daemon started. SIGINT exits cleanly; running jobs are reaped on the next start.",
    daemonStartFailed: (detail) => `Could not start daemon: ${detail}`,
    daemonWorkerSpawnFailed: (detail) => `Could not start worker: ${detail}`,
    daemonWorkerExited: (exitCode) => `worker exited ${exitCode}`,
    daemonWorkerExitedDetail: (exitCode, detail) => `worker exited ${exitCode}: ${detail}`,
    daemonWorkerTerminated: (signal) => `worker terminated by ${signal}`,
    daemonWorkerTerminatedDetail: (signal, detail) => `worker terminated by ${signal}: ${detail}`,
    stopRequiresServe: () => "--stop can only be used with serve.",
    daemonStopRunningWarning: (count) => `${count} job(s) are running; stopping the daemon does not stop their active spokes, which continue to completion and will still have their results and API costs recorded.`,
    daemonStopConfirmPrompt: () => "Stop the daemon? [y/N] ",
    daemonStopCancelled: () => "Cancelled; the daemon is still running.",
    daemonStopNotRunning: (reason) => `Daemon is not running (${reason}).`,
    daemonStopPidNotDowafu: (pid) => `pid ${pid} is not a dowafu process; no signal was sent to avoid killing the wrong process.`,
    daemonStopSignalFailed: (pid) => `A stop signal was sent to pid ${pid}, but it did not stop.`,
    daemonStopSucceeded: (pid) => `Daemon (pid ${pid}) stopped.`,
    daemonStopRestarted: (pid) => `Daemon (previous pid ${pid}) came back after stopping; an OS-level service manager appears to be restarting it. Use launchctl or systemctl to stop it permanently.`,
    doctorDaemonLine: (value) => `  Daemon       ${value}`,
    doctorDaemonAlive: (pid) => `running (pid ${pid})`,
    doctorDaemonMissing: (reason) => `not running (${reason})`,
    daemonOfflineWarning: (reason) => `⚠ The worker daemon is not running (${reason}); the job is queued but will not execute. Start it with dowafu serve.`,
    mcpTicketsEmpty: () => "No dispatchable DB tickets.",
    mcpTicketsTitle: () => "Dispatchable tickets:",
    mcpTicketsRow: (ticket, spokeCount) => `- ${ticket}: ${spokeCount} spoke(s)`,
    mcpTicketsSpoke: (agent, provider, model, allowCount) =>
      `  ${agent}: ${provider}/${model}; allowlist files=${allowCount}`,
    mcpKeysTitle: () => "API key status:",
    mcpKeysRow: (provider, status) => `  ${provider}: ${status}`,
    mcpEnabledModelsTitle: () => "Enabled model allowlist:",
    mcpEnabledModelRow: (provider, model) => `  ${provider}/${model}`,
    mcpSubmitQueued: (jobId) => `Job queued: ${jobId}; status pending_approval. It has not started and needs terminal approval by a human.`,
    mcpSubmitInvalidLang: (value, available) => `dispatch_submit lang is invalid: ${value} (available values: ${available}). No job was created.`,
    mcpPriorResultsReminder: (runs) => `Reminder: this ticket already has ${runs} result run(s). This is not an error; it can still be queued.`,
    mcpApproveCommand: (command) => `Run this in a terminal: ${command}`,
    mcpJobStarted: (at) => `Started at ${at}`,
    mcpJobFinished: (at) => `Finished at ${at}`,
    mcpJobError: (detail) => `Error: ${detail}`,
    mcpJobProgress: (agent, lastRound, tokensIn, tokensOut, lastAt) =>
      `  ${agent}: round ${lastRound}, ${tokensIn} in / ${tokensOut} out tokens so far, last updated ${lastAt}`,
    mcpJobNoProgressYet: () => "  (no round has completed yet)",
    mcpJobHeartbeatStale: (seconds) =>
      `⚠ The worker's heartbeat has not moved for ${seconds}s; this job is most likely dead. ` +
      `The next reap will mark it interrupted; with no daemon running it stays at running indefinitely.`,
    mcpJobOutcome: (succeeded, failed, failedAgentsSuffix) =>
      `Spoke outcomes: ${succeeded} succeeded / ${failed} failed${failedAgentsSuffix}`,
    mcpJobFailedAgentsSuffix: (agents) => ` (failed: ${agents})`,
    mcpResultPending: (jobId, status) => `Job ${jobId} is ${status}; no result is available yet.`,
    mcpResultComplete: (jobId) => `Job ${jobId} result:`,
    mcpResultEmpty: () => "(No stored spoke results.)",
    mcpApproveAmountMismatch: (jobId, providedUsd, expectedUsd) =>
      `Approval rejected: amount mismatch. Job ${jobId}'s hard cap is $${expectedUsd}; you gave ${providedUsd}. Not approved; no API was called.`,
    mcpApproveNoPricing: (jobId) => `Approval rejected: the ticket behind job ${jobId} lacks pricing data, so the amount could not be verified. Not approved.`,

    httpServerStarted: (port) => `HTTP binding started: 127.0.0.1:${port}/mcp (loopback only; exposure is the tunnel's job)`,
    httpNoTokensWarning: () =>
      "⚠ No token has been issued yet (dowafu token issue). The endpoint is alive, but no request can get in — it isn't broken, it just has no token yet.",
    tokenHelp: (cmd) => `${cmd} token issue [--label <text>]\n${cmd} token list\n${cmd} token revoke <id>`,
    tokenIssued: (id, plaintext) =>
      `Token issued, id = ${id}\nPlaintext (shown only this once, unrecoverable afterward): ${plaintext}`,
    tokenListEmpty: () => "No tokens have been issued yet.",
    tokenListRow: (id, label, createdAt, revoked) => `${id}\t${label}\t${createdAt}\t${revoked ? "revoked" : "active"}`,
    tokenRevoked: (id) => `Revoked token: ${id}`,
    tokenNotFoundOrRevoked: (id) => `Token not found or already revoked: ${id}`,

    keyHelp: (cmd) =>
      `${cmd} key                 Interactive setup (pick a provider from a menu, paste the key; takes no CLI args)\n${cmd} key list            List each provider's currently effective source (no plaintext)\n${cmd} key rm <provider>    Remove that provider's key from the DB\n${cmd} key test <provider>  Call the real API once to verify the key (costs money)`,
    keyInteractiveRequiresTty: () =>
      "dowafu key needs an interactive terminal (stdin is not a TTY); it will not hang waiting for input or read from a pipe. Run dowafu key in an interactive terminal to set the API key.",
    keyMenuHeader: () => "  provider      status",
    keyMenuRow: (num, providerPadded, status) => `  ${num}) ${providerPadded} ${status}`,
    keyMenuPrompt: (max) => `Choose a provider to set (1-${max}, q to quit): `,
    keyMenuInvalidChoice: () => "Invalid choice.",
    keyMenuQuit: () => "Left without changing anything.",
    keyPastePrompt: (provider) => `Paste the API key for ${provider} (will not be echoed): `,
    keyPasteEmpty: () => "Nothing was pasted; cancelled.",
    keySavedTail: (tail) => `✓ Saved to the DB (${tail}).`,
    keyVerifyPrompt: (provider) => `Verify this key now? This calls ${provider}'s API once and costs money (y/N): `,
    keyListRow: (provider, status) => `${provider}\t${status}`,
    keyRemoved: (provider) => `Removed ${provider}'s key from the DB.`,
    keyRemovedNotFound: (provider) => `The DB has no key for ${provider}; nothing to remove.`,
    keyUnknownProvider: (provider, list) => `Unknown provider: ${provider} (known: ${list})`,
    keyStatusDb: (tail, date) => `✓ set (${tail}, DB, ${date})`,
    keyStatusMissing: () => "✗ not set",
    keyStatusUntested: () => "; never tested",
    keyStatusTestSucceeded: (model, at) => `; last test passed (${model}, ${at})`,
    keyStatusTestFailed: (model, at) => `; last test failed (${model}, ${at})`,
    keyTestHelp: (cmd) => `Usage: ${cmd} key test <provider>`,
    keyTestKeyMissing: (provider) => `${provider} has no API key set yet (neither DB nor environment) — set one with \`dowafu key\` first.`,
    keyTestNoEnabledModel: (provider) => `${provider} has no enabled model to test with (see \`dowafu providers enable\`).`,
    keyTestCostWarning: (provider) => `About to call ${provider}'s API once as a minimal verification. This costs money.`,
    keyTestConfirmPrompt: () => "Proceed? [y/N] ",
    keyTestCancelled: () => "Cancelled; no API call was made.",
    keyTestSucceeded: (provider, model) => `✓ ${provider}/${model} verified; this key works.`,
    keyTestFailed: (provider, detail) => `✗ ${provider} verification failed: ${detail}`,

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
    ticketNotFound: (name) => `DB ticket not found: ${name}`,
    ticketCorrupt: (name) => `DB ticket is corrupt: ${name}`,
    ticketNameInvalid: (name) => `Invalid ticket name: ${name}`,
    ticketAlreadyExists: (name) => `DB ticket already exists: ${name}`,
    ticketSpokeNotFound: (name, agent) => `DB ticket "${name}" has no agent "${agent}"`,
    ticketShowHeader: (name) => `DB ticket ${name}:`,
    ticketEstimateTokens: (tokens) => `est. ${tokens} tokens`,
    ticketCompletedRuns: (runs, total, last) => `Completed ${runs} times; total $${total}; last ${last}`,
    ticketCompletedRunsNoPricing: (runs, last) => `Completed ${runs} times; total No pricing data; last ${last}`,
    ticketHelp: (cmd) => `${cmd} ticket create <name> <shared-file>\n${cmd} ticket add-spoke <name> <agent> <provider> <model> <body-file> [effort]\n${cmd} ticket add-allow <name> <agent> <repo-relative-path> [--repo-root <dir>]\n${cmd} ticket import <existing-ticket-dir> [name] [--repo-root <dir>]\n${cmd} ticket show <name>\n  <shared-file>/<body-file> may be - to read the body from stdin (stdin must be piped/redirected, not an interactive terminal)`,
    ticketStdinRequiresPipe: () =>
      "This command reads the body from stdin via -, but stdin is an interactive terminal right now; nothing is being piped in. " +
      'Pipe or redirect content instead (for example, echo "..." | dowafu ticket create <name> -), or use a regular file path.',

    agentDefNotFound: (path, agent) => `Agent definition file not found: ${path} (_dispatch.md lists "${agent}")`,
    providerUndefinedInRow: (agent, provider) =>
      `_dispatch.md's "${agent}" row references provider "${provider}", which is not defined in providers.json`,
    apiKeyNotConfigured: (agent, provider, cmd) =>
      `No API key configured for provider "${provider}" (the "${agent}" row needs one).\n`
      + `  This version keeps API keys in the database and no longer reads .env or environment variables; run \`${cmd} key\` to set one.`,
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
    providerModelsRequired: (name) => `providers.json: ${name}.models must list at least one model`,
    pricingModelNotWhitelisted: (providerName, model) => `providers.json: ${providerName}.pricing.${model} is not in the models whitelist`,
    providersDbCorrupt: (name) => `providers DB is corrupt: ${name} has no model data or invalid JSON`,
    modelDisabled: (model, cmd) => `Model "${model}" is disabled; first run ${cmd} providers enable ${model}`,
    providerModelNotFound: (model) => `Model not found: ${model}`,
    providerModelAmbiguous: (model, providers) => `Model "${model}" exists in: ${providers}. Use dowafu providers enable <provider> ${model}; see providers list.`,
    providersHelp: (cmd) => `${cmd} providers list [--db <path>]\n${cmd} providers enable <model> [--db <path>]\n${cmd} providers enable <provider> <model> [--db <path>]\n${cmd} providers disable <model> [--db <path>]\n${cmd} providers disable <provider> <model> [--db <path>]\n${cmd} providers import <path> [--db <path>]`,
    providersListEmpty: () => "The providers DB has no models; explicitly run providers import.",
    providersListRow: (provider, model, input, output, enabled) => `${provider}\t${model}\tinput $${input}/M\toutput $${output}/M\t${enabled ? "enabled" : "disabled"}`,
    providersImported: (path) => `Providers merged from: ${path}`,
    providersSeeded: (path) => `The providers table was empty and has been seeded from the bundled file: ${path} (expensive models start disabled; see providers list)`,
    providersDbEmpty: (cmd) => `The providers table holds no models, so no model is usable. That usually means the bundled providers.json could not be read; run \`${cmd} providers import <bundled providers.json>\` to load it, or \`${cmd} --doctor\` to see the source.`,
    providersEnabled: (model) => `Enabled model: ${model}`,
    providersDisabled: (model) => `Disabled model: ${model}`,
    providersFileNotObject: () => "providers.json format is not an object",
    providersFormatVersionMismatch: (want, got) =>
      `providers.json: formatVersion mismatch (expected ${want}, got ${got}). ` +
      `This usually means an old or incompatible file was imported.`,
    providersFileInvalidJson: (msg) => `providers.json is not valid JSON: ${msg}`,
    providerUndefined: (name) => `providers.json does not define provider "${name}"`,

    noFullReportAvailable: (status) => `(Full report unavailable; execution status: ${status})`,
    persistTextFailed: (agent, maskedErr) => `Failed to write file (${agent}.md): ${maskedErr}`,
    persistRawFailed: (agent, maskedErr) => `Failed to write file (${agent} raw/): ${maskedErr}`,
    budgetTriggerLabel: (trigger) =>
      ({ total: "total", reasoning: "cumulative reasoning", reasoning_round: "single-round reasoning spike" })[
        trigger
      ],
    anomalySpikeFlag: () => "⚠ anomalous spike - ",
    noneLabel: () => "none",
    unknownUsageKeysWarning: (provider, keys) => `⚠ Unknown usage field(s): ${provider} ${keys}`,
    zeroSourceReadWarning: (n) => `⚠ Zero source reads (allowed ${n} file(s))`,
    finishReasonWarningCell: (reason) => `Provider-reported truncation:${reason}`,
    toolCallStats: (total, allowed, rejected) => `Tool calls:${total} (allowed ${allowed} / rejected ${rejected})`,
    closingLineCell: (passFail) => `Closing line:${passFail}`,
    observationCountCell: (display) => `Observations:${display}`,
    cannotCountObservations: () => "uncountable",
    cannotVerifySectionCell: (passFail) => `Cannot-verify section:${passFail}`,
    templatePlaceholdersPassCell: () => "Template placeholders:pass",
    templatePlaceholdersFailCell: (count) =>
      `Template placeholders:fail (content is usable, but contains ${count} placeholder marker(s); clean them before delivery)`,
    auditUnavailable: () => "(audit unavailable)",
    summaryHeader: (ticketId) => `# dispatch summary — ${ticketId}

| agent | provider | api | model(requested) | model(returned) | effort | store | status | latency | token | est. cost | audit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,

    providersDatabase: () => "SQLite DB",
    strayHeadingsWarning: (reviewChars, strayNames) =>
      `  ⚠ _shared.md's "# Under review" holds only ${reviewChars} characters, and ${strayNames.length} other ` +
      `top-level heading(s) follow: ${strayNames.map((s) => `"# ${s}"`).join(", ")} — the section under review ` +
      `may have been cut off by them. The ticket splits into sections by \`#\`; if an embedded document has its ` +
      `own \`#\` headings, demote them to \`##\` or wrap the block in \`\`\` fences. Ignore this line if it is intended`,
    gitignoreNotIgnored: (dbPath) => `  ⚠ Database file ${dbPath} is not ignored by the git repo it lives in`,
    gitignoreUnknown: (dbPath) =>
      `  ℹ Cannot determine whether database file ${dbPath} is covered by .gitignore (it is outside the git work tree of the current directory, the current directory is not a git repo, or git is unavailable)`,
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
    allowedReadsSummary: (n) => `  Allowed reads: ${n} file(s); results go to the database`,
    allowedReadsListEntry: (path) => `    ${path}`,
    allowedReadsListFolded: (n) => `    …and ${n} more`,
    allowedReadsListEmpty: () => "    (Allowlist is empty)",

    lensClosingLineZh: (agent) => `ℹ ${agent}'s lens closing line matches the Chinese fixed closing line`,
    lensClosingLineEn: (agent) => `ℹ ${agent}'s lens closing line matches the English fixed closing line`,
    modelPricing: (input, output, cachedSuffix, asOfSuffix) =>
      `    └ Price per M tokens: input $${input} / output $${output}${cachedSuffix}${asOfSuffix}`,
    modelPricingCachedSuffix: (cached) => ` / cached input $${cached}`,
    modelPricingAsOfSuffix: (asOf) => `; priced as of ${asOf}`,
    modelPricingMissing: (model) =>
      `    └ ⚠ The database has no pricing data for "${model}"; cost cannot be estimated for it`,
    hardCapLine: (hardCapUsd) => `Hard cap $${hardCapUsd} (absolute upper bound, not a prediction)`,
    hardCapWithTypicalLine: (typicalUsd, runs, hardCapUsd) =>
      `Typical $${typicalUsd} (last ${runs} runs) / hard cap $${hardCapUsd} (absolute upper bound, not a prediction)`,
    hardCapMissingPricing: () => "Hard cap: no pricing data",

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
    doctorDbLine: (dbPath) => `  Database     ${dbPath}`,
    doctorEnvLine: (value) => `  .env         ${value}`,
    doctorEnvPresentValue: () => "present, but this version does not read it (set API keys with `dowafu key`)",
    doctorApiKeyLine: (value) => `  API keys     ${value}`,
    doctorApiKeyRow: (provider, status) => `${provider} ${status}`,
    doctorApiKeySourceDb: (tail, date) => `DB (${tail}, ${date})`,
    doctorApiKeySourceMissing: () => "not set",
    doctorProviderCountItem: (name, count) => `${name} ${count}`,
    doctorModelListLine: (value) => `  Model list   ${value}`,
    doctorModelListValue: (enabled, total, mostExpensive) => `enabled ${enabled}/${total}; most expensive enabled ${mostExpensive}; source SQLite DB`,
    doctorModelListLoadFailedValue: (reason) => `failed to load: ${reason}`,
    doctorLensLine: (value) => `  Lens defs    ${value}`,
    doctorLensFoundValue: (dirPath, total, closingCount, closingNames, noClosingSuffix) =>
      `${dirPath} holds ${total} definition file(s), ${closingCount} with a fixed closing line:\n${" ".repeat(15)}${closingNames}${noClosingSuffix}`,
    doctorLensNoClosingSuffix: (count, names) => `\n${" ".repeat(15)}(${count} other agent file(s), not lenses: ${names})`,
    doctorLensDirMissingValue: (dirPath) => `directory not found: ${dirPath}`,
    doctorFooter: () =>
      'This command calls no API and costs nothing. To fill in what is missing, see "API keys" in the README.',
  },
};

export function m<K extends keyof MessageArgs>(lang: Lang, key: K, ...args: MessageArgs[K]): string {
  return MESSAGES[lang][key](...args);
}
