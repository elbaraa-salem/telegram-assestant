#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--dns-result-order=ipv4first"

if [[ -n "${LOCAL_SOCKS_PROXY:-}" ]]; then
  export ALL_PROXY="$LOCAL_SOCKS_PROXY"
  export HTTPS_PROXY="$LOCAL_SOCKS_PROXY"
  export HTTP_PROXY="$LOCAL_SOCKS_PROXY"
  echo "Using local proxy for network requests: $LOCAL_SOCKS_PROXY"
fi

ADMIN_PID=""
LISTENER_PID=""

cleanup() {
  if [[ -n "${ADMIN_PID}" ]]; then
    kill "${ADMIN_PID}" 2>/dev/null || true
  fi

  if [[ -n "${LISTENER_PID}" ]]; then
    kill "${LISTENER_PID}" 2>/dev/null || true
  fi

  pkill -f "tsx src/web/server.ts" || true
  pkill -f "tsx src/services/telegramListener.ts" || true
}

run_with_retries() {
  name="$1"
  shift
  max_attempts="${RETRY_ATTEMPTS:-5}"
  delay_seconds="${RETRY_DELAY_SECONDS:-5}"
  invalid_google_token_message="Google token is invalid or expired. Run npm run google:auth."

  attempt=1
  while [ "$attempt" -le "$max_attempts" ]; do
    echo "Running $name attempt $attempt/$max_attempts..."
    output_file="$(mktemp)"
    if "$@" 2>&1 | tee "$output_file"; then
      rm -f "$output_file"
      echo "$name succeeded"
      return 0
    fi

    if grep -q "invalid_grant" "$output_file" || grep -q "$invalid_google_token_message" "$output_file"; then
      rm -f "$output_file"
      echo "$invalid_google_token_message"
      return 1
    fi

    rm -f "$output_file"
    echo "$name failed attempt $attempt/$max_attempts"
    attempt=$((attempt + 1))

    if [ "$attempt" -le "$max_attempts" ]; then
      echo "Waiting ${delay_seconds}s before retry..."
      sleep "$delay_seconds"
    fi
  done

  echo "$name failed after $max_attempts attempts"
  return 1
}

require_env() {
  name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: $name"
    return 1
  fi
}

check_google_oauth_connectivity() {
  curl -I --connect-timeout 10 https://oauth2.googleapis.com/token >/dev/null
}

required_env_vars=(
  TEST_STUDENT_NAME_RU
  TEST_STUDENT_NAME_AR
  TEST_STUDENT_TELEGRAM_USERNAME
  TEST_STUDENT_CALENDAR_KEYWORD
  TG_API_ID
  TG_API_HASH
  TG_PHONE
  TG_SESSION
  OPENROUTER_API_KEY
  OPENROUTER_MODEL
)

trap cleanup INT TERM EXIT

pkill -f "tsx src/web/server.ts" || true
pkill -f "tsx src/services/telegramListener.ts" || true
pkill -f "tsx src/services/reminderService.ts" || true
pkill -f "tsx src/services/calendarSync.ts" || true
pkill -f "tsx src/scripts" || true

for env_var in "${required_env_vars[@]}"; do
  require_env "$env_var"
done

rm -f data/app.db data/app.db-wal data/app.db-shm
rm -f data/.fuse_hidden*
rm -rf data/receipts
mkdir -p data/receipts

npm run build:css
npm run typecheck
npm run seed:test-student
run_with_retries "sync:telegram-ids" npm run sync:telegram-ids

if ! run_with_retries "Google OAuth connectivity check" check_google_oauth_connectivity; then
  echo "Google OAuth endpoint is not reachable. Start VPN/proxy and run npm run dev:full-test again."
  exit 1
fi

run_with_retries "calendar sync first run" \
  env CALENDAR_SYNC_DAYS_AHEAD=3 \
  CALENDAR_SYNC_MAX_LESSONS_PER_STUDENT=1 \
  CALENDAR_SYNC_VERBOSE_MATCHED=true \
  npm run sync:calendar

run_with_retries "calendar sync second idempotency run" \
  env CALENDAR_SYNC_DAYS_AHEAD=3 \
  CALENDAR_SYNC_MAX_LESSONS_PER_STUDENT=1 \
  CALENDAR_SYNC_VERBOSE_MATCHED=true \
  npm run sync:calendar

npm run admin &
ADMIN_PID=$!

sleep 2

TELEGRAM_LISTENER_POLL_INTERVAL_MS=5000 \
TELEGRAM_LISTENER_POLL_LIMIT=5 \
npm run listen:telegram &
LISTENER_PID=$!

sleep 8

run_with_retries "send:reminders" npm run send:reminders

echo "Local full test is running"
echo "Admin: http://localhost:3000"
echo "Now reply from Telegram with 1, then click تم الدرس, then send PDF."

wait
