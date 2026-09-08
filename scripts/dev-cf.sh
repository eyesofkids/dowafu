#!/usr/bin/env bash
# 起 cloudflared tunnel。token 從 .env 讀，不寫在 package.json、也不進 argv。
#
# 為什麼不是 `cloudflared tunnel run --token <值>`：
#   1. 寫死在 package.json 就是進版控——2026-09-03 才從那裡搬出來，git 歷史裡還留著一份
#   2. 就算改成 `--token "${CLOUDFLARE_TOKEN}"`，token 仍會出現在 process 的 argv，
#      `ps aux` 任何本機使用者都看得到。cloudflared 支援 ${TUNNEL_TOKEN}，走那條不經 argv
#
# 為什麼不在 npm script 裡 `set -a && . ./.env`：
#   那會把 .env 裡的四把 provider 金鑰一起 export 進 cloudflared 的環境。
#   cloudflared 不需要它們，本腳本只挑 CLOUDFLARE_TOKEN 這一個。
set -euo pipefail

ENV_FILE="${CLOUDFLARE_ENV_FILE:-$(cd "$(dirname "$0")/.." && pwd)/.env}"

if [ ! -f "${ENV_FILE}" ]; then
  echo "找不到 ${ENV_FILE}。請複製 .env.example 並填入 CLOUDFLARE_TOKEN。" >&2
  exit 1
fi

# 只取這一個 key，且不經過 shell 展開——值裡的引號或 $ 不會被解讀。
TOKEN="$(sed -n 's/^CLOUDFLARE_TOKEN=//p' "${ENV_FILE}" | head -1 | tr -d '\r')"
TOKEN="${TOKEN%\"}"; TOKEN="${TOKEN#\"}"
TOKEN="${TOKEN%\'}"; TOKEN="${TOKEN#\'}"

# fail closed：空值交給 cloudflared 只會得到一個與成因無關的錯誤訊息。
if [ -z "${TOKEN}" ]; then
  echo "${ENV_FILE} 裡沒有 CLOUDFLARE_TOKEN（或值是空的）。" >&2
  exit 1
fi

echo "cloudflared tunnel run（token 取自 ${ENV_FILE}，長度 ${#TOKEN}）" >&2
TUNNEL_TOKEN="${TOKEN}" exec cloudflared tunnel run "$@"
