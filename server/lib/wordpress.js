function wpAuthHeader(config) {
  const user = config.wordpressUser;
  const pass = config.wordpressAppPassword?.replace(/\s/g, '');
  return Buffer.from(`${user}:${pass}`).toString('base64');
}

function wpBase(config) {
  return (config.wordpressUrl || '').replace(/\/$/, '');
}

async function wpFetch(path, config, options = {}) {
  const base = wpBase(config);
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      Authorization: `Basic ${wpAuthHeader(config)}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch (_) {
    body = { raw: text.slice(0, 200) };
  }
  return { res, body };
}

function slugifyTerm(name, prefix = 't') {
  // WP는 한글 slug를 자동 생성하지만, 충돌·생성 실패 시 안전한 보조 slug 사용
  const ascii = String(name)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  if (ascii) return ascii;
  return `${prefix}-${Buffer.from(name, 'utf8').toString('hex').slice(0, 24)}`;
}

function normalizeTermName(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

function compactTermName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s·•\-_/.,]/g, '');
}

function findTermInList(list, name) {
  if (!Array.isArray(list)) return null;
  const exact = list.find((t) => String(t.name || '').toLowerCase() === name.toLowerCase());
  if (exact?.id) return Number(exact.id);
  const compact = compactTermName(name);
  const fuzzy = list.find((t) => compactTermName(t.name) === compact);
  if (fuzzy?.id) return Number(fuzzy.id);
  return null;
}

function parseCategoryNames(config, extraNames = []) {
  const fromEnv = String(config.wordpressCategory ?? '가전디지털')
    .split(',')
    .map((s) => normalizeTermName(s))
    .filter(Boolean);
  const extras = (extraNames || []).map((s) => normalizeTermName(s)).filter(Boolean);
  const seen = new Set();
  const names = [];
  for (const name of [...fromEnv, ...extras]) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function asIdList(arr) {
  return (arr || []).map((id) => Number(id)).filter((n) => n > 0);
}

function hasAllIds(haystack, needles) {
  const set = new Set(asIdList(haystack));
  return asIdList(needles).every((id) => set.has(id));
}

async function resolveTermIds(termNames, config, { endpoint, slugPrefix, label, listFallback }) {
  const ids = [];
  const names = [];
  const errors = [];
  const seen = new Set();

  for (const raw of termNames || []) {
    const name = normalizeTermName(raw);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());

    let foundId = null;

    const q = encodeURIComponent(name);
    const { res: searchRes, body: searchBody } = await wpFetch(
      `${endpoint}?search=${q}&per_page=40`,
      config
    );
    if (searchRes.ok && Array.isArray(searchBody)) {
      foundId = findTermInList(searchBody, name);
    }

    if (!foundId && listFallback) {
      const { res: listRes, body: listBody } = await wpFetch(
        `${endpoint}?per_page=100&hide_empty=false`,
        config
      );
      if (listRes.ok) foundId = findTermInList(listBody, name);
    }

    if (!foundId) {
      const slugCandidates = [...new Set([name, slugifyTerm(name, slugPrefix)])];
      for (const slug of slugCandidates) {
        const { res: slugRes, body: slugBody } = await wpFetch(
          `${endpoint}?slug=${encodeURIComponent(slug)}&per_page=10`,
          config
        );
        if (slugRes.ok && Array.isArray(slugBody) && slugBody[0]?.id) {
          foundId = Number(slugBody[0].id);
          break;
        }
      }
    }

    if (!foundId) {
      const slug = slugifyTerm(name, slugPrefix);
      const { res: createRes, body: createBody } = await wpFetch(endpoint, config, {
        method: 'POST',
        body: JSON.stringify({ name, slug })
      });

      if (createRes.ok && createBody?.id) {
        foundId = Number(createBody.id);
      } else {
        const existingId = createBody?.data?.term_id || createBody?.term_id;
        if (existingId) {
          foundId = Number(existingId);
        } else {
          const msg = createBody?.message || createBody?.code || createRes.statusText || 'unknown';
          errors.push(`${name}: ${msg}`);
          console.warn(`[wp-${label}] 생성 실패 "${name}":`, msg, createBody);
        }
      }
    }

    if (foundId) {
      ids.push(Number(foundId));
      names.push(name);
    }
  }

  return { ids: [...new Set(ids)], names, errors };
}

/**
 * 태그 이름으로 WP 태그 ID를 찾거나 새로 만듭니다.
 * @param {string[]} tagNames
 * @returns {Promise<{ ids: number[], names: string[], errors: string[] }>}
 */
async function resolveTagIds(tagNames, config) {
  return resolveTermIds(tagNames, config, {
    endpoint: '/wp-json/wp/v2/tags',
    slugPrefix: 't',
    label: 'tags'
  });
}

async function resolveCategoryIds(categoryNames, config) {
  return resolveTermIds(categoryNames, config, {
    endpoint: '/wp-json/wp/v2/categories',
    slugPrefix: 'c',
    label: 'categories',
    listFallback: true
  });
}

async function assignTermsToPost(postId, payload, config, label) {
  const { res, body } = await wpFetch(`/wp-json/wp/v2/posts/${postId}`, config, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const msg = body.message || body.code || res.statusText;
    throw new Error(`WordPress ${label} 연결 실패: ${msg}`);
  }
  return body;
}

function seoMetaVariants(focusKeyphrase, metaDescription) {
  const kw = String(focusKeyphrase || '').trim();
  const desc = String(metaDescription || '').trim();
  return [
    {
      label: 'Yoast',
      payload: {
        meta: {
          ...(kw ? { _yoast_wpseo_focuskw: kw } : {}),
          ...(desc ? { _yoast_wpseo_metadesc: desc } : {})
        }
      }
    },
    {
      label: 'Yoast(yoast_meta)',
      payload: {
        yoast_meta: {
          ...(kw ? { yoast_wpseo_focuskw: kw } : {}),
          ...(desc ? { yoast_wpseo_metadesc: desc } : {})
        }
      }
    },
    {
      label: 'Rank Math',
      payload: {
        meta: {
          ...(kw ? { rank_math_focus_keyword: kw } : {}),
          ...(desc ? { rank_math_description: desc } : {})
        }
      }
    },
    {
      label: 'SEOPress',
      payload: {
        meta: {
          ...(kw ? { _seopress_analysis_target_kw: kw } : {}),
          ...(desc ? { _seopress_titles_desc: desc } : {})
        }
      }
    }
  ];
}

function flattenMeta(source) {
  if (!source || typeof source !== 'object') return {};
  if (source.meta && typeof source.meta === 'object') return source.meta;
  return source;
}

function seoMetaLooksSaved(stored, payload, focusKeyphrase, metaDescription) {
  const meta = flattenMeta(stored);
  const expected = flattenMeta(payload.meta ? payload : { meta: payload.yoast_meta || payload.meta || {} });
  const values = Object.values(meta).map((v) => String(Array.isArray(v) ? v[0] : v || ''));
  const keys = Object.keys(expected);
  if (keys.some((k) => {
    const got = meta[k];
    const gotStr = String(Array.isArray(got) ? got[0] : got || '');
    const want = String(expected[k] || '');
    return want && gotStr && (gotStr === want || gotStr.includes(want));
  })) {
    return true;
  }
  const kw = String(focusKeyphrase || '');
  const desc = String(metaDescription || '');
  if (kw && values.some((v) => v === kw)) return true;
  if (desc && values.some((v) => v === desc || (desc.length >= 40 && v.includes(desc.slice(0, 40))))) {
    return true;
  }
  return false;
}

async function readPostMeta(postId, config) {
  const { res, body } = await wpFetch(`/wp-json/wp/v2/posts/${postId}?context=edit`, config);
  if (!res.ok) return {};
  return body.meta || {};
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xmlCustomField(key, value) {
  return `<value><struct>
    <member><name>key</name><value><string>${xmlEscape(key)}</string></value></member>
    <member><name>value</name><value><string>${xmlEscape(value)}</string></value></member>
  </struct></value>`;
}

async function assignSeoMetaXmlRpc(postId, { focusKeyphrase, metaDescription }, config) {
  const fields = [];
  if (focusKeyphrase) {
    fields.push(xmlCustomField('_yoast_wpseo_focuskw', focusKeyphrase));
    fields.push(xmlCustomField('_yoast_wpseo_focuskw_text_input', focusKeyphrase));
    fields.push(xmlCustomField('rank_math_focus_keyword', focusKeyphrase));
  }
  if (metaDescription) {
    fields.push(xmlCustomField('_yoast_wpseo_metadesc', metaDescription));
    fields.push(xmlCustomField('rank_math_description', metaDescription));
  }
  if (!fields.length) return false;

  const xml = `<?xml version="1.0"?>
<methodCall>
  <methodName>wp.editPost</methodName>
  <params>
    <param><value><int>1</int></value></param>
    <param><value><string>${xmlEscape(config.wordpressUser)}</string></value></param>
    <param><value><string>${xmlEscape(config.wordpressAppPassword?.replace(/\s/g, '') || '')}</string></value></param>
    <param><value><int>${Number(postId)}</int></value></param>
    <param><value><struct>
      <member><name>custom_fields</name><value><array><data>
        ${fields.join('\n')}
      </data></array></value></member>
    </struct></value></param>
  </params>
</methodCall>`;

  try {
    const res = await fetch(`${wpBase(config)}/xmlrpc.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: xml
    });
    const text = await res.text();
    if (!res.ok || /faultCode/i.test(text)) {
      console.warn('[wp-seo] XML-RPC 실패:', text.slice(0, 180));
      return false;
    }
    return /<boolean>1<\/boolean>|<int>1<\/int>/i.test(text);
  } catch (err) {
    console.warn('[wp-seo] XML-RPC 오류:', err.message);
    return false;
  }
}

