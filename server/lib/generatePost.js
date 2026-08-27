function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ratingStats(reviews) {
  const rated = reviews.filter((r) => typeof r.rating === 'number' && r.rating > 0);
  if (!rated.length) return { avg: null, counts: {} };
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  rated.forEach((r) => {
    const b = Math.min(5, Math.max(1, Math.round(r.rating)));
    counts[b] = (counts[b] || 0) + 1;
    sum += r.rating;
  });
  return { avg: (sum / rated.length).toFixed(1), counts, ratedCount: rated.length };
}

function pickHighlightReviews(reviews, limit = 8) {
  return [...reviews]
    .filter((r) => (r.content || '').trim().length > 20)
    .sort((a, b) => (b.content?.length || 0) - (a.content?.length || 0))
    .slice(0, limit);
}

function normalizeKeyword(keyword) {
  return String(keyword || '').trim().replace(/\s+/g, ' ');
}

function normalizeProducts(payload) {
  if (Array.isArray(payload.products) && payload.products.length) {
    return payload.products.map((p) => ({
      productTitle: p.productTitle || '쿠팡 상품',
      productUrl: p.productUrl || '',
      reviews: p.reviews || [],
      totalReviews: p.totalReviews || (p.reviews || []).length
    }));
  }
  return [
    {
      productTitle: payload.productTitle || '쿠팡 상품',
      productUrl: payload.productUrl || '',
      reviews: payload.reviews || [],
      totalReviews: payload.totalReviews || (payload.reviews || []).length
    }
  ];
}

function keywordTargetRange(productCount) {
  const n = Math.max(1, productCount);
  return { min: n * 5, max: n * 6 };
}

/** SEO 키워드·상품명 기반 기본 태그 */
function buildTagsFromPayload(payload) {
  const products = normalizeProducts(payload);
  const kw = normalizeKeyword(payload.seoKeyword);
  const tags = [];
  const push = (t) => {
    const s = String(t || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 40);
    if (!s || s.length < 2) return;
    if (tags.some((x) => x.toLowerCase() === s.toLowerCase())) return;
    tags.push(s);
  };

  if (kw) {
    push(kw);
    push(`${kw} 추천`);
    push(`${kw} 후기`);
    kw.split(/\s+/)
      .filter((w) => w.length >= 2)
      .forEach((w) => push(w));
  }

  products.slice(0, 5).forEach((p) => {
    const title = String(p.productTitle || '').trim();
    // 브랜드/짧은 핵심어: 앞 2~3토큰 (너무 긴 마케팅 문장 제외)
    const parts = title.split(/\s+/).filter(Boolean);
    if (parts[0] && parts[0].length <= 12) push(parts[0]);
    if (parts.length >= 2 && (parts[0] + ' ' + parts[1]).length <= 20) {
      push(`${parts[0]} ${parts[1]}`);
    }
  });

  push('쿠팡');
  push('구매후기');

  return tags.slice(0, 12);
}

