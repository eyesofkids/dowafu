# dowafu

[English](https://github.com/eyesofkids/dowafu/blob/main/README.md) ｜ **繁體中文**

**一支唯讀審查用的 spoke harness**：把文件段落派給外部模型，限定它讀什麼、記下它做了什麼、機械稽核它的回報格式。

講具體一點——你(與AI agent協同)寫一份工單，`dowafu` 呼叫各家 provider 的 API；每個審查者（*spoke*）**只讀你列進白名單的檔案**，回傳帶依據的觀察，全部落檔供你查核。

相容於各種支援標準SKILL的AI Agent程式與VS Code擴充套件包含以下，但還有更多:

- Claude Code
- VS Code Codepilot 

**spoke 產出的是意見，不是裁決。** 那些意見要怎麼處理，仍然由你決定。

> ### 英文與繁體中文都是完整支援的語言。
>
> 整次執行的語言由一個旗標決定：`--lang en` 或 `--lang zh-tw`。沒帶旗標時看 `DISPATCH_LANG`，兩者都沒有時**預設為英文**。旗標優先於環境變數；任一方填了無法辨識的值都會直接中止，不會猜。
>
> 語言涵蓋所有地方：審查者收到的 Prompt 與報告範本、稽核用來檢查報告的範本，以及 CLI 自己的輸出——`--help`、錯誤訊息、dry-run 報告、`summary.md`。Dry run 會針對每個審查者印出判定的語言，送出前就看得到。
>
> 工單的段落標題兩種語言都可以寫，與語言選擇無關——它們是欄位名稱，不是語言開關。見[工單格式](#工單格式)。
>
> Skill 與審查者定義同樣有兩種語言，分別放在 `publish/en/` 與 `publish/zh-tw/`。**擇一安裝，不可混裝**——審查者的固定收尾句必須與稽核檢查用的範本是同一種語言。

## 安裝

```bash
npm install -g dowafu
```

執行指令為 `dowafu`。

## API Keys

API Key 會從 `$DISPATCH_HOME/.env` 讀取，預設位置為：

`~/.config/dowafu/.env`

可以透過 `DISPATCH_HOME` 或 `XDG_CONFIG_HOME` 覆寫這個位置。

如果環境變數中已經存在相同的變數，環境變數會優先於檔案中的值。因此在 CI 或臨時覆寫設定時，完全不需要建立 `.env` 檔案。

```bash
mkdir -p ~/.config/dowafu
cat > ~/.config/dowafu/.env <<'EOF'
DEEPSEEK_API_KEY=
GEMINI_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
EOF
chmod 600 ~/.config/dowafu/.env
```

只需要為實際要執行 Dispatch 的 Provider 設定 Key 即可。

這個檔案是純文字檔——它唯一的保護機制就是檔案權限。

**永遠不會讀取目前工作目錄的 `.env`。**

那個目錄是你下指令的地方，通常就是被審查的專案；它的 secrets 不該被一個正對外部 API 發請求的行程讀進去。

## 使用方式

```bash
dowafu <ticket-dir> --dry-run   # 解析、驗證、估算。不呼叫 API，也不產生成本。
dowafu <ticket-dir> --yes       # 執行審查。這個操作會產生成本。
dowafu --help                   # 查看所有旗標
```

沒有指定 `--yes` 時，指令會要求使用者確認。

當 stdin 不是 TTY 時——例如由 Agent 代替你執行——沒有人可以回答確認，因此程式會在呼叫任何 API 之前停止。

## 工單

工單是一個目錄，其中包含三種檔案。

其中的標題是**字面標記（literal markers）**，Parser 會直接比對這些標記——必須完全使用以下兩組標題之一。

| English | 中文 |
| --- | --- |
| `# Questions` | `# 具體問題` |
| `# Allowed reads` | `# 允許讀取` |
| `# Under review` | `# 待審段落` |
| `# Premises` | `# 前提（不受審）` |

| 檔案 | 內容 |
| --- | --- |
| `_dispatch.md` | 要執行哪些審查者，以及各自使用哪個 Provider 與 Model |
| `_shared.md` | 前提與正在審查的段落，以原始內容直接貼入 |
| `<agent>.md` | 每個審查者一份：包含它的問題，以及允許讀取的檔案 |

```markdown
<!-- _dispatch.md -->
<!-- format: v1 -->
# dispatch auth-review

| agent | provider | model | effort |
| --- | --- | --- | --- |
| hole-finder-safety | deepseek | deepseek-v4-flash | |
| hole-finder-feasibility | openai | gpt-5.6-luna | |
```

```markdown
<!-- hole-finder-safety.md -->
# Questions
1. Does the permission check described here hold under concurrent requests?

# Allowed reads
- lib/auth-guard.ts
- prisma/schema.prisma
```

兩組標題都收，而且**與審查者使用的語言無關**——語言由 `--lang`／`DISPATCH_LANG` 決定（見上方）。兩組只是同一批欄位的別名，所以英文工單可以用中文跑，反之亦然。

不支援在同一個審查者檔案中混用兩組標題——第一個符合的標題會決定用哪一組欄位名，不是決定語言。

審查者定義放在 Repository 根目錄下的：

```text
.claude/agents/<agent>.md
```

它們是每個 spoke 的 System Prompt 來源，CLI 會直接讀取這些檔案。

結果會寫入：

```text
tmp/spoke/<ticket-id>/
```

其中包含：

- 每個 spoke 的審查報告
- `summary.md`：包含稽核表格與預估成本
- `run.jsonl`：每個事件一行
- `raw/`：精確保存實際送出的 Request 與收到的 Response

## 工具保證的事項

- **每次呼叫的讀取範圍都有白名單限制。** 如果 spoke 要求讀取白名單以外的檔案，會被拒絕，而且拒絕事件會被記錄。
- **`_docs/` 永遠禁止讀取。** 不論白名單如何設定。
- **在你確認之前不會產生任何費用。** Dry run 會列出解析後的 repo 根目錄、每個 spoke 的模型與語言、token 預估值與輸出路徑，而且不會呼叫任何 API。
- **Secrets 會被遮罩。** `run.jsonl`、`raw/*.json` 以及 stdout 中都會遮罩 Secrets。
- **發生錯誤就停止整個執行流程。** 例如缺少 API Key、未知的 Model、指定的檔案不存在等，都會在產生任何費用之前中止，並指出造成問題的路徑或名稱。

## Models

| Provider | Model |
| --- | --- |
| `openai` | `gpt-5.6-luna`、`gpt-5.6-terra`、`gpt-5.6-sol` |
| `deepseek` | `deepseek-v4-flash` |
| `gemini` | `gemini-3.1-flash-lite`、`gemini-3.5-flash-lite`、`gemini-3.6-flash` |
| `anthropic` | `claude-opus-5`、`claude-sonnet-5` |

這份清單會隨套件以 `providers.json` 一起提供。

如果想使用其他 Model，可以透過 `--providers` 指定自己的 Provider 設定檔。

## 從 Agent 驅動

`publish/` 包含可以複製到專案中的 skill 與審查者定義，讓在該專案中工作的 Agent 知道：

- 如何寫工單
- 在產生成本之前要檢查什麼
- 如何讀取審查結果

請將兩個目錄都複製過去。

其中 `.claude/` 包含 CLI 本身會讀取的審查者定義，因此無論你使用哪一種 Agent，都必須複製它。

`publish/` 提供兩種語言：`publish/en/` 與 `publish/zh-tw/`。**擇一複製，不可混裝**——審查者的固定收尾句必須與稽核檢查用的範本是同一種語言。

```bash
TARGET=<your project>
SRC=publish/zh-tw               # 或 publish/en

mkdir -p "$TARGET/.claude/skills" "$TARGET/.claude/agents" "$TARGET/.agents/skills"

cp -R "$SRC/.claude/skills/." "$TARGET/.claude/skills/"
cp -R "$SRC/.agents/skills/." "$TARGET/.agents/skills/"
cp "$SRC"/.claude/agents/*.md "$TARGET/.claude/agents/"
cp "$SRC/workflow_spec.md" "$TARGET/"
```

詳細內容請參考該語言目錄下的 README：

```text
publish/zh-tw/README.md   （或 publish/en/README.md）
```

兩份各自以該語言撰寫。

## License

MIT