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

function slugifyTag(name) {
  // WP는 한글 slug를 자동 생성하지만, 충돌·생성 실패 시 안전한 보조 slug 사용
  const ascii = String(name)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  if (ascii && /[a-z0-9]/i.test(ascii)) return ascii;
  return `t-${Buffer.from(name, 'utf8').toString('hex').slice(0, 24)}`;
}

/**
 * 태그 이름으로 WP 태그 ID를 찾거나 새로 만듭니다.
 * @param {string[]} tagNames
 * @returns {Promise<{ ids: number[], names: string[], errors: string[] }>}
 */
async function resolveTagIds(tagNames, config) {
  const ids = [];
  const names = [];
  const errors = [];
  const seen = new Set();

  for (const raw of tagNames || []) {
    const name = String(raw || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 80);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());

    let foundId = null;

    // 1) 이름 검색
    const q = encodeURIComponent(name);
    const { res: searchRes, body: searchBody } = await wpFetch(
      `/wp-json/wp/v2/tags?search=${q}&per_page=40`,
      config
    );
    if (searchRes.ok && Array.isArray(searchBody)) {
      const exact = searchBody.find(
        (t) => String(t.name || '').toLowerCase() === name.toLowerCase()
      );
      if (exact?.id) foundId = exact.id;
    }

    // 2) 없으면 생성
    if (!foundId) {
      const slug = slugifyTag(name);
      const { res: createRes, body: createBody } = await wpFetch('/wp-json/wp/v2/tags', config, {
        method: 'POST',
        body: JSON.stringify({ name, slug })
      });

      if (createRes.ok && createBody?.id) {
        foundId = createBody.id;
      } else {
        const existingId = createBody?.data?.term_id || createBody?.term_id;
        if (existingId) {
          foundId = Number(existingId);
        } else {
          const msg = createBody?.message || createBody?.code || createRes.statusText || 'unknown';
          errors.push(`${name}: ${msg}`);
          console.warn(`[wp-tags] 생성 실패 "${name}":`, msg, createBody);
        }
      }
    }

    if (foundId) {
      ids.push(foundId);
      names.push(name);
    }
  }

  return { ids: [...new Set(ids)], names, errors };
}

async function assignTagsToPost(postId, tagIds, config) {
  const { res, body } = await wpFetch(`/wp-json/wp/v2/posts/${postId}`, config, {
    method: 'POST',
    body: JSON.stringify({ tags: tagIds })
  });
  if (!res.ok) {
    const msg = body.message || body.code || res.statusText;
    throw new Error(`WordPress 태그 연결 실패: ${msg}`);
  }
  return body;
}

async function publishToWordPress({ title, content, status, tags }, config) {
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

  const payload = {
    title,
    content,
    status: status || 'draft'
  };
  if (tagIds.length) {
    payload.tags = tagIds;
  }

  const { res, body } = await wpFetch('/wp-json/wp/v2/posts', config, {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const msg = body.message || body.code || res.statusText;
    throw new Error(`WordPress 발행 실패: ${msg}`);
  }

  // 일부 환경은 생성 시 tags를 무시함 → 명시적으로 한 번 더 연결
  let finalTags = Array.isArray(body.tags) ? body.tags : [];
  if (tagIds.length && (!finalTags.length || !tagIds.every((id) => finalTags.includes(id)))) {
    console.log(`[wp] 글 ${body.id}에 태그 재연결 시도...`);
    const updated = await assignTagsToPost(body.id, tagIds, config);
    finalTags = Array.isArray(updated.tags) ? updated.tags : tagIds;
  }

  if (tagIds.length && !finalTags.length) {
    throw new Error(
      '글은 저장됐지만 태그가 연결되지 않았습니다. WordPress 사용자에게 태그 편집 권한이 있는지 확인하세요.'
    );
  }

  return {
    id: body.id,
    link: body.link,
    status: body.status,
    tags: finalTags,
    tagNames: resolvedNames
  };
}

module.exports = { publishToWordPress, resolveTagIds };