async function buildTagsWithOpenAI(payload, config) {
  const products = normalizeProducts(payload);
  const kw = normalizeKeyword(payload.seoKeyword);
  const fallback = buildTagsFromPayload(payload);
  if (!config.openaiApiKey || !kw) return fallback;

  try {
    const parsed = await callOpenAIJson(
      [
        {
          role: 'system',
          content:
            '한국어 SEO 태그 생성기. WordPress 태그용 짧은 한글 키워드만 JSON으로 반환.'
        },
        {
          role: 'user',
          content: `SEO 핵심 키워드: 「${kw}」
상품명 목록:
${products.map((p, i) => `${i + 1}. ${p.productTitle}`).join('\n')}

규칙:
- 5~10개 태그
- 각 태그는 1~4단어, 40자 이내
- SEO 키워드와 자연스러운 연관어 포함
- 해시태그(#) 금지
- JSON만: {"tags":["태그1","태그2",...]}`
        }
      ],
      config
    );
    const aiTags = Array.isArray(parsed.tags) ? parsed.tags : [];
    const merged = [];
    const push = (t) => {
      const s = String(t || '')
        .trim()
        .replace(/^#/, '')
        .replace(/\s+/g, ' ')
        .slice(0, 40);
      if (!s || s.length < 2) return;
      if (merged.some((x) => x.toLowerCase() === s.toLowerCase())) return;
      merged.push(s);
    };
    push(kw);
    aiTags.forEach(push);
    fallback.forEach(push);
    return merged.slice(0, 12);
  } catch (err) {
    console.warn('태그 OpenAI 생성 실패, 기본 태그 사용:', err.message);
    return fallback;
  }
}

/**
 * 상품 1개분 HTML (서론 → 본론[특징6·팁·체크] → 결론)
 * 예시 글 구조와 동일하게 맞춤.
 */
function buildOneProductSection(p, kw, index, productCount) {
  const highlights = pickHighlightReviews(p.reviews, 6);
  const quotes = highlights
    .slice(0, 3)
    .map((r) => `<blockquote><p>${escapeHtml((r.content || '').slice(0, 180))}</p></blockquote>`)
    .join('\n');
  const name = escapeHtml(p.productTitle);
  const url = escapeHtml(p.productUrl);
  const k = escapeHtml(kw);
  const heading =
    productCount > 1 ? `<h2>${index + 1}. ${name}</h2>` : `<h2>${name}</h2>`;

  return `
<section>
${heading}

<h3>서론</h3>
<p>실제 구매 후기를 모아 보면 <strong>${k}</strong> 선택에서 이 상품이 자주 거론됩니다. 디자인·성능·관리 편의의 균형이 어떤지, 리뷰 톤을 기준으로 정리했습니다.</p>
<p>과장된 광고 문구보다 실사용 체감이 중요합니다. 아래에서는 후기에서 반복된 포인트를 중심으로 <strong>${k}</strong> 관점의 장단을 풀어 봅니다.</p>

<h3>본론</h3>

<h4>제품 특징(리뷰 기반 핵심 6가지)</h4>

<p><strong>1. 실사용에서 체감되는 기본기</strong><br>
후기에서는 일상 사용 만족도가 꾸준히 언급됩니다. <strong>${k}</strong> 후보로 볼 때 “무난하게 잘 쓴다”는 평가가 많았습니다.</p>

<p><strong>2. 가격 대비 가성비 인식</strong><br>
가격과 기대치를 맞춘 구매자에게 만족도가 높다는 의견이 반복됐습니다. 상위 라인과 직접 비교하면 아쉽다는 솔직한 후기도 함께 보입니다.</p>

<p><strong>3. 부가 기능·메뉴 활용도</strong><br>
기본 용도 외에 부가 모드를 활용했다는 후기가 눈에 띕니다. 주말에 몰아 쓰고 평일에 활용하는 패턴이 자주 등장했습니다.</p>

<p><strong>4. 세척·관리 편의</strong><br>
분리 세척·건조 루틴을 언급한 리뷰가 많았습니다. 관리만 성실히 하면 냄새·오염 누적을 줄일 수 있다는 조언이 공통적입니다.</p>

<p><strong>5. 조작·예약·일상 동선</strong><br>
버튼·메뉴가 직관적이라 가족도 적응이 빨랐다는 평가가 있었습니다. 하루 루틴에 넣기 쉽다는 점이 <strong>${k}</strong> 선택 이유로 꼽혔습니다.</p>

<p><strong>6. 소음·한계점에 대한 현실 체감</strong><br>
장점만 있는 것은 아닙니다. 소음·배출음·기대치 미스매치 등 현실적인 단점도 후기에 함께 나옵니다. 구매 전 사용 환경과 맞춰 보는 것이 좋습니다.</p>

${quotes || '<p>표시할 대표 후기 인용은 부족합니다.</p>'}

<p><a href="${url}" target="_blank" rel="nofollow noopener">상품 보러가기</a></p>

<h4>사용 팁(리뷰에서 자주 나온 조언)</h4>
<ul>
<li>설명서 기본값을 기준으로 2~3회 미세 조정하면 ‘우리 집 세팅’이 빨리 잡힙니다.</li>
<li>사용 직후 주요 부품을 분리 세척·건조하면 관리 스트레스가 줄어듭니다.</li>
<li><strong>${k}</strong> 구매 후엔 설치 자리를 고정해 두고 동선을 단순화하라는 조언이 많았습니다.</li>
<li>몰아 사용→소분·보관 루틴을 병행하면 평일 활용도가 올라간다는 후기가 있습니다.</li>
</ul>

<h4>체크 포인트(구매 전 참고)</h4>
<ul>
<li>상위 라인과 정면 비교하면 기대치가 높아질 수 있습니다. 일상형 기준으로 보세요.</li>
<li>소음·배출·크기 등 환경 제약을 미리 확인하세요.</li>
<li>가족 수·사용 빈도에 <strong>${k}</strong> 체급이 맞는지 먼저 결정하면 선택이 쉬워집니다.</li>
</ul>

<h3>결론</h3>
<p>종합하면 이 상품은 실사용 기본기·관리 편의·일상 동선을 고르게 갖춘 <strong>${k}</strong> 후보로 요약됩니다. 상위 스펙 경쟁보다 “매일 번거로움 없이”에 초점을 두면 만족도가 높습니다.</p>
<p>리뷰 기준으로 보면 라이프스타일에 맞는 분에게는 실사용 만족 확률이 높은 선택입니다. 초기 세팅만 빠르게 잡으면 <strong>${k}</strong> 하나로 평일 루틴이 한결 가벼워질 수 있습니다.</p>
<p><a href="${url}" target="_blank" rel="nofollow noopener">${name}</a></p>
</section>
`.trim();
}

function buildTemplatePost(payload) {
  const products = normalizeProducts(payload);
  const kw = normalizeKeyword(payload.seoKeyword) || products[0].productTitle;
  const { min, max } = keywordTargetRange(products.length);
  const title = `${kw} 추천 — 구매 후기 총정리`.slice(0, 70);

  const sections = products
    .map((p, i) => buildOneProductSection(p, kw, i, products.length))
    .join('\n\n');

  const content = `${sections}
<p><em>※ 본 글은 자동 수집·편집된 리뷰 요약입니다. (키워드 목표 ${min}~${max}회)</em></p>`;

  return { title, content, tags: buildTagsFromPayload(payload) };
}

async function callOpenAIJson(messages, config) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.openaiModel,
      messages,
      temperature: 0.55
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI 오류: ${res.status} ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('OpenAI 응답 JSON 파싱 실패');
  const parsed = JSON.parse(jsonMatch[0]);
  return parsed;
}

