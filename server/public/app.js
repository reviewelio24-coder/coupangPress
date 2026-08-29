const $ = (sel) => document.querySelector(sel);

let activeJobId = null;
let pollTimer = null;
let healthCache = {};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function setCrawlCard(data) {
  const card = $('#crawlCard');
  const el = $('#crawlStatus');
  card.classList.add('online');
  if (data.serverCrawler) {
    el.textContent = '서버 Playwright (확장 불필요)';
  } else {
    el.textContent = 'Chrome 확장 브릿지 필요';
    card.classList.toggle('offline', !data.bridge?.online);
    card.classList.toggle('online', !!data.bridge?.online);
  }
}

function setBridgeCard(online, serverMode) {
  const card = $('#bridgeCard');
  const el = $('#bridgeStatus');
  if (serverMode) {
    card.classList.remove('online', 'offline');
    el.textContent = '미사용 (server 모드)';
    return;
  }
  card.classList.toggle('online', online);
  card.classList.toggle('offline', !online);
  el.textContent = online
    ? '연결됨 — 작업 수신 가능'
    : '미연결 — 확장 새로고침 후 이 페이지도 새로고침';
}

function setWpCard(configured) {
  const el = $('#wpStatus');
  $('#wpCard').classList.toggle('online', configured);
  $('#wpCard').classList.toggle('offline', !configured);
  el.textContent = configured ? '설정 완료' : '미설정 — server/.env';
}

async function refreshHealth() {
  try {
    const data = await api('/api/health');
    healthCache = data;
    setCrawlCard(data);
    setBridgeCard(!!data.bridge?.online, data.serverCrawler);
    setWpCard(!!data.wordpressConfigured);
  } catch (_) {
    setBridgeCard(false, true);
    setWpCard(false);
    $('#crawlStatus').textContent = '서버 오프라인';
    $('#crawlCard').classList.add('offline');
  }
}

function renderJob(job) {
  if (!job || job.id !== activeJobId) return;

  $('#activeJob').hidden = true;
  $('#jobProgress').hidden = false;

  const max = job.progress?.maxPages || job.maxPages || 5;
  const cur = job.progress?.currentPage || 0;
  const done = ['completed', 'published', 'failed', 'drafted'].includes(job.status);
  const pct = done
    ? 100
    : job.status === 'publishing' || job.status === 'generating'
      ? 92
      : Math.min(95, max ? (cur / max) * 100 : 10);

  $('#progressFill').style.width = `${pct}%`;
  if (job.status === 'failed' && job.error) {
    $('#progressMessage').textContent = job.error;
  } else if (job.status === 'publishing') {
    $('#progressMessage').textContent =
      job.progress?.message || 'WordPress 글 생성·발행 중… (상품이 많으면 2~3분 걸릴 수 있습니다)';
  } else if (job.status === 'generating') {
    $('#progressMessage').textContent =
      job.progress?.message || '본문 HTML 생성 중… (상품이 많으면 2~3분 걸릴 수 있습니다)';
  } else if (job.error && job.status === 'completed') {
    $('#progressMessage').textContent = job.error;
  } else {
    $('#progressMessage').textContent = job.progress?.message || job.status;
  }
  $('#jobStatusBadge').textContent = job.status;
  $('#jobStatusBadge').className = `badge ${job.status}`;

  const productBits = [];
  if (job.result?.productCount) {
    productBits.push(`${job.result.productCount}개 상품`);
  } else if (job.progress?.productTotal > 1 || job.productCount > 1) {
    productBits.push(
      `상품 ${job.progress?.productIndex || job.currentUrlIndex || '-'}/${job.progress?.productTotal || job.productCount}`
    );
  }
  if (job.result?.totalReviews) {
    productBits.push(`${job.result.totalReviews}개 리뷰`);
  } else if (job.progress?.collectedReviews) {
    productBits.push(`${job.progress.collectedReviews}개 수집 중`);
  }
  $('#reviewCount').textContent = productBits.join(' · ');

  $('#publishBtn').hidden = job.status !== 'completed' && job.status !== 'drafted';
  $('#publishBtn').disabled = job.status === 'publishing' || job.status === 'generating';
  $('#draftBtn').hidden = job.status !== 'completed' && job.status !== 'drafted';
  $('#draftBtn').disabled = job.status === 'generating';

  const draft = job.draft;
  const panel = $('#draftPanel');
  if (draft?.content) {
    panel.hidden = false;
    $('#draftTitle').value = draft.title || '';
    $('#draftKeyphrase').value = draft.focusKeyphrase || job.seoKeyword || '';
    $('#draftMeta').value = draft.metaDescription || '';
    $('#draftHtml').value = draft.content || '';
  } else {
    panel.hidden = true;
  }

  const link = $('#postLink');
  if (job.publish?.postUrl) {
    link.href = job.publish.postUrl;
    link.hidden = false;
    link.textContent = `발행된 글: ${job.publish.generatedTitle || job.publish.postUrl}`;
  } else {
    link.hidden = true;
  }

  if (done) {
    stopPolling();
  }
}

