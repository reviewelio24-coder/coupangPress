// 중복 실행 방지 - 전체 스크립트를 감싸기
if (window.coupangCrawlerScriptLoaded) {
  console.log('쿠팡 크롤러 스크립트가 이미 로드되었습니다.');
} else {
  window.coupangCrawlerScriptLoaded = true;

// 쿠팡 리뷰 크롤링 콘텐츠 스크립트
class CoupangReviewCrawler {
  constructor() {
    this.reviews = [];
    this.isCrawling = false;
    this.currentPage = 1;
    this.maxPages = 5; // 최대 크롤링할 페이지 수
  }

  /** Twc(Tailwind) SDP: 도움돼요 블록에 data-review-id — 가장 안정적 */
  rootsFromHelpfulContainers() {
    const nodes = document.querySelectorAll(
      '.js_reviewArticleHelpfulContainer, .sdp-review__article__list__help[data-review-id], [data-review-id].js_reviewArticleHelpfulContainer'
    );
    if (!nodes.length) return [];
    const articles = [...nodes].map((n) => n.closest('article')).filter(Boolean);
    const unique = [...new Set(articles)];
    return unique.filter((el) => unique.every((o) => o === el || !o.contains(el)));
  }

  /** SDP 리뷰 마크업이 버전별로 달라서 여러 선택자와 중복 제거로 루트 수집 */
  collectReviewRootElements() {
    const fromHelpful = this.rootsFromHelpfulContainers();
    if (fromHelpful.length > 0) return fromHelpful;

    const selectors = [
      'article.js_reviewArticleReviewList',
      'article.sdp-review__article__list',
      '.sdp-review__article__list.js_reviewArticleReviewList',
      '.sdp-review__article__list'
    ];

    for (const sel of selectors) {
      const nodes = [...document.querySelectorAll(sel)].filter(Boolean);
      if (nodes.length === 0) continue;
      const withContent = nodes.filter((el) =>
        el.querySelector?.('.sdp-review__article__list__review__content, .js_reviewArticleContent')
      );
      const pick = withContent.length > 0 ? withContent : nodes;
      const deduped = pick.filter((el) => pick.every((other) => other === el || !other.contains(el)));
      if (deduped.length > 0) return deduped;
    }

    let contentNodes = document.querySelectorAll(
      '.js_reviewArticleContent, .sdp-review__article__list__review__content'
    );
    if (!contentNodes.length) {
      contentNodes = document.querySelectorAll(
        '[class*="twc-break-all"] span[class*="twc-bg-white"], article [class*="twc-break-all"]'
      );
      if (!contentNodes.length) {
        contentNodes = document.querySelectorAll('[data-review-id] article, article[data-review-id]');
        if (!contentNodes.length) return [];
        return [...contentNodes];
      }
    }

    const rootsSet = new Set();
    [...contentNodes].forEach((node) => {
      let root =
        node.closest('article.sdp-review__article__list') ||
        node.closest('article.js_reviewArticleReviewList') ||
        node.closest('article[class*="sdp-review"]') ||
        node.closest('[data-review-id]') ||
        node.closest('.js_reviewArticleContentContainer')?.parentElement ||
        node.closest('.sdp-review__article__list');

      const container = node.closest('.js_reviewArticleContentContainer');
      if (!root && container) root = container.parentElement;
      if (!root) root = container || node.parentElement?.parentElement || node.parentElement || node;

      rootsSet.add(root);
    });

    const rootsArr = [...rootsSet];
    return rootsArr.filter((el) => rootsArr.every((other) => other === el || !other.contains(el)));
  }

  clickReviewTabIfPresent() {
    const candidates = [...document.querySelectorAll('button, a, [role="tab"], div[role="button"]')];
    const hit = candidates.find((el) => {
      const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
      const small = (el.querySelector('*') === null ? t : t.slice(0, 80)).trim();
      return (
        /\b후기\b/.test(t) ||
        /\b상품평\b/.test(t) ||
        /\b구매평\b/.test(t) ||
        /^\s*후기\s*\(\d+\)/.test(t) ||
        /\bReviews?\b/i.test(small || t)
      );
    });
    if (hit && !hit.getAttribute?.('disabled')) {
      try {
        hit.click();
        return true;
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  async ensureReviewSectionRendered() {
    const anchors =
      '#sdp-review, #sdpReview, [id*="sdp-review"], [id*="sdpReview"], [class*="sdp-review"], [data-comp="sdpReviews"]'.split(', ');
    for (const sel of anchors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          try {
            el.scrollIntoView({ block: 'start', behavior: 'auto' });
          } catch (_) {
            el.scrollIntoView(true);
          }
          break;
        }
      } catch (_) {
        /* ignore */
      }
    }

    const firstHelpful = document.querySelector('.js_reviewArticleHelpfulContainer');
    if (firstHelpful) {
      try {
        firstHelpful.scrollIntoView({ block: 'center', behavior: 'auto' });
      } catch (_) {
        try {
          firstHelpful.scrollIntoView(true);
        } catch (_) {
          /* ignore */
        }
      }
      await this.wait(600);
    }

    const legacyCount = () => document.querySelectorAll('.sdp-review__article__list').length;
    const twcHelpfulCount = () => document.querySelectorAll('.js_reviewArticleHelpfulContainer').length;

    for (let i = 0; i < 8; i++) {
      if (i === 2) this.clickReviewTabIfPresent();
      window.scrollBy(0, 400);
      await this.wait(350);
      if (
        this.collectReviewRootElements().length > 0 ||
        legacyCount() > 0 ||
        twcHelpfulCount() > 0
      ) {
        return;
      }
    }
    this.clickReviewTabIfPresent();
    await this.wait(800);
  }

  // 리뷰 데이터 추출
  extractReviews() {
    let reviewElements = this.collectReviewRootElements();
    if (!reviewElements.length) {
      const legacy = [...document.querySelectorAll('.sdp-review__article__list')];
      if (legacy.length) reviewElements = legacy;
    }

    const extractedReviews = [];

    reviewElements.forEach((element, index) => {
      try {
        const review = {
          id: index + 1,
          rating: this.extractRating(element),
          title: this.extractTitle(element),
          content: this.extractContent(element),
          author: this.extractAuthor(element),
          date: this.extractDate(element),
          helpful: this.extractHelpful(element),
          images: this.extractImages(element),
          productInfo: this.extractProductInfo(element)
        };
        
        if (review.content && review.content.trim().length > 0) {
          extractedReviews.push(review);
        }
      } catch (error) {
        console.error('리뷰 추출 중 오류:', error);
      }
    });

    return extractedReviews;
  }

  // 평점 추출
  extractRating(element) {
    const ratingElement = element.querySelector('.sdp-review__rating__star__active');
    if (ratingElement && ratingElement.style?.width) {
      const pct = parseInt(String(ratingElement.style.width).replace('%', ''), 10);
      if (!Number.isNaN(pct)) return Math.round(pct / 20);
    }
    const labelled = element.querySelector(
      '[aria-label*="점"], [aria-label*="별"], [data-rating], [aria-label*="star"], [aria-label*="Star"]'
    );
    if (labelled) {
      const ds = labelled.getAttribute('data-rating');
      if (ds != null && ds !== '') {
        const n = parseFloat(ds);
        if (!Number.isNaN(n)) return Math.min(5, Math.max(0, Math.round(n)));
      }
      const label = labelled.getAttribute('aria-label') || '';
      const m = label.match(/(\d(?:\.\d)?)\s*(?:점|\/\s*5|\/\s*5점|stars?)/i) || label.match(/(\d)\s*\/?\s*5/);
      if (m) {
        const n = parseFloat(m[1]);
        if (!Number.isNaN(n)) return Math.min(5, Math.max(0, Math.round(n)));
      }
    }
    return null;
  }

  // 리뷰 제목 추출
  extractTitle(element) {
    const titleElement = element.querySelector(
      '.sdp-review__article__list__headline, [class*="sdp-review__article__list__headline"]'
    );
    return titleElement ? titleElement.textContent.trim() : '';
  }

  textFromFirst(selectors, root) {
    for (const sel of selectors.split(', ').map((s) => s.trim())) {
      const n = root.querySelector(sel);
      if (n) {
        const t = (n.innerText || n.textContent || '').trim();
        if (t) return t;
      }
    }
    return '';
  }

  // 리뷰 내용 추출
  extractContent(element) {
    const legacy = this.textFromFirst(
      '.sdp-review__article__list__review__content, .js_reviewArticleContent, [class*="article__list__review__content"]',
      element
    );
    if (legacy) return legacy;

    const spanInBreak = element.querySelector('[class*="twc-break-all"] span[class*="twc-bg-white"]');
    if (spanInBreak) {
      const t = (spanInBreak.innerText || spanInBreak.textContent || '').trim();
      if (t) return t;
    }
    const translatedNo = element.querySelector('span[translate="no"][class*="twc-bg-white"]');
    if (translatedNo) {
      const t = (translatedNo.innerText || translatedNo.textContent || '').trim();
      if (t) return t;
    }
    const breakAll = element.querySelector('[class*="twc-break-all"]');
    if (breakAll) {
      const t = (breakAll.innerText || breakAll.textContent || '').trim();
      if (t) return t;
    }
    return '';
  }

  // 작성자 추출
  extractAuthor(element) {
    return this.textFromFirst(
      '.sdp-review__article__list__user__name, [class*="article__list__user__name"]',
      element
    );
  }

  // 작성일 추출
  extractDate(element) {
    return this.textFromFirst(
      '.sdp-review__article__list__user__date, time, [class*="article__list__user__date"], [datetime]',
      element
    );
  }

  // 도움됨 수 추출
  extractHelpful(element) {
    const twcHelp = element.querySelector(
      '.js_reviewArticleHelpfulContainer, .sdp-review__article__list__help[data-review-id]'
    );
    if (twcHelp && twcHelp.hasAttribute('data-count')) {
      const n = parseInt(twcHelp.getAttribute('data-count'), 10);
      if (!Number.isNaN(n)) return n;
    }
    const helpfulElement = element.querySelector('.sdp-review__article__list__feedback__button--active');
    return helpfulElement ? parseInt(helpfulElement.textContent.trim(), 10) || 0 : 0;
  }

  // 리뷰 이미지 추출
  extractImages(element) {
    const imageElements = element.querySelectorAll('.sdp-review__article__list__photo__item img');
    return Array.from(imageElements).map(img => img.src);
  }

  // 상품 정보 추출
  extractProductInfo(element) {
    const productElement = element.querySelector('.sdp-review__article__list__product__name');
    if (productElement) return productElement.textContent.trim();
    const lineClamp = element.querySelector('[class*="twc-line-clamp"]');
    if (lineClamp) {
      const t = (lineClamp.innerText || lineClamp.textContent || '').trim();
      if (t) return t;
    }
    return '';
  }

  /** @param {ParentNode | Document | null | undefined} [scope] */
  findPaginationActiveEl(scope) {
    const root = scope && scope.querySelector ? scope : document;
    return (
      root.querySelector(
        '.sdp-review__article__page__num--active, .sdp-review__article__page__num[class*="active"], button[class*="sdp-review"][class*="page__num"][class*="active"]'
      ) ||
      root.querySelector(
        'button[data-page][aria-current="page"], button[data-page][aria-current="true"], [role="button"][data-page][aria-current="page"]'
      ) ||
      root.querySelector(
        'button[aria-current="page"][data-page], a[aria-current="page"][data-page]'
      )
    );
  }

  /** @param {ParentNode | Document | null | undefined} [scope] */
  findPaginationButtonByNum(scope, pageNum) {
    const root = scope && scope.querySelector ? scope : document;
    const n = String(pageNum);
    const btnCandidate =
      root.querySelector(`.sdp-review__article__page__num[data-page="${n}"]`) ||
      root.querySelector(`[data-page="${n}"][class*="sdp-review"][class*="page"]`);

    const dataPageBtns = [...root.querySelectorAll(`[data-page="${n}"]`)].filter(
      (el) => !el.closest?.('.js_reviewArticleHelpfulContainer')
    );

    const textMatch =
      [...root.querySelectorAll('button, [role="button"], a')].find(
        (el) =>
          !el.closest?.('.js_reviewArticleHelpfulContainer') &&
          /^\s*\d{1,4}\s*$/.test((el.textContent || '').trim()) &&
          (el.textContent || '').trim() === n
      );

    const nonDiv = dataPageBtns.find((el) => el.matches?.('button, a, [role="button"]'));
    const firstClickable = btnCandidate || nonDiv;
    return firstClickable || textMatch || null;
  }

  getReviewPaginationScope() {
    const articles = this.rootsFromHelpfulContainers();
    const marker = articles[0] || document.querySelector('.js_reviewArticleHelpfulContainer');

    let el = marker ? marker.parentElement : null;
    let lastGood = marker ? marker.closest('main') || document.body : document.body;

    for (let depth = 0; depth < 28 && el; depth++) {
      const btns = [...el.querySelectorAll('button')].filter((b) => !b.closest?.('.js_reviewArticleHelpfulContainer'));
      const numbered = btns.filter((b) =>
        /^\s*\d{1,4}\s*$/.test((b.textContent || '').trim())
      );

      const hasClassic = !!el.querySelector('.sdp-review__article__page__num');

      const hasNextStyle = btns.some((b) =>
        /next|다음/i.test(`${b.getAttribute('aria-label') || ''}${b.title || ''}${b.textContent || ''}`)
      );

      const hasMetaWrapper =
        [...el.querySelectorAll('[data-start][data-end][data-page]')].filter((n) => n !== document.body)
          .length > 0;

      if (
        (numbered.length >= 2 || (numbered.length >= 1 && hasNextStyle)) &&
        numbered.length <= 80
      ) {
        lastGood = el;
        if (numbered.length >= 2 || hasClassic || hasMetaWrapper) return lastGood;
      }
      el = el.parentElement;
    }

    const main = document.querySelector('main');
    return main || lastGood || document.body;
  }

  collectNumberedPageButtons(scope) {
    const root = scope && scope.querySelector ? scope : document;
    return [...root.querySelectorAll('button, [role="button"], a')].filter(
      (el) =>
        !el.closest?.('.js_reviewArticleHelpfulContainer') &&
        /^\s*\d{1,4}\s*$/.test((el.textContent || '').trim())
    );
  }

  inferCurrentReviewPageFromScope(scope) {
    let n = NaN;

    const metas = [...scope.querySelectorAll('[data-page][data-start][data-end]')].filter(
      (el) => el.tagName !== 'BODY'
    );
    const metaEl = metas.sort((a, b) => {
      try {
        return b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom;
      } catch (_) {
        return 0;
      }
    })[0];
    if (metaEl) {
      const p = parseInt(metaEl.getAttribute('data-page') || '', 10);
      if (!Number.isNaN(p) && p >= 1) n = p;
    }

    const legacyActive = scope.querySelector(
      '.sdp-review__article__page__num--active, .sdp-review__article__page__num[class*="active"]'
    );

    if (Number.isNaN(n) || n < 1) {
      const dp = legacyActive?.getAttribute('data-page');
      if (dp != null && dp !== '') {
        const pn = parseInt(dp, 10);
        if (!Number.isNaN(pn) && pn >= 1) n = pn;
      }
    }

    if (Number.isNaN(n) || n < 1) {
      if (legacyActive) {
        const t = String(legacyActive.textContent || '').trim();
        if (/^\d+$/.test(t)) {
          const pn = parseInt(t, 10);
          if (!Number.isNaN(pn)) n = pn;
        }
      }
    }

    if (Number.isNaN(n) || n < 1) {
      const ariaBtn = this.collectNumberedPageButtons(scope).find((btn) =>
        ['page', 'true'].includes((btn.getAttribute('aria-current') || '').trim())
      );
      if (ariaBtn) {
        const pn = parseInt(ariaBtn.textContent.trim(), 10);
        if (!Number.isNaN(pn) && pn >= 1) n = pn;
      }
    }

    if (Number.isNaN(n) || n < 1) {
      const guessed = this.collectNumberedPageButtons(scope).find((btn) =>
        /underline|accent|Orange|orange|Bold|bold|Brand|Brand600|Selected|pointer-events-none|twc-underline/i.test(
          `${btn.className}`
        )
      );
      if (guessed) {
        const pn = parseInt(guessed.textContent.trim(), 10);
        if (!Number.isNaN(pn) && pn >= 1) n = pn;
      }
    }

    return Number.isNaN(n) || n < 1 ? null : n;
  }

  findNextPageFallbackControl(scope) {
    const root = scope && scope.querySelector ? scope : document;

    const cands = [
      ...root.querySelectorAll(
        'button, a[href], [role="button"]'
      ),
    ].filter((el) => !el.closest?.('.js_reviewArticleHelpfulContainer'));

    return (
      cands.find((el) =>
        /\b(next|다음페이지)/i.test(el.getAttribute('aria-label') || '')
      ) ||
      cands.find((el) =>
        /\b(next|다음\s*페이지)/i.test(
          `${el.title || ''}${el.textContent || ''}${el.getAttribute('aria-label') || ''}`
        )
      ) ||
      null
    );
  }

  getVisibleReviewIdSnapshot(limit = 22) {
    return [
      ...document.querySelectorAll(
        '.js_reviewArticleHelpfulContainer[data-review-id]'
      ),
    ]
      .slice(0, limit)
      .map((el) => el.getAttribute('data-review-id') || '')
      .join('|');
  }

  snapshotChanged(beforeSnap, beforePage, scope) {
    const afterSnap = this.getVisibleReviewIdSnapshot();
    const root = scope?.querySelector ? scope : document;
    const afterPage = this.inferCurrentReviewPageFromScope(root);
    if (beforeSnap !== '' && afterSnap !== beforeSnap) return true;
    if (
      typeof beforePage === 'number' &&
      !Number.isNaN(beforePage) &&
      afterPage !== null &&
      afterPage !== beforePage
    ) {
      return true;
    }
    return false;
  }

  // 다음 페이지 이동: 스코프 한정 검색 + 클릭 후 리뷰 ID 목록 변경까지 대기
  async goToNextPage() {
    console.log('다음 페이지로 이동 시도...');

    const scope = this.getReviewPaginationScope();
    const main = document.querySelector('main') || document.body;

    const beforeSnap = this.getVisibleReviewIdSnapshot();
    const beforePageGuess = this.inferCurrentReviewPageFromScope(scope);

    const legacyActiveWithDp = this.findPaginationActiveEl(scope);
    let current =
      typeof beforePageGuess === 'number' ? beforePageGuess : NaN;
    if ((Number.isNaN(current) || current < 1) && legacyActiveWithDp?.getAttribute?.('data-page')) {
      current = parseInt(legacyActiveWithDp.getAttribute('data-page'), 10);
    }

    let nextNum = typeof current === 'number' && !Number.isNaN(current) ? current + 1 : NaN;

    let nextBtn = Number.isFinite(nextNum)
      ? this.findPaginationButtonByNum(scope, nextNum)
      : null;

    if (!nextBtn) {
      nextBtn = this.findNextPageFallbackControl(scope);
    }

    const numsAscending = [...this.collectNumberedPageButtons(scope)]
      .map((b) => parseInt(String(b.textContent || '').trim(), 10))
      .filter((x) => !Number.isNaN(x) && x >= 1)
      .sort((a, b) => a - b);

    if (!nextBtn && Number.isFinite(numsAscending[0]) && numsAscending.length >= 2) {
      const low = numsAscending[0];
      nextNum = low + 1;
      console.log(`페이지번호 추정 불가 → 보이는 최소 ${low}, 다음 클릭 ${nextNum}`);
      nextBtn = this.findPaginationButtonByNum(scope, nextNum);
    }

    if (!nextBtn && Number.isFinite(nextNum)) {
      nextBtn = this.findPaginationButtonByNum(main, nextNum);
    }

    if (!nextBtn && !Number.isFinite(nextNum)) {
      nextBtn =
        this.findNextPageFallbackControl(scope) ||
        this.findNextPageFallbackControl(main);
    }

    if (!nextBtn) {
      console.log('다음 페이지 컨트롤 없음.');
      return false;
    }

    const nextCue = /\b(next|다음페이지|다음\s*페이지)\b/i.test(
      `${nextBtn.getAttribute('aria-label') || ''}${nextBtn.textContent || ''}`
    );

    const hardDisabled =
      nextBtn.disabled ||
      nextBtn.classList.contains('disabled') ||
      nextBtn.getAttribute('aria-disabled') === 'true';

    if (hardDisabled && !nextCue) {
      console.log('페이지네이션 비활성(막 페이지 또는 제한).');
      return false;
    }

    try {
      nextBtn.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    } catch (_) {
      try {
        nextBtn.scrollIntoView(true);
      } catch (_) {
        /* ignore */
      }
    }
    await this.wait(500);

    nextBtn.click?.();

    await this.waitForPageLoadAfterPagination(beforeSnap, beforePageGuess, scope);
    return true;
  }

  async waitForPageLoadAfterPagination(previousSnapshot, previousPageHint, scopeHint) {
    await this.wait(750);

    const scope =
      scopeHint?.querySelector && scopeHint !== document.documentElement
        ? scopeHint
        : this.getReviewPaginationScope();

    let i = 0;
    while (i < 30) {
      if (this.snapshotChanged(previousSnapshot, previousPageHint, scope)) {
        await this.wait(1100);
        return;
      }
      await this.wait(430);
      i++;
    }
    await this.wait(1800);
  }

  /** 최초 진입 또는 비-페이지 이동 시 로딩 안정화 */
  async waitForPageLoad() {
    console.log('페이지 로딩 중...');
    await this.wait(1600);

    let tries = 0;
    while (tries++ < 16) {
      const ok =
        document.querySelectorAll('.sdp-review__article__list').length > 0 ||
        document.querySelectorAll('.js_reviewArticleHelpfulContainer').length > 0 ||
        this.collectReviewRootElements().length > 0;
      if (ok) break;
      await this.wait(450);
    }

    await this.wait(900);
    console.log('페이지 로딩 완료');
  }

  // 대기 함수
  wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 크롤링 시작
  async startCrawling() {
    if (this.isCrawling) return;

    this.isCrawling = true;
    this.reviews = [];
    this.currentPage = 1;

    console.log('쿠팡 리뷰 크롤링 시작...');
    console.log(`최대 ${this.maxPages}페이지까지 크롤링 예정`);

    try {
      await this.ensureReviewSectionRendered();

      while (this.isCrawling && this.currentPage <= this.maxPages) {
        console.log(`=== 페이지 ${this.currentPage} 크롤링 시작 ===`);

        // 현재 페이지의 리뷰 추출
        const pageReviews = this.extractReviews();
        this.reviews.push(...pageReviews);
        
        console.log(`페이지 ${this.currentPage}에서 ${pageReviews.length}개 리뷰 추출됨`);
        console.log(`현재까지 총 ${this.reviews.length}개 리뷰 수집됨`);
        
        // 진행 상황을 팝업에 전송
        chrome.runtime.sendMessage({
          type: 'CRAWLING_PROGRESS',
          data: {
            currentPage: this.currentPage,
            maxPages: this.maxPages,
            collectedReviews: this.reviews.length,
            pageReviews: pageReviews.length
          }
        });
        
        // 마지막 페이지인지 확인
        if (this.currentPage >= this.maxPages) {
          console.log('설정된 최대 페이지 수에 도달했습니다.');
          break;
        }
        
        // 다음 페이지로 이동
        console.log('다음 페이지로 이동 시도...');
        const hasNextPage = await this.goToNextPage();
        
        if (!hasNextPage) {
          console.log('더 이상 페이지가 없습니다.');
          break;
        }
        
        this.currentPage++;
        console.log(`=== 페이지 ${this.currentPage}로 이동 완료 ===`);
      }
      
      console.log(`크롤링 완료! 총 ${this.reviews.length}개 리뷰 수집됨`);
      
      // 크롤링된 데이터를 storage에 저장
      await this.saveReviews();
      
      // 팝업에 완료 메시지 전송
      chrome.runtime.sendMessage({
        type: 'CRAWLING_COMPLETE',
        data: {
          productUrl: window.location.href,
          totalReviews: this.reviews.length,
          reviews: this.reviews,
          pagesCrawled: this.currentPage
        }
      });
      
    } catch (error) {
      console.error('크롤링 중 오류 발생:', error);
      chrome.runtime.sendMessage({
        type: 'CRAWLING_ERROR',
        error: error.message
      });
    } finally {
      this.isCrawling = false;
      console.log('크롤링 프로세스 종료');
    }
  }

  // 크롤링 중지
  stopCrawling() {
    this.isCrawling = false;
    console.log('크롤링이 중지되었습니다.');
  }

  // 리뷰 데이터 저장
  async saveReviews() {
    const data = {
      productUrl: window.location.href,
      crawledAt: new Date().toISOString(),
      totalReviews: this.reviews.length,
      reviews: this.reviews
    };
    
    await chrome.storage.local.set({
      'coupang_reviews': data
    });
  }

  // 엑셀 형태로 데이터 내보내기
  exportToExcel() {
    if (this.reviews.length === 0) {
      console.log('내보낼 리뷰가 없습니다.');
      return;
    }

    // 엑셀용 데이터 준비
    const excelData = this.reviews.map(review => ({
      'ID': review.id,
      '평점': review.rating || '',
      '제목': review.title || '',
      '내용': review.content || '',
      '작성자': review.author || '',
      '작성일': review.date || '',
      '도움됨': review.helpful || 0,
      '상품정보': review.productInfo || ''
    }));

    // 실제 XLSX 형식으로 파일 생성
    const xlsxData = this.createXLSXFile(excelData);
    
    // CSV 파일로 다운로드 (엑셀에서 열 수 있음)
    const blob = new Blob([xlsxData], { 
      type: 'text/csv;charset=utf-8;' 
    });
    
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `coupang_reviews_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    console.log('CSV 파일이 다운로드되었습니다.');
  }

  // 엑셀 호환 CSV 파일 생성
  createXLSXFile(data) {
    const headers = ['ID', '평점', '제목', '내용', '작성자', '작성일', '도움됨', '상품정보'];
    
    // CSV 내용 생성
    const csvRows = [
      headers.join(','),
      ...data.map(row => 
        headers.map(header => {
          const value = row[header] || '';
          // 특수문자 처리
          const escapedValue = value.toString()
            .replace(/"/g, '""')  // 따옴표 이스케이프
            .replace(/\n/g, ' ')  // 줄바꿈을 공백으로
            .replace(/\r/g, ' '); // 캐리지 리턴을 공백으로
          
          // 따옴표로 감싸기
          return `"${escapedValue}"`;
        }).join(',')
      )
    ];
    
    const csvContent = csvRows.join('\n');
    
    // UTF-8 BOM 추가 (엑셀에서 한글 인코딩 문제 해결)
    return '\uFEFF' + csvContent;
  }

  // HTML 이스케이프 함수
  escapeHtml(text) {
    if (!text) return '';
    return text.toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

// 크롤러 인스턴스 생성
const crawler = new CoupangReviewCrawler();

// 콘텐츠 스크립트 로드 완료 신호
console.log('쿠팡 리뷰 크롤러 콘텐츠 스크립트 로드 완료');

// 메시지 리스너
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('콘텐츠 스크립트에서 메시지 수신:', request.type);
  
  switch (request.type) {
    case 'START_CRAWLING':
      // 최대 페이지 수 설정
      if (request.maxPages) {
        crawler.maxPages = request.maxPages;
        console.log(`최대 페이지 수 설정: ${crawler.maxPages}`);
      }
      crawler.startCrawling();
      sendResponse({ success: true });
      break;
      
    case 'STOP_CRAWLING':
      crawler.stopCrawling();
      sendResponse({ success: true });
      break;
      
    case 'EXPORT_EXCEL':
      crawler.exportToExcel();
      sendResponse({ success: true });
      break;
      
    case 'GET_REVIEWS':
      sendResponse({ reviews: crawler.reviews });
      break;
      
    case 'PAGE_LOADED':
      console.log('페이지 로드 완료 메시지 수신:', request.url);
      sendResponse({ success: true });
      break;
      
    case 'CRAWLING_PROGRESS':
      // 크롤링 진행 상황 로그
      console.log('크롤링 진행:', request.data);
      break;
      
    case 'CRAWLING_COMPLETE':
      // 크롤링 완료 로그
      console.log('=== 크롤링 완료 ===', request.data);
      break;
      
    case 'CRAWLING_ERROR':
      // 크롤링 오류 로그
      console.log('크롤링 오류:', request.error);
      break;
      
    case 'PING':
      // 콘텐츠 스크립트 존재 확인
      sendResponse({ success: true, message: 'pong' });
      break;

    case 'GET_PRODUCT_META': {
      const titleEl =
        document.querySelector('h1.product-title') ||
        document.querySelector('h1[class*="twc-"]') ||
        document.querySelector('h1') ||
        document.querySelector('[class*="product-title"]');
      sendResponse({
        title: (titleEl?.textContent || document.title || '').trim(),
        productUrl: window.location.href
      });
      break;
    }
      
    default:
      console.log('알 수 없는 메시지 타입:', request.type);
      sendResponse({ error: 'Unknown message type' });
  }
  
  return true; // 비동기 응답을 위해 true 반환
});

// 페이지 로드 완료 후 초기화
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    console.log('쿠팡 리뷰 크롤러가 로드되었습니다.');
    console.log('현재 URL:', window.location.href);
    console.log('페이지네이션 요소 확인:', document.querySelectorAll('.sdp-review__article__page__num').length);
    console.log('활성 페이지:', document.querySelector('.sdp-review__article__page__num--active')?.getAttribute('data-page'));
  });
} else {
  console.log('쿠팡 리뷰 크롤러가 로드되었습니다.');
  console.log('현재 URL:', window.location.href);
  console.log('페이지네이션 요소 확인:', document.querySelectorAll('.sdp-review__article__page__num').length);
  console.log('활성 페이지:', document.querySelector('.sdp-review__article__page__num--active')?.getAttribute('data-page'));
}

} // 중복 실행 방지 블록 종료