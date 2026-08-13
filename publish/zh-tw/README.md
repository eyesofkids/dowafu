# publish/ — 要複製到別的專案去用的東西

三樣，落地位置各不相同：

| 這裡的 | 落到目標專案的 | 是什麼 |
| --- | --- | --- |
| `.claude/skills/<name>/` | `.claude/skills/<name>/` | skill——給讀這個目錄的 host |
| `.agents/skills/<name>/` | `.agents/skills/<name>/` | 同樣的 skill，給讀開放規格目錄的 host |
| `.claude/agents/*.md` | `.claude/agents/` | lens 定義——spoke 的 system prompt 來源 |
| `workflow_spec.md` | 專案根目錄 | 規劃→實作→驗收流程規範 |

> **`.claude/agents/` 不要跟著搬。** 那是 CLI 硬編的路徑（`--repo-root` 底下的
> `.claude/agents`），跟 host 讀哪裡無關——它是工具在讀，不是 agent 在讀。

## 安裝

```bash
TARGET=<目標專案路徑>
mkdir -p "$TARGET/.claude/skills" "$TARGET/.claude/agents" "$TARGET/.agents/skills"
cp -R .claude/skills/. "$TARGET/.claude/skills/"
cp -R .agents/skills/. "$TARGET/.agents/skills/"
cp .claude/agents/*.md "$TARGET/.claude/agents/"
cp workflow_spec.md "$TARGET/"
```

**全部整檔覆蓋**，沒有需要手工拼接的部分。

> **`.claude/` 與 `.agents/` 兩個都要複製，不要因為「這個專案不用 Claude」就跳過
> `.claude/`。** 底下的 `agents/` 是 CLI 的資料目錄——它是工具在讀，跟你的 agent 是誰
> 無關。漏了的話乾跑會中止並印出它找不到的路徑（不會花到錢），但你得回頭補一次。

裝完之後在目標專案跑 **`preflight`**——它會檢查接線有沒有做、環境有沒有把流程靜默停用。
這些失效**都不會報錯**，只會安靜地讓流程不生效。

**skill 不保證是 `/` 指令。** 有的 host 會自動掛載這兩個目錄並提供 `/名稱`，有的兩者
都沒有。叫不動的話直接指名檔案：「照 `.agents/skills/preflight/SKILL.md` 執行」。

### 兩份 skill 的關係

`.agents/skills/` 那份是從 `.claude/skills/` 衍生的——**內容相同，只拿掉了只有特定
host 才成立的段落**。它的 frontmatter `metadata` 記著來源檔的 sha256，來源改了、衍生版
沒跟上，發佈前檢查會擋下來。**要改一律改 `.claude/skills/` 那份**，再回頭看衍生版。

## 把 `workflow_spec.md` 接進目標專案

Claude Code **讀 `CLAUDE.md`、不讀 `AGENTS.md`**；而 `AGENTS.md` 規格本身**沒有定義任何
import 機制**。兩種讀者得分別交代，否則其中一邊會靜默漏讀整份規範。

在目標專案的 `AGENTS.md` 尾端加：

```markdown
## 工作流程規範

見 `workflow_spec.md`（專案根目錄）。下一行的 `@` 是 Claude Code 的 import 語法，
會自動載入該檔；其他工具請自行開啟。

@workflow_spec.md
```

三個細節，弄錯了不會報錯、只會安靜地沒作用：

- **`@` 不能包在反引號裡**——包了就是字面文字，不會 import
- 路徑**相對於含 import 的那個檔**，不是相對工作目錄
- import 可遞迴，上限**四層**；`CLAUDE.md` → `AGENTS.md` → `workflow_spec.md` 是兩層

目標專案若沒有 `CLAUDE.md`，另建一個、內容一行 `@AGENTS.md` 即可（官方建議做法）。

### 專案本來就有一章流程規範時

很多專案本來就有一份，直接貼在入口檔裡——而且語言可能跟你剛裝的這套不同，因為每個語言
套件各帶各的 `workflow_spec.md`。就這樣把檔案複製進去，專案裡會變成**兩份、而且沒有任何
機制保證同步**；真正管到每個 session 的是入口檔會自動載入的那一份——**是本來就在的那章，
不是你剛裝的那個檔**。

二選一，另一份要拿掉：

- **留 `workflow_spec.md`**（建議）：把入口檔裡舊的那一章刪掉，換成上面那段 import
- **留內嵌的那一章**：把它的內容換成你要統一的語言那份 `workflow_spec.md` 的內容，
  並且**不要**把 `workflow_spec.md` 複製進專案

不論走哪一條，專案裡最後**只留一份**。裝完跑一次 `preflight`——它會回報實際在 context
裡的是哪一份，所以這個決定就算漏掉了，還有一道會抓到。

## 這裡不准出現的東西

`publish/` 的內容會在一個不知道來源專案存在的地方執行，所以不得出現絕對路徑、來源專案的
名稱與文件檔名、只有來源專案成立的指令，以及實測數字與樣本數討論（那些是依據，不是操作）。

例外：`_docs/` 這個名字可以出現——它是 CLI 硬編的 spoke 禁區，屬工具層保留目錄。

同步前先跑來源專案的發佈前檢查，它會把上面這些掃一遍。
