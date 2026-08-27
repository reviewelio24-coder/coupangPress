// 백그라운드: 웹 대시보드 연동(작업 큐) + 다중 상품 크롤링
console.log('쿠팡 리뷰 크롤러 백그라운드');

const DEFAULT_API = 'https://review.choineiu.com';
const BRIDGE_ALARM = 'bridge_tick';

/** @type {Map<number, { jobId: string, apiBaseUrl: string, urlIndex: number, urlTotal: number }>} */
const crawlJobsByTabId = new Map();

let bridgePollTimer = null;
let isProcessingClaim = false;

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.get(['bridge_settings'], ({ bridge_settings: prev }) => {
    chrome.storage.local.set({
      coupang_crawler_settings: { maxPages: 5 },
      bridge_settings: {
        enabled: prev?.enabled !== false,
        apiBaseUrl: normalizeApiBaseUrl(prev?.apiBaseUrl || DEFAULT_API)
      }
    });
  });
  startBridgeLoop();
});

chrome.runtime.onStartup.addListener(() => startBridgeLoop());

function normalizeApiBaseUrl(url) {
  const raw = String(url || DEFAULT_API).trim().replace(/\/$/, '');
  if (!raw) return DEFAULT_API;
  // localhost → 127.0.0.1 (일부 환경에서 IPv6(::1)로 가서 실패)
  return raw.replace(/^http:\/\/localhost(?=:\d|$)/i, 'http://127.0.0.1');
}

async function getBridgeSettings() {
  const { bridge_settings: s } = await chrome.storage.local.get(['bridge_settings']);
  return {
    enabled: s?.enabled !== false,
    apiBaseUrl: normalizeApiBaseUrl(s?.apiBaseUrl || DEFAULT_API),
    basicUser: String(s?.basicUser || '').trim(),
    basicPass: String(s?.basicPass || '')
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForTabComplete(tabId, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('페이지 로드 시간 초과'));
    }, timeoutMs);

    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, (tab) => {
      if (tab?.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    });
  });
}

