#!/usr/bin/env bash
# 發佈前檢查：掃 publish/ 有沒有本 repo 的痕跡。
#
# publish/ 的內容會被複製到一個對本 repo 一無所知的專案裡執行——任何指向這裡的
# 絕對路徑、文件檔名或專屬指令，在那邊都是死的。這支腳本只查得到「機械性」的洩漏；
# 屬於判斷的部分（實測數字該不該留、立場與最新裁示一不一致）見
# .claude/skills/publish-check/SKILL.md 的清單。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$ROOT/publish"

if [ ! -d "$TARGET" ]; then
  echo "找不到 $TARGET"
  exit 2
fi

fail=0

check() {
  local label="$1" pattern="$2" hint="$3"
  local hits
  hits=$(grep -rnE "$pattern" "$TARGET" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "✗ $label"
    printf '%s\n' "$hits" | sed "s|^$TARGET/|    publish/|"
    echo "  → $hint"
    echo
    fail=1
  fi
}

echo "掃描 $TARGET"
echo

check "絕對路徑" \
  '/(Users|Volumes|home)/' \
  "改成相對路徑，或改成「請使用者提供」"

check "本 repo 名稱" \
  'ai-workflow-hub-spoke' \
  "外部專案不知道這個 repo 叫什麼"

# 只抓帶版號／帶主題的**具體檔名**。`issue_log`／`report`／`runbook` 這些
# 光禿禿的名詞是流程規範裡的文件類別（六種文件），屬通用詞彙，不算洩漏。
check "本 repo 的文件檔名" \
  '(issue_log_v[0-9]|plan_dispatch|plan_lens_bench|facts_dispatch|decision_dispatch|runbook_dispatch|handoff_dispatch|quickstart_dispatch|report_v[0-9])' \
  "那些檔只存在於本 repo 的 _docs/。理由要寫進 publish 的文件本身，或整句拿掉"

check "_docs 底下的具體路徑" \
  '_docs/[a-z][a-z-]+/' \
  "_docs/ 這個名字可以出現（CLI 硬編的 spoke 禁區），但底下的子目錄是本 repo 的"

check "其他專案名稱" \
  '(igopms|real-run-same-lens)' \
  "那是測試素材與實驗記錄所在的專案，與外部使用者無關"

# 衍生版（.agents/skills）與來源（.claude/skills）的同步檢查。
# 兩者內容刻意不同——衍生版拿掉了只有某一種 host 才成立的段落——所以不能逐位元組比對。
# 改成在衍生版的 frontmatter 記下來源檔的 sha256：來源一改、雜湊就對不上，
# 逼你回來看衍生版要不要跟著改。漏改是靜默的，這條就是為了讓它出聲。
check_derived() {
  local name="$1"
  local src="$TARGET/.claude/skills/$name/SKILL.md"
  local dst="$TARGET/.agents/skills/$name/SKILL.md"
  [ -f "$src" ] && [ -f "$dst" ] || { echo "✗ $name 少了一邊"; echo; fail=1; return; }
  local want have
  want=$(shasum -a 256 "$src" | cut -d' ' -f1)
  have=$(grep -o 'derived-from-sha256: "[0-9a-f]*"' "$dst" | cut -d'"' -f2)
  if [ "$want" != "$have" ]; then
    echo "✗ $name 的來源已變動，衍生版沒跟上"
    echo "    來源 publish/.claude/skills/$name/SKILL.md  $want"
    echo "    衍生 publish/.agents/skills/$name/SKILL.md  ${have:-（沒記）}"
    echo "  → 檢視衍生版要不要跟著改，改完把新的 sha 填回它的 frontmatter"
    echo
    fail=1
  fi
}

for s in find-holes-external preflight wrap; do check_derived "$s"; done

if [ "$fail" -eq 0 ]; then
  echo "✓ 沒有機械性洩漏"
  echo
  # 判斷清單放在一支本地 skill 裡，那支不隨 publish/ 出貨，所以不是每個 checkout 都有。
  # 沒有的話照樣要人工看一遍，只是沒有現成清單可循——這裡不假裝它一定在。
  if [ -f "$ROOT/.claude/skills/publish-check/SKILL.md" ]; then
    echo "接著走 .claude/skills/publish-check/SKILL.md 的判斷清單——"
  else
    echo "接著人工看一遍——"
  fi
  echo "grep 查不到「實測數字該不該留」「立場與最新裁示一不一致」這類問題。"
fi

exit "$fail"
