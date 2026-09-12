# dowafu

[English](https://github.com/eyesofkids/dowafu/blob/main/README.md) ｜ **繁體中文**

**一支唯讀審查用的 spoke harness**：把文件段落派給外部模型，限定它讀什麼、記下它做了什麼、機械稽核它的回報格式。

講具體一點——你(與AI agent協同)寫一份工單，`dowafu` 呼叫各家 provider 的 API；每個審查者（*spoke*）**只讀你列進白名單的檔案**，回傳帶依據的觀察，做過的事全部記錄下來供你查核。

相容於各種支援標準SKILL的AI Agent程式與VS Code擴充套件包含以下，但還有更多:

- Claude Code
- VS Code Copilot(內建)
- Codex(擴充套件)
- Google Antigravity IDE

**spoke 產出的是意見，不是裁決。** 那些意見要怎麼處理，仍然由你決定。

> ### 英文與繁體中文都是完整支援的語言。
>
> 有兩個設定各自決定不同範圍的語言。
>
> `--lang en`／`--lang zh-tw` 決定**一次派工**的語言：審查者收到的 Prompt 與報告範本、
> 稽核用來檢查報告的範本、dry-run 報告，以及隨結果一起存下來的執行摘要。
>
> `DISPATCH_LANG` 決定 **CLI 自己的介面**語言——`--help`、`--doctor`、解析期的錯誤訊息，
> 以及各個子指令（`key`、`providers`、`token`、`approve`、`serve`）。
> **`--lang` 管不到這些。** 那些訊息在旗標通過驗證之前就要印出來了；而 `--doctor` 更是
> 「語言設定本身壞掉時你會拿來查的那個工具」。
>
> 兩者都沒有時**預設為英文**；任一方填了無法辨識的值都會直接中止，不會猜。
> Dry run 會針對每個審查者印出判定的語言，送出前就看得到。
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

API Key 存在資料庫裡。請在你自己的終端機設定：

```bash
dowafu key
```

它會列出各家 provider，接收你貼上的 key（**不會回顯**），存起來之後只印出末四碼，並詢問要不要立刻對該家 API 驗證一次。

- `dowafu key list`：列出哪幾家已設定——只顯示有沒有，永遠不顯示內容
- `dowafu key rm <provider>`：移除某一家
- `dowafu key test <provider>`：對真實 API 驗證一次（**這個呼叫會花錢**，執行前會再問一次）

`dowafu key` 需要互動式終端機；stdin 被導向管道時它會直接拒絕，不會把管道內容當成 key 讀進去。

只需要為實際要執行 Dispatch 的 Provider 設定 Key 即可。

**本版不讀取任何 `.env` 檔，也不讀取 `*_API_KEY` 環境變數。** 來源只有一個，因此沒有優先序要推敲，也不會有環境裡殘留的舊值悄悄蓋過你剛設好的 key。從 0.4.x 升上來：把 `~/.config/dowafu/.env` 刪掉，改用 `dowafu key` 重設一次。

資料庫位於 `$DISPATCH_HOME/dowafu.db`，預設是 `~/.config/dowafu/dowafu.db`，可透過 `DISPATCH_HOME` 或 `XDG_CONFIG_HOME` 覆寫。**Key 在裡面是明文存放**——跟先前那個檔案一樣，它唯一的保護機制就是檔案權限。

## 使用方式

```bash
dowafu <ticket-id> --dry-run   # 解析、驗證、估算。不呼叫 API，也不產生成本。
dowafu <ticket-id> --yes       # 執行審查。這個操作會產生成本。
dowafu --help                  # 查看所有旗標
```

沒有指定 `--yes` 時，指令會要求使用者確認。

當 stdin 不是 TTY 時——例如由 Agent 代替你執行——沒有人可以回答確認，因此程式會在呼叫任何 API 之前停止。

## 工單

工單存在資料庫裡，不落到磁碟。用 CLI 建立：

```bash
dowafu ticket create <ticket-id> <shared-file>
dowafu ticket add-spoke <ticket-id> <agent> <provider> <model> <body-file> [effort]
dowafu ticket add-allow <ticket-id> <agent> <repo-relative-path> --repo-root .
```

`create` 與 `add-spoke` 的本文參數可以是路徑，也可以是 `-`（從 stdin 讀）——所以用 heredoc
就能把整張工單寫完，不必先落一個暫存檔：

```bash
dowafu ticket create auth-review - <<'EOF'
# 前提（不受審）
- 無

# 待審段落
...
EOF

dowafu ticket add-spoke auth-review hole-finder-safety deepseek deepseek-flash - <<'EOF'
# 具體問題
1. 這裡描述的權限檢查在併發請求下還成立嗎？

# 允許讀取
- lib/auth-guard.ts
- prisma/schema.prisma
EOF
```

`add-allow` 會立刻驗證路徑、拒絕 `_docs/`，並把該檔案**當下的內容**存起來——派工時不會再讀一次，
所以審查者看到的是那一刻的快照。用 `dowafu ticket show <ticket-id>` 檢視 Model、允許清單與估算。

### 段落標題

上面本文裡的標題是**字面標記（literal markers）**，Parser 會直接比對——必須完全使用以下兩組
標題之一。

| English | 中文 |
| --- | --- |
| `# Questions` | `# 具體問題` |
| `# Allowed reads` | `# 允許讀取` |
| `# Under review` | `# 待審段落` |
| `# Premises` | `# 前提（不受審）` |

兩組標題都收，而且**與審查者使用的語言無關**——語言由 `--lang`／`DISPATCH_LANG` 決定（見上方）。兩組只是同一批欄位的別名，所以英文工單可以用中文跑，反之亦然。

不支援在同一個審查者本文中混用兩組標題——第一個符合的標題會決定用哪一組欄位名，不是決定語言。

### 匯入舊的工單目錄

0.5.0 之前，工單是一個目錄，內含三種檔案——`_dispatch.md`、`_shared.md`，以及每個審查者一份的
`<agent>.md`。那個形態仍然讀得進來，作為一次性的搬遷：

```bash
dowafu ticket import <dir> [ticket-id] --repo-root .
```

審查者定義放在 Repository 根目錄下的：

```text
.claude/agents/<agent>.md
```

它們是每個 spoke 的 System Prompt 來源，CLI 會直接讀取這些檔案。

結果不會落到磁碟上，而是存進 SQLite 資料庫（預設 `$DISPATCH_HOME/dowafu.db`），其中包含：

- 每個 spoke 的審查報告
- 稽核表格與該次的實際花費
- 每一次呼叫實際送出的 Request 與收到的 Response

讀回某一次派工的結果：

```bash
dowafu result <id>
```

## 工具保證的事項

- **每次呼叫的讀取範圍都有白名單限制。** 如果 spoke 要求讀取白名單以外的檔案，會被拒絕，而且拒絕事件會被記錄。
- **`_docs/` 永遠禁止讀取。** 不論白名單如何設定。
- **在你確認之前不會產生任何費用。** Dry run 會列出解析後的 repo 根目錄、每個 spoke 的模型與語言、token 預估值與硬上限金額，而且不會呼叫任何 API。
- **Secrets 會被遮罩。** 存進資料庫的所有內容以及 stdout 中都會遮罩 Secrets。
- **發生錯誤就停止整個執行流程。** 例如缺少 API Key、未知的 Model、指定的檔案不存在等，都會在產生任何費用之前中止，並指出造成問題的路徑或名稱。

## Models

| Provider | Model | 全新安裝時 |
| --- | --- | :-: |
| `openai` | `gpt-5.6-luna` | **啟用** |
| | `gpt-5.6-terra`、`gpt-5.6-sol`、`gpt-6-astra` | 停用 |
| `deepseek` | `deepseek-flash` | **啟用** |
| | `deepseek-v4-flash`、`deepseek-v4-pro` | 停用 |
| `gemini` | `gemini-3.1-flash-lite`、`gemini-3.5-flash-lite` | **啟用** |
| | `gemini-3.6-flash`、`gemini-3.7-flash`、`gemini-3.8-flash` | 停用 |
| `anthropic` | `claude-haiku-4-5-20251001` | **啟用** |
| | `claude-opus-5`、`claude-sonnet-5` | 停用 |

共 15 個 Model，開箱只啟用五個——較貴的預設停用，讓打錯字不會安靜地派到昂貴的 Model 上。
派到停用的 Model 會在產生任何費用之前被拒絕，並告訴你該跑哪一條 `providers enable`。

`deepseek-v4-flash` 已於 2026-09-10 在上游退役，目前被轉址到 V4.1 Flash，官方未說明何時停止。
它留在清單上是為了讓既有工單還能運作，**新工單請改用 `deepseek-flash`**。

這份清單會隨套件以 `providers.json` 一起提供，並在第一次開啟資料庫時播種進去。
之後**資料庫就是唯一來源**：

```bash
dowafu providers list                      # 白名單，以及哪些 Model 是啟用的
dowafu providers enable|disable <model>    # 開關其中一個
dowafu providers import <path>             # 匯入自己的設定檔
```

**升級套件不會刷新這份清單。** 播種只在 Model 表完全為空時發生，所以升級永遠不會安靜地改掉
你既有的價格或啟用狀態。要取得後續版本新增的 Model，請自己匯入隨套件出貨的那一份：

```bash
dowafu providers import "$(npm root -g)/dowafu/providers.json"
dowafu providers list                      # 確認新的 Model 已經進來
```

**沒有 `--providers` 旗標**——0.5.0 把白名單搬進資料庫時已移除，帶了會被當成未知選項拒絕。

## 從 Agent 驅動

`publish/` 包含可以複製到專案中的 skill 與審查者定義，讓在該專案中工作的 Agent 知道：

- 如何寫工單
- 在產生成本之前要檢查什麼
- 如何讀取審查結果

請將兩個目錄都複製過去。

其中 `.claude/` 包含 CLI 本身會讀取的審查者定義，因此無論你使用哪一種 Agent，都必須複製它。

`publish/` 提供兩種語言：`publish/en/` 與 `publish/zh-tw/`。**擇一複製，不可混裝**——審查者的固定收尾句必須與稽核檢查用的範本是同一種語言。

```bash
npx degit eyesofkids/dowafu/publish/zh-tw#v0.6.0 .claude-pack   # 或 publish/en

cd .claude-pack
TARGET=<your project>
mkdir -p "$TARGET/.claude/skills" "$TARGET/.claude/agents" "$TARGET/.agents/skills"

cp -R .claude/skills/. "$TARGET/.claude/skills/"
cp -R .agents/skills/. "$TARGET/.agents/skills/"
cp .claude/agents/*.md "$TARGET/.claude/agents/"
cp workflow_spec.md "$TARGET/"
```

抓完跑 `dowafu --doctor` 確認 lens 都認得出來。

詳細內容請參考該語言目錄下的 README：

```text
publish/zh-tw/README.md   （或 publish/en/README.md）
```

兩份各自以該語言撰寫。

## 接成 MCP server

Agent 可以不走 shell，改用 MCP 驅動 `dowafu`。露出五個 tool：`dispatch_tickets`、
`dispatch_submit`、`dispatch_status`、`dispatch_result`、`dispatch_approve`。

有兩條路，差別在**誰啟動誰**。

| | stdio | HTTP |
| --- | --- | --- |
| 指令 | `dowafu mcp` | `dowafu serve` |
| 誰啟動 | client 自己 spawn | 你，在自己的終端機 |
| Token | 沒有，也不需要 | 必要（`x-api-key`） |
| 會跑 reviewer 嗎 | **不會** | 會 |

### 兩條路都需要 `dowafu serve`

`dowafu mcp` 只回應 tool 呼叫，**它不執行任何 reviewer**。真正花錢的 worker 在
`dowafu serve` 裡。沒有它，核准過的 job 永遠不會執行——`dispatch_submit`、`dispatch_approve`、
`dispatch_status` 都會印一行 `⚠` 說明這件事。

```
stdio：  你的 client ──spawn──→ dowafu mcp ──┐
                                             ├─ 同一個 SQLite 資料庫
         你的終端機 ─────────→ dowafu serve ─┘  （worker 在這邊）

HTTP：   你的 client ──x-api-key──→ dowafu serve  （端點與 worker 同一個行程）
```

所以走 stdio 時，要在 client 旁邊另開一個終端機讓 `dowafu serve` 跑著。**要先起 daemon，再核准。**
daemon 只執行它在線期間核准的 job：它啟動時、以及停止時，還停在「已核准」的 job 會被退回待核准，
所以在 daemon 起來之前給的核准要再給一次。`dowafu serve` 會印出退回了幾張。

### stdio

把 client 指到那條指令。以 Claude Code 為例：

```bash
claude mcp add dowafu -- dowafu mcp
```

不涉及 token：client 直接 spawn 那個行程，信任邊界是作業系統，中間沒有網路可攔。

### HTTP

`dowafu serve` 綁 `127.0.0.1:7391/mcp`——**只綁 loopback，沒有 `--host` 旗標**。要不要對外
是 tunnel 的事，不是 server 的事。改埠用 `--http-port <port>` 或環境變數 `DOWAFU_HTTP_PORT`。

每個請求都要帶 token：

```bash
dowafu token issue --label laptop   # 明文只印這一次，不會存下來
```

資料庫只存它的 SHA-256 hash，比對是常數時間。把明文填進 client 的 MCP 設定，header 名稱是
`x-api-key`。`dowafu token list` 看有哪幾把（不顯示明文）、`dowafu token revoke <id>` 撤銷。
限流是**以 token 計，不是以 IP 計**——tunnel 後面每個請求的來源位址都一樣。

> **daemon 要先起，client 才起。** 反過來的話 client 會把 server 標成失敗、那個對話完全沒有
> tool——**症狀跟設定寫錯一模一樣**。

### 讓 daemon 一直跑著

沒有東西會在需要時把 `dowafu serve` 喚醒——client 是連上一個**已經在監聽**的 socket，
沒有行程在聽就沒有東西可被喚醒。交給作業系統讓它保持啟動。

**macOS**——`~/Library/LaunchAgents/dowafu.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dowafu</string>
  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/to/dowafu</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/Library/Logs/dowafu.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/dowafu.err</string>
</dict>
</plist>
```

用 `launchctl load -w ~/Library/LaunchAgents/dowafu.plist` 載入。

**Linux**——`~/.config/systemd/user/dowafu.service`：

```ini
[Unit]
Description=dowafu dispatch daemon

[Service]
ExecStart=/absolute/path/to/dowafu serve
Restart=always

[Install]
WantedBy=default.target
```

用 `systemctl --user enable --now dowafu` 啟用。

三個會咬人的地方：

- **路徑要寫絕對路徑。** launchd 與 systemd 都看不到你 shell 的 `PATH`。跑 `which dowafu`，
  把它印出來的東西原樣貼進去。
- **環境變數同樣不會繼承。** 如果你的 shell 設了 `DISPATCH_HOME` 或 `XDG_CONFIG_HOME`，
  daemon 看不到它們，會解析到**另一個資料庫**——裡面沒有你的 key，也沒有你的工單。
  要用就寫進 unit 裡。
- **輸出要導到檔案。** 變成背景服務之後就沒有終端機可以看了，而埠被占用、或某支審查者死掉，
  訊息都出現在那裡。把 stdout 與 stderr 指到你找得到的檔案。

daemon 常駐之後，stdio 那條路不需要任何額外動作——`dowafu mcp` 會找到已經在跑的 worker。
這時自己再打 `dowafu serve` 會被擋下並回報 `daemon already running (pid N)`：
**那是守衛在運作，不是故障。**

### 停止與重啟

`dowafu serve --stop` 停掉 daemon；`dowafu serve --restart` 停掉之後再起一支新的
（沒在跑的話就直接起）。有東西會受影響時，兩者都會先分開問兩件事：

- **還在執行的 job**——停掉 daemon 不會停掉已經在跑的審查者，它會跑完，結果與 API 成本照樣記帳。
- **已核准但還沒開始的 job**——會退回待核准，下一支 daemon 沒有新的核准就不會跑它們。

沒有終端機可以回答時（agent 代為呼叫、腳本），問題一律視為「不要」，什麼都不會停；要繼續就帶 `--yes`。

daemon 收到 SIGTERM 卻沒停下來時，`--stop` 會明說並印出要檢查的 pid。**不要改用 SIGKILL**：
審查者的 worker 行程可能比 daemon 活得久，照樣會寫入結果。停掉之後 daemon 馬上又回來，
代表有服務管理器（上面的 `KeepAlive`／`Restart=always`）在重拉它——那要用 `launchctl` 或 `systemctl` 停。

### 核准仍然是獨立的一步

`dispatch_submit` 只把 job 排進佇列就停下，核准之前不會計費。兩種核准方式：在自己的終端機下
`dowafu approve <id>`，或用 `dispatch_approve` tool——後者要求帶上這張 job 的硬上限金額，且
必須與資料庫自己算出來的相符，所以 agent 沒辦法核准一張它沒有把成本攤給你看過的 job。

## License

MIT