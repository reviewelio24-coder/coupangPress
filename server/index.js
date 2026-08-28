require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const { generatePost } = require('./lib/generatePost');
const { publishToWordPress } = require('./lib/wordpress');
const jobs = require('./lib/jobs');
const { startWorker, isServerCrawlEnabled, crawlMode } = require('./lib/jobWorker');
const { shutdownBrowser } = require('./lib/crawler');

const app = express();
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';

if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

const config = {
  wordpressUrl: process.env.WORDPRESS_URL,
  wordpressUser: process.env.WORDPRESS_USER,
  wordpressAppPassword: process.env.WORDPRESS_APP_PASSWORD,
  wordpressPostStatus: process.env.WORDPRESS_POST_STATUS || 'draft',
  wordpressCategory: process.env.WORDPRESS_CATEGORY || '가전디지털',
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, '')
};

app.use(cors());
app.use(express.json({ limit: '8mb' }));

const publicDir = path.join(__dirname, 'public');
const indexHtml = path.join(publicDir, 'index.html');

if (!fs.existsSync(indexHtml)) {
  console.error('public/index.html 없음:', indexHtml);
  console.error('server 폴더에서 npm start 로 실행했는지 확인하세요.');
}

app.use(express.static(publicDir));

app.get('/', (_req, res) => {
  if (fs.existsSync(indexHtml)) {
    return res.sendFile(indexHtml);
  }
  res.status(500).send('웹 UI 파일을 찾을 수 없습니다. server/public/index.html 을 확인하세요.');
});

function resolveProductsForPublish(job) {
  const expected = job.coupangUrls?.length || 1;
  let products = Array.isArray(job.result?.products) ? job.result.products : null;

  if (!products?.length && job.productResults?.length) {
    products = job.productResults.map((p) => ({
      productUrl: p.productUrl,
      productTitle: p.productTitle || '쿠팡 상품',
      reviews: p.reviews || [],
      totalReviews: p.totalReviews || (p.reviews || []).length,
      pagesCrawled: p.pagesCrawled || 0
    }));
  }

  if (!products?.length && job.result?.reviews?.length) {
    products = [
      {
        productUrl: job.result.productUrl,
        productTitle: job.result.productTitle || '쿠팡 상품',
        reviews: job.result.reviews || [],
        totalReviews: job.result.totalReviews || (job.result.reviews || []).length
      }
    ];
  }

  if (!products?.length) {
    throw new Error('발행할 상품 데이터가 없습니다.');
  }

  if (expected > 1 && products.length < expected) {
    throw new Error(
      `상품 ${products.length}/${expected}개만 수집되었습니다. 모든 상품 크롤링이 끝난 뒤 다시 발행하세요.`
    );
  }

  return products;
}

function schedulePublish(jobId) {
  const job = jobs.getJob(jobId);
  if (!job) return;
  jobs.setPublishing(jobId);
  publishJobResult(job)
    .then((publish) => {
      jobs.setPublished(jobId, publish);
      console.log(`[publish ${jobId}] 완료: ${publish.postUrl}`);
    })
    .catch((err) => {
      console.error(`[publish ${jobId}] 실패:`, err.message);
      jobs.failJob(jobId, err.message);
    });
}

async function publishJobResult(job) {
  const products = resolveProductsForPublish(job);
  if (!products.some((p) => (p.reviews || []).length)) {
    throw new Error('발행할 리뷰 데이터가 없습니다.');
  }

  console.log(`[publish ${job.id}] 상품 ${products.length}개 → WordPress 글 생성`);

  const { title, content, tags, focusKeyphrase, metaDescription } = await generatePost(
    {
      products,
      productUrl: products[0]?.productUrl || job.result?.productUrl,
      productTitle: products.map((p) => p.productTitle).join(' · '),
      reviews: products.flatMap((p) => p.reviews || []),
      totalReviews: products.reduce((n, p) => n + (p.reviews?.length || 0), 0),
      seoKeyword: job.seoKeyword || ''
    },
    config
  );

  console.log(`[publish ${job.id}] 태그 ${tags?.length || 0}개:`, (tags || []).join(', '));
  console.log(`[publish ${job.id}] 카테고리:`, config.wordpressCategory || '가전디지털');
  console.log(`[publish ${job.id}] 초점 키프레이즈:`, focusKeyphrase || '(없음)');
  console.log(`[publish ${job.id}] 메타 설명:`, metaDescription || '(없음)');

  const wp = await publishToWordPress(
    {
      title,
      content,
      status: config.wordpressPostStatus,
      tags: tags || [],
      focusKeyphrase: focusKeyphrase || job.seoKeyword || '',
      metaDescription: metaDescription || ''
    },
    config
  );

  return {
    message: `WordPress에 ${wp.status === 'publish' ? '공개' : '임시'} 글로 저장했습니다.`,
    postId: wp.id,
    postUrl: wp.link,
    postStatus: wp.status,
    generatedTitle: title,
    tags: tags || [],
    tagIds: wp.tags || [],
    tagNames: wp.tagNames || tags || [],
    categories: wp.categories || [],
    categoryNames: wp.categoryNames || [],
    focusKeyphrase: wp.focusKeyphrase || focusKeyphrase || '',
    metaDescription: wp.metaDescription || metaDescription || '',
    seoPlugin: wp.seoPlugin || null
  };
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    crawlMode: crawlMode(),
    serverCrawler: isServerCrawlEnabled(),
    wordpressConfigured: !!(config.wordpressUrl && config.wordpressUser && config.wordpressAppPassword),
    openaiEnabled: !!config.openaiApiKey,
    bridge: jobs.bridgeStatus(),
    publicUrl: config.publicUrl || null
  });
});