async function pollActiveJob() {
  if (!activeJobId) return;
  try {
    const { job } = await api(`/api/jobs/${activeJobId}`);
    renderJob(job);
  } catch (err) {
    console.error(err);
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollActiveJob, 1200);
  pollActiveJob();
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}


function collectUrls() {
  return [...document.querySelectorAll('.coupang-url')]
    .map((el) => el.value.trim())
    .filter(Boolean);
}

function addUrlField() {
  const list = $('#urlList');
  const count = list.querySelectorAll('.coupang-url').length;
  if (count >= 5) {
    alert('상품 URL은 최대 5개까지입니다.');
    return;
  }
  const label = document.createElement('label');
  label.className = 'url-row';
  label.innerHTML = `쿠팡 상품 URL ${count + 1}
    <input type="url" class="coupang-url" placeholder="https://www.coupang.com/vp/products/..." />`;
  list.appendChild(label);
  $('#addUrlBtn').disabled = count + 1 >= 5;
}

$('#addUrlBtn').addEventListener('click', addUrlField);

$('#jobForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const coupangUrls = collectUrls();
  const seoKeyword = $('#seoKeyword').value.trim();
  const maxPages = Number($('#maxPages').value) || 5;
  const outputMode = document.querySelector('input[name="outputMode"]:checked')?.value || 'wordpress';

  if (!coupangUrls.length) {
    alert('쿠팡 상품 URL을 1개 이상 입력하세요.');
    return;
  }
  if (coupangUrls.some((u) => !u.includes('coupang.com/vp/products/'))) {
    alert('유효한 쿠팡 상품 URL만 입력하세요.');
    return;
  }
  if (!seoKeyword) {
    alert('SEO 키워드를 입력하세요.');
    return;
  }

  $('#startBtn').disabled = true;
  try {
    await refreshHealth();
    if (healthCache.serverCrawler === false && !healthCache.bridge?.online) {
      throw new Error(
        'Chrome 확장이 연결되지 않았습니다.\n확장 팝업에서 「웹 대시보드 연동」을 켠 뒤 다시 시도하세요.'
      );
    }
    const { job } = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        coupangUrls,
        coupangUrl: coupangUrls[0],
        maxPages,
        autoPublish: outputMode === 'wordpress',
        outputMode,
        seoKeyword
      })
    });
    activeJobId = job.id;
    renderJob(job);
    startPolling();
  } catch (err) {
    alert(err.message || '작업 생성 실패');
  } finally {
    $('#startBtn').disabled = false;
  }
});

$('#draftBtn').addEventListener('click', async () => {
  if (!activeJobId) return;
  $('#draftBtn').disabled = true;
  try {
    await api(`/api/jobs/${activeJobId}/draft`, { method: 'POST' });
    startPolling();
  } catch (err) {
    alert(err.message);
  } finally {
    $('#draftBtn').disabled = false;
  }
});

async function copyText(value) {
  const text = String(value || '');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

document.querySelectorAll('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const el = document.getElementById(btn.dataset.copy);
    await copyText(el?.value);
    const prev = btn.textContent;
    btn.textContent = '복사됨';
    setTimeout(() => {
      btn.textContent = prev;
    }, 1200);
  });
});

$('#copyHtmlBtn').addEventListener('click', async () => {
  await copyText($('#draftHtml').value);
  const btn = $('#copyHtmlBtn');
  const prev = btn.textContent;
  btn.textContent = '복사됨';
  setTimeout(() => {
    btn.textContent = prev;
  }, 1200);
});

$('#downloadHtmlBtn').addEventListener('click', () => {
  const title = $('#draftTitle').value.trim() || '본문';
  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <title>${title.replace(/</g, '')}</title>
</head>
<body>
${$('#draftHtml').value}
</body>
</html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${title.slice(0, 40).replace(/[\\/:*?"<>|]/g, '_')}.html`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#publishBtn').addEventListener('click', async () => {
  if (!activeJobId) return;
  $('#publishBtn').disabled = true;
  try {
    await api(`/api/jobs/${activeJobId}/publish`, { method: 'POST' });
    startPolling();
  } catch (err) {
    alert(err.message);
  } finally {
    $('#publishBtn').disabled = false;
  }
});

refreshHealth();
setInterval(refreshHealth, 5000);
