/** @typedef {'queued'|'running'|'completed'|'failed'|'publishing'|'published'|'generating'|'drafted'} JobStatus */

const jobs = new Map();
let bridgeLastSeen = null;

function touchJob(job) {
  job.updatedAt = new Date().toISOString();
}

function normalizeUrls(input) {
  const list = Array.isArray(input) ? input : [input];
  const urls = [...new Set(list.map((u) => String(u || '').trim()).filter(Boolean))];
  return urls.filter((u) => u.includes('coupang.com/vp/products/')).slice(0, 5);
}

function publicJob(job) {
  return {
    id: job.id,
    coupangUrl: job.coupangUrls[0] || job.coupangUrl || '',
    coupangUrls: job.coupangUrls,
    maxPages: job.maxPages,
    autoPublish: job.autoPublish,
    outputMode: job.outputMode || (job.autoPublish ? 'wordpress' : 'html'),
    seoKeyword: job.seoKeyword || '',
    productCount: job.coupangUrls.length,
    currentUrlIndex: job.currentUrlIndex,
    status: job.status,
    progress: job.progress,
    result: job.result
      ? {
          productUrl: job.result.productUrl,
          productTitle: job.result.productTitle,
          totalReviews: job.result.totalReviews,
          pagesCrawled: job.result.pagesCrawled,
          productCount: (job.result.products || []).length || 1
        }
      : null,
    publish: job.publish || null,
    draft: job.draft || null,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

function createJob({ coupangUrl, coupangUrls, maxPages, autoPublish, outputMode, seoKeyword }) {
  const urls = normalizeUrls(coupangUrls?.length ? coupangUrls : [coupangUrl]);
  if (!urls.length) {
    throw new Error('유효한 쿠팡 상품 URL이 필요합니다.');
  }

  const mode = outputMode === 'html' ? 'html' : 'wordpress';
  const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    coupangUrls: urls,
    coupangUrl: urls[0],
    maxPages: maxPages || 5,
    outputMode: mode,
    autoPublish: mode === 'wordpress',
    seoKeyword: String(seoKeyword || '').trim(),
    currentUrlIndex: 0,
    crawlInFlight: false,
    productResults: [],
    status: 'queued',
    progress: {
      message: '대기 중',
      currentPage: 0,
      maxPages: maxPages || 5,
      collectedReviews: 0,
      productIndex: 0,
      productTotal: urls.length
    },
    result: null,
    publish: null,
    draft: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  jobs.set(id, job);
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

function listJobs(limit = 20) {
  return [...jobs.values()]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit)
    .map(publicJob);
}

function claimPayload(job) {
  const idx = job.currentUrlIndex;
  return {
    id: job.id,
    coupangUrl: job.coupangUrls[idx],
    maxPages: job.maxPages,
    urlIndex: idx,
    urlTotal: job.coupangUrls.length,
    seoKeyword: job.seoKeyword
  };
}

/** 확장 프로그램이 다음에 크롤할 URL 단위를 가져감 */
function claimNextJob() {
  for (const job of jobs.values()) {
    if (
      job.status === 'running' &&
      !job.crawlInFlight &&
      job.currentUrlIndex < job.coupangUrls.length
    ) {
      job.crawlInFlight = true;
      job.progress.message = `상품 ${job.currentUrlIndex + 1}/${job.coupangUrls.length} 크롤링 중...`;
      job.progress.productIndex = job.currentUrlIndex + 1;
      job.progress.productTotal = job.coupangUrls.length;
      touchJob(job);
      return claimPayload(job);
    }
  }

  for (const job of jobs.values()) {
    if (job.status === 'queued') {
      job.status = 'running';
      job.crawlInFlight = true;
      job.currentUrlIndex = 0;
      job.progress.message = `상품 1/${job.coupangUrls.length} 크롤링 중...`;
      job.progress.productIndex = 1;
      job.progress.productTotal = job.coupangUrls.length;
      touchJob(job);
      return claimPayload(job);
    }
  }
  return null;
}

function updateProgress(id, progress) {
  const job = jobs.get(id);
  if (!job) return null;
  job.progress = { ...job.progress, ...progress };
  touchJob(job);
  return job;
}

function aggregateResult(productResults) {
  const products = productResults.map((p) => ({
    productUrl: p.productUrl,
    productTitle: p.productTitle || '쿠팡 상품',
    reviews: p.reviews || [],
    totalReviews: p.totalReviews || (p.reviews || []).length,
    pagesCrawled: p.pagesCrawled || 0
  }));

  const allReviews = [];
  products.forEach((p) => {
    (p.reviews || []).forEach((r) => {
      allReviews.push({ ...r, productInfo: r.productInfo || p.productTitle });
    });
  });

  return {
    products,
    productUrl: products[0]?.productUrl || '',
    productTitle: products.map((p) => p.productTitle).join(' · '),
    reviews: allReviews,
    totalReviews: allReviews.length,
    pagesCrawled: products.reduce((sum, p) => sum + (p.pagesCrawled || 0), 0)
  };
}

function completeJob(id, result) {
  const job = jobs.get(id);
  if (!job) return null;
  job.status = 'completed';
  job.result = result;
  job.crawlInFlight = false;
  job.progress.message = `크롤링 완료 (${result.totalReviews || 0}개 · 상품 ${result.products?.length || 1}개)`;
  job.error = null;
  touchJob(job);
  return job;
}

/**
 * 상품 1개 크롤 완료. 남은 URL이 있으면 running 유지, 없으면 completed.
 * @returns {{ job: object, done: boolean } | null}
 */
function appendProductAndMaybeComplete(id, productData) {
  const job = jobs.get(id);
  if (!job) return null;

  if (job.status !== 'running' && job.status !== 'queued') {
    throw new Error(`작업이 ${job.status} 상태라 크롤 결과를 추가할 수 없습니다.`);
  }

  const expectedIndex = job.currentUrlIndex;
  if (expectedIndex >= job.coupangUrls.length) {
    throw new Error('이미 모든 상품 크롤링이 끝난 작업입니다.');
  }

  job.productResults.push({
    productUrl: productData.productUrl || job.coupangUrls[expectedIndex],
    productTitle: productData.productTitle || '쿠팡 상품',
    reviews: productData.reviews || [],
    totalReviews: productData.totalReviews || (productData.reviews || []).length,
    pagesCrawled: productData.pagesCrawled || 0
  });

  job.crawlInFlight = false;
  job.currentUrlIndex += 1;

  const collected = job.productResults.reduce(
    (sum, p) => sum + (p.reviews?.length || 0),
    0
  );
  job.progress.collectedReviews = collected;
  job.progress.productIndex = Math.min(job.currentUrlIndex + 1, job.coupangUrls.length);
  job.progress.productTotal = job.coupangUrls.length;

  console.log(
    `[job ${id}] 상품 ${job.productResults.length}/${job.coupangUrls.length} 저장 · ${productData.productTitle || '-'}`
  );

  if (job.currentUrlIndex >= job.coupangUrls.length) {
    if (job.productResults.length !== job.coupangUrls.length) {
      throw new Error(
        `상품 수 불일치 (${job.productResults.length}/${job.coupangUrls.length}). 발행을 중단합니다.`
      );
    }
    const result = aggregateResult(job.productResults);
    completeJob(id, result);
    return { job, done: true };
  }

  job.progress.message = `상품 ${job.currentUrlIndex}/${job.coupangUrls.length} 완료 · 다음 상품 대기`;
  touchJob(job);
  return { job, done: false };
}

function failJob(id, error) {
  const job = jobs.get(id);
  if (!job) return null;
  job.status = 'failed';
  job.crawlInFlight = false;
  job.error = error;
  job.progress.message = '실패';
  touchJob(job);
  return job;
}

function setPublishing(id) {
  const job = jobs.get(id);
  if (!job) return null;
  job.status = 'publishing';
  job.progress.message = 'WordPress 글 생성·발행 중...';
  touchJob(job);
  return job;
}

function setPublished(id, publishResult) {
  const job = jobs.get(id);
  if (!job) return null;
  job.status = 'published';
  job.publish = publishResult;
  job.error = null;
  job.progress.message = 'WordPress 발행 완료';
  touchJob(job);
  return job;
}

function setGenerating(id) {
  const job = jobs.get(id);
  if (!job) return null;
  job.status = 'generating';
  job.progress.message = '본문 HTML 생성 중… (상품이 많으면 2~3분 걸릴 수 있습니다)';
  touchJob(job);
  return job;
}

function setDrafted(id, draft) {
  const job = jobs.get(id);
  if (!job) return null;
  job.status = 'drafted';
  job.draft = draft;
  job.error = null;
  job.progress.message = '본문 HTML 생성 완료 — 복사해서 WordPress에 붙여넣으세요';
  touchJob(job);
  return job;
}

function revertToCompleted(id, error) {
  const job = jobs.get(id);
  if (!job) return null;
  job.status = 'completed';
  job.error = error || job.error;
  job.progress.message = error || '크롤링 완료';
  touchJob(job);
  return job;
}

function recordBridgeHeartbeat() {
  bridgeLastSeen = Date.now();
}

function bridgeStatus() {
  const online = bridgeLastSeen && Date.now() - bridgeLastSeen < 90000;
  return {
    online: !!online,
    lastSeen: bridgeLastSeen ? new Date(bridgeLastSeen).toISOString() : null
  };
}

/** 서버 Playwright 모드: 큐에서 job 전체를 가져옴 */
function takeQueuedJobForServer() {
  for (const job of jobs.values()) {
    if (job.status === 'queued') {
      job.status = 'running';
      job.crawlInFlight = false;
      job.currentUrlIndex = 0;
      job.productResults = [];
      job.progress.message = `상품 1/${job.coupangUrls.length} 서버 크롤링 준비...`;
      job.progress.productIndex = 1;
      job.progress.productTotal = job.coupangUrls.length;
      touchJob(job);
      return job;
    }
  }
  return null;
}

module.exports = {
  createJob,
  getJob,
  listJobs,
  claimNextJob,
  takeQueuedJobForServer,
  updateProgress,
  completeJob,
  appendProductAndMaybeComplete,
  failJob,
  setPublishing,
  setPublished,
  setGenerating,
  setDrafted,
  revertToCompleted,
  publicJob,
  recordBridgeHeartbeat,
  bridgeStatus,
  normalizeUrls,
  aggregateResult
};