app.post('/api/bridge/heartbeat', (_req, res) => {
  jobs.recordBridgeHeartbeat();
  res.json({ ok: true });
});

app.get('/api/bridge/status', (_req, res) => {
  res.json(jobs.bridgeStatus());
});

app.post('/api/jobs', (req, res) => {
  try {
    const { coupangUrl, coupangUrls, maxPages, autoPublish, seoKeyword } = req.body || {};
    const kw = String(seoKeyword || '').trim();
    if (!kw) {
      return res.status(400).json({ error: 'SEO 키워드를 입력하세요.' });
    }
    const job = jobs.createJob({
      coupangUrl,
      coupangUrls,
      maxPages: Number(maxPages) || 5,
      autoPublish: !!autoPublish,
      seoKeyword: kw
    });
    res.status(201).json({ job: jobs.publicJob(job) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/jobs', (_req, res) => {
  res.json({ jobs: jobs.listJobs() });
});

app.get('/api/jobs/:id', (req, res) => {
  if (req.params.id === 'claim') return res.status(404).json({ error: 'not found' });
  const job = jobs.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  res.json({ job: jobs.publicJob(job) });
});

app.post('/api/jobs/claim', (_req, res) => {
  if (isServerCrawlEnabled()) {
    return res.json({ job: null, mode: 'server' });
  }
  const unit = jobs.claimNextJob();
  if (!unit) return res.json({ job: null });
  res.json({ job: unit });
});

app.patch('/api/jobs/:id/progress', (req, res) => {
  const job = jobs.updateProgress(req.params.id, req.body || {});
  if (!job) return res.status(404).json({ error: '작업 없음' });
  res.json({ ok: true });
});

app.post('/api/jobs/:id/complete', async (req, res) => {
  try {
    const body = req.body || {};
    if (!Array.isArray(body.reviews) || body.reviews.length === 0) {
      return res.status(400).json({ error: 'reviews 배열이 필요합니다.' });
    }

    const appended = jobs.appendProductAndMaybeComplete(req.params.id, {
      productUrl: body.productUrl,
      productTitle: body.productTitle || '쿠팡 상품',
      reviews: body.reviews,
      totalReviews: body.totalReviews || body.reviews.length,
      pagesCrawled: body.pagesCrawled
    });
    if (!appended) return res.status(404).json({ error: '작업 없음' });

    const { job, done } = appended;
    if (!done) {
      return res.json({
        ok: true,
        done: false,
        job: jobs.publicJob(job),
        message: `상품 ${job.currentUrlIndex}/${job.coupangUrls.length} 완료`
      });
    }

    if (job.autoPublish) {
      schedulePublish(job.id);
    }

    res.json({ ok: true, done: true, job: jobs.publicJob(jobs.getJob(job.id)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/jobs/:id/fail', (req, res) => {
  const job = jobs.failJob(req.params.id, req.body?.error || '크롤링 실패');
  if (!job) return res.status(404).json({ error: '작업 없음' });
  res.json({ ok: true, job: jobs.publicJob(job) });
});

app.post('/api/jobs/:id/publish', async (req, res) => {
  try {
    const job = jobs.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: '작업 없음' });
    if (job.status !== 'completed' && job.status !== 'published') {
      return res.status(400).json({ error: '크롤링이 완료된 작업만 발행할 수 있습니다.' });
    }
    if (job.status === 'publishing') {
      return res.json({ ok: true, job: jobs.publicJob(job) });
    }
    schedulePublish(job.id);
    res.json({ ok: true, job: jobs.publicJob(jobs.getJob(job.id)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/publish', async (req, res) => {
  try {
    const { productUrl, productTitle, reviews, totalReviews, seoKeyword } = req.body || {};
    if (!productUrl || !Array.isArray(reviews) || reviews.length === 0) {
      return res.status(400).json({ error: 'productUrl과 reviews(1개 이상)가 필요합니다.' });
    }
    const fakeJob = {
      seoKeyword: seoKeyword || '',
      result: {
        productUrl,
        productTitle: productTitle || '쿠팡 상품',
        reviews,
        totalReviews: totalReviews || reviews.length
      }
    };
    const publish = await publishJobResult(fakeJob);
    res.json({ success: true, ...publish });
  } catch (err) {
    res.status(500).json({ error: err.message || '발행 중 오류' });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`coupangPress: http://${HOST}:${PORT}`);
  if (HOST === '127.0.0.1') {
    console.log(`  (브라우저) http://127.0.0.1:${PORT} 또는 http://localhost:${PORT}`);
  }
  console.log(`  public: ${publicDir}`);
  console.log(`  CRAWL_MODE=${crawlMode()}`);
  console.log('  종료: Ctrl+C');
  startWorker(publishJobResult);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ 포트 ${PORT}이(가) 이미 사용 중입니다.`);
    console.error(`   lsof -ti :${PORT} | xargs kill`);
    console.error('   위 명령으로 종료 후 다시 npm start 하세요.\n');
  } else {
    console.error('서버 시작 실패:', err.message);
  }
  process.exit(1);
});

async function gracefulShutdown(signal) {
  console.log(`${signal} — 종료 중...`);
  server.close();
  await shutdownBrowser();
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
