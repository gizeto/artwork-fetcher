// ==UserScript==
// @name         TMDB Artwork Fetcher
// @namespace    https://github.com/gizeto/artwork-fetcher
// @version      1.4.2
// @author       gizeto
// @homepageURL  https://github.com/gizeto/artwork-fetcher
// @supportURL   https://github.com/gizeto/artwork-fetcher/issues
// @downloadURL  https://raw.githubusercontent.com/gizeto/artwork-fetcher/main/artwork-fetcher.user.js
// @updateURL    https://raw.githubusercontent.com/gizeto/artwork-fetcher/main/artwork-fetcher.user.js
// @description  Find Amazon, Apple and Kanopy artwork, preview a JPEG, and confirm its upload to TMDB.
// @match        https://www.themoviedb.org/movie/*
// @match        https://www.themoviedb.org/tv/*
// @match        https://www.amazon.com/*
// @match        https://www.amazon.co.uk/*
// @match        https://www.amazon.de/*
// @match        https://www.amazon.fr/*
// @match        https://www.amazon.it/*
// @match        https://www.amazon.es/*
// @match        https://www.amazon.ca/*
// @match        https://www.amazon.com.au/*
// @match        https://www.amazon.co.jp/*
// @match        https://www.amazon.in/*
// @match        https://www.amazon.com.br/*
// @match        https://www.amazon.com.mx/*
// @match        https://www.amazon.pl/*
// @match        https://www.primevideo.com/*
// @match        https://tv.apple.com/*
// @match        https://www.kanopy.com/*
// @match        https://www.google.com/search*
// @connect      www.google.com
// @connect      apis.justwatch.com
// @connect      amazon.com
// @connect      amazon.co.uk
// @connect      amazon.de
// @connect      amazon.fr
// @connect      amazon.it
// @connect      amazon.es
// @connect      amazon.ca
// @connect      amazon.com.au
// @connect      amazon.co.jp
// @connect      amazon.in
// @connect      amazon.com.br
// @connect      amazon.com.mx
// @connect      amazon.pl
// @connect      primevideo.com
// @connect      tv.apple.com
// @connect      m.media-amazon.com
// @connect      images-na.ssl-images-amazon.com
// @connect      mzstatic.com
// @connect      kanopy.com
// @connect      static-assets.kanopy.com
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_openInTab
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function (root) {
  'use strict';
  const TMDB = 'https://www.themoviedb.org';
  const AMAZON = new Set(['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.it',
    'amazon.es', 'amazon.ca', 'amazon.com.au', 'amazon.co.jp', 'amazon.in', 'amazon.com.br',
    'amazon.com.mx', 'amazon.pl', 'primevideo.com']);
  const TTL = 10 * 60 * 1000;
  const PREFIX = 'tmdb-artwork-job:';
  const QUERY = `query GetSearchResults($country: Country!, $language: Language!, $first: Int!, $searchQuery: String, $location: String!) {
    searchTitles(country: $country, first: $first, filter: {searchQuery: $searchQuery, includeTitlesWithoutUrl: true}, source: $location) {
      edges { node { id objectType content(country: $country, language: $language) { title originalReleaseYear fullPath }
        offers(country: $country, platform: WEB, filter: {preAffiliate: true, presentationTypes: [HD, SD, _4K]}) { standardWebURL preAffiliatedStandardWebURL presentationType package { shortName } }
      } }
    }
  }`;

  const parse = html => new root.DOMParser().parseFromString(html, 'text/html');
  const normalize = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const slug = s => normalize(s).replace(/ /g, '-').slice(0, 100).replace(/-$/, '') || 'unknown-title';
  function exactMatch(title, target) {
    const key = value => normalize(value).replace(/ /g, '');
    const targetKey = key(target.title);
    return !!targetKey && key(title.title) === targetKey &&
      /^\d{4}$/.test(String(target.year)) && String(title.year) === String(target.year);
  }
  function regions(value) {
    const list = [...new Set(String(value).toUpperCase().split(/[\s,;]+/).filter(Boolean))];
    if (!list.length || list.some(x => !/^[A-Z]{2}$/.test(x))) throw new Error('Enter country codes such as US, GB, PL.');
    return list;
  }
  function targetFromPage(doc, href) {
    const url = new URL(href);
    const match = url.pathname.match(/^\/(movie|tv)\/(\d+[^/]*)(?:\/images\/(?:posters|backdrops))?\/?$/);
    if (url.origin !== TMDB || !match) return null;
    const heading = doc.querySelector('section.header .title h2 a, .title h2 a, h2 a[href="/' + match[1] + '/' + match[2] + '"]');
    const title = heading?.textContent.trim() || doc.querySelector('meta[property="og:title"]')?.content;
    if (!title) return null;
    const year = doc.querySelector('.title .release_date')?.textContent.match(/\d{4}/)?.[0] || '';
    return { type: match[1], id: match[2].match(/^\d+/)[0], path: `/${match[1]}/${match[2]}`, title, year };
  }
  function provider(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:') return null;
      if (u.hostname === 'tv.apple.com') return 'Apple TV';
      if (u.hostname === 'www.kanopy.com') return 'Kanopy';
      if (AMAZON.has(u.hostname.replace(/^(?:www|watch)\./, ''))) return 'Amazon';
    } catch (_) { /* Not a provider link. */ }
    return null;
  }
  function canonicalProvider(url) {
    const u = new URL(url);
    const gti = u.searchParams.get('gti');
    if (u.hostname.startsWith('watch.') && provider(url) === 'Amazon' && /^amzn1\.dv\.gti\.[a-z0-9-]+$/i.test(gti || '')) {
      return `https://www.${u.hostname.slice(6)}/gp/video/detail/${encodeURIComponent(gti)}`;
    }
    const keep = new URLSearchParams();
    if (u.searchParams.has('playableId')) keep.set('playableId', u.searchParams.get('playableId'));
    u.search = keep.toString();
    u.hash = '';
    return u.href;
  }
  function isTitleLink(url) {
    const { pathname } = new URL(url);
    switch (provider(url)) {
      case 'Kanopy': return /^(?:\/[a-z]{2})?\/product\/[a-z\d-]+\/?$/i.test(pathname);
      case 'Apple TV': return /\/(movie|show)\/[^/]+\/umc\./.test(pathname);
      case 'Amazon': return /\/(?:detail|dp|product)\/[^/]+/.test(pathname);
      default: return false;
    }
  }
  function manualSource(value) {
    const text = String(value).trim().replace(/[),.;]+$/, '');
    const name = provider(text);
    if (!name) throw new Error('Paste an HTTPS title-page URL from Amazon/Prime Video, Apple TV, or Kanopy.');
    const parsed = new URL(text);
    if (parsed.username || parsed.password) throw new Error('Provider links must not contain credentials.');
    const url = canonicalProvider(text);
    if (!isTitleLink(url)) throw new Error('Use a movie or TV title page, not a provider homepage or search page.');
    return { url, provider: name, countries: ['Direct link'] };
  }
  function discoveryLinks(title, country) {
    const storefront = country.toLowerCase();
    const term = encodeURIComponent(title);
    return [
      ['Search Apple TV', `https://tv.apple.com/${storefront}/search?term=${term}`],
      ['Search Prime Video', `https://www.primevideo.com/search?phrase=${term}`],
      ['Find indexed Apple pages', 'https://www.google.com/search?q=' + encodeURIComponent(`"${title}" site:tv.apple.com`)],
      ['Find indexed Amazon pages', 'https://www.google.com/search?q=' + encodeURIComponent(`"${title}" (site:primevideo.com OR site:amazon.com)`)],
    ];
  }
  function googleQueries(title) {
    return ['prime video', 'apple tv'].map(provider =>
      'https://www.google.com/search?q=' + encodeURIComponent(`${title} ${provider}`));
  }
  function sourceIdentity(source) {
    const u = new URL(source.url);
    return source.provider + ':' + (u.pathname.match(/\/(umc\.[^/]+|[A-Z0-9]{10}|[A-Z0-9]{26})(?:\/|$)/)?.[1] || source.url);
  }
  function googleResults(doc, type) {
    const found = new Map();
    for (const anchor of doc.querySelectorAll('a[href]')) {
      try {
        let url = new URL(anchor.getAttribute('href'), 'https://www.google.com');
        if (url.origin === 'https://www.google.com' && url.pathname === '/url') {
          url = new URL(url.searchParams.get('q') || url.searchParams.get('url'));
        }
        if (!['Amazon', 'Apple TV'].includes(provider(url.href))) continue;
        const source = manualSource(url.href);
        const heading = anchor.querySelector('h3, [role="heading"]');
        const titleNode = heading?.cloneNode(true) || anchor.cloneNode(true);
        titleNode.querySelectorAll('cite, time, script, style, [aria-hidden="true"]').forEach(node => node.remove());
        const title = cleanGoogleTitle(titleNode.textContent);
        if (!title || /^https?:\/\//.test(title)) continue;
        if (source.provider === 'Apple TV' && !url.pathname.includes(type === 'tv' ? '/show/' : '/movie/')) continue;
        source.countries = ['Google', ...(source.provider === 'Apple TV' ? [url.pathname.split('/')[1].toUpperCase()] : [])];
        const key = sourceIdentity(source);
        if (!found.has(key)) found.set(key, { title, sources: [source] });
      } catch (_) { /* Ignore tracking links, search controls and unsupported URLs. */ }
    }
    return [...found.values()];
  }
  function cleanGoogleTitle(value) {
    return String(value || '').replace(/\s+/g, ' ').trim()
      .replace(/\s*(?:[-|–—:]\s*)?(?:Amazon(?:\.com)?(?:\s+Prime)?\s+Video|Prime\s*Video|Apple\s*TV)(?:\s*[-|–—:]?\s*\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)?\s*$/i, '')
      .replace(/^Watch\s+/i, '').trim().slice(0, 300);
  }
  function titlePageId(url) {
    return new URL(url).pathname.split('/').filter(Boolean).pop();
  }
  function amazonHeaders(doc) {
    const node = doc.querySelector('#dv-web-page-hydration-data');
    if (!node) return {};
    return JSON.parse(node.textContent).init?.preparations?.body?.atf?.state?.detail?.headerDetail || {};
  }
  function appleTitleItems(doc, pageURL) {
    const node = doc.querySelector('#serialized-server-data');
    if (!node) return [];
    const id = titlePageId(pageURL);
    const entries = JSON.parse(node.textContent).data || [];
    return entries.flatMap(entry => {
      const page = entry?.data;
      if (!page?.canonicalURL || titlePageId(page.canonicalURL) !== id) return [];
      return (page.shelves || []).flatMap(shelf => shelf.items || []);
    }).filter(item => item.$kind === 'SuperheroLockup');
  }
  function providerMetadata(doc, pageURL) {
    const year = value => String(value || '').match(/\b(?:18|19|20|21)\d{2}\b/)?.[0] || '';
    if (provider(pageURL) === 'Amazon') {
      const headers = amazonHeaders(doc);
      const entry = headers[titlePageId(pageURL)] || (Object.keys(headers).length === 1 ? Object.values(headers)[0] : null);
      if (entry?.title) {
        return {
          title: entry.title,
          year: year(entry.releaseYear) || year(entry.releaseDate),
          type: entry.titleType === 'movie' ? 'Movie' : entry.titleType ? 'TV series' : '',
        };
      }
    } else if (provider(pageURL) === 'Apple TV') {
      const item = appleTitleItems(doc, pageURL).find(item => item.title);
      if (item) {
        return {
          title: item.title,
          year: (item.badgeRowMetadata || []).map(String).find(value => /^\d{4}$/.test(value)) || year(item.releaseDate),
          type: item.type === 'Movie' || item.primaryMetadata?.includes('Movie') ? 'Movie' : 'TV series',
        };
      }
    }
    // Only title-level structured data, never a search snippet's crawl date or recommendations.
    for (const node of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(node.textContent);
        const entries = Array.isArray(data) ? data : data['@graph'] || [data];
        const candidates = entries.filter(item => ['Movie', 'TVSeries'].includes(item['@type']) && item.name &&
          (!item.url || sourceIdentity(manualSource(item.url)) === sourceIdentity(manualSource(pageURL))));
        if (candidates.length === 1) return { title: candidates[0].name, year: year(candidates[0].datePublished),
          type: candidates[0]['@type'] === 'Movie' ? 'Movie' : 'TV series' };
      } catch (_) { /* Malformed or unrelated structured data. */ }
    }
    throw new Error('Title/year metadata unavailable.');
  }
  function searchResults(responses, target) {
    const titles = new Map();
    for (const { country, data } of responses) {
      if (data.errors?.length) throw new Error(data.errors.map(x => x.message).join('; '));
      for (const { node } of data.data?.searchTitles?.edges || []) {
        if (node.objectType !== (target.type === 'movie' ? 'MOVIE' : 'SHOW')) continue;
        let item = titles.get(node.id);
        if (!item) {
          item = { id: node.id, title: node.content.title, year: node.content.originalReleaseYear,
            type: node.objectType, sources: [], countries: [] };
          titles.set(node.id, item);
        }
        if (!item.countries.includes(country)) item.countries.push(country);
        for (const offer of node.offers || []) {
          if (['DVD', 'BLURAY', 'BLURAY_4K'].includes(offer.presentationType)) continue;
          const rawURL = [offer.standardWebURL, offer.preAffiliatedStandardWebURL].find(value => provider(value));
          if (!rawURL) continue;
          const name = provider(rawURL);
          const url = canonicalProvider(rawURL);
          if (!isTitleLink(url)) continue;
          const found = item.sources.find(source => source.url === url);
          if (!found) item.sources.push({ url, provider: name, countries: [country] });
          else if (!found.countries.includes(country)) found.countries.push(country);
        }
      }
    }
    return [...titles.values()].sort((a, b) =>
      Number(normalize(b.title) === normalize(target.title)) - Number(normalize(a.title) === normalize(target.title)) ||
      Number(String(b.year) === target.year) - Number(String(a.year) === target.year));
  }
  function isImageURL(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && (u.hostname === 'm.media-amazon.com' ||
        u.hostname === 'images-na.ssl-images-amazon.com' || u.hostname.endsWith('.mzstatic.com') ||
        (u.hostname === 'static-assets.kanopy.com' && u.pathname.startsWith('/video-images/')));
    } catch (_) { return false; }
  }
  function amazonVariants(url) {
    const u = new URL(url);
    const original = u.pathname.replace(/\._[^/]*_\.(jpg|jpeg|png|webp|avif)$/i, '.$1');
    const base = original.replace(/\.(?:jpg|jpeg|png|webp|avif)$/i, '');
    return [new URL(original, u.origin).href, new URL(base + '._SX4096_FMavif_PQ100_.jpg', u.origin).href];
  }
  function amazonArtwork(doc, kind) {
    const assets = [];
    // headerDetail contains the current title; never traverse recommendation collections.
    for (const header of Object.values(amazonHeaders(doc))) {
      const image = header.images?.[kind === 'backdrop' ? 'heroshot' : 'packshot'];
      if (image && isImageURL(image)) assets.push({ title: header.title, url: image, variants: amazonVariants(image) });
    }
    if (!assets.length && kind === 'backdrop') {
      const hero = doc.querySelector('[data-automation-id="hero-background"]');
      const image = hero?.querySelector('img');
      const url = image?.getAttribute('src');
      if (isImageURL(url)) assets.push({ title: image.alt, url, variants: amazonVariants(url) });
    }
    return assets;
  }
  function appleArtwork(doc, kind, pageURL) {
    const assets = [];
    for (const item of appleTitleItems(doc, pageURL)) {
      const art = item.artwork?.[kind === 'backdrop' ? 'wide' : 'tall'];
      if (!art?.template || !(art.width > 0 && art.height > 0)) continue;
      const url = art.template.replaceAll('{w}', art.width).replaceAll('{h}', art.height).replaceAll('{f}', 'jpg');
      if (isImageURL(url)) assets.push({ title: item.title, url, variants: [url] });
    }
    return assets;
  }
  function kanopyAPI(pageURL, webshopId = 9) {
    const source = manualSource(pageURL);
    if (source.provider !== 'Kanopy') throw new Error('Not a Kanopy title page.');
    const alias = titlePageId(source.url);
    return 'https://www.kanopy.com/kapi/videos/alias/' + encodeURIComponent(alias) + '?webshopId=' + encodeURIComponent(webshopId);
  }
  async function fetchKanopy(pageURL, kind, request, signal) {
    // The public client performs this visitor handshake before reading metadata.
    // Keep the anonymous JWT in memory and send it only to Kanopy's API.
    const headers = { Accept: 'application/json', 'X-Version': 'web/undefined/undefined/undefined' };
    const session = JSON.parse(await request('https://www.kanopy.com/kapi/handshake', { signal, headers, anonymous: true }));
    if (typeof session.jwt !== 'string' || !session.jwt || !Number.isInteger(session.webshopId) || session.webshopId <= 0) {
      throw new Error('Kanopy visitor initialization failed. Open the source tab and try again.');
    }
    if (signal?.aborted) throw new Error('Cancelled.');
    const data = JSON.parse(await request(kanopyAPI(pageURL, session.webshopId), {
      signal, anonymous: true, headers: { ...headers, Authorization: 'Bearer ' + session.jwt },
    }));
    return kanopyArtwork(data, kind, pageURL);
  }
  function kanopyArtwork(data, kind, pageURL) {
    const video = data?.video;
    const expectedId = new URL(pageURL).pathname.match(/\/justwatch-(\d+)\/?$/)?.[1];
    if (!video || (expectedId && String(video.videoId) !== expectedId)) throw new Error('Kanopy returned no matching title. Open its source tab and try again.');
    const images = video.images?.[kind === 'backdrop' ? 'landscapes' : 'posters'] || {};
    const assets = [];
    for (const resized of Object.values(images)) {
      if (typeof resized !== 'string') continue;
      // Kanopy's CDN URL contains the original asset. Download it without the
      // low-resolution fit=cover transformation; do not manufacture extra pixels.
      const proxy = new URL(resized);
      const original = proxy.hostname === 'img.kanopy.com' ?
        proxy.pathname.match(/^\/cdn-cgi\/image\/[^/]+\/(https:\/\/static-assets\.kanopy\.com\/video-images\/.+)$/)?.[1] : resized;
      if (isImageURL(original) && new URL(original).hostname === 'static-assets.kanopy.com') {
        assets.push({ title: video.title, url: original, variants: [original] });
      }
    }
    const unique = [...new Map(assets.map(a => [a.url, a])).values()];
    if (!unique.length) throw new Error(`Kanopy has no ${kind === 'backdrop' ? 'background' : 'poster'} artwork for this title.`);
    return unique;
  }
  function extract(doc, url, kind) {
    const result = provider(url) === 'Apple TV' ? appleArtwork(doc, kind, url) : amazonArtwork(doc, kind);
    const unique = [...new Map(result.map(a => [a.url, a])).values()];
    if (!unique.length) throw new Error('No title artwork found. The page may require a challenge or sign-in.');
    return unique;
  }
  function uploadConfig(doc, kind, target) {
    const cropper = doc.querySelector('.image_cropper');
    if (!cropper) throw new Error('TMDB upload form unavailable. Sign in to TMDB and try again.');
    const settings = cropper.dataset;
    const mediaType = target.type === 'movie' ? 'Movie' : 'TvSeries';
    if (settings.imageKind !== kind || settings.mediaType !== mediaType) {
      throw new Error('TMDB returned an unexpected upload form.');
    }
    const [ratioWidth, ratioHeight] = (settings.aspectRatio || '').split('/').map(Number);
    const config = {
      mediaId: settings.mediaId,
      mediaType,
      kind,
      token: settings.csrfToken,
      minWidth: Number(settings.minCropWidth),
      minHeight: Number(settings.minCropHeight),
      maxWidth: Number(settings.maxCropWidth),
      maxHeight: Number(settings.maxCropHeight),
      ratioWidth,
      ratioHeight,
    };
    const dimensions = [config.minWidth, config.minHeight, config.maxWidth, config.maxHeight, ratioWidth, ratioHeight];
    if (!config.mediaId || !config.token || dimensions.some(value => !Number.isFinite(value) || value <= 0)) {
      throw new Error('TMDB upload form is missing required settings.');
    }
    return config;
  }
  function cropPlan(width, height, config) {
    const { ratioWidth, ratioHeight, minWidth, minHeight, maxWidth, maxHeight } = config;
    const scale = Math.min(width / ratioWidth, height / ratioHeight);
    const cropWidth = scale * ratioWidth;
    const cropHeight = scale * ratioHeight;
    const unit = Math.floor(Math.min(scale, maxWidth / ratioWidth, maxHeight / ratioHeight));
    const outputWidth = unit * ratioWidth;
    const outputHeight = unit * ratioHeight;
    return {
      x: (width - cropWidth) / 2,
      y: (height - cropHeight) / 2,
      cropWidth,
      cropHeight,
      width: outputWidth,
      height: outputHeight,
      valid: outputWidth >= minWidth && outputHeight >= minHeight,
    };
  }
  function filename(target, kind) {
    return `${Math.floor(Date.now() / 1000)}_${slug(target.title)}${target.year ? '-' + target.year : ''}_${kind === 'backdrop' ? 'bg' : 'poster'}.jpg`;
  }
  function multipart(blob, name, config) {
    const data = new root.FormData();
    data.append('upload_files', blob, name);
    const fields = {
      media_id: config.mediaId,
      media_type: config.mediaType,
      type: config.kind,
      translate: 'false',
      crop_area: '',
      authenticity_token: config.token,
    };
    for (const [key, value] of Object.entries(fields)) data.append(key, value);
    return data;
  }
  function uploadResult(json) {
    if (json.success !== true) throw new Error(json.status_message || json.message || 'TMDB rejected the upload.');
    const doc = parse(json.html || '');
    const card = doc.querySelector('[data-image-id]');
    const id = card?.getAttribute('data-image-id');
    return { id: /^[a-f\d]{24}$/i.test(id || '') ? id : null,
      processing: card?.classList.contains('processing') || false };
  }
  function crossRequest(url, { json, blob = false, signal, anonymous = true, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Cancelled.'));
      const finish = (fn, value) => { signal?.removeEventListener('abort', abort); fn(value); };
      let request;
      const abort = () => { request?.abort(); finish(reject, new Error('Cancelled.')); };
      request = GM_xmlhttpRequest({ method: json ? 'POST' : 'GET', url, anonymous,
        headers: { ...(json ? { 'Content-Type': 'application/json', Accept: 'application/json' } : {}), ...headers },
        data: json ? JSON.stringify(json) : undefined, responseType: blob ? 'blob' : 'text', timeout: 30000,
        onload: r => {
          if (r.status < 200 || r.status >= 300) return finish(reject, new Error(`Source returned HTTP ${r.status}.`));
          finish(resolve, blob ? r.response : r.responseText);
        }, onerror: () => finish(reject, new Error('Source request failed. Check Tampermonkey host permissions.')),
        ontimeout: () => finish(reject, new Error('Source request timed out.')),
        onabort: () => finish(reject, new Error('Cancelled.')) });
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  async function tmdbRequest(path, { body, signal } = {}) {
    const controller = new root.AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = root.setTimeout(abort, 45000);
    try {
      const response = await root.fetch(new URL(path, TMDB), { method: body ? 'POST' : 'GET', body,
        credentials: 'same-origin', signal: controller.signal,
        headers: { Accept: body ? 'application/json' : 'text/html', 'X-Requested-With': 'XMLHttpRequest' } });
      if (!response.ok) throw new Error(`TMDB returned HTTP ${response.status}.`);
      return body ? await response.json() : await response.text();
    } finally { root.clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function waf() {
    const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : root;
    if (typeof page.withWafToken !== 'function') return;
    await new Promise((resolve, reject) => {
      const timer = root.setTimeout(() => reject(new Error('TMDB session check timed out. Reload the page and retry.')), 20000);
      page.withWafToken(() => { root.clearTimeout(timer); resolve(); });
    });
  }
  async function decode(blob) {
    const url = root.URL.createObjectURL(blob);
    try {
      const image = new root.Image();
      image.src = url;
      await image.decode();
      return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => root.URL.revokeObjectURL(url) };
    } catch (_) {
      root.URL.revokeObjectURL(url);
      throw new Error('Cannot decode source image. Use a browser with AVIF support.');
    }
  }
  async function prepare(asset, config, signal) {
    let best, lastError;
    for (const url of asset.variants) {
      if (!isImageURL(url)) continue;
      try {
        const decoded = await decode(await crossRequest(url, { blob: true, signal }));
        if (!best || decoded.width * decoded.height >= best.width * best.height) {
          best?.close();
          best = decoded;
        } else {
          decoded.close();
        }
      } catch (e) { lastError = e; }
      if (signal?.aborted) {
        best?.close();
        throw new Error('Cancelled.');
      }
    }
    if (!best) throw lastError || new Error('No downloadable artwork.');
    try {
      const crop = cropPlan(best.width, best.height, config);
      if (!crop.valid) throw new Error(`Source ${best.width}×${best.height} is too small after cropping (minimum ${config.minWidth}×${config.minHeight}).`);
      const canvas = root.document.createElement('canvas');
      canvas.width = crop.width;
      canvas.height = crop.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(best.image, crop.x, crop.y, crop.cropWidth, crop.cropHeight, 0, 0, crop.width, crop.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      if (!blob || blob.type !== 'image/jpeg') throw new Error('JPEG conversion failed.');
      return { blob, crop, sourceWidth: best.width, sourceHeight: best.height };
    } finally { best.close(); }
  }
  function element(tag, text, attrs = {}) {
    const el = root.document.createElement(tag);
    if (text !== null && text !== undefined) el.textContent = text;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }
  function button(text, action) {
    const control = element('button', text, { type: 'button' });
    control.addEventListener('click', action);
    return control;
  }
  function link(text, href) { return element('a', text, { href, target: '_blank', rel: 'noopener noreferrer' }); }
  const CSS = `
    :host { all: initial; font: 14px/1.5 system-ui,sans-serif; color:#edf4fb; }
    * { box-sizing:border-box; } button,input,select { font:inherit; } button { cursor:pointer; border:0; border-radius:6px; padding:9px 13px; color:#fff; background:#166a94; }
    [hidden] { display:none !important; }
    button:hover { background:#238ab8; } button:disabled { opacity:.45; cursor:default; }
    .toolbar { position:fixed; bottom:18px; right:18px; display:flex; flex-wrap:wrap; gap:7px; padding:10px; background:#102435; border:1px solid #426279; border-radius:10px; box-shadow:0 4px 18px #0005; }
    .overlay { position:fixed; inset:0; background:#0009; display:flex; align-items:center; justify-content:center; padding:20px; }
    .panel { width:1000px; max-width:100%; max-height:92vh; overflow:auto; background:#102435; padding:22px; border:1px solid #426279; border-radius:12px; }
    .dialog-header { display:flex; align-items:center; gap:16px; position:sticky; top:-22px; margin:-22px -22px 14px; padding:16px 22px; background:#102435; z-index:1; }
    .dialog-header h2 { margin:0; flex:1; } .close { font-size:26px; line-height:1; width:36px; height:36px; padding:0; flex-shrink:0; background:transparent; color:#bcd0df; }
    h2 { margin:0 0 14px; font-size:22px; } p { margin:10px 0; } a { color:#69d5fb; } label { display:inline-flex; gap:8px; align-items:center; }
    input,select { padding:7px; border:1px solid #7591a5; border-radius:4px; background:#fff; color:#122433; }
    .row { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin:12px 0; } .row input { flex:1; min-width:180px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(270px,100%),1fr)); gap:16px; }
    .card { padding:14px; border:1px solid #426279; border-radius:8px; overflow:hidden; }
    .exact-match { border-color:#648c7d; background:#16332f; } .match-label { display:block; color:#abcabb; font-size:12px; margin:4px 0; }
    details { margin-top:18px; } .google-section { grid-column:1/-1; }
    .google-heading { display:block; font-size:16px; margin-bottom:14px; }
    .google-card { display:flex; flex-direction:column; gap:8px; min-width:0; }
    .google-card strong { font-size:16px; line-height:1.4; overflow-wrap:anywhere; }
    .google-card p { margin:0; } .google-meta, .google-summary { color:#b3c5d3; font-size:13px; }
    .google-actions { display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; padding-top:12px; margin-top:auto; }
    .google-note { font-size:12px; color:#b3c5d3; } .google-summary { margin:12px 0 0; }
    img { display:block; width:100%; height:260px; object-fit:contain; background:#07111a; cursor:zoom-in; }
    .full { max-height:65vh; height:auto; } .error { color:#ffc5b8; } .status { white-space:pre-wrap; }
  `;

  class App {
    constructor(target, deps = {}) {
      this.target = target;
      this.request = deps.request || tmdbRequest;
      this.cross = deps.cross || crossRequest;
      this.prepare = deps.prepare || prepare;
      this.waf = deps.waf || waf;
      this.urls = [];
      this.jobs = [];
      this.busy = false;
      this.host = element('div', null, { id: 'tmdb-artwork' });
      this.host.style.cssText = 'position:relative;z-index:2147483646';
      this.shadow = this.host.attachShadow({ mode: 'open' });
      this.shadow.append(element('style', CSS));
      const toolbar = element('div', null, { class: 'toolbar' });
      toolbar.append(button('Fetch background', () => this.open('backdrop')), button('Fetch poster', () => this.open('poster')), button('Settings', () => this.settings()));
      this.shadow.append(toolbar); root.document.body.append(this.host);
      root.addEventListener('pagehide', () => this.cleanup(), { once: true });
    }
    cleanup() {
      this.controller?.abort();
      this.urls.forEach(url => root.URL.revokeObjectURL(url));
      this.urls = [];
      for (const job of this.jobs) {
        root.clearTimeout(job.timer);
        root.clearTimeout(job.attentionTimer);
        job.tab?.close?.();
        GM_removeValueChangeListener(job.listener);
        GM_deleteValue(PREFIX + job.id);
      }
      this.jobs = [];
    }
    newRequest() {
      this.cleanup();
      this.controller = new root.AbortController();
      return this.controller.signal;
    }
    shell(title) {
      if (this.busy) return false;
      this.newRequest();
      this.overlay?.remove();
      this.overlay = element('div', null, { class: 'overlay' });
      this.panel = element('div', null, { class: 'panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
      const header = element('div', null, { class: 'dialog-header' });
      this.close = button('×', () => { if (!this.busy) { this.cleanup(); this.overlay.remove(); } });
      this.close.className = 'close'; this.close.setAttribute('aria-label', 'Close'); this.close.title = 'Close';
      header.append(element('h2', title), this.close);
      this.panel.append(header); this.overlay.append(this.panel); this.shadow.append(this.overlay);
      this.close.focus(); return true;
    }
    settings() {
      if (!this.shell('Artwork settings')) return;
      const input = element('input', null, { value: GM_getValue('regions', ['US']).join(', '), 'aria-label': 'JustWatch regions' });
      const status = element('p');
      this.panel.append(element('p', 'JustWatch countries, e.g. US, GB, PL. Searches combine the regions you enter.'), input,
        button('Save regions', () => { try { GM_setValue('regions', regions(input.value)); status.textContent = 'Settings saved.'; } catch (e) { status.textContent = e.message; } }), status);
    }
    open(kind) {
      if (!this.shell(`${kind === 'backdrop' ? 'Background' : 'Poster'} · ${this.target.title}`)) return;
      this.kind = kind;
      const row = element('div', null, { class: 'row' });
      const query = element('input', null, { value: this.target.title, 'aria-label': 'Search title' });
      const search = button('Search', () => this.search(query.value));
      query.addEventListener('keydown', e => { if (e.key === 'Enter') this.search(query.value); });
      row.append(query, search); this.panel.append(row);
      this.status = element('p', '', { class: 'status', role: 'status' }); this.results = element('div', null, { class: 'grid' });
      this.panel.append(this.status, this.results);
      this.directControls(query);
      this.search(this.target.title);
    }
    directControls(query) {
      const section = element('details'); section.append(element('summary', 'No streaming link? Find or paste a provider page'));
      section.append(element('p', 'An unavailable title may still have artwork. Search the provider or web index, then paste its title-page URL.'));
      const links = element('div', null, { class: 'row' });
      const refreshLinks = () => {
        links.replaceChildren(...discoveryLinks(query.value || this.target.title, GM_getValue('regions', ['US'])[0]).map(([text, url]) => link(text, url)));
      };
      query.addEventListener('input', refreshLinks); refreshLinks(); section.append(links);
      const input = element('input', null, { type: 'url', placeholder: 'https://tv.apple.com/… or Amazon/Prime Video/Kanopy title URL', 'aria-label': 'Provider title URL' });
      const row = element('div', null, { class: 'row' }); const state = element('p', '', { role: 'status' });
      const key = `direct-sources:${this.target.type}:${this.target.id}`;
      const saved = element('div', null, { class: 'row' });
      const renderSaved = () => {
        saved.replaceChildren();
        for (const url of GM_getValue(key, [])) {
          let source;
          try { source = manualSource(url); } catch (_) { continue; }
          saved.append(button(`Fetch saved ${source.provider} link`, () => this.fetchTitle({ sources: [source] })));
        }
      };
      const fetch = () => {
        if (this.busy) return;
        try {
          const source = manualSource(input.value);
          const urls = [...new Set([...GM_getValue(key, []), source.url])].slice(-10);
          GM_setValue(key, urls); renderSaved(); state.textContent = '';
          this.fetchTitle({ sources: [source] });
        } catch (e) { state.textContent = e.message; }
      };
      row.append(input, button('Fetch from URL', fetch)); input.addEventListener('keydown', e => { if (e.key === 'Enter') fetch(); });
      section.append(row, state, saved, button('Forget saved links', () => { if (!this.busy) { GM_deleteValue(key); renderSaved(); } }));
      renderSaved(); if (saved.childElementCount) section.open = true;
      this.panel.append(section);
    }
    async search(query) {
      if (this.busy) return;
      const signal = this.newRequest();
      const { results, status } = this;
      results.replaceChildren();
      status.textContent = 'Searching JustWatch…';
      const responses = [], errors = [];
      const countries = GM_getValue('regions', ['US']);
      await Promise.all(countries.map(async country => {
        try {
          const json = JSON.parse(await this.cross('https://apis.justwatch.com/graphql', { signal,
            json: { operationName: 'GetSearchResults', query: QUERY, variables: { country, language: 'en', first: 10, searchQuery: query, location: 'SearchSuggester' } } }));
          if (json.errors?.length) throw new Error(json.errors.map(x => x.message).join('; '));
          responses.push({ country, data: json });
        } catch (e) { errors.push(`${country}: ${e.message}`); }
      }));
      if (signal.aborted) return;
      const titles = searchResults(responses, this.target);
      status.textContent = `${titles.length ? 'Choose the matching title. Provider years can differ.' : 'No matches. Edit the title, change regions, or use a provider URL below.'}${errors.length ? '\n' + errors.join('\n') : ''}`;
      for (const title of titles) {
        const card = this.titleCard(title);
        card.append(element('strong', `${title.title} (${title.year || 'year unknown'})`), element('p', `${title.type} · ${title.countries.join(', ')} · ${title.sources.length} provider pages`));
        const choose = button('Fetch artwork', () => this.fetchTitle(title)); choose.disabled = !title.sources.length;
        card.append(choose); results.append(card);
      }
      if (!titles.some(title => normalize(title.title) === normalize(query) && title.sources.length)) {
        await this.googleSearch(query, signal, results);
      }
    }
    titleCard(title) {
      const matched = exactMatch(title, this.target);
      const card = element('div', null, { class: matched ? 'card exact-match' : 'card' });
      if (matched) card.append(element('span', 'Title & year match', { class: 'match-label' }));
      return card;
    }
    async renderGoogle(titles, container, context) {
      const { seen, signal, summary } = context;
      const pending = [];
      for (const title of titles) {
        if (signal.aborted) return;
        const source = title.sources[0]; const key = sourceIdentity(source);
        if (seen.has(key)) continue;
        seen.add(key);
        const card = element('div', null, { class: 'card google-card' });
        const heading = element('strong', cleanGoogleTitle(title.title));
        const badge = element('span', 'Title & year match', { class: 'match-label' }); badge.hidden = true;
        const region = source.provider === 'Apple TV' ? new URL(source.url).pathname.split('/')[1].toUpperCase() : '';
        const providerLine = [source.provider, region].filter(Boolean).join(' · ');
        const meta = element('p', providerLine + ' · Reading year…', { class: 'google-meta' });
        const note = element('p', '', { class: 'google-note' }); note.hidden = true;
        const actions = element('div', null, { class: 'google-actions' });
        actions.append(link('View provider page', source.url), button('Fetch artwork', () => this.fetchTitle(title)));
        card.append(heading, badge, meta, note, actions);
        container.append(card);
        pending.push(async () => {
          try {
            const html = await this.cross(source.url, { signal });
            if (signal.aborted) return;
            const metadata = providerMetadata(parse(html), source.url);
            Object.assign(title, metadata); heading.textContent = metadata.title;
            meta.textContent = [providerLine, metadata.type, metadata.year || 'Year unknown'].filter(Boolean).join(' · ');
            const matched = exactMatch(metadata, this.target);
            card.classList.toggle('exact-match', matched); badge.hidden = !matched;
          } catch (_) {
            if (signal.aborted) return;
            meta.textContent = providerLine + ' · Year unknown';
            note.textContent = 'Could not read provider details. Open the page to check.'; note.hidden = false;
          }
        });
      }
      summary.textContent = `${seen.size} provider ${seen.size === 1 ? 'page' : 'pages'} found`;
      // Bound metadata traffic; a blocked provider never discards another card.
      await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
        while (pending.length && !signal.aborted) await pending.shift()();
      }));
    }
    async googleSearch(query, signal, results) {
      const section = element('div', null, { class: 'card google-section' });
      section.append(element('strong', 'Google Search fallback', { class: 'google-heading' }));
      const grid = element('div', null, { class: 'grid' });
      const states = element('div'); const summary = element('p', '0 provider pages found', { class: 'google-summary', role: 'status' });
      section.append(grid, states, summary); results.append(section);
      const context = { seen: new Set(), signal, summary };
      await Promise.all(googleQueries(query).map(async url => {
        const state = element('p', 'Searching Google…'); states.append(state);
        try {
          const html = await this.cross(url, { signal });
          if (signal.aborted) return;
          const titles = googleResults(parse(html), this.target.type);
          if (!titles.length) throw new Error('No readable provider results. Google may require JavaScript, consent, or a challenge.');
          await this.renderGoogle(titles, grid, context); state.remove();
        } catch (e) {
          if (signal.aborted) return;
          this.googleTab(url, grid, context, signal, state, e.message);
        }
      }));
    }
    googleTab(url, grid, context, signal, state, initialError) {
      if (signal.aborted || this.busy) return;
      const id = root.crypto.randomUUID(), key = PREFIX + id;
      const job = { id, url, mode: 'search', type: this.target.type, expires: Date.now() + TTL, state: 'waiting' };
      const record = { id }; this.jobs.push(record);
      const query = new URL(url).searchParams.get('q');
      const destination = new URL(url); destination.hash = 'tmdb-artwork=' + id;
      const closeTab = () => {
        if (record.tab) { record.tab.onclose = null; record.tab.close?.(); record.tab = null; }
      };
      let done = false;
      const finish = () => {
        done = true; root.clearTimeout(record.timer); root.clearTimeout(record.attentionTimer);
        GM_removeValueChangeListener(record.listener); GM_deleteValue(key); closeTab();
      };
      const attention = message => {
        if (done || signal.aborted) return;
        state.replaceChildren(element('span', `${query}: ${message} `), button('Open Google to resolve', () => {
          if (signal.aborted || done || this.busy) return;
          closeTab(); openTab(true);
        }));
      };
      const openTab = active => {
        try {
          record.tab = GM_openInTab(destination.href, { active, insert: true, setParent: true });
          if (record.tab) record.tab.onclose = () => attention('The search tab closed before returning results.');
        } catch (e) { attention(e.message); }
      };
      GM_setValue(key, job);
      record.listener = GM_addValueChangeListener(key, async (_key, _old, value) => {
        if (done || signal.aborted || !value || value.id !== id || value.state !== 'ready' || value.expires < Date.now()) return;
        finish();
        try {
          if (!Array.isArray(value.titles)) throw new Error('Invalid Google response.');
          const titles = value.titles.slice(0, 30).map(item => {
            const source = manualSource(item.sources?.[0]?.url);
            if (!['Amazon', 'Apple TV'].includes(source.provider)) throw new Error('Unsupported Google result.');
            source.countries = ['Google'];
            return { title: String(item.title).slice(0, 300), sources: [source] };
          });
          await this.renderGoogle(titles, grid, context); state.remove();
        } catch (e) { if (!signal.aborted) state.textContent = e.message; }
      });
      state.textContent = `${query}: Searching in a background tab…`;
      record.attentionTimer = root.setTimeout(() => attention('No results received yet. Google may require consent or a challenge, or have no matching pages. ' + initialError), 20000);
      record.timer = root.setTimeout(() => { state.textContent = `${query}: Search expired. Run the search again to retry.`; finish(); }, TTL);
      openTab(false);
    }
    async config(signal) {
      const html = await this.request(`${this.target.path}/images/${this.kind === 'backdrop' ? 'backdrops' : 'posters'}/upload`, { signal });
      return uploadConfig(parse(html), this.kind, this.target);
    }
    async fetchTitle(title) {
      if (this.busy) return;
      const signal = this.newRequest();
      const { results, status } = this;
      results.replaceChildren();
      status.textContent = 'Reading TMDB image limits…';
      let config;
      try {
        config = await this.config(signal);
      } catch (e) {
        if (!signal.aborted) status.textContent = e.message;
        return;
      }
      if (signal.aborted) return;
      status.textContent = 'Fetching artwork. Each card previews the exact JPEG that will be uploaded.';
      for (const source of title.sources) {
        if (signal.aborted) return;
        const card = element('div', null, { class: 'card' });
        card.append(link(`${source.provider} · ${source.countries.join(', ')}`, source.url)); results.append(card);
        const state = element('p', 'Loading…'); card.append(state);
        try {
          let assets;
          if (source.provider === 'Kanopy') {
            assets = await fetchKanopy(source.url, this.kind, this.cross, signal);
          } else {
            const html = await this.cross(source.url, { signal });
            assets = extract(parse(html), source.url, this.kind);
          }
          await this.addAssets(assets, source, card, config, signal);
          state.remove();
        } catch (e) {
          if (signal.aborted) return;
          state.textContent = e.message; state.className = 'error';
          card.append(button('Open source tab', event => this.sourceTab(source, card, config, signal, event.currentTarget)));
        }
      }
    }
    async addAssets(assets, source, card, config, signal) {
      for (const asset of assets) {
        if (signal.aborted) return;
        const prepared = await this.prepare(asset, config, signal);
        if (signal.aborted) return;
        const url = root.URL.createObjectURL(prepared.blob); this.urls.push(url);
        const block = element('div');
        const img = element('img', null, { src: url, alt: asset.title || this.target.title });
        img.addEventListener('click', () => img.classList.toggle('full'));
        block.append(element('p', asset.title || this.target.title), img,
          element('p', `Source ${prepared.sourceWidth}×${prepared.sourceHeight} → JPEG ${prepared.crop.width}×${prepared.crop.height} · ${(prepared.blob.size / 1024).toFixed(0)} KB. Center crop; click image to enlarge.`));
        if (this.kind === 'poster' && prepared.sourceWidth >= prepared.sourceHeight) {
          block.append(element('p', 'This provider artwork is landscape. The poster crop removes the sides; check that titles and faces remain intact.', { class: 'error' }));
        }
        const language = element('input', null, { value: this.kind === 'backdrop' ? 'xx-XX' : 'en-US', list: 'artwork-languages', 'aria-label': 'Image language' });
        const label = element('label', 'Image language '); label.append(language); block.append(label);
        if (!this.panel.querySelector('#artwork-languages')) {
          const list = element('datalist', null, { id: 'artwork-languages' });
          for (const [value, text] of [['xx-XX', 'No language'], ['en-US', 'English'], ['en-GB', 'English (UK)'], ['pl-PL', 'Polish'], ['de-DE', 'German'], ['fr-FR', 'French'], ['es-ES', 'Spanish'], ['it-IT', 'Italian'], ['ja-JP', 'Japanese']]) list.append(element('option', text, { value }));
          this.panel.append(list);
        }
        const name = filename(this.target, this.kind);
        const row = element('div', null, { class: 'row' });
        const save = link('Save JPEG', url); save.setAttribute('download', name);
        const upload = button('Upload this image', () => this.upload(prepared, name, language.value, config, block, upload));
        row.append(upload, save); block.append(row); card.append(block);
      }
    }
    lock(value) {
      this.busy = value;
      for (const control of this.shadow.querySelectorAll('button,input,select')) {
        if (value) {
          control.dataset.wasDisabled = String(control.disabled);
          control.disabled = true;
        } else {
          control.disabled = control.dataset.wasDisabled === 'true';
          delete control.dataset.wasDisabled;
        }
      }
    }
    async language(id, value, config) {
      await this.waf();
      const body = new root.URLSearchParams({ image_language: value, media_id: config.mediaId,
        media_type: config.mediaType, image_type: config.kind, authenticity_token: config.token });
      const response = await this.request(`/image/${id}/language`, { body });
      if (response.success !== true) throw new Error(response.message || 'Language update failed.');
    }
    languageRetry(id, value, mediaId, state) {
      const retry = button('Retry language only', async () => {
        if (this.busy) return;
        this.lock(true);
        try {
          const config = await this.config();
          if (config.mediaId !== mediaId) throw new Error('TMDB returned a different title. Reload the correct gallery.');
          await this.language(id, value, config);
          state.textContent = 'Uploaded; language updated.';
          retry.remove();
        } catch (e) {
          state.textContent = `Image is already uploaded. Language update failed: ${e.message}`;
        } finally {
          this.lock(false);
        }
      });
      return retry;
    }
    async upload(prepared, name, language, originalConfig, block, uploadButton) {
      if (this.busy || uploadButton.dataset.submitted || this.controller?.signal.aborted || !block.isConnected) return;
      const state = element('p', '', { role: 'status' });
      block.append(state);
      if (!/^[a-z]{2,3}-[A-Z]{2}$/.test(language)) {
        state.textContent = 'Choose a language tag such as en-US, or xx-XX for no language.';
        return;
      }
      this.lock(true);
      let attempted = false;
      try {
        state.textContent = 'Checking the upload session…';
        const config = await this.config();
        const { width, height } = prepared.crop;
        const sameForm = config.mediaId === originalConfig.mediaId &&
          config.ratioWidth === originalConfig.ratioWidth && config.ratioHeight === originalConfig.ratioHeight;
        const outsideLimits = width < config.minWidth || height < config.minHeight ||
          width > config.maxWidth || height > config.maxHeight;
        if (!sameForm || outsideLimits) {
          throw new Error('TMDB form settings changed. Fetch artwork again before uploading.');
        }
        await this.waf();
        state.textContent = 'Uploading the confirmed JPEG…';
        attempted = true;
        uploadButton.dataset.submitted = 'true';
        const result = uploadResult(await this.request('/image', { body: multipart(prepared.blob, name, config) }));
        state.textContent = result.processing ? 'Uploaded; TMDB is processing the image.' : 'Uploaded successfully.';
        block.append(link('View TMDB gallery', `${TMDB}${this.target.path}/images/${config.kind === 'backdrop' ? 'backdrops' : 'posters'}`));
        if (!result.id) {
          state.textContent += ' The response did not include an image ID; set its language in the gallery.';
          return;
        }
        try { await this.language(result.id, language, config); }
        catch (e) {
          state.textContent += ` Language was not updated: ${e.message}`;
          block.append(this.languageRetry(result.id, language, config.mediaId, state));
        }
      } catch (e) {
        state.textContent = attempted ? `${e.message} The image may already have reached TMDB. Check the gallery before starting another upload.` : e.message;
      } finally {
        this.lock(false);
        if (attempted) {
          uploadButton.disabled = true;
          uploadButton.textContent = 'Submission sent';
        }
      }
    }
    sourceTab(source, card, config, signal, opener) {
      if (signal.aborted) return;
      opener.disabled = true;
      const id = root.crypto.randomUUID(); const key = PREFIX + id;
      const job = { id, url: source.url, kind: this.kind, expires: Date.now() + TTL, state: 'waiting' };
      GM_setValue(key, job);
      const listener = GM_addValueChangeListener(key, async (_key, _old, value) => {
        if (signal.aborted || !value || value.state !== 'ready' || value.expires < Date.now()) return;
        GM_removeValueChangeListener(listener); GM_deleteValue(key);
        try {
          if (!Array.isArray(value.assets) || value.assets.some(a => !Array.isArray(a.variants) || a.variants.some(u => !isImageURL(u)))) throw new Error('Invalid source response.');
          await this.addAssets(value.assets, source, card, config, signal);
        } catch (e) { if (!signal.aborted) card.append(element('p', e.message, { class: 'error' })); }
      });
      const url = new URL(source.url); url.hash = 'tmdb-artwork=' + id;
      GM_openInTab(url.href, { active: true, insert: true, setParent: true });
      card.append(element('p', 'In the source tab, resolve any challenge and click “Send artwork to TMDB”. This request expires in 10 minutes.'));
      const timer = root.setTimeout(() => { if (!signal.aborted) { GM_removeValueChangeListener(listener); GM_deleteValue(key); opener.disabled = false; } }, TTL);
      this.jobs.push({ id, listener, timer });
    }
  }
  function googleHelper(job, key) {
    // Observe only the request-specific Google page. No artwork fetching or upload.
    let debounce;
    const observer = new root.MutationObserver(() => {
      root.clearTimeout(debounce); debounce = root.setTimeout(scan, 250);
    });
    const stop = () => { observer.disconnect(); root.clearTimeout(debounce); root.clearInterval(expiry); };
    const currentSearch = () => root.location.origin === 'https://www.google.com' && root.location.pathname === '/search' &&
      new URL(job.url).searchParams.get('q') === new URL(root.location.href).searchParams.get('q');
    const scan = () => {
      const current = GM_getValue(key);
      if (!current || current.state !== 'waiting' || current.expires < Date.now() || !currentSearch()) { stop(); return; }
      const titles = googleResults(root.document, job.type);
      if (titles.length) { GM_setValue(key, { ...job, state: 'ready', titles }); stop(); }
    };
    const expiry = root.setInterval(scan, 10000);
    observer.observe(root.document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    root.addEventListener('pagehide', stop, { once: true });
    scan();
  }
  function helper() {
    const id = new URLSearchParams(root.location.hash.slice(1)).get('tmdb-artwork');
    if (!id || !/^[a-f\d-]{36}$/i.test(id)) return;
    const key = PREFIX + id; const job = GM_getValue(key);
    // Providers can redirect a title to a different slug. Keep the job bound to its
    // source origin, a title route, and the unguessable request ID in the fragment.
    if (!job || job.state !== 'waiting' || job.expires < Date.now() || new URL(job.url).origin !== root.location.origin) return;
    if (job.mode === 'search') {
      if (root.location.origin !== 'https://www.google.com' || root.location.pathname !== '/search' ||
        new URL(job.url).searchParams.get('q') !== new URL(root.location.href).searchParams.get('q')) return;
      googleHelper(job, key);
      return;
    }
    if (!isTitleLink(root.location.href)) return;
    const host = element('div'); host.style.cssText = 'position:relative;z-index:2147483647';
    const shadow = host.attachShadow({ mode: 'open' }); shadow.append(element('style', CSS));
    const toolbar = element('div', null, { class: 'toolbar' }); const state = element('span');
    const send = button('Send artwork to TMDB', async () => {
      if (send.disabled) return;
      send.disabled = true;
      try {
        const current = GM_getValue(key);
        if (!current || current.state !== 'waiting' || current.expires < Date.now()) throw new Error('Request expired. Open a new source tab from TMDB.');
        let assets;
        if (provider(root.location.href) === 'Kanopy') {
          assets = await fetchKanopy(root.location.href, job.kind, async (url, options) => {
            const response = await root.fetch(url, { credentials: 'same-origin', headers: options.headers, signal: options.signal });
            if (!response.ok) throw new Error(`Kanopy returned HTTP ${response.status}. Wait for the title page to finish loading, then try again.`);
            return response.text();
          }, root.AbortSignal.timeout(30000));
        } else assets = extract(root.document, root.location.href, job.kind);
        const pending = GM_getValue(key);
        if (!pending || pending.expires < Date.now()) throw new Error('Request expired. Open a new source tab from TMDB.');
        GM_setValue(key, { ...job, state: 'ready', assets });
        state.textContent = 'Artwork sent. Return to TMDB to preview it.'; send.disabled = true;
      } catch (e) { state.textContent = e.message; send.disabled = false; }
    });
    toolbar.append(send, state); shadow.append(toolbar); root.document.body.append(host);
  }
  function start() {
    for (const key of GM_listValues()) {
      if (key.startsWith(PREFIX) && GM_getValue(key)?.expires < Date.now()) GM_deleteValue(key);
    }
    if (provider(root.location.href) || root.location.origin === 'https://www.google.com') { helper(); return; }
    const target = targetFromPage(root.document, root.location.href);
    if (target && !root.document.getElementById('tmdb-artwork')) new App(target);
  }
  const api = { QUERY, regions, targetFromPage, exactMatch, provider, canonicalProvider, searchResults, amazonVariants,
    amazonArtwork, appleArtwork, kanopyAPI, kanopyArtwork, fetchKanopy, manualSource, discoveryLinks, googleQueries, googleResults, cleanGoogleTitle, providerMetadata, crossRequest, extract, uploadConfig, cropPlan, filename, multipart, uploadResult, prepare, App, helper, start };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else start();
})(globalThis);
