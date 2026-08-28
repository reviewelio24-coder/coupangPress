/**
 * Playwright page.evaluate() 안에서 실행되는 크롤링 로직.
 * Node 모듈/require 사용 금지 — 브라우저 컨텍스트만.
 */
async function crawlInBrowser(maxPages) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const report = (data) => {
    try {
      if (typeof reportProgress === 'function') reportProgress(data);
    } catch (_) {
      /* ignore */
    }
  };

  function rootsFromHelpful() {
    const nodes = document.querySelectorAll(
      '.js_reviewArticleHelpfulContainer, .sdp-review__article__list__help[data-review-id]'
    );
    if (!nodes.length) return [];
    const articles = [...nodes].map((n) => n.closest('article')).filter(Boolean);
    return [...new Set(articles)];
  }

  function collectRoots() {
    const h = rootsFromHelpful();
    if (h.length) return h;
    const sels = [
      'article.js_reviewArticleReviewList',
      'article.sdp-review__article__list',
      '.sdp-review__article__list'
    ];
    for (const sel of sels) {
      const nodes = [...document.querySelectorAll(sel)];
      if (nodes.length) return nodes;
    }
    return [];
  }

  function textFrom(root, sels) {
    for (const sel of sels) {
      const n = root.querySelector(sel);
      if (n) {
        const t = (n.innerText || n.textContent || '').trim();
        if (t) return t;
      }
    }
    return '';
  }

  function extractOne(el, idx) {
    const content =
      textFrom(el, [
        '.sdp-review__article__list__review__content',
        '.js_reviewArticleContent',
        '[class*="twc-break-all"] span[class*="twc-bg-white"]',
        '[class*="twc-break-all"]'
      ]) || '';
    const helpfulEl = el.querySelector('.js_reviewArticleHelpfulContainer[data-review-id]');
    let helpful = 0;
    if (helpfulEl?.getAttribute('data-count')) {
      helpful = parseInt(helpfulEl.getAttribute('data-count'), 10) || 0;
    }
    return {
      id: idx + 1,
      rating: null,
      title: textFrom(el, ['.sdp-review__article__list__headline', '[class*="headline"]']),
      content,
      author: textFrom(el, ['.sdp-review__article__list__user__name', '[class*="user__name"]']),
      date: textFrom(el, ['.sdp-review__article__list__user__date', 'time']),
      helpful,
      productInfo: textFrom(el, ['.sdp-review__article__list__product__name', '[class*="twc-line-clamp"]'])
    };
  }

  function extractPage() {
    return collectRoots()
      .map((el, i) => extractOne(el, i))
      .filter((r) => r.content && r.content.trim().length > 0);
  }

  function reviewSnapshot() {
    return [...document.querySelectorAll('.js_reviewArticleHelpfulContainer[data-review-id]')]
      .slice(0, 15)
      .map((el) => el.getAttribute('data-review-id'))
      .join('|');
  }

  async function ensureReviewsVisible() {
    document.querySelector('.js_reviewArticleHelpfulContainer')?.scrollIntoView?.({ block: 'center' });
    await wait(600);
    for (let i = 0; i < 8; i++) {
      window.scrollBy(0, 400);
      await wait(350);
      if (collectRoots().length) return;
    }
    const tabs = [...document.querySelectorAll('button, a, [role="tab"]')];
    const tab = tabs.find((el) => /\b후기\b|\b상품평\b|\b구매평\b/i.test(el.textContent || ''));
    tab?.click?.();
    await wait(800);
  }

  async function goNextPage(beforeSnap) {
    const scope = document.querySelector('main') || document.body;
    const numbered = [...scope.querySelectorAll('button')].filter(
      (b) => !b.closest('.js_reviewArticleHelpfulContainer') && /^\s*\d{1,4}\s*$/.test((b.textContent || '').trim())
    );
    const meta = scope.querySelector('[data-page][data-start][data-end]');
    let cur = meta ? parseInt(meta.getAttribute('data-page') || '', 10) : NaN;
    if (Number.isNaN(cur) && numbered.length) {
      cur = parseInt(numbered[0].textContent.trim(), 10);
    }
    const nextNum = cur + 1;
    let btn =
      scope.querySelector(`.sdp-review__article__page__num[data-page="${nextNum}"]`) ||
      numbered.find((b) => (b.textContent || '').trim() === String(nextNum));
    if (!btn) {
      btn = [...scope.querySelectorAll('button, [role="button"]')].find((el) =>
        /다음\s*페이지|next\s*page/i.test(`${el.getAttribute('aria-label') || ''}${el.textContent || ''}`)
      );
    }
    if (!btn || btn.disabled) return false;
    btn.click();
    for (let i = 0; i < 25; i++) {
      await wait(450);
      if (reviewSnapshot() !== beforeSnap) {
        await wait(900);
        return true;
      }
    }
    return false;
  }

  await ensureReviewsVisible();

  const reviews = [];
  let currentPage = 1;
  const limit = Math.min(Math.max(1, maxPages || 5), 50);

  while (currentPage <= limit) {
    const pageReviews = extractPage();
    reviews.push(...pageReviews);
    report({
      currentPage,
      maxPages: limit,
      collectedReviews: reviews.length,
      pageReviews: pageReviews.length,
      message: `페이지 ${currentPage}/${limit} · ${reviews.length}개 수집`
    });

    if (currentPage >= limit) break;
    const snap = reviewSnapshot();
    const moved = await goNextPage(snap);
    if (!moved) break;
    currentPage++;
  }

  const titleEl =
    document.querySelector('h1.product-title') ||
    document.querySelector('h1[class*="twc-"]') ||
    document.querySelector('h1');

  return {
    productUrl: location.href,
    productTitle: (titleEl?.textContent || document.title || '쿠팡 상품').trim(),
    reviews,
    totalReviews: reviews.length,
    pagesCrawled: currentPage
  };
}

module.exports = crawlInBrowser;