/** 상품 1개분 HTML (서론·본론·결론) — OpenAI */
async function buildOneProductSectionOpenAI(product, kw, index, total, config) {
  const stats = ratingStats(product.reviews);
  const reviewSamples = pickHighlightReviews(product.reviews, 10).map((r) => ({
    rating: r.rating,
    content: (r.content || '').slice(0, 400)
  }));

  const heading =
    total > 1
      ? `<h2>${index + 1}. ${escapeHtml(product.productTitle)}</h2>`
      : `<h2>${escapeHtml(product.productTitle)}</h2>`;

  const prompt = `당신은 한국어 SEO 쇼핑 블로그 에디터입니다.
아래 **상품 1개**의 쿠팡 구매 후기만 바탕으로 WordPress HTML 섹션을 작성하세요.

# SEO 키워드
「${kw}」 — 이 상품 섹션 본문에 **5~6회** 자연스럽게 포함 (제목 h2 제외)

# HTML 구조 (반드시 이 순서·제목 그대로)
${heading}
<h3>서론</h3>
<p>…니즈·상황 1~2문단. 리뷰 종합 관점. 키워드 자연 포함…</p>

<h3>본론</h3>
<h4>제품 특징(리뷰 기반 핵심 6가지)</h4>
<p><strong>특징 소제목 1</strong><br>리뷰 근거 설명 2~4문장…</p>
…정확히 6개 항목…
<h4>사용 팁(리뷰에서 자주 나온 조언)</h4>
<ul><li>…</li><li>…</li><li>…</li><li>…</li></ul>
<h4>체크 포인트(구매 전 참고)</h4>
<ul><li>…</li><li>…</li><li>…</li></ul>

<h3>결론</h3>
<p>…이 상품 요약 + 누구에게 맞는지 2~3문단. 키워드 재언급…</p>
<p><a href="${escapeHtml(product.productUrl)}" target="_blank" rel="nofollow noopener">${escapeHtml(product.productTitle)}</a></p>

# 규칙
- 마크다운 금지, HTML만
- 리뷰에 없는 스펙·수치 지어내지 말 것
- 리뷰 원문 장문 복붙 금지
- 다른 상품 언급·비교 금지 (이 상품만)
- JSON만 출력: {"section":"...HTML..."}

# 상품 데이터
${JSON.stringify(
  {
    productTitle: product.productTitle,
    productUrl: product.productUrl,
    totalReviews: product.totalReviews,
    avgRating: stats.avg,
    reviewSamples
  },
  null,
  2
)}`;

  const parsed = await callOpenAIJson(
    [
      {
        role: 'system',
        content:
          '한국어 SEO 쇼핑 에디터. 상품 1개분 서론-본론(특징6+팁+체크)-결론 HTML만 JSON({"section"})로 반환.'
      },
      { role: 'user', content: prompt }
    ],
    config
  );

  if (!parsed.section || !String(parsed.section).includes('서론')) {
    throw new Error(`상품 ${index + 1} OpenAI 섹션 형식 오류`);
  }
  return String(parsed.section).trim();
}

