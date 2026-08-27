// 로컬 대시보드 탭에서 실행 — 서비스 워커를 깨워 브릿지 하트비트 유지
(function bridgePageKeepAlive() {
  function ping() {
    try {
      chrome.runtime.sendMessage({ type: 'BRIDGE_PING' }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {
      /* ignore */
    }
  }

  ping();
  setInterval(ping, 2000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) ping();
  });
})();
