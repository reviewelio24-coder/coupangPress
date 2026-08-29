const jobs = require('./jobs');
const { crawlCoupang } = require('./crawler');

let processing = false;

function crawlMode() {
  return (process.env.CRAWL_MODE || 'server').toLowerCase();
}

function isServerCrawlEnabled() {
  return crawlMode() === 'server';
}

async function runJobPipeline(job, publishJobResult, generateDraftJobResult) {
  const urls = job.coupangUrls || [job.coupangUrl];

  for (let i = 0; i < urls.length; i++) {
    const onProgress = (data) => {
      jobs.updateProgress(job.id, {
        ...data,
        productIndex: i + 1,
        productTotal: urls.length,
        message:
          data.message ||
          `상품 ${i + 1}/${urls.length} 크롤링 중... (${data.collectedReviews ?? 0}개)`
      });
    };

    jobs.updateProgress(job.id, {
      message: `상품 ${i + 1}/${urls.length} 서버 크롤링 시작...`,
      productIndex: i + 1,
      productTotal: urls.length
    });

    // appendProductAndMaybeComplete expects currentUrlIndex to match
    job.currentUrlIndex = i;
    job.crawlInFlight = true;

    const result = await crawlCoupang(urls[i], job.maxPages, onProgress);
    const appended = jobs.appendProductAndMaybeComplete(job.id, {
      productUrl: result.productUrl,
      productTitle: result.productTitle,
      reviews: result.reviews,
      totalReviews: result.totalReviews,
      pagesCrawled: result.pagesCrawled
    });

    if (!appended) throw new Error('작업 상태 갱신 실패');
  }

  const updated = jobs.getJob(job.id);
  if (updated?.status === 'completed') {
    if (updated.autoPublish) {
      jobs.setPublishing(job.id);
      try {
        const publish = await publishJobResult(updated);
        jobs.setPublished(job.id, publish);
      } catch (err) {
        jobs.failJob(job.id, err.message);
        throw err;
      }
    } else if (updated.outputMode === 'html' && generateDraftJobResult) {
      jobs.setGenerating(job.id);
      try {
        const draft = await generateDraftJobResult(updated);
        jobs.setDrafted(job.id, draft);
      } catch (err) {
        jobs.revertToCompleted(job.id, err.message);
        throw err;
      }
    }
  }
}

async function tick(publishJobResult, generateDraftJobResult) {
  if (!isServerCrawlEnabled() || processing) return;

  const job = jobs.takeQueuedJobForServer();
  if (!job) return;

  processing = true;
  try {
    await runJobPipeline(job, publishJobResult, generateDraftJobResult);
  } catch (err) {
    console.error(`Job ${job.id} failed:`, err.message);
    if (jobs.getJob(job.id)?.status === 'running') {
      jobs.failJob(job.id, err.message);
    }
  } finally {
    processing = false;
  }
}

function startWorker(publishJobResult, generateDraftJobResult) {
  if (!isServerCrawlEnabled()) {
    console.log('CRAWL_MODE=extension — Chrome 확장 브릿지가 작업을 처리합니다.');
    return;
  }
  console.log('CRAWL_MODE=server — Playwright 서버 크롤러가 작업을 처리합니다.');
  setInterval(() => tick(publishJobResult, generateDraftJobResult), 1500);
  tick(publishJobResult, generateDraftJobResult);
}

module.exports = { startWorker, isServerCrawlEnabled, crawlMode };
