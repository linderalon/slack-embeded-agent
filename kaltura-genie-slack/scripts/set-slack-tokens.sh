#!/usr/bin/env bash
# Asks for the test Slack app's tokens (input hidden) and writes them into ./.env.
set -euo pipefail
cd "$(dirname "$0")/.."
read -rsp "Paste SLACK_BOT_TOKEN (xoxb-...), then Enter: " BOT; echo
read -rsp "Paste SLACK_APP_TOKEN (xapp-...), then Enter: " APPT; echo
[[ "$BOT" == xoxb-* ]] || { echo "That bot token doesn't start with xoxb-. Nothing saved."; exit 1; }
[[ "$APPT" == xapp-* ]] || { echo "That app token doesn't start with xapp-. Nothing saved."; exit 1; }
umask 077
grep -v -E '^SLACK_(BOT|APP)_TOKEN=' .env > .env.tmp || true
printf 'SLACK_BOT_TOKEN=%s\nSLACK_APP_TOKEN=%s\n' "$BOT" "$APPT" >> .env.tmp
mv .env.tmp .env
echo "Saved both tokens to .env. You can close this tab."