async function assignSeoMeta(postId, { focusKeyphrase, metaDescription }, config) {
  if (!focusKeyphrase && !metaDescription) return { ok: false, plugin: null };

  const variants = seoMetaVariants(focusKeyphrase, metaDescription);
  const errors = [];

  for (const variant of variants) {
    const { res, body } = await wpFetch(`/wp-json/wp/v2/posts/${postId}`, config, {
      method: 'POST',
      body: JSON.stringify(variant.payload)
    });
    if (!res.ok) {
      const msg = body.message || body.code || res.statusText;
      errors.push(`${variant.label}: ${msg}`);
      console.warn(`[wp-seo] ${variant.label} 저장 실패:`, msg);
      continue;
    }

    const stored = {
      ...(body.meta || {}),
      ...(await readPostMeta(postId, config))
    };
    if (seoMetaLooksSaved(stored, variant.payload, focusKeyphrase, metaDescription)) {
      console.log(`[wp-seo] ${variant.label} 초점 키프레이즈/메타 설명 저장`);
      return { ok: true, plugin: variant.label };
    }
    console.warn(`[wp-seo] ${variant.label} 응답은 성공했으나 필드 확인 실패, 다음 방식 시도`);
  }

  if (await assignSeoMetaXmlRpc(postId, { focusKeyphrase, metaDescription }, config)) {
    console.log('[wp-seo] XML-RPC로 초점 키프레이즈/메타 설명 저장');
    return { ok: true, plugin: 'XML-RPC' };
  }

  if (errors.length) {
    console.warn('[wp-seo] REST 메타 저장 실패:', errors.join(' | '));
  }
  return { ok: false, plugin: null, errors };
}

