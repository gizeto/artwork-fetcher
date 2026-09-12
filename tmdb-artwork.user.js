// ==UserScript==
// @name         TMDB artwork finder
// @namespace    local.tmdb-artwork
// @version      1.1.0
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
    u.search = keep.toString(); u.hash = '';
    return u.href;
  }
  function isTitleLink(url) {
    const u = new URL(url);
    if (provider(url) === 'Kanopy') return /^(?:\/[a-z]{2})?\/product\/[a-z\d-]+\/?$/i.test(u.pathname);
    return provider(url) === 'Apple TV' ? /\/(movie|show)\/[^/]+\/umc\./.test(u.pathname) :
      /\/(?:detail|dp|product)\/[^/]+/.test(u.pathname);
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
          const found = item.sources.find(s => s.url === url);
          if (found) { if (!found.countries.includes(country)) found.countries.push(country); }
          else item.sources.push({ url, provider: name, countries: [country] });
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
    const script = doc.querySelector('#dv-web-page-hydration-data');
    if (script) {
      const data = JSON.parse(script.textContent);
      const detail = data.init?.preparations?.body?.atf?.state?.detail;
      const headers = Object.values(detail?.headerDetail || {});
      // headerDetail contains the current title; never traverse recommendation collections.
      for (const header of headers) {
        const image = header.images?.[kind === 'backdrop' ? 'heroshot' : 'packshot'];
        if (image && isImageURL(image)) assets.push({ title: header.title, url: image, variants: amazonVariants(image) });
      }
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
    const node = doc.querySelector('#serialized-server-data');
    if (!node) return [];
    const data = JSON.parse(node.textContent);
    const assets = [];
    for (const entry of data.data || []) {
      const page = entry?.data;
      if (!page?.canonicalURL || !page.shelves) continue;
      const id = new URL(pageURL).pathname.split('/').pop();
      if (new URL(page.canonicalURL).pathname.split('/').pop() !== id) continue;
      for (const shelf of page.shelves) {
        for (const item of shelf.items || []) {
          if (item.$kind !== 'SuperheroLockup') continue;
          const art = item.artwork?.[kind === 'backdrop' ? 'wide' : 'tall'];
          if (!art?.template || !(art.width > 0 && art.height > 0)) continue;
          const url = art.template.replaceAll('{w}', art.width).replaceAll('{h}', art.height).replaceAll('{f}', 'jpg');
          if (isImageURL(url)) assets.push({ title: item.title, url, variants: [url] });
        }
      }
    }
    return assets;
  }
  function kanopyAPI(pageURL) {
    const source = manualSource(pageURL);
    if (source.provider !== 'Kanopy') throw new Error('Not a Kanopy title page.');
    const alias = new URL(source.url).pathname.split('/').filter(Boolean).pop();
    return 'https://www.kanopy.com/kapi/videos/alias/' + encodeURIComponent(alias) + '?webshopId=9';
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
    const el = doc.querySelector('.image_cropper');
    if (!el) throw new Error('TMDB upload form unavailable. Sign in to TMDB and try again.');
    const d = el.dataset;
    if (d.imageKind !== kind || d.mediaType !== (target.type === 'movie' ? 'Movie' : 'TvSeries')) throw new Error('TMDB returned an unexpected upload form.');
    const ratio = d.aspectRatio.split('/').map(Number);
    const config = { mediaId: d.mediaId, mediaType: d.mediaType, kind, token: d.csrfToken,
      minWidth: +d.minCropWidth, minHeight: +d.minCropHeight, maxWidth: +d.maxCropWidth, maxHeight: +d.maxCropHeight,
      ratioWidth: ratio[0], ratioHeight: ratio[1] };
    if (!config.mediaId || !config.token || [config.minWidth, config.minHeight, config.maxWidth, config.maxHeight,
      config.ratioWidth, config.ratioHeight].some(n => !Number.isFinite(n) || n <= 0)) throw new Error('TMDB upload form is missing required settings.');
    return config;
  }
  function cropPlan(width, height, c) {
    const scale = Math.min(width / c.ratioWidth, height / c.ratioHeight);
    const cropWidth = scale * c.ratioWidth, cropHeight = scale * c.ratioHeight;
    const unit = Math.floor(Math.min(scale, c.maxWidth / c.ratioWidth, c.maxHeight / c.ratioHeight));
    const outputWidth = unit * c.ratioWidth, outputHeight = unit * c.ratioHeight;
    return { x: (width - cropWidth) / 2, y: (height - cropHeight) / 2, cropWidth, cropHeight,
      width: outputWidth, height: outputHeight, valid: outputWidth >= c.minWidth && outputHeight >= c.minHeight };
  }
  function filename(target, kind) {
    return `${Math.floor(Date.now() / 1000)}_${slug(target.title)}${target.year ? '-' + target.year : ''}_${kind === 'backdrop' ? 'bg' : 'poster'}.jpg`;
  }
  function multipart(blob, name, c) {
    const data = new root.FormData();
    data.append('upload_files', blob, name);
    for (const [key, value] of Object.entries({ media_id: c.mediaId, media_type: c.mediaType, type: c.kind,
      translate: 'false', crop_area: '', authenticity_token: c.token })) data.append(key, value);
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
  function crossRequest(url, { json, blob = false, signal, anonymous = true } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Cancelled.'));
      const finish = (fn, value) => { signal?.removeEventListener('abort', abort); fn(value); };
      let request;
      const abort = () => { request?.abort(); finish(reject, new Error('Cancelled.')); };
      request = GM_xmlhttpRequest({ method: json ? 'POST' : 'GET', url, anonymous,
        headers: json ? { 'Content-Type': 'application/json', Accept: 'application/json' } : {},
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
      const image = new root.Image(); image.src = url;
      await image.decode();
      return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => root.URL.revokeObjectURL(url) };
    } catch (_) { root.URL.revokeObjectURL(url); throw new Error('Cannot decode source image. Use a browser with AVIF support.'); }
  }
  async function prepare(asset, config, signal) {
    let best, lastError;
    for (const url of asset.variants) {
      if (!isImageURL(url)) continue;
      try {
        const decoded = await decode(await crossRequest(url, { blob: true, signal }));
        if (!best || decoded.width * decoded.height >= best.width * best.height) { best?.close(); best = decoded; }
        else decoded.close();
      } catch (e) { lastError = e; }
      if (signal?.aborted) { best?.close(); throw new Error('Cancelled.'); }
    }
    if (!best) throw lastError || new Error('No downloadable artwork.');
    try {
      const crop = cropPlan(best.width, best.height, config);
      if (!crop.valid) throw new Error(`Source ${best.width}×${best.height} is too small after cropping (minimum ${config.minWidth}×${config.minHeight}).`);
      const canvas = root.document.createElement('canvas'); canvas.width = crop.width; canvas.height = crop.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(best.image, crop.x, crop.y, crop.cropWidth, crop.cropHeight, 0, 0, crop.width, crop.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 1.0));
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
    const b = element('button', text, { type: 'button' }); b.addEventListener('click', action); return b;
  }
  function link(text, href) { return element('a', text, { href, target: '_blank', rel: 'noopener noreferrer' }); }
  const CSS = `
    :host { all: initial; font: 14px/1.5 system-ui,sans-serif; color:#edf4fb; }
    * { box-sizing:border-box; } button,input,select { font:inherit; } button { cursor:pointer; border:0; border-radius:6px; padding:9px 13px; color:#fff; background:#166a94; }
    button:hover { background:#238ab8; } button:disabled { opacity:.45; cursor:default; }
    .toolbar { position:fixed; bottom:18px; right:18px; display:flex; flex-wrap:wrap; gap:7px; padding:10px; background:#102435; border:1px solid #426279; border-radius:10px; box-shadow:0 4px 18px #0005; }
    .overlay { position:fixed; inset:0; background:#0009; display:flex; align-items:center; justify-content:center; padding:20px; }
    .panel { width:1000px; max-width:100%; max-height:92vh; overflow:auto; background:#102435; padding:22px; border:1px solid #426279; border-radius:12px; }
    h2 { margin:0 0 14px; font-size:22px; } p { margin:10px 0; } a { color:#69d5fb; } label { display:inline-flex; gap:8px; align-items:center; }
    input,select { padding:7px; border:1px solid #7591a5; border-radius:4px; background:#fff; color:#122433; }
    .row { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin:12px 0; } .row input { flex:1; min-width:180px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(270px,1fr)); gap:16px; }
    .card { padding:14px; border:1px solid #426279; border-radius:8px; overflow:hidden; }
    img { display:block; width:100%; height:260px; object-fit:contain; background:#07111a; cursor:zoom-in; }
    .full { max-height:65vh; height:auto; } .error { color:#ffc5b8; } .status { white-space:pre-wrap; }
  `;

  class App {
    constructor(target, deps = {}) {
      this.target = target; this.request = deps.request || tmdbRequest; this.cross = deps.cross || crossRequest;
      this.prepare = deps.prepare || prepare; this.waf = deps.waf || waf;
      this.urls = []; this.jobs = []; this.busy = false;
      this.host = element('div', null, { id: 'tmdb-artwork' }); this.host.style.cssText = 'position:relative;z-index:2147483646';
      this.shadow = this.host.attachShadow({ mode: 'open' }); this.shadow.append(element('style', CSS));
      const toolbar = element('div', null, { class: 'toolbar' });
      toolbar.append(button('Fetch background', () => this.open('backdrop')), button('Fetch poster', () => this.open('poster')), button('Settings', () => this.settings()));
      this.shadow.append(toolbar); root.document.body.append(this.host);
    }
    cleanup() {
      this.controller?.abort();
      this.urls.forEach(url => root.URL.revokeObjectURL(url)); this.urls = [];
      for (const job of this.jobs) { root.clearTimeout(job.timer); GM_removeValueChangeListener(job.listener); GM_deleteValue(PREFIX + job.id); }
      this.jobs = [];
    }
    shell(title) {
      if (this.busy) return false;
      this.cleanup(); this.overlay?.remove(); this.controller = new root.AbortController();
      this.overlay = element('div', null, { class: 'overlay' });
      this.panel = element('div', null, { class: 'panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
      this.panel.append(element('h2', title));
      this.close = button('Close', () => { if (!this.busy) { this.cleanup(); this.overlay.remove(); } });
      this.panel.append(this.close); this.overlay.append(this.panel); this.shadow.append(this.overlay);
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
      // Keep this fallback above the results and available even when search fails.
      this.panel.insertBefore(section, this.results);
    }
    async search(query) {
      if (this.busy) return;
      this.cleanup(); this.controller = new root.AbortController();
      const signal = this.controller.signal; const results = this.results; const status = this.status;
      results.replaceChildren(); status.textContent = 'Searching JustWatch…';
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
        const card = element('div', null, { class: 'card' });
        card.append(element('strong', `${title.title} (${title.year || 'year unknown'})`), element('p', `${title.type} · ${title.countries.join(', ')} · ${title.sources.length} provider pages`));
        const choose = button('Fetch artwork', () => this.fetchTitle(title)); choose.disabled = !title.sources.length;
        card.append(choose); results.append(card);
      }
    }
    async config(signal) {
      const html = await this.request(`${this.target.path}/images/${this.kind === 'backdrop' ? 'backdrops' : 'posters'}/upload`, { signal });
      return uploadConfig(parse(html), this.kind, this.target);
    }
    async fetchTitle(title) {
      if (this.busy) return;
      this.cleanup(); this.controller = new root.AbortController();
      const signal = this.controller.signal; const results = this.results; const status = this.status;
      results.replaceChildren(); status.textContent = 'Reading TMDB image limits…';
      let config;
      try { config = await this.config(signal); } catch (e) { if (!signal.aborted) status.textContent = e.message; return; }
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
            const data = JSON.parse(await this.cross(kanopyAPI(source.url), { signal, anonymous: false }));
            assets = kanopyArtwork(data, this.kind, source.url);
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
        if (value) { control.dataset.wasDisabled = String(control.disabled); control.disabled = true; }
        else { control.disabled = control.dataset.wasDisabled === 'true'; delete control.dataset.wasDisabled; }
      }
    }
    async language(id, value, config) {
      await this.waf();
      const body = new root.URLSearchParams({ image_language: value, media_id: config.mediaId,
        media_type: config.mediaType, image_type: config.kind, authenticity_token: config.token });
      const response = await this.request(`/image/${id}/language`, { body });
      if (response.success !== true) throw new Error(response.message || 'Language update failed.');
    }
    async upload(prepared, name, language, originalConfig, block, uploadButton) {
      if (this.busy || uploadButton.dataset.submitted || this.controller?.signal.aborted || !block.isConnected) return;
      const state = element('p', '', { role: 'status' }); block.append(state);
      if (!/^[a-z]{2,3}-[A-Z]{2}$/.test(language)) { state.textContent = 'Choose a language tag such as en-US, or xx-XX for no language.'; return; }
      this.lock(true);
      let attempted = false;
      try {
        state.textContent = 'Checking the upload session…';
        const config = await this.config();
        if (config.mediaId !== originalConfig.mediaId || prepared.crop.width < config.minWidth || prepared.crop.height < config.minHeight ||
          prepared.crop.width > config.maxWidth || prepared.crop.height > config.maxHeight ||
          config.ratioWidth !== originalConfig.ratioWidth || config.ratioHeight !== originalConfig.ratioHeight) throw new Error('TMDB form settings changed. Fetch artwork again before uploading.');
        await this.waf();
        state.textContent = 'Uploading the confirmed JPEG…';
        attempted = true; uploadButton.dataset.submitted = 'true';
        const result = uploadResult(await this.request('/image', { body: multipart(prepared.blob, name, config) }));
        state.textContent = result.processing ? 'Uploaded; TMDB is processing the image.' : 'Uploaded successfully.';
        block.append(link('View TMDB gallery', `${TMDB}${this.target.path}/images/${config.kind === 'backdrop' ? 'backdrops' : 'posters'}`));
        if (!result.id) { state.textContent += ' The response did not include an image ID; set its language in the gallery.'; return; }
        try { await this.language(result.id, language, config); }
        catch (e) {
          state.textContent += ` Language was not updated: ${e.message}`;
          const retry = button('Retry language only', async () => {
            if (this.busy) return;
            this.lock(true);
            try {
              const fresh = await this.config();
              if (fresh.mediaId !== config.mediaId) throw new Error('TMDB returned a different title. Reload the correct gallery.');
              await this.language(result.id, language, fresh); state.textContent = 'Uploaded; language updated.'; retry.remove();
            }
            catch (err) { state.textContent = `Image is already uploaded. Language update failed: ${err.message}`; }
            finally { this.lock(false); uploadButton.disabled = true; }
          });
          block.append(retry);
        }
      } catch (e) {
        state.textContent = attempted ? `${e.message} The image may already have reached TMDB. Check the gallery before starting another upload.` : e.message;
      } finally {
        this.lock(false);
        if (attempted) { uploadButton.disabled = true; uploadButton.textContent = 'Submission sent'; }
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
  function helper() {
    const id = new URLSearchParams(root.location.hash.slice(1)).get('tmdb-artwork');
    if (!id || !/^[a-f\d-]{36}$/i.test(id)) return;
    const key = PREFIX + id; const job = GM_getValue(key);
    // Providers can redirect a title to a different slug. Keep the job bound to its
    // source origin, a title route, and the unguessable request ID in the fragment.
    if (!job || job.expires < Date.now() || new URL(job.url).origin !== root.location.origin || !isTitleLink(root.location.href)) return;
    const host = element('div'); host.style.cssText = 'position:relative;z-index:2147483647';
    const shadow = host.attachShadow({ mode: 'open' }); shadow.append(element('style', CSS));
    const toolbar = element('div', null, { class: 'toolbar' }); const state = element('span');
    const send = button('Send artwork to TMDB', async () => {
      if (send.disabled) return;
      send.disabled = true;
      try {
        const current = GM_getValue(key);
        if (!current || current.expires < Date.now()) throw new Error('Request expired. Open a new source tab from TMDB.');
        let assets;
        if (provider(root.location.href) === 'Kanopy') {
          const response = await root.fetch(kanopyAPI(root.location.href), { credentials: 'same-origin', signal: root.AbortSignal.timeout(30000) });
          if (!response.ok) throw new Error(`Kanopy returned HTTP ${response.status}. Wait for the title page to finish loading, then try again.`);
          assets = kanopyArtwork(await response.json(), job.kind, root.location.href);
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
    if (provider(root.location.href)) { helper(); return; }
    const target = targetFromPage(root.document, root.location.href);
    if (target && !root.document.getElementById('tmdb-artwork')) new App(target);
  }
  const api = { QUERY, regions, targetFromPage, provider, canonicalProvider, searchResults, amazonVariants,
    amazonArtwork, appleArtwork, kanopyAPI, kanopyArtwork, manualSource, discoveryLinks, extract, uploadConfig, cropPlan, filename, multipart, uploadResult, prepare, App, helper, start };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else start();
})(globalThis);
