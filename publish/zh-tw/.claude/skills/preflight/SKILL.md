---
name: preflight
description: 開工前檢查這個專案的環境有沒有把工作流程靜默停用：流程規範那一章的內容讀不讀得到、skill 與 lens 齊不齊、tmp/ 有沒有被 gitignore。Claude Code 另查 auto-compact 與 subagent 模型；其他 host 另查 dowafu 跑不跑得起來。只讀、只報告，不改任何設定。
---

# preflight — 環境前置檢查

**第一次在一個專案用這套流程之前，先跑這個。** 派工、實作、收尾都做完了才發現環境早就
把流程靜默停用，那整段工是白做的。

假設你面對的是一個**完全沒接觸過這套東西**的專案：可能一樣都沒裝、可能裝一半、
可能檔案都在、但你其實讀不到。三種狀態要分得出來，而且**它們都不會報錯**。

> **只讀、只報告，不要改任何設定檔。** 那是使用者的東西，其中幾項還是全域的，動了會
> 影響他所有專案。查完列表，讓他自己決定改不改。

**本文分三節。第 1 節所有人都要查，第 2、3 節二選一：**

| 你是 | 查哪些 |
| --- | --- |
| 任何 agent | 第 1 節 |
| **Claude Code** | 第 1 節 ＋ **第 2 節** |
| **其他 host** | 第 1 節 ＋ **第 3 節**（第 2 節那幾項對你不存在，查了只會得到一堆「查不到」） |

> **判準是「誰在跑你」，不是「你背後是哪個模型」。** Claude Code 用 `settings.json` 接
> 相容 API 或別家模型當 BYOK 時，它**仍然是 Claude Code**——`autoCompactEnabled`、
> `CLAUDE_CODE_SUBAGENT_MODEL` 那些照樣生效，走第 2 節。反過來，別的 host 就算選了
> Claude 當模型，也走第 3 節。
>
> **不確定就兩節都查**，把查不到的如實標成「查不到」。

---

## 1. 不分環境都要查

指令在 repo 根目錄下跑。**你的工作目錄不保證落在哪裡，先 `cd` 過去再說。**

```bash
cd <repo 根的絕對路徑>

echo "=== 流程規範 ==="
ls CLAUDE.md AGENTS.md workflow_spec.md 2>&1
# 這條只幫你定位「內容寫在哪個檔」。它有命中 ≠ 你讀得到——判準見下。
grep -n "規劃→實作→驗收流程規範" CLAUDE.md AGENTS.md workflow_spec.md 2>/dev/null

echo "=== skill 與 lens ==="
ls .claude/skills/ 2>/dev/null
ls .claude/agents/hole-finder-*.md 2>/dev/null

echo "=== tmp/ ==="
git check-ignore -q tmp && echo "已忽略" || echo "未忽略"
```

### 流程規範讀不讀得到

**判準只有一條：「規劃→實作→驗收流程規範（主從形態）」這一章的內容，你現在讀得到嗎？**

讀得到就算通過。內容是直接貼在入口檔裡、還是用 `@` 之類的方式引入的，**那是使用者的
選擇，不在檢查範圍內**。

讀不到就標成不符合，然後**自己去找一下**（多半在 repo 根的 `workflow_spec.md`），
讀完在回報裡註明「規範不在自動載入範圍內，本次是手動讀取的」——讓使用者知道換個
session 又會漏掉。

> **為什麼會讀不到？** 入口檔因 host 而異：Claude Code 讀 `CLAUDE.md`（**不讀
> `AGENTS.md`**），其他 host 多半讀 repo 根的 `AGENTS.md`。而 `@xxx.md` 是 Claude Code
> 的 import 語法，**別的 host 不會展開它**——那時你看到的只是一行字，規範內容從來沒進
> 過你的 context。這不代表專案設定錯了，是你這一側的差異。

### skill 與 lens

`.claude/skills/find-holes-external/` 與 `.claude/agents/hole-finder-*.md` 在不在。
（後者 glob 會列出通用的 `hole-finder.md` 加三個 lens，四個都算正常。）

**lens 缺了不要自己補寫**——它是 spoke 的 system prompt 來源，自己寫的版本會讓產出跟
稽核判準對不上。

### `tmp/`

未被 gitignore 就標成不符合：spoke 回報含規劃書原文，會被 commit 進版控。
**不要自己改 `.gitignore`**，問使用者。

---

## 2. 如果你是 Claude Code 的 agent

下面兩項只影響 **Claude Code 自己的內派 sub-agent**。外派（`find-holes-external` 走
`dowafu`）的 spoke 模型由工單的 `_dispatch.md` 決定，**不受這兩項影響**——
這個專案只跑外派的話，這一節查了也不會改變什麼。