async function publishToWordPress(
  { title, content, status, tags, categories, focusKeyphrase: focusKeyphraseRaw, metaDescription: metaDescriptionRaw },
  config
) {
  const base = wpBase(config);
  const user = config.wordpressUser;
  const pass = config.wordpressAppPassword?.replace(/\s/g, '');

  if (!base || !user || !pass) {
    throw new Error('WordPress 설정(WORDPRESS_URL, USER, APP_PASSWORD)이 .env에 필요합니다.');
  }

  const tagNames = (tags || []).map((t) => String(t || '').trim()).filter(Boolean);
  console.log(`[wp] 태그 준비 ${tagNames.length}개:`, tagNames.join(', '));

  const { ids: tagIds, names: resolvedNames, errors: tagErrors } = await resolveTagIds(
    tagNames,
    config
  );
  console.log(`[wp] 태그 ID ${tagIds.length}개:`, tagIds.join(', ') || '(없음)');
  if (tagErrors.length) {
    console.warn('[wp] 태그 오류:', tagErrors.join(' | '));
  }

  if (tagNames.length && !tagIds.length) {
    throw new Error(
      `WordPress 태그를 하나도 만들 수 없습니다. 계정 권한(태그 관리) 또는 REST /wp/v2/tags 를 확인하세요. ${tagErrors[0] || ''}`
    );
  }

  const categoryNames = parseCategoryNames(config, categories);
  console.log(`[wp] 카테고리 준비 ${categoryNames.length}개:`, categoryNames.join(', '));

  const {
    ids: categoryIds,
    names: resolvedCategories,
    errors: categoryErrors
  } = await resolveCategoryIds(categoryNames, config);
  console.log(`[wp] 카테고리 ID ${categoryIds.length}개:`, categoryIds.join(', ') || '(없음)');
  if (categoryErrors.length) {
    console.warn('[wp] 카테고리 오류:', categoryErrors.join(' | '));
  }

  if (categoryNames.length && !categoryIds.length) {
    throw new Error(
      `WordPress 카테고리를 찾을 수 없습니다. 「${categoryNames.join(', ')}」 폴더가 있는지, 계정에 카테고리 권한이 있는지 확인하세요. ${categoryErrors[0] || ''}`
    );
  }

  const payload = {
    title,
    content,
    status: status || 'draft'
  };
  if (tagIds.length) {
    payload.tags = tagIds;
  }
  if (categoryIds.length) {
    payload.categories = categoryIds;
  }

  const focusKeyphrase = String(focusKeyphraseRaw || '').trim().slice(0, 80);
  const metaDescription = String(metaDescriptionRaw || '').trim().slice(0, 156);
  if (focusKeyphrase || metaDescription) {
    console.log(`[wp] SEO 초점 키프레이즈: ${focusKeyphrase || '(없음)'}`);
    console.log(`[wp] SEO 메타 설명: ${metaDescription || '(없음)'}`);
  }

  const { res, body } = await wpFetch('/wp-json/wp/v2/posts', config, {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const msg = body.message || body.code || res.statusText;
    throw new Error(`WordPress 발행 실패: ${msg}`);
  }

  // 일부 환경은 생성 시 tags/categories를 무시함 → 명시적으로 한 번 더 연결
  let finalTags = asIdList(body.tags);
  let finalCategories = asIdList(body.categories);
  const tagsMissing = tagIds.length && !hasAllIds(finalTags, tagIds);
  const catsMissing = categoryIds.length && !hasAllIds(finalCategories, categoryIds);

  if (tagsMissing || catsMissing) {
    console.log(`[wp] 글 ${body.id}에 태그/카테고리 재연결 시도...`);
    const retry = {};
    if (tagIds.length) retry.tags = tagIds;
    if (categoryIds.length) retry.categories = categoryIds;
    const updated = await assignTermsToPost(body.id, retry, config, '태그/카테고리');
    finalTags = asIdList(updated.tags).length ? asIdList(updated.tags) : tagIds;
    finalCategories = asIdList(updated.categories).length
      ? asIdList(updated.categories)
      : categoryIds;
  }

  if (tagIds.length && !finalTags.length) {
    throw new Error(
      '글은 저장됐지만 태그가 연결되지 않았습니다. WordPress 사용자에게 태그 편집 권한이 있는지 확인하세요.'
    );
  }

  if (categoryIds.length && !hasAllIds(finalCategories, categoryIds)) {
    throw new Error(
      `글은 저장됐지만 「${resolvedCategories.join(', ')}」 카테고리에 연결되지 않았습니다. WordPress 카테고리 권한을 확인하세요.`
    );
  }

  let seo = { ok: false, plugin: null };
  if (focusKeyphrase || metaDescription) {
    seo = await assignSeoMeta(body.id, { focusKeyphrase, metaDescription }, config);
    if (!seo.ok) {
      throw new Error(
        '글은 저장됐지만 Yoast 초점 키프레이즈/메타 설명이 연결되지 않았습니다. REST에서 Yoast(또는 Rank Math) 메타 필드가 열려 있는지 확인하세요.'
      );
    }
  }

  return {
    id: body.id,
    link: body.link,
    status: body.status,
    tags: finalTags,
    tagNames: resolvedNames,
    categories: finalCategories,
    categoryNames: resolvedCategories,
    focusKeyphrase,
    metaDescription,
    seoPlugin: seo.plugin
  };
}

module.exports = { publishToWordPress, resolveTagIds, resolveCategoryIds };
