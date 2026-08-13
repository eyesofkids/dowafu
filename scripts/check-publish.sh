#!/usr/bin/env bash
# publish/ 的發佈前檢查，兩段職責：
#
# 一、**衍生 skill 的同步**——`.agents/skills/` 是從 `.claude/skills/` 衍生的，來源改了
#     衍生版沒跟上是靜默的。這段永遠執行，因為它守的是這個 repo 真的會出貨的東西。
#
# 二、**洩漏掃描**（絕對路徑、內部文件檔名、專案名⋯）——樣式讀自 scripts/leak-patterns.local。
#     樣式本身就是要藏的東西，寫死在這裡等於把它們複製到每個同步目的地；沒有那個檔就
#     不跑這段，因為沒有該檔的地方也不是編輯發生的地方。
#
# 兩段都查不到「判斷題」（實測數字該不該留、立場與最新裁示一不一致）——那要人看。

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

# 專案專屬的洩漏樣式（自己的 repo 名、測試素材所在的專案名⋯）放在單獨一個檔案裡，
# 因為**樣式本身就是要藏的東西**——寫死在這支腳本裡，等於把那些名字複製到每一份
# 這支腳本會被同步到的地方。該檔不隨同步出去；沒有它就只跑上面那幾條通用檢查。
# 格式：每行「標籤<tab>regex<tab>提示」，`#` 開頭與空行略過。
PATTERNS_FILE="$ROOT/scripts/leak-patterns.local"
if [ -f "$PATTERNS_FILE" ]; then
  while IFS=$'\t' read -r label pattern hint; do
    [ -z "${label:-}" ] && continue
    case "$label" in \#*) continue ;; esac
    check "$label" "$pattern" "$hint"
  done < "$PATTERNS_FILE"
fi

# 衍生版（.agents/skills）與來源（.claude/skills）的同步檢查。
# 兩者內容刻意不同——衍生版拿掉了只有某一種 host 才成立的段落——所以不能逐位元組比對。
# 改成在衍生版的 frontmatter 記下來源檔的 sha256：來源一改、雜湊就對不上，
# 逼你回來看衍生版要不要跟著改。漏改是靜默的，這條就是為了讓它出聲。
#
# T6：publish/ 分語言之後，同一組 skill 在 en/ 與 zh-tw/ 底下各有一份，兩邊都要查——
# 語言迴圈包在外層，「少了一邊」（整個語言目錄漏放某個 skill）跟「來源改了衍生版沒跟上」
# 是兩種不同的漏，都要各自的語言都抓到。
check_derived() {
  local lang="$1" name="$2"
  local src="$TARGET/$lang/.claude/skills/$name/SKILL.md"
  local dst="$TARGET/$lang/.agents/skills/$name/SKILL.md"
  [ -f "$src" ] && [ -f "$dst" ] || { echo "✗ $lang/$name 少了一邊"; echo; fail=1; return; }
  local want have
  want=$(shasum -a 256 "$src" | cut -d' ' -f1)
  have=$(grep -o 'derived-from-sha256: "[0-9a-f]*"' "$dst" | cut -d'"' -f2)
  if [ "$want" != "$have" ]; then
    echo "✗ $lang/$name 的來源已變動，衍生版沒跟上"
    echo "    來源 publish/$lang/.claude/skills/$name/SKILL.md  $want"
    echo "    衍生 publish/$lang/.agents/skills/$name/SKILL.md  ${have:-（沒記）}"
    echo "  → 檢視衍生版要不要跟著改，改完把新的 sha 填回它的 frontmatter"
    echo
    fail=1
  fi
}

for lang in en zh-tw; do
  for s in find-holes-external preflight wrap; do check_derived "$lang" "$s"; done
done

if [ "$fail" -eq 0 ]; then
  # 「通過」要講清楚是通過了什麼。沒有樣式檔的地方沒跑洩漏掃描，卻印「沒有洩漏」，
  # 那是這個專案最不想要的那種訊息——看起來查過了，其實整段沒執行。
  echo "✓ 衍生 skill 與來源同步"
  if [ -f "$PATTERNS_FILE" ]; then
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
  else
    echo "（未跑洩漏掃描：找不到 scripts/leak-patterns.local，此處不是編輯發生的地方）"
  fi
fi

exit "$fail"