async function injectContentScriptToTab(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return;
  } catch (_) {
    /* not loaded */
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

function basicAuthHeader(user, pass) {
  const raw = `${user}:${pass}`;
  // btoa는 Latin1만 안전. 특수문자 비밀번호용.
  const bytes = new TextEncoder().encode(raw);
  let bin = '';
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return `Basic ${btoa(bin)}`;
}

async function apiFetch(apiBaseUrl, path, options = {}) {
  const settings = await getBridgeSettings();
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  if (settings.basicUser) {
    headers.Authorization = basicAuthHeader(settings.basicUser, settings.basicPass);
  }
  const res = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function runCrawlJob(job, apiBaseUrl) {
  const urlTotal = job.urlTotal || 1;
  const urlIndex = job.urlIndex || 0;
  const label = urlTotal > 1 ? `상품 ${urlIndex + 1}/${urlTotal}` : '상품';

  const tab = await chrome.tabs.create({ url: job.coupangUrl, active: true });
  crawlJobsByTabId.set(tab.id, { jobId: job.id, apiBaseUrl, urlIndex, urlTotal });

  await apiFetch(apiBaseUrl, `/api/jobs/${job.id}/progress`, {
    method: 'PATCH',
    body: JSON.stringify({
      message: `${label} 페이지 로딩 중...`,
      productIndex: urlIndex + 1,
      productTotal: urlTotal
    })
  });

  await waitForTabComplete(tab.id);
  await injectContentScriptToTab(tab.id);
  await sleep(2000);

  await apiFetch(apiBaseUrl, `/api/jobs/${job.id}/progress`, {
    method: 'PATCH',
    body: JSON.stringify({
      message: `${label} 리뷰 크롤링 시작...`,
      productIndex: urlIndex + 1,
      productTotal: urlTotal
    })
  });

  await chrome.tabs.sendMessage(tab.id, {
    type: 'START_CRAWLING',
    maxPages: job.maxPages || 5
  });
}

async function handleJobCrawlComplete(tabId, crawlData) {
  const ctx = crawlJobsByTabId.get(tabId);
  if (!ctx) return;

  try {
    let meta = { title: '', productUrl: '' };
    try {
      meta = await chrome.tabs.sendMessage(tabId, { type: 'GET_PRODUCT_META' });
    } catch (_) {
      /* ignore */
    }

    const res = await apiFetch(ctx.apiBaseUrl, `/api/jobs/${ctx.jobId}/complete`, {
      method: 'POST',
      body: JSON.stringify({
        productUrl: crawlData?.productUrl || meta.productUrl || '',
        productTitle: meta.title || '쿠팡 상품',
        reviews: crawlData?.reviews || [],
        totalReviews: crawlData?.totalReviews || (crawlData?.reviews || []).length,
        pagesCrawled: crawlData?.pagesCrawled
      })
    });

    if (res.done) {
      await showNotification('크롤링 완료', '모든 상품 수집이 끝났습니다.');
    } else {
      await showNotification('상품 완료', res.message || '다음 상품을 이어서 수집합니다.');
    }

    try {
      await chrome.tabs.remove(tabId);
    } catch (_) {
      /* ignore */
    }
  } catch (err) {
    const msg = err.message || String(err);
    // Nginx 504 등: 서버는 글 생성·발행을 계속 처리 중일 수 있음
    if (/HTTP 50[24]/.test(msg)) {
      try {
        await sleep(5000);
        const { job } = await apiFetch(ctx.apiBaseUrl, `/api/jobs/${ctx.jobId}`);
        if (['publishing', 'published', 'completed'].includes(job?.status)) {
          if (job.status === 'published') {
            await showNotification('발행 완료', 'WordPress 글이 저장되었습니다.');
          } else {
            await showNotification('발행 진행 중', '대시보드에서 진행 상황을 확인하세요.');
          }
          try {
            await chrome.tabs.remove(tabId);
          } catch (_) {
            /* ignore */
          }
          return;
        }
      } catch (_) {
        /* ignore */
      }
    }
    await handleJobCrawlError(tabId, msg);
  } finally {
    crawlJobsByTabId.delete(tabId);
  }
}

async function handleJobCrawlError(tabId, errorMessage) {
  const ctx = crawlJobsByTabId.get(tabId);
  if (!ctx) return;
  try {
    await apiFetch(ctx.apiBaseUrl, `/api/jobs/${ctx.jobId}/fail`, {
      method: 'POST',
      body: JSON.stringify({ error: errorMessage || '크롤링 실패' })
    });
  } catch (_) {
    /* ignore */
  }
  crawlJobsByTabId.delete(tabId);
}

async function handleJobProgress(tabId, data) {
  const ctx = crawlJobsByTabId.get(tabId);
  if (!ctx || !data) return;
  try {
    const label = ctx.urlTotal > 1 ? `상품 ${ctx.urlIndex + 1}/${ctx.urlTotal} · ` : '';
    await apiFetch(ctx.apiBaseUrl, `/api/jobs/${ctx.jobId}/progress`, {
      method: 'PATCH',
      body: JSON.stringify({
        currentPage: data.currentPage,
        maxPages: data.maxPages,
        collectedReviews: data.collectedReviews,
        pageReviews: data.pageReviews,
        productIndex: ctx.urlIndex + 1,
        productTotal: ctx.urlTotal,
        message: `${label}페이지 ${data.currentPage}/${data.maxPages} · ${data.collectedReviews}개 수집`
      })
    });
  } catch (_) {
    /* ignore */
  }
}

async function bridgeTick() {
  const settings = await getBridgeSettings();
  if (!settings.enabled) return;

  try {
    await apiFetch(settings.apiBaseUrl, '/api/bridge/heartbeat', { method: 'POST', body: '{}' });
  } catch (err) {
    console.warn('bridge heartbeat 실패:', settings.apiBaseUrl, err.message);
    return;
  }

  if (isProcessingClaim || crawlJobsByTabId.size > 0) return;

  try {
    isProcessingClaim = true;
    const { job } = await apiFetch(settings.apiBaseUrl, '/api/jobs/claim', {
      method: 'POST',
      body: '{}'
    });
    if (job?.id) {
      await runCrawlJob(job, settings.apiBaseUrl);
    }
  } catch (err) {
    console.warn('bridge claim:', err.message);
  } finally {
    isProcessingClaim = false;
  }
}

function startBridgeLoop() {
  if (bridgePollTimer) clearInterval(bridgePollTimer);
  bridgePollTimer = setInterval(bridgeTick, 2500);
  // Chrome 알람 최소 1분 — 대시보드 content script가 더 자주 깨움
  chrome.alarms.create(BRIDGE_ALARM, { periodInMinutes: 1 });
  bridgeTick();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BRIDGE_ALARM) bridgeTick();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.bridge_settings) startBridgeLoop();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'CRAWLING_COMPLETE' && sender.tab?.id) {
    handleJobCrawlComplete(sender.tab.id, request.data || {});
    return false;
  }
  if (request.type === 'CRAWLING_ERROR' && sender.tab?.id) {
    handleJobCrawlError(sender.tab.id, request.error);
    return false;
  }
  if (request.type === 'CRAWLING_PROGRESS' && sender.tab?.id) {
    handleJobProgress(sender.tab.id, request.data);
    return false;
  }

  switch (request.type) {
    case 'BRIDGE_PING':
      bridgeTick()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'GET_BRIDGE_STATUS':
      getBridgeSettings().then(async (s) => {
        let online = false;
        let error = null;
        try {
          await apiFetch(s.apiBaseUrl, '/api/bridge/heartbeat', { method: 'POST', body: '{}' });
          online = true;
        } catch (e) {
          error = e.message || String(e);
        }
        sendResponse({
          enabled: s.enabled,
          apiBaseUrl: s.apiBaseUrl,
          hasBasicAuth: !!s.basicUser,
          serverReachable: online,
          error
        });
      });
      return true;

    case 'SET_BRIDGE_ENABLED':
      chrome.storage.local
        .get(['bridge_settings'])
        .then(({ bridge_settings: prev }) =>
          chrome.storage.local.set({
            bridge_settings: {
              ...(prev || {}),
              enabled: !!request.enabled,
              apiBaseUrl: normalizeApiBaseUrl(
                request.apiBaseUrl || prev?.apiBaseUrl || DEFAULT_API
              ),
              basicUser:
                request.basicUser !== undefined
                  ? String(request.basicUser || '').trim()
                  : prev?.basicUser || '',
              basicPass:
                request.basicPass !== undefined
                  ? String(request.basicPass || '')
                  : prev?.basicPass || ''
            }
          })
        )
        .then(() => {
          startBridgeLoop();
          sendResponse({ success: true });
        })
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case 'OPEN_DASHBOARD':
      getBridgeSettings().then((s) => {
        chrome.tabs.create({ url: s.apiBaseUrl });
        sendResponse({ success: true });
      });
      return true;

    case 'SAVE_REVIEWS':
      saveReviews(request.data)
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ error: error.message }));
      return true;

    default:
      break;
  }
  return false;
});

async function saveReviews(data) {
  const existingData = await chrome.storage.local.get(['coupang_reviews']);
  await chrome.storage.local.set({
    coupang_reviews: { ...existingData.coupang_reviews, ...data, lastUpdated: new Date().toISOString() }
  });
}

// OS 알림은 iconUrl 로드 실패 시 Chrome이 lastError를 내므로 사용하지 않음.
function showNotification(_title, _message) {
  /* no-op: 대시보드/팝업에서 상태를 확인 */
}

startBridgeLoop();