```bash
cd <repo 根的絕對路徑>

echo "=== settings（由低到高優先序）==="
for f in ~/.claude/settings.json .claude/settings.json .claude/settings.local.json; do
  [ -f "$f" ] && { echo "--- $f"; cat "$f"; }
done

echo "=== 環境變數 ==="
echo "DISABLE_AUTO_COMPACT=${DISABLE_AUTO_COMPACT:-（未設）}"
echo "CLAUDE_CODE_SUBAGENT_MODEL=${CLAUDE_CODE_SUBAGENT_MODEL:-（未設）}"

echo "=== agent 定義的模型 ==="
grep -H "^model:" .claude/agents/*.md 2>/dev/null || echo "（沒有 agent 定義，或都沒指定 model）"

echo "=== 主模型與 effort ==="
grep -h "\"model\"\|\"effortLevel\"" ~/.claude/settings.json .claude/settings.json .claude/settings.local.json 2>/dev/null || echo "（未設，用預設）"
```

### auto-compact

**`autoCompactEnabled` 沒有出現在任何一層 settings ＝ 不符合**，因為它的預設值是 `true`。
不要把「沒看到設定」讀成「沒問題」——那會讓這條檢查永遠通過。

流程規範要求 context 吃緊時走 `/wrap` 交接、關 session 重啟，而不是 compact
（compact 是有損壓縮，壓完之後熱 session 的價值已經沒了）。

相關的還有 `autoCompactWindow`（100000–1000000）與環境變數 `DISABLE_AUTO_COMPACT`。

### subagent 模型

`settings.json` **沒有**「預設 subagent 模型」這個鍵——但**有一個環境變數會一刀切**。
解析順序由高到低四層，**全部攤出來給使用者看**：

1. **`CLAUDE_CODE_SUBAGENT_MODEL` 環境變數**（設成別名或 model ID 時）
2. 每次呼叫傳入的 `model` 參數
3. `.claude/agents/*.md`（或 `~/.claude/agents/`）的 `model:` frontmatter
4. 主對話的模型（frontmatter 省略時的預設就是這個）

**第 1 層會蓋掉所有 agent 定義檔的 `model:`**，包含刻意設成 opus 的那些——
「一設下去內派全變輕量模型」就是它。而且它是**全域的，在 A 專案設的會影響 B 專案**。

`availableModels` 允許清單會再過濾上面三層：被擋的家族別名換成該家族允許的最新版本，
其他情況**退回繼承主對話的模型**。所以 frontmatter 寫 `model: opus` **不保證跑 opus**。

**只查其中一層就回報「沒問題」會漏掉最常見的那個。**

**壓低的後果是靜默的**：內派 sub-agent 全部變成輕量模型，找漏洞照跑、照產出、照收尾，
只是品質整個掉下來，沒有任何地方會提示。

---

## 3. 如果你不是 Claude Code 的 agent

第 2 節那兩項對你不存在，跳過。你要確認的是下面三件事，**按這個順序**——前一項不成立，
後面查了也沒有意義。

### 一、`dowafu` 在哪、跑不跑得起來

**這是首要條件。** 工具起不來，工單寫得再好都派不出去；等到派工當下才發現，
會白費一次組工單的工。

```bash
dowafu --version
```

印得出版本號就過。印不出來只有兩種情況：

| 症狀 | 意思 | 怎麼回報 |
| --- | --- | --- |
| `Operation not permitted` | **沙箱擋的**，不是沒安裝。CLI 多半裝在家目錄底下，而沙箱預設不讀家目錄 | 照 host 的提示放行後重試。順帶告訴使用者：API key（`~/.config/dowafu/.env`）與對外網路同樣被擋，派工時一併要放行 |
| `command not found` | 可能沒裝，也可能裝在 PATH 之外 | 問使用者 CLI 裝在哪（請他跑 `which dowafu`），**不要自己搜檔案系統** |

**`command -v dowafu` 查不到不代表沒安裝**，別拿那個當判準。

### 二、lens 定義與 skill 在不在

見第 1 節的「skill 與 lens」。有一點對你特別重要：

**lens 定義是 CLI 要讀的，不是你要讀的。** 它是 `dowafu` 組 spoke system prompt
的來源，你只要確認**檔案在**就好，不必自己讀懂內容。skill 才是你要讀的。

### 三、流程規範的內容，在你讀得到的地方

見第 1 節的「流程規範讀不讀得到」，判準相同：**那一章的內容，你現在讀得到嗎。**

**這一項你比 Claude Code 更容易踩空**，值得多看一眼。`@xxx.md` 是 Claude Code 的 import
語法，你不會展開它——入口檔裡若只有那一行，你看到的就是一行字，而**你很可能以為自己
已經讀過規範了**。實際檢查你的 context 裡有沒有那章的內容，別憑印象。

---

## 4. 輸出

一張表，最多一頁：

| 項目 | 狀態 | 現況 | 怎麼改 |
| --- | :-: | --- | --- |
| 流程規範 | ✗ | 「規劃→實作→驗收流程規範」那章的內容不在我的 context 裡；已手動讀取 `workflow_spec.md` 補上 | 若希望每個 session 都自動載入，需調整入口檔的接法 |
| `tmp/` | ✓ | 已被 `.gitignore` 忽略 | — |

**表格開頭先寫明你是哪種 host、走的是第 2 節還是第 3 節**，不要讓使用者以為沒查的那幾項
已經查過了。

**「查不到」要跟「符合」分開標。** 讀不到某個檔、或某項無法判定時，如實寫查不到，
不要當成通過——這個 skill 存在的理由就是抓靜默失效，自己先靜默失效就沒有意義了。