async function buildMultiProductOpenAI(products, kw, config) {
  const sections = [];
  for (let i = 0; i < products.length; i++) {
    console.log(`  OpenAI 상품 ${i + 1}/${products.length}: ${products[i].productTitle}`);
    try {
      sections.push(await buildOneProductSectionOpenAI(products[i], kw, i, products.length, config));
    } catch (err) {
      console.warn(`  상품 ${i + 1} OpenAI 실패, 템플릿 사용:`, err.message);
      sections.push(buildOneProductSection(products[i], kw, i, products.length));
    }
  }

  const { min, max } = keywordTargetRange(products.length);
  const title = `${kw} 추천 — ${products.length}개 상품 후기`.slice(0, 70);
  const content = `${sections.join('\n\n')}
<p><em>※ 본 글은 자동 수집·편집된 리뷰 요약입니다. (키워드 목표 ${min}~${max}회)</em></p>`;

  return { title, content };
}

async function buildWithOpenAI(payload, config) {
  const products = normalizeProducts(payload);
  const kw = normalizeKeyword(payload.seoKeyword);
  if (!kw) throw new Error('SEO 키워드가 필요합니다.');

  let post;
  if (products.length > 1) {
    post = await buildMultiProductOpenAI(products, kw, config);
  } else {
    const section = await buildOneProductSectionOpenAI(products[0], kw, 0, 1, config);
    const title = `${kw} 추천 — ${products[0].productTitle}`.slice(0, 70);
    const content = `${section}
<p><em>※ 본 글은 자동 수집·편집된 리뷰 요약입니다. (키워드 5~6회)</em></p>`;
    post = { title, content };
  }

  const tags = await buildTagsWithOpenAI(payload, config);
  return { ...post, tags };
}

async function generatePost(payload, config) {
  const base = {
    ...payload,
    products: normalizeProducts(payload),
    seoKeyword: normalizeKeyword(payload.seoKeyword)
  };

  if (config.openaiApiKey) {
    try {
      return await buildWithOpenAI(base, config);
    } catch (err) {
      console.warn('OpenAI 생성 실패, 템플릿으로 대체:', err.message);
    }
  }

  return buildTemplatePost(base);
}

module.exports = {
  generatePost,
  buildTemplatePost,
  keywordTargetRange,
  buildTagsFromPayload
};
