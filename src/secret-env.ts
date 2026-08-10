// plan_dispatch_v1.4.md §12／plan_dispatch_v2.7.md §29 規格七：registerSecrets 的來源清單
// 是硬編的，不是自動掃描——API key 的解析（`${provider}_API_KEY` 慣例）會自動成立，但遮罩
// 不會。清單獨立成檔（而非留在 cli.ts 內聯宣告），是為了讓測試能直接匯入比對，不需要匯入
// 有 main() 副作用的 cli.ts 本體（cli-args.ts 拆分同一理由）。新增 provider 時漏加這裡，
// 該 provider 的金鑰就可能原樣出現在錯誤訊息、raw/*.request.json 或 run.jsonl 中。
export const SECRET_ENV_VARS = ["DEEPSEEK_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
