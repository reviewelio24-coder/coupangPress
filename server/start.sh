#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8787}"

if lsof -ti ":$PORT" >/dev/null 2>&1; then
  echo "포트 $PORT 사용 중 — 기존 프로세스 종료..."
  lsof -ti ":$PORT" | xargs kill 2>/dev/null || true
  sleep 1
fi

if [ ! -d node_modules ]; then
  echo "npm install 실행 중..."
  npm install
fi

echo ""
echo "서버 시작 — 이 터미널 창을 닫지 마세요."
echo "브라우저: http://127.0.0.1:$PORT"
echo ""
echo "※ 크롤링이 실패하면: npx playwright install chromium"
echo ""

exec node index.js
