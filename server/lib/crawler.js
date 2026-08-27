const { chromium } = require('playwright');
const crawlInBrowser = require('./coupangInBrowser');

const USER_AGENT =
  process.env.CRAWL_USER_AGENT ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let browserPromise = null;

function wantHeadless() {
  // 쿠팡은 headless를 잘 막음. 기본은 창 띄움(false). 명시적으로 true일 때만 headless.
  return process.env.PLAYWRIGHT_HEADLESS === 'true';
}

async function getBrowser() {
  if (browserPromise) return browserPromise;

  const headless = wantHeadless();
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-infobars',
    '--window-size=1440,900'
  ];

  const tryLaunch = async (opts) => {
    const browser = await chromium.launch(opts);
    return browser;
  };

  // 1) 설치된 Google Chrome 우선 (봇 탐지에 덜 걸림)
  try {
    browserPromise = tryLaunch({ headless, channel: 'chrome', args });
    return await browserPromise;
  } catch (err) {
    console.warn('시스템 Chrome 실행 실패, Playwright Chromium으로 재시도:', err.message);
  }

  browserPromise = tryLaunch({ headless, args });
  return browserPromise;
}

async function softGoto(page, url, timeout) {
  const response = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout
  });
  return response;
}

function isBlockedPage(title, bodyText) {
  const t = `${title}\n${bodyText}`.toLowerCase();
  return (
    /access denied/.test(t) ||
    /권한이 없/.test(t) ||
    /로봇|robot|captcha|자동화된/.test(t) ||
    /sorry! access denied/.test(t)
  );
}

async function crawlCoupang(productUrl, maxPages, onProgress) {
  const browser = await getBrowser();
  const timeout = Number(process.env.CRAWL_TIMEOUT_MS) || 90000;

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: {
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1'
    }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  if (onProgress) {
    await page.exposeFunction('reportProgress', (data) => onProgress(data));
  }

  try {
    onProgress?.({ message: '쿠팡 홈 접속(쿠키 확보) 중...' });
    try {
      await softGoto(page, 'https://www.coupang.com/', timeout);
      await page.waitForTimeout(2000);
    } catch (_) {
      /* 홈 실패해도 상품 URL 재시도 */
    }

    onProgress?.({
      message: wantHeadless()
        ? '상품 페이지 로딩 중...'
        : '상품 페이지 로딩 중... (브라우저 창이 뜰 수 있습니다)'
    });

    const response = await softGoto(page, productUrl, timeout);
    await page.waitForTimeout(3500);

    const title = await page.title();
    const bodyText = await page.locator('body').innerText().catch(() => '');

    if (isBlockedPage(title, bodyText)) {
      throw new Error(
        '쿠팡이 자동 접속을 차단했습니다(403/Access Denied). ' +
          '해결: 1) .env에 PLAYWRIGHT_HEADLESS=false 후 서버 재시작 2) 또는 CRAWL_MODE=extension 으로 Chrome 확장 브릿지 사용'
      );
    }

    // 403이어도 본문이 정상이면 진행 (드물게 발생)
    if (response && response.status() >= 400 && !bodyText.includes('sdp-review') && bodyText.length < 200) {
      throw new Error(
        `페이지 로드 실패 (HTTP ${response.status()}). 쿠팡 봇 차단 가능성이 큽니다. PLAYWRIGHT_HEADLESS=false 또는 extension 모드를 사용하세요.`
      );
    }

    onProgress?.({ message: '리뷰 크롤링 중...' });

    const result = await page.evaluate(crawlInBrowser, maxPages);

    if (!result.reviews?.length) {
      throw new Error(
        '리뷰를 찾지 못했습니다. 페이지에 리뷰가 있는지, 차단/로그인 화면인지 확인하세요.'
      );
    }

    return result;
  } finally {
    await context.close();
  }
}

async function shutdownBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      await b.close();
    } catch (_) {
      /* ignore */
    }
    browserPromise = null;
  }
}

module.exports = { crawlCoupang, shutdownBrowser };
