// ==UserScript==
// @name         TMDB Artwork Fetcher
// @namespace    https://github.com/gizeto/artwork-fetcher
// @version      1.6.1
// @author       gizeto
// @homepageURL  https://github.com/gizeto/artwork-fetcher
// @supportURL   https://github.com/gizeto/artwork-fetcher/issues
// @downloadURL  https://raw.githubusercontent.com/gizeto/artwork-fetcher/main/artwork-fetcher.user.js
// @updateURL    https://raw.githubusercontent.com/gizeto/artwork-fetcher/main/artwork-fetcher.user.js
// @description  Find provider or webpage artwork, preview a JPEG, and confirm its upload to TMDB.
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
// @match        https://www.disneyplus.com/*
// @match        https://disneyplus.com/*
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
// @connect      uts-api.itunes.apple.com
// @connect      m.media-amazon.com
// @connect      images-na.ssl-images-amazon.com
// @connect      mzstatic.com
// @connect      kanopy.com
// @connect      static-assets.kanopy.com
// @connect      disneyplus.com
// @connect      disney.images.edge.bamgrid.com
// @connect      *
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
  const CACHE_PREFIX = 'tmdb-artwork-cache:v1:';
  const CACHE_TTL = 15 * 60 * 1000;
  const CACHE_MAX_BYTES = 5 * 1024 * 1024;
  const BLOB_MAX_BYTES = 50 * 1024 * 1024;
  class Cache {
    constructor() { this.blobs = new Map(); }
    records() {
      const now = Date.now(), records = [];
      for (const key of GM_listValues()) {
        if (!key.startsWith(CACHE_PREFIX)) continue;
        const entry = GM_getValue(key);
        if (!entry || entry.version !== 1 || !(entry.expires > now)) GM_deleteValue(key);
        else records.push({ key, entry, size: JSON.stringify(entry).length * 2 });
      }
      return records;
    }
    get(key) {
      try {
        const entry = GM_getValue(CACHE_PREFIX + key);
        if (entry?.version === 1 && entry.expires > Date.now()) return entry.value;
        if (entry) GM_deleteValue(CACHE_PREFIX + key);
      } catch (_) { /* Storage is optional. */ }
    }
    set(key, value, signal) {
      if (signal?.aborted) return;
      try {
        const entry = { version: 1, created: Date.now(), expires: Date.now() + CACHE_TTL, value };
        const size = JSON.stringify(entry).length * 2;
        if (size > CACHE_MAX_BYTES) return;
        const storageKey = CACHE_PREFIX + key;
        const records = this.records().filter(r => r.key !== storageKey).sort((a, b) => a.entry.created - b.entry.created);
        let total = records.reduce((sum, r) => sum + r.size, size);
        while (records.length >= 200 || total > CACHE_MAX_BYTES) {
          const oldest = records.shift(); total -= oldest.size; GM_deleteValue(oldest.key);
        }
        GM_setValue(storageKey, entry);
      } catch (_) { /* Keep fetching if storage is full or unavailable. */ }
    }
    getBlob(url) {
      for (const [key, entry] of this.blobs) if (entry.expires <= Date.now()) this.blobs.delete(key);
      return this.blobs.get(url)?.blob;
    }
    setBlob(url, blob, signal) {
      if (signal?.aborted || blob.size > BLOB_MAX_BYTES) return;
      this.getBlob(url); this.blobs.delete(url);
      let total = [...this.blobs.values()].reduce((sum, e) => sum + e.blob.size, blob.size);
      while (total > BLOB_MAX_BYTES) {
        const key = this.blobs.keys().next().value;
        total -= this.blobs.get(key).blob.size; this.blobs.delete(key);
      }
      this.blobs.set(url, { blob, expires: Date.now() + CACHE_TTL });
    }
    clear() {
      this.blobs.clear();
      try { for (const key of GM_listValues()) if (key.startsWith(CACHE_PREFIX)) GM_deleteValue(key); }
      catch (_) { /* Storage may be disabled. */ }
    }
  }
  function checkCancelled(signal) { if (signal?.aborted) throw new Error('Cancelled.'); }
  async function forEachConcurrent(items, signal, visit) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
      while (next < items.length && !signal.aborted) await visit(items[next++]);
    }));
  }
  function uniqueArtwork(assets) { return [...new Map(assets.map(asset => [asset.url, asset])).values()]; }
  function webURL(value, base) {
    try {
      const url = new URL(value, base);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
    } catch (_) { /* Invalid URL. */ }
    return null;
  }
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
      if (['www.disneyplus.com', 'disneyplus.com'].includes(u.hostname)) return 'Disney+';
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
      case 'Disney+': return /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/(?:browse\/entity-[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}|(?:movies|series)\/[^/]+\/[a-z\d-]+)\/?$/i.test(pathname);
      default: return false;
    }
  }
  function manualSource(value) {
    const text = String(value).trim();
    if (!webURL(text)) throw new Error('Paste an HTTP or HTTPS image or webpage URL without credentials.');
    const name = provider(text);
    const canonical = name && canonicalProvider(text.replace(/[),.;]+$/, ''));
    if (canonical && isTitleLink(canonical)) {
      return { url: canonical, provider: name, countries: ['Direct link'] };
    }
    return { url: text, provider: new URL(text).hostname, generic: true, countries: ['Direct link'] };
  }
  function discoveryLinks(title, target) {
    const query = target.type === 'tv' ? `${title} tv show online` : [title, target.year, 'online'].filter(Boolean).join(' ');
    return [['Search Google for streaming options', 'https://www.google.com/search?q=' + encodeURIComponent(query)]];
  }
  function googleQueries(title) {
    return ['prime video', 'apple tv', 'disney plus'].map(provider =>
      'https://www.google.com/search?q=' + encodeURIComponent(`${title} ${provider}`));
  }
  function sourceIdentity(source) {
    const u = new URL(source.url);
    if (source.provider === 'Disney+') return 'Disney+:' + titlePageId(source.url);
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
        if (!['Amazon', 'Apple TV', 'Disney+'].includes(provider(url.href))) continue;
        const source = manualSource(url.href);
        if (source.generic) continue;
        const heading = anchor.querySelector('h3, [role="heading"]');
        const titleNode = heading?.cloneNode(true) || anchor.cloneNode(true);
        titleNode.querySelectorAll('cite, time, script, style, [aria-hidden="true"]').forEach(node => node.remove());
        const title = cleanGoogleTitle(titleNode.textContent);
        if (!title || /^https?:\/\//.test(title)) continue;
        if (source.provider === 'Apple TV' && !url.pathname.includes(type === 'tv' ? '/show/' : '/movie/')) continue;
        if (source.provider === 'Disney+' && /\/(movies|series)\//.test(url.pathname) &&
          !url.pathname.includes(type === 'tv' ? '/series/' : '/movies/')) continue;
        source.countries = ['Google', ...(source.provider === 'Apple TV' ? [url.pathname.split('/')[1].toUpperCase()] : [])];
        const key = sourceIdentity(source);
        if (!found.has(key)) found.set(key, { title, sources: [source] });
      } catch (_) { /* Ignore tracking links, search controls and unsupported URLs. */ }
    }
    return [...found.values()];
  }
  function cleanGoogleTitle(value) {
    return String(value || '').replace(/\s+/g, ' ').trim()
      .replace(/\s*(?:[-|–—:]\s*)?(?:Amazon(?:\.com)?(?:\s+Prime)?\s+Video|Prime\s*Video|Apple\s*TV|Disney\s*\+)(?:\s*[-|–—:]?\s*\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)?\s*$/i, '')
      .replace(/\s*\|\s*Watch (?:Full Episodes|Full Movie|Now)\s*$/i, '')
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
    const name = provider(pageURL);
    if (name === 'Amazon') {
      const headers = amazonHeaders(doc);
      const entry = headers[titlePageId(pageURL)] || (Object.keys(headers).length === 1 ? Object.values(headers)[0] : null);
      if (entry?.title) {
        return {
          title: entry.title,
          year: year(entry.releaseYear) || year(entry.releaseDate),
          type: entry.titleType === 'movie' ? 'Movie' : entry.titleType ? 'TV series' : '',
        };
      }
    } else if (name === 'Apple TV') {
      const item = appleTitleItems(doc, pageURL).find(item => item.title);
      if (item) {
        return {
          title: item.title,
          year: (item.badgeRowMetadata || []).map(String).find(value => /^\d{4}$/.test(value)) || year(item.releaseDate),
          type: item.type === 'Movie' || item.primaryMetadata?.includes('Movie') ? 'Movie' : 'TV series',
        };
      }
    } else if (name === 'Disney+') {
      const page = disneyTitleData(doc, pageURL);
      if (page?.details?.title) return { title: page.details.title, year: year(page.hero?.releaseYear || page.details.release),
        type: page.schema?.['@type'] === 'Movie' ? 'Movie' : page.schema?.['@type'] === 'TVSeries' || page.hero?.seasonsAvailable ? 'TV series' : '' };
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
        (u.hostname === 'static-assets.kanopy.com' && u.pathname.startsWith('/video-images/')) ||
        (u.hostname === 'disney.images.edge.bamgrid.com' && /^\/ripcut-delivery\/v2\/variant\/disney\/[a-z\d-]+\/(?:compose|scale)$/i.test(u.pathname)));
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
  function appleCatalogURL(doc, pageURL) {
    // Bootstrap supplies the current storefront and anonymous catalog configuration.
    // The hero's tall image is a separate asset from the catalog's posterArt.
    if (!appleTitleItems(doc, pageURL).length) return null;
    const entries = JSON.parse(doc.querySelector('#serialized-server-data').textContent).data || [];
    const config = entries.map(entry => entry?.data).find(data => data?.configureParams && data?.configuration);
    if (!config) return null;
    const { sfh, locale, caller, v, pfm } = config.configureParams;
    const utsk = config.configuration.utskProps?.utsk;
    if (!(Number(sfh) > 0) || !locale || !utsk) throw new Error('Apple TV catalog configuration is incomplete. Open a fresh source tab.');
    const type = new URL(pageURL).pathname.includes('/movie/') ? 'movies' : 'shows';
    const url = new URL(`https://uts-api.itunes.apple.com/uts/v3/${type}/${encodeURIComponent(titlePageId(pageURL))}`);
    for (const [key, value] of Object.entries({ sf: sfh, locale, caller: caller || 'web', v: v || '100', pfm: pfm || 'web', utsk })) {
      url.searchParams.set(key, value);
    }
    return url.href;
  }
  function appleCatalogPoster(data, pageURL) {
    const content = data.data?.content;
    if (content?.id !== titlePageId(pageURL)) throw new Error('Apple TV catalog returned a different title.');
    const art = content.images?.posterArt;
    if (!art?.url || !(art.width > 0 && art.height > art.width)) throw new Error('Apple TV has no cover poster for this title.');
    const url = art.url.replaceAll('{w}', art.width).replaceAll('{h}', art.height).replaceAll('{f}', 'jpg');
    if (!isImageURL(url)) throw new Error('Apple TV returned an unsupported poster URL.');
    return [{ title: content.title, url, variants: [url], orientation: 'portrait' }];
  }
  async function fetchApplePoster(doc, pageURL, request, signal) {
    checkCancelled(signal);
    const url = appleCatalogURL(doc, pageURL);
    if (!url) return extract(doc, pageURL, 'poster');
    const data = JSON.parse(await request(url, { signal, anonymous: true }));
    checkCancelled(signal);
    return appleCatalogPoster(data, pageURL);
  }
  function disneyTitleData(doc, pageURL) {
    const node = doc.querySelector('#__NEXT_DATA__');
    if (!node) return null;
    const data = JSON.parse(node.textContent), props = data.props?.pageProps;
    const id = titlePageId(pageURL);
    if (!props || (props.pageId || data.query?.slug) !== id) return null;
    // Only the top-level title sections; episodes, recommendations and offers have other images.
    const content = props.stitchDocument?.mainContent || [];
    const metadata = content.find(item => item._type === 'Metadata');
    return { hero: content.find(item => item._type === 'DetailEntityHero'),
      details: content.find(item => item._type === 'MediaDetails'), metadata,
      schema: metadata?.ldJSON?.['@graph']?.find(item => ['Movie', 'TVSeries'].includes(item['@type'])) };
  }
  function disneyOriginal(url) {
    if (!isImageURL(url) || new URL(url).hostname !== 'disney.images.edge.bamgrid.com') return null;
    const original = new URL(url);
    // Removing social-image crops restores the native portrait; removing size limits restores native pixels.
    for (const key of ['width', 'height', 'aspectRatio', 'max']) original.searchParams.delete(key);
    return original.href;
  }
  function disneyArtwork(doc, kind, pageURL) {
    const page = disneyTitleData(doc, pageURL);
    if (!page) return [];
    const title = page.details?.title || page.hero?.backgroundImage?.alt;
    let source;
    if (kind === 'backdrop') {
      const images = Object.values(page.hero?.backgroundImage || {}).filter(image => image?.source);
      source = images.sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.source;
    }
    const property = kind === 'poster' ? 'twitter:image' : 'og:image';
    source ||= page.metadata?.metaTags?.find(tag => tag.property === property || tag.name === property)?.content;
    const original = disneyOriginal(source);
    if (!original) return [];
    // Social thumbnails can be landscape crops of a portrait. Never use that crop as a poster fallback.
    const variants = kind === 'poster' ? [original] : [...new Set([original, source])];
    return [{ title, url: original, variants, orientation: kind === 'poster' ? 'portrait' : 'landscape' }];
  }
  function kanopyAPI(pageURL, webshopId = 9) {
    const source = manualSource(pageURL);
    if (source.provider !== 'Kanopy') throw new Error('Not a Kanopy title page.');
    const alias = titlePageId(source.url);
    return 'https://www.kanopy.com/kapi/videos/alias/' + encodeURIComponent(alias) + '?webshopId=' + encodeURIComponent(webshopId);
  }
  async function fetchKanopy(pageURL, kind, request, signal) {
    return kanopyArtwork(await kanopyData(pageURL, request, signal), kind, pageURL);
  }
  async function kanopyData(pageURL, request, signal) {
    // The public client performs this visitor handshake before reading metadata.
    // Keep the anonymous JWT in memory and send it only to Kanopy's API.
    const headers = { Accept: 'application/json', 'X-Version': 'web/undefined/undefined/undefined' };
    const session = JSON.parse(await request('https://www.kanopy.com/kapi/handshake', { signal, headers, anonymous: true }));
    if (typeof session.jwt !== 'string' || !session.jwt || !Number.isInteger(session.webshopId) || session.webshopId <= 0) {
      throw new Error('Kanopy visitor initialization failed. Open the source tab and try again.');
    }
    checkCancelled(signal);
    const data = JSON.parse(await request(kanopyAPI(pageURL, session.webshopId), {
      signal, anonymous: true, headers: { ...headers, Authorization: 'Bearer ' + session.jwt },
    }));
    checkCancelled(signal);
    return data;
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
    const unique = uniqueArtwork(assets);
    if (!unique.length) throw new Error(`Kanopy has no ${kind === 'backdrop' ? 'background' : 'poster'} artwork for this title.`);
    return unique;
  }
  function extract(doc, url, kind) {
    const extractor = { 'Disney+': disneyArtwork, 'Apple TV': appleArtwork }[provider(url)] || amazonArtwork;
    const unique = uniqueArtwork(extractor(doc, kind, url));
    if (!unique.length) throw new Error('No title artwork found. The page may require a challenge or sign-in.');
    return unique;
  }
  function pageImages(doc, pageURL) {
    const base = webURL(doc.querySelector('base[href]')?.getAttribute('href') || pageURL, pageURL) || pageURL;
    const urls = new Set();
    const add = value => {
      if (typeof value !== 'string' || !value.trim()) return;
      const url = webURL(value.trim(), base); if (url) urls.add(url);
    };
    const srcset = value => {
      // Consume URL tokens first: commas inside an URL are legal in srcset.
      let rest = value || '';
      while (rest.trim()) {
        rest = rest.replace(/^[\s,]+/, '');
        const token = rest.match(/^\S+/)?.[0]; if (!token) break;
        add(token.replace(/,+$/, '')); rest = rest.slice(token.length);
        if (!token.endsWith(',')) rest = rest.replace(/^[^,]*(?:,|$)/, '');
      }
    };
    for (const node of doc.querySelectorAll('img, picture source')) {
      for (const attr of ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-url']) add(node.getAttribute(attr));
      for (const attr of ['srcset', 'data-srcset', 'data-lazy-srcset']) srcset(node.getAttribute(attr));
    }
    for (const node of doc.querySelectorAll('meta[property], meta[name]')) {
      if (/^(?:og:image(?::(?:url|secure_url))?|twitter:image(?::src)?)$/i.test(node.getAttribute('property') || node.getAttribute('name'))) add(node.content);
    }
    for (const node of doc.querySelectorAll('link[rel="image_src"]')) add(node.getAttribute('href'));
    for (const node of doc.querySelectorAll('[style]')) {
      for (const declaration of node.getAttribute('style').split(';')) {
        if (!/^\s*background(?:-image)?\s*:/i.test(declaration)) continue;
        for (const match of declaration.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)/g)) add(match[1] || match[2] || match[3]);
      }
    }
    const imageValue = value => {
      if (typeof value === 'string') add(value);
      else if (Array.isArray(value)) value.forEach(imageValue);
      else if (value && typeof value === 'object') { add(value.url); add(value.contentUrl); }
    };
    const walk = value => {
      if (!value || typeof value !== 'object') return;
      if (value['@type'] === 'ImageObject') imageValue(value);
      for (const [key, item] of Object.entries(value)) {
        if (['image', 'thumbnailUrl', 'thumbnail', 'associatedMedia'].includes(key)) imageValue(item);
        if (item && typeof item === 'object') walk(item);
      }
    };
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try { walk(JSON.parse(script.textContent)); } catch (_) { /* Malformed structured data. */ }
    }
    return [...urls];
  }
  async function blobText(blob) {
    if (blob.text) return blob.text();
    return new Promise((resolve, reject) => {
      const reader = new root.FileReader(); reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Cannot read page response.')); reader.readAsText(blob);
    });
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
  function crossRequest(url, { json, blob = false, detailed = false, signal, anonymous = true, headers = {} } = {}) {
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
          const body = blob ? r.response : r.responseText;
          finish(resolve, detailed ? { body, contentType: r.responseHeaders?.match(/^content-type:\s*([^\r\n]+)/im)?.[1] || '', finalURL: r.finalUrl || url } : body);
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
      throw new Error('Cannot decode source image. The response may not be an image, or its format may be unsupported by your browser.');
    }
  }
  async function prepare(asset, config, signal, download = (url, signal) => crossRequest(url, { blob: true, signal })) {
    let best, lastError;
    for (const url of asset.variants) {
      if (!(asset.generic ? webURL(url) : isImageURL(url))) continue;
      try {
        const decoded = await decode(asset.blob && url === asset.url ? asset.blob : await download(url, signal));
        if ((asset.orientation === 'portrait' && decoded.width >= decoded.height) ||
          (asset.orientation === 'landscape' && decoded.width <= decoded.height)) {
          decoded.close(); throw new Error('The source does not provide artwork in the requested orientation.');
        }
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
    .dialog-header { display:grid; grid-template-columns:36px minmax(0,1fr) 36px; align-items:center; gap:16px; position:sticky; top:-22px; margin:-22px -22px 6px; padding:16px 22px 10px; background:#102435; z-index:1; }
    .dialog-header h2 { grid-column:2; margin:0; text-align:center; overflow-wrap:anywhere; }
    .icon-button { font-size:26px; line-height:1; width:36px; height:36px; padding:0; background:transparent; color:#bcd0df; }
    .back { grid-column:1; grid-row:1; } .close { grid-column:3; grid-row:1; }
    h2 { margin:0 0 14px; font-size:22px; } p { margin:10px 0; } a { color:#69d5fb; } label { display:inline-flex; gap:8px; align-items:center; }
    input,select { padding:7px; border:1px solid #7591a5; border-radius:4px; background:#fff; color:#122433; }
    .row { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin:12px 0; } .row input { flex:1; min-width:180px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(270px,100%),1fr)); gap:16px; }
    .artwork-grid { grid-template-columns:repeat(auto-fill,minmax(min(270px,100%),1fr)); align-items:start; }
    .card { padding:14px; border:1px solid #426279; border-radius:8px; overflow:hidden; }
    .artwork-heading { text-align:center; margin:0 0 14px; }
    .artwork-sources { display:flex; flex-wrap:wrap; gap:4px 12px; }
    .artwork-provider-name, .artwork-sources a { white-space:nowrap; }
    .artwork-footer { display:grid; gap:12px; margin-top:12px; padding-top:12px; border-top:1px solid #426279; }
    .artwork-language { display:grid; grid-template-columns:auto minmax(0,1fr); gap:12px; }
    .artwork-language input { width:100%; min-width:0; }
    .artwork-actions { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:stretch; gap:10px; }
    .artwork-actions button { padding:9px 10px; border:1px solid transparent; }
    .save-jpeg { display:flex; align-items:center; justify-content:center; padding:9px 10px; border:1px solid #426279; border-radius:6px; text-decoration:none; }
    .save-jpeg:hover { background:#19384d; border-color:#69d5fb; }
    @media (max-width:420px) { .artwork-actions { grid-template-columns:1fr; } }
    .exact-match { border-color:#648c7d; background:#16332f; } .match-label { display:block; color:#abcabb; font-size:12px; margin:4px 0; }
    details { margin-top:18px; } .google-section { grid-column:1/-1; }
    .google-heading { display:block; font-size:16px; margin-bottom:14px; }
    .google-card { display:flex; flex-direction:column; gap:8px; min-width:0; }
    .google-card strong { font-size:16px; line-height:1.4; overflow-wrap:anywhere; }
    .google-card p { margin:0; } .google-meta, .google-summary { color:#b3c5d3; font-size:13px; }
    .google-actions { display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; padding-top:12px; margin-top:auto; }
    .google-note { font-size:12px; color:#b3c5d3; } .google-summary { margin:12px 0 0; }
    img { display:block; width:100%; height:auto; }
    .artwork-image { display:block; position:relative; width:100%; padding:0; overflow:hidden; background:transparent; cursor:zoom-in; }
    .artwork-image:hover { background:transparent; }
    .artwork-image img { aspect-ratio:16/9; object-fit:cover; } .artwork-image.poster img { aspect-ratio:2/3; }
    .enlarge-icon { position:absolute; right:8px; bottom:8px; padding:2px 7px; border-radius:4px; background:#102435cc; font-size:20px; line-height:1.4; }
    .image-viewer { position:fixed; inset:0; z-index:2; display:flex; flex-direction:column; background:#07111af5; padding:16px; }
    .image-viewer .dialog-header { position:static; flex-shrink:0; margin:0 0 12px; padding:0; background:transparent; }
    .viewer-stage { flex:1; min-height:0; overflow:auto; display:flex; align-items:center; justify-content:center; }
    .viewer-stage img { width:auto; height:auto; max-width:100%; max-height:100%; flex-shrink:0; object-fit:contain; }
    .viewer-stage.actual-size { display:block; } .viewer-stage.actual-size img { max-width:none; max-height:none; margin:auto; }
    .viewer-controls { display:flex; justify-content:center; flex-shrink:0; padding-top:12px; }
    button:focus-visible { outline:2px solid #69d5fb; outline-offset:3px; }
    .error { color:#ffc5b8; } .status { white-space:pre-wrap; } .status:empty { display:none; }
  `;

  class App {
    constructor(target, deps = {}) {
      this.target = target;
      this.request = deps.request || tmdbRequest;
      this.cross = deps.cross || crossRequest;
      this.cache = deps.cache || new Cache();
      this.pending = new Map();
      this.assetPreviews = new WeakMap();
      this.decode = deps.decode || decode;
      this.prepare = deps.prepare || ((asset, config, signal) => prepare(asset, config, signal, (url, active) => this.download(url, active)));
      this.waf = deps.waf || waf;
      this.kind = 'backdrop';
      this.urls = [];
      this.jobs = [];
      this.busy = false;
      this.host = element('div', null, { id: 'tmdb-artwork' });
      this.host.style.cssText = 'position:relative;z-index:2147483646';
      this.shadow = this.host.attachShadow({ mode: 'open' });
      // Outside the shadow root, keyboard events appear to come from the host
      // div, so TMDB's shortcuts cannot recognize typing in our fields. Let
      // local handlers and native editing run, but keep these events off the page.
      for (const type of ['keydown', 'keypress', 'keyup']) {
        this.shadow.addEventListener(type, event => event.stopPropagation());
      }
      this.shadow.append(element('style', CSS));
      const toolbar = element('div', null, { class: 'toolbar' });
      toolbar.append(button('Fetch artwork', () => this.open()), button('Settings', () => this.settings()));
      this.shadow.append(toolbar); root.document.body.append(this.host);
      root.addEventListener('pagehide', () => this.cleanup(), { once: true });
    }
    async cached(key, signal, read) {
      checkCancelled(signal);
      const stored = this.cache.get(key);
      if (stored !== undefined) return stored;
      const existing = this.pending.get(key);
      if (existing?.signal === signal) return existing.promise;
      const entry = { signal };
      entry.promise = (async () => {
        const value = await read(); checkCancelled(signal);
        this.cache.set(key, value, signal); return value;
      })();
      this.pending.set(key, entry);
      try { return await entry.promise; }
      finally { if (this.pending.get(key) === entry) this.pending.delete(key); }
    }
    async download(url, signal) {
      checkCancelled(signal);
      const saved = this.cache.getBlob(url); if (saved) return saved;
      const blob = await this.cross(url, { blob: true, signal });
      checkCancelled(signal);
      // Decode before caching so error pages and unsupported files are retried.
      await this.imageDimensions(url, blob, signal);
      checkCancelled(signal);
      this.cache.setBlob(url, blob, signal); return blob;
    }
    async imageDimensions(url, blob, signal) {
      const image = await this.decode(blob);
      const dimensions = { width: image.width, height: image.height };
      image.close(); checkCancelled(signal);
      this.cache.set('dimensions:' + url, dimensions, signal);
      return dimensions;
    }
    async providerRecord(source, signal) {
      // Refresh Apple records that older versions cached with tall hero artwork as the poster.
      return this.cached((source.provider === 'Apple TV' ? 'provider:apple-poster-v2:' : 'provider:') + source.url, signal, async () => {
        const record = { artwork: {}, errors: {} };
        const data = source.provider === 'Kanopy' ? await kanopyData(source.url, this.cross, signal) :
          // Disney's public page supplies title artwork; an authenticated response can be only an app shell.
          parse(await this.cross(source.url, { signal, ...(source.provider === 'Disney+' ? { anonymous: true } : {}) }));
        checkCancelled(signal);
        for (const kind of ['backdrop', 'poster']) {
          try { record.artwork[kind] = source.provider === 'Kanopy' ? kanopyArtwork(data, kind, source.url) :
            source.provider === 'Apple TV' && kind === 'poster' ? await fetchApplePoster(data, source.url, this.cross, signal) : extract(data, source.url, kind); }
          catch (e) { record.errors[kind] = e.message; }
        }
        if (source.provider !== 'Kanopy') {
          try { record.metadata = providerMetadata(data, source.url); } catch (_) { /* Artwork can exist without readable metadata. */ }
        }
        if (!record.metadata && !Object.keys(record.artwork).length) throw new Error(record.errors.backdrop);
        return record;
      });
    }
    async genericPage(source, signal) {
      const response = await this.cross(source.url, { blob: true, detailed: true, signal });
      checkCancelled(signal);
      const { body, contentType, finalURL } = response;
      if (!webURL(finalURL)) throw new Error('Source redirected to an unsupported URL.');
      const type = contentType || body.type || '';
      if (!/html|xhtml/i.test(type)) {
        try {
          const decoded = await this.decode(body); decoded.close(); checkCancelled(signal);
          return { image: true, blob: body };
        } catch (e) { checkCancelled(signal); if (/^image\//i.test(type)) throw e; }
      }
      const doc = parse(await blobText(body));
      checkCancelled(signal);
      if (/just a moment|access denied|verify you are human|captcha/i.test(doc.title)) throw new Error('This page requires a browser challenge. Paste a direct image URL instead.');
      return { candidates: pageImages(doc, finalURL) };
    }
    async genericAssets(source, config, signal) {
      const key = 'page:' + source.url;
      const cachedPage = this.cache.get(key);
      const page = cachedPage || await this.genericPage(source, signal);
      checkCancelled(signal);
      if (page.image) {
        if (!cachedPage) {
          this.cache.setBlob(source.url, page.blob, signal);
          this.cache.set(key, { image: true }, signal);
        }
        return [{ url: source.url, variants: [source.url], generic: true, ...(page.blob ? { blob: page.blob } : {}) }];
      }
      let best;
      await forEachConcurrent(page.candidates, signal, async url => {
        try {
          const blob = await this.download(url, signal);
          const { width, height } = this.cache.get('dimensions:' + url) || await this.imageDimensions(url, blob, signal);
          checkCancelled(signal);
          if (!(config.kind === 'poster' ? height > width : width > height) || !cropPlan(width, height, config).valid) return;
          const area = width * height, difference = Math.abs(width / height - config.ratioWidth / config.ratioHeight);
          if (!best || area > best.area || (area === best.area && (difference < best.difference || (difference === best.difference && url < best.url)))) {
            best = { url, area, difference, blob };
          }
        } catch (_) { /* One failed candidate must not hide other images. */ }
      });
      checkCancelled(signal);
      if (!best) throw new Error('No suitable image found for this orientation and TMDB size limits. Paste a direct image URL instead.');
      if (!cachedPage) this.cache.set(key, page, signal);
      return [{ url: best.url, variants: [best.url], generic: true, blob: best.blob }];
    }
    cleanup() {
      this.closeImage(false);
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
      this.discovery = null; this.previewing = false;
      this.overlay?.remove();
      this.overlay = element('div', null, { class: 'overlay' });
      this.panel = element('div', null, { class: 'panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
      const header = element('div', null, { class: 'dialog-header' });
      this.backButton = button('←', () => this.back());
      this.backButton.className = 'icon-button back'; this.backButton.hidden = true;
      this.backButton.setAttribute('aria-label', 'Back to results'); this.backButton.title = 'Back to results';
      this.close = button('×', () => { if (!this.busy) { this.cleanup(); this.overlay.remove(); } });
      this.close.className = 'icon-button close'; this.close.setAttribute('aria-label', 'Close'); this.close.title = 'Close';
      header.append(this.backButton, element('h2', title), this.close);
      this.panel.append(header); this.overlay.append(this.panel); this.shadow.append(this.overlay);
      this.close.focus(); return true;
    }
    settings() {
      if (!this.shell('Artwork settings')) return;
      const input = element('input', null, { value: GM_getValue('regions', ['US']).join(', '), 'aria-label': 'JustWatch regions' });
      const status = element('p');
      this.panel.append(element('p', 'JustWatch countries, e.g. US, GB, PL. Searches combine the regions you enter.'), input,
        button('Save regions', () => { try { GM_setValue('regions', regions(input.value)); status.textContent = 'Settings saved.'; } catch (e) { status.textContent = e.message; } }),
        button('Clear cache', () => { this.cache.clear(); status.textContent = 'Cache cleared. Saved regions and links were kept.'; }), status);
    }
    open() {
      if (!this.shell(`Artwork · ${this.target.title}`)) return;
      this.kind = 'backdrop';
      this.discovery = element('div'); this.panel.append(this.discovery);
      const row = element('div', null, { class: 'row' });
      const query = element('input', null, { value: this.target.title, 'aria-label': 'Search title' });
      const search = button('Search', () => this.search(query.value));
      query.addEventListener('keydown', e => { if (e.key === 'Enter') this.search(query.value); });
      row.append(query, search, button('Search Google', () => this.manualGoogle(query.value))); this.discovery.append(row);
      this.status = element('p', '', { class: 'status', role: 'status' }); this.results = element('div', null, { class: 'grid' });
      this.discovery.append(this.status, this.results);
      this.directControls(query);
      this.search(this.target.title);
    }
    artworkButtons(title) {
      return ['backdrop', 'poster'].map(kind => {
        const control = button(kind === 'backdrop' ? 'Fetch background' : 'Fetch poster', () => this.fetchTitle(title, kind));
        control.disabled = !title.sources.length; return control;
      });
    }
    back() {
      if (this.busy || !this.previewing) return;
      this.newRequest(); this.previewing = false;
      this.backButton.hidden = true;
      this.preview.remove(); this.preview = null;
      this.discovery.hidden = false;
      this.results = this.searchView.results; this.status = this.searchView.status;
      // Interrupted Google searches can be explicitly retried without losing completed cards.
      for (const section of this.results.querySelectorAll('.google-section[data-complete="false"]')) {
        section.dataset.interrupted = 'true';
        section.querySelector('.google-states').textContent = 'Search paused. Click Search Google to retry.';
        for (const meta of section.querySelectorAll('.google-meta')) meta.textContent = meta.textContent.replace('Reading year…', 'Year unknown');
      }
      if (this.status.textContent === 'Searching JustWatch…') this.status.textContent = 'Search paused. Click Search to retry.';
      this.panel.scrollTop = this.searchView.scroll;
      this.searchView.focus?.focus({ preventScroll: true });
    }
    manualGoogle(query) {
      if (this.busy || this.previewing) return;
      return this.googleSearch(query, this.controller.signal, this.results);
    }
    directControls(query) {
      const section = element('details'); section.append(element('summary', 'Find or paste an image or webpage URL'));
      section.append(element('p', 'Paste a provider page, direct image, or webpage. Webpages use the largest suitable image found in their HTML.'));
      const links = element('div', null, { class: 'row' });
      const refreshLinks = () => {
        links.replaceChildren(...discoveryLinks(query.value || this.target.title, this.target).map(([text, url]) => link(text, url)));
      };
      query.addEventListener('input', refreshLinks); refreshLinks(); section.append(links);
      const input = element('input', null, { type: 'url', placeholder: 'https://… image or webpage URL', 'aria-label': 'Image or webpage URL' });
      const kind = element('select', null, { 'aria-label': 'Artwork type' });
      kind.append(element('option', 'Background', { value: 'backdrop' }), element('option', 'Poster', { value: 'poster' }));
      kind.addEventListener('change', () => { this.kind = kind.value; }); this.directKind = kind;
      const row = element('div', null, { class: 'row' }); const state = element('p', '', { role: 'status' });
      const key = `direct-sources:${this.target.type}:${this.target.id}`;
      const saved = element('div', null, { class: 'row' });
      const renderSaved = () => {
        saved.replaceChildren();
        for (const url of GM_getValue(key, [])) {
          let source;
          try { source = manualSource(url); } catch (_) { continue; }
          const card = element('div', null, { class: 'card' });
          const actions = element('div', null, { class: 'row' }); actions.append(...this.artworkButtons({ sources: [source] }));
          card.append(link(`Saved ${source.provider} link`, source.url), actions); saved.append(card);
        }
      };
      const fetch = () => {
        if (this.busy) return;
        try {
          const source = manualSource(input.value);
          const urls = [...new Set([...GM_getValue(key, []), source.url])].slice(-10);
          GM_setValue(key, urls); renderSaved(); state.textContent = '';
          this.fetchTitle({ sources: [source] }, kind.value);
        } catch (e) { state.textContent = e.message; }
      };
      row.append(input, kind, button('Fetch from URL', fetch)); input.addEventListener('keydown', e => { if (e.key === 'Enter') fetch(); });
      section.append(row, state, saved, button('Forget saved links', () => { if (!this.busy) { GM_deleteValue(key); renderSaved(); } }));
      renderSaved(); if (saved.childElementCount) section.open = true;
      (this.discovery || this.panel).append(section);
    }
    async search(query) {
      if (this.busy || this.previewing) return;
      const signal = this.newRequest();
      const { results, status } = this;
      results.replaceChildren();
      status.textContent = 'Searching JustWatch…';
      const responses = [], errors = [];
      const countries = GM_getValue('regions', ['US']);
      await Promise.all(countries.map(async country => {
        try {
          const json = await this.cached('justwatch:' + JSON.stringify([query, country, 'en']), signal, async () => {
            const data = JSON.parse(await this.cross('https://apis.justwatch.com/graphql', { signal,
              json: { operationName: 'GetSearchResults', query: QUERY, variables: { country, language: 'en', first: 10, searchQuery: query, location: 'SearchSuggester' } } }));
            if (data.errors?.length) throw new Error(data.errors.map(x => x.message).join('; '));
            if (!Array.isArray(data.data?.searchTitles?.edges)) throw new Error('Invalid JustWatch response.');
            return data;
          });
          responses.push({ country, data: json });
        } catch (e) { errors.push(`${country}: ${e.message}`); }
      }));
      if (signal.aborted) return;
      const titles = searchResults(responses, this.target);
      status.textContent = `${titles.length ? 'Choose the matching title. Provider years can differ.' : 'No matches. Edit the title, change regions, or use a provider URL below.'}${errors.length ? '\n' + errors.join('\n') : ''}`;
      for (const title of titles) {
        const card = this.titleCard(title);
        card.append(element('strong', `${title.title} (${title.year || 'year unknown'})`), element('p', `${title.type} · ${title.countries.join(', ')} · ${title.sources.length} provider pages`));
        const actions = element('div', null, { class: 'row' }); actions.append(...this.artworkButtons(title));
        card.append(actions); results.append(card);
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
        card.dataset.source = key;
        card.dataset.enriched = 'false';
        const heading = element('strong', cleanGoogleTitle(title.title));
        const badge = element('span', 'Title & year match', { class: 'match-label' }); badge.hidden = true;
        const region = source.provider === 'Apple TV' ? new URL(source.url).pathname.split('/')[1].toUpperCase() : '';
        const providerLine = [source.provider, region].filter(Boolean).join(' · ');
        const meta = element('p', providerLine + ' · Reading year…', { class: 'google-meta' });
        const note = element('p', '', { class: 'google-note' }); note.hidden = true;
        const actions = element('div', null, { class: 'google-actions' });
        actions.append(link('View provider page', source.url), ...this.artworkButtons(title));
        card.append(heading, badge, meta, note, actions);
        container.append(card);
        pending.push(async () => {
          try {
            const record = await this.providerRecord(source, signal);
            if (signal.aborted) return;
            const metadata = record.metadata;
            if (!metadata) throw new Error('Provider details unavailable.');
            Object.assign(title, metadata); heading.textContent = metadata.title;
            meta.textContent = [providerLine, metadata.type, metadata.year || 'Year unknown'].filter(Boolean).join(' · ');
            const matched = exactMatch(metadata, this.target);
            card.classList.toggle('exact-match', matched); badge.hidden = !matched;
            card.dataset.enriched = 'true';
          } catch (_) {
            if (signal.aborted) return;
            meta.textContent = providerLine + ' · Year unknown';
            note.textContent = 'Could not read provider details. Open the page to check.'; note.hidden = false;
          }
        });
      }
      summary.textContent = `${seen.size} provider ${seen.size === 1 ? 'page' : 'pages'} found`;
      // Bound metadata traffic; a blocked provider never discards another card.
      await forEachConcurrent(pending, signal, read => read());
    }
    async googleSearch(query, signal, results) {
      if (signal.aborted) return;
      let section = [...results.querySelectorAll('.google-section')].find(node => node.dataset.query === query);
      if (section && section.dataset.interrupted !== 'true') return;
      if (!section) {
        section = element('div', null, { class: 'card google-section' }); section.dataset.query = query;
        section.append(element('strong', 'Google Search results', { class: 'google-heading' }), element('div', null, { class: 'grid' }),
          element('div', null, { class: 'google-states' }), element('p', '0 provider pages found', { class: 'google-summary', role: 'status' }));
        results.append(section);
      }
      section.searchController?.abort();
      const parentSignal = signal, controller = new root.AbortController();
      section.searchController = controller;
      const cancel = () => controller.abort();
      parentSignal.addEventListener('abort', cancel, { once: true });
      controller.signal.addEventListener('abort', () => parentSignal.removeEventListener('abort', cancel), { once: true });
      signal = controller.signal;
      section.dataset.complete = 'false'; section.dataset.interrupted = 'false';
      const grid = section.querySelector('.grid'), states = section.querySelector('.google-states'), summary = section.querySelector('.google-summary');
      for (const card of grid.querySelectorAll('[data-enriched="false"]')) card.remove();
      states.replaceChildren();
      const context = { seen: new Set([...grid.querySelectorAll('.google-card')].map(card => card.dataset.source)), signal, summary };
      await Promise.all(googleQueries(query).map(async url => {
        const state = element('p', 'Searching Google…'); states.append(state);
        try {
          const titles = await this.cached('google:' + this.target.type + ':' + url, signal, async () => {
            const html = await this.cross(url, { signal });
            const found = googleResults(parse(html), this.target.type);
            if (!found.length) throw new Error('No readable provider results. Google may require JavaScript, consent, or a challenge.');
            return found;
          });
          if (signal.aborted) return;
          await this.renderGoogle(titles, grid, context);
          if (signal.aborted) return;
          state.remove();
        } catch (e) {
          if (signal.aborted) return;
          this.googleTab(url, grid, context, signal, state, e.message);
        }
      }));
      if (!signal.aborted) section.dataset.complete = String(!states.childElementCount);
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
        signal.removeEventListener('abort', finish);
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
            if (source.generic || !['Amazon', 'Apple TV', 'Disney+'].includes(source.provider)) throw new Error('Unsupported Google result.');
            source.countries = ['Google'];
            return { title: String(item.title).slice(0, 300), sources: [source] };
          });
          if (titles.length) this.cache.set('google:' + this.target.type + ':' + url, titles, signal);
          await this.renderGoogle(titles, grid, context);
          if (signal.aborted) return;
          state.remove();
          const section = grid.closest('.google-section');
          if (section && !signal.aborted) section.dataset.complete = String(!section.querySelector('.google-states').childElementCount);
        } catch (e) {
          if (!signal.aborted) { state.textContent = e.message; grid.closest('.google-section').dataset.interrupted = 'true'; }
        }
      });
      state.textContent = `${query}: Searching in a background tab…`;
      record.attentionTimer = root.setTimeout(() => attention('No results received yet. Google may require consent or a challenge, or have no matching pages. ' + initialError), 20000);
      record.timer = root.setTimeout(() => {
        state.textContent = `${query}: Search expired. Run the search again to retry.`;
        grid.closest('.google-section').dataset.interrupted = 'true'; finish();
      }, TTL);
      signal.addEventListener('abort', finish, { once: true });
      openTab(false);
    }
    async config(signal, kind = this.kind) {
      const html = await this.request(`${this.target.path}/images/${kind === 'backdrop' ? 'backdrops' : 'posters'}/upload`, { signal });
      return uploadConfig(parse(html), kind, this.target);
    }
    async fetchTitle(title, kind = this.kind) {
      if (this.busy) return;
      if (this.previewing) this.back();
      this.kind = kind;
      if (this.directKind) this.directKind.value = kind;
      const signal = this.newRequest();
      if (!this.discovery) {
        this.discovery = element('div'); this.panel.append(this.discovery);
        this.discovery.append(this.status, this.results);
      }
      this.searchView = { results: this.results, status: this.status, scroll: this.panel.scrollTop, focus: this.shadow.activeElement };
      this.discovery.hidden = true; this.previewing = true;
      this.preview = element('div');
      this.results = element('div', null, { class: 'grid artwork-grid' }); this.status = element('p', '', { class: 'status', role: 'status' });
      this.backButton.hidden = false;
      this.preview.append(element('h3', kind === 'poster' ? 'Poster' : 'Background', { class: 'artwork-heading' }), this.status, this.results);
      this.panel.append(this.preview); this.panel.scrollTop = 0;
      this.backButton.focus({ preventScroll: true });
      const { results, status } = this;
      status.textContent = 'Reading TMDB image limits…';
      let config;
      try {
        config = await this.config(signal, kind);
      } catch (e) {
        if (!signal.aborted) status.textContent = e.message;
        return;
      }
      if (signal.aborted) return;
      status.textContent = '';
      for (const source of title.sources) {
        if (signal.aborted) return;
        const card = element('div', null, { class: 'card' });
        this.addArtworkSource(card, source); results.append(card);
        const state = element('p', 'Loading…'); card.append(state);
        try {
          let assets;
          if (source.generic) {
            assets = await this.genericAssets(source, config, signal);
          } else {
            const record = await this.providerRecord(source, signal);
            assets = record.artwork[kind];
            if (!assets) throw new Error(record.errors[kind] || 'No artwork available.');
          }
          await this.addAssets(assets, source, card, config, signal);
          state.remove();
        } catch (e) {
          if (signal.aborted) return;
          state.textContent = e.message; state.className = 'error';
          if (source.generic) card.append(link('Open source page', source.url), element('p', 'Try pasting a direct image URL. Pages that require JavaScript are not rendered automatically.'));
          else card.append(button('Open source tab', event => this.sourceTab(source, card, config, signal, event.currentTarget)));
        }
      }
    }
    addArtworkSource(card, source) {
      if (!source.url) return;
      let sources = card.querySelector('.artwork-sources');
      if (!sources) {
        sources = element('div', null, { class: 'artwork-sources' }); card.prepend(sources);
      }
      let group = [...sources.querySelectorAll('.artwork-provider')].find(item => item.dataset.provider === source.provider);
      if (!group) {
        group = element('span', null, { class: 'artwork-provider', 'data-provider': source.provider });
        group.append(element('span', source.provider, { class: 'artwork-provider-name' })); sources.append(group);
      }
      for (const region of source.countries?.length ? source.countries : ['Source']) {
        if ([...group.querySelectorAll('a')].some(item => item.href === source.url && item.textContent === region)) continue;
        const regionLink = link(region, source.url);
        regionLink.title = `${source.provider} · ${region}`;
        regionLink.setAttribute('aria-label', regionLink.title);
        group.append(' · ', regionLink);
      }
    }
    async addAssets(assets, source, card, config, signal) {
      let previews = this.assetPreviews.get(signal);
      if (!previews) { previews = new Map(); this.assetPreviews.set(signal, previews); }
      for (const asset of assets) {
        if (signal.aborted) return;
        const key = JSON.stringify([config.kind, asset.url || asset.variants[0]]);
        const existing = previews.get(key);
        if (existing) {
          await existing.prepared;
          if (signal.aborted) return;
          this.addArtworkSource(existing.card, source);
          continue;
        }
        // Reserve the URL before preparing so overlapping source helpers share the same work.
        const entry = { card, prepared: this.prepare(asset, config, signal) }; previews.set(key, entry);
        let prepared;
        try { prepared = await entry.prepared; checkCancelled(signal); }
        catch (error) { previews.delete(key); throw error; }
        this.addArtworkSource(card, source);
        const url = root.URL.createObjectURL(prepared.blob); this.urls.push(url);
        const block = element('div');
        const title = asset.title || this.target.title;
        const img = element('img', null, { src: url, alt: title, width: prepared.crop.width, height: prepared.crop.height });
        const enlarge = button(null, () => this.showImage(url, title, prepared.crop, enlarge));
        enlarge.className = 'artwork-image' + (config.kind === 'poster' ? ' poster' : '');
        enlarge.setAttribute('aria-label', `Enlarge ${title}`); enlarge.title = 'Enlarge image';
        enlarge.append(img, element('span', '⤢', { class: 'enlarge-icon', 'aria-hidden': 'true' }));
        block.append(element('p', title), enlarge,
          element('p', `${prepared.sourceWidth}×${prepared.sourceHeight} → JPEG ${prepared.crop.width}×${prepared.crop.height} · ${(prepared.blob.size / 1024).toFixed(0)} KB`));
        if (config.kind === 'poster' && prepared.sourceWidth >= prepared.sourceHeight) {
          block.append(element('p', 'This provider artwork is landscape. The poster crop removes the sides; check that titles and faces remain intact.', { class: 'error' }));
        }
        const language = element('input', null, { value: config.kind === 'backdrop' ? 'xx-XX' : 'en-US', list: 'artwork-languages', 'aria-label': 'Language' });
        const label = element('label', 'Language', { class: 'artwork-language' }); label.append(language);
        if (!this.panel.querySelector('#artwork-languages')) {
          const list = element('datalist', null, { id: 'artwork-languages' });
          for (const [value, text] of [['xx-XX', 'No language'], ['en-US', 'English'], ['en-GB', 'English (UK)'], ['pl-PL', 'Polish'], ['de-DE', 'German'], ['fr-FR', 'French'], ['es-ES', 'Spanish'], ['it-IT', 'Italian'], ['ja-JP', 'Japanese']]) list.append(element('option', text, { value }));
          this.panel.append(list);
        }
        const name = filename(this.target, config.kind);
        const footer = element('div', null, { class: 'artwork-footer' });
        const row = element('div', null, { class: 'artwork-actions' });
        const save = link('Save JPEG', url); save.setAttribute('download', name); save.className = 'save-jpeg';
        const upload = button('Upload this image', () => this.upload(prepared, name, language.value, config, block, upload));
        row.append(upload, save); footer.append(label, row); block.append(footer); card.append(block);
      }
      if (!card.querySelector('.artwork-image')) card.remove();
    }
    showImage(url, title, dimensions, trigger) {
      if (this.busy) return;
      this.closeImage(false);
      this.imageTrigger = trigger;
      this.viewer = element('div', null, { class: 'image-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Image preview · ${title}` });
      const header = element('div', null, { class: 'dialog-header' });
      const close = button('×', () => this.closeImage());
      close.className = 'icon-button close'; close.setAttribute('aria-label', 'Close image preview'); close.title = 'Close image preview';
      header.append(element('h2', title), close);
      const stage = element('div', null, { class: 'viewer-stage', tabindex: '0', 'aria-label': 'Image preview; scroll to inspect at 100%' });
      const img = element('img', null, { src: url, alt: title, width: dimensions.width, height: dimensions.height });
      stage.append(img);
      const zoom = button('View at 100%', () => {
        const actual = stage.classList.toggle('actual-size');
        zoom.textContent = actual ? 'Fit to screen' : 'View at 100%';
        zoom.setAttribute('aria-pressed', String(actual));
        stage.scrollTop = 0; stage.scrollLeft = 0;
      });
      zoom.setAttribute('aria-pressed', 'false');
      const controls = element('div', null, { class: 'viewer-controls' }); controls.append(zoom);
      this.viewer.append(header, stage, controls);
      this.viewer.addEventListener('click', event => { if (event.target === stage || event.target === this.viewer) this.closeImage(); });
      this.viewer.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); this.closeImage(); }
        if (event.key === 'Tab') {
          const controls = [close, stage, zoom];
          const index = controls.indexOf(this.shadow.activeElement);
          event.preventDefault(); controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
        }
      });
      this.panel.inert = true; this.panel.setAttribute('aria-hidden', 'true');
      this.overlay.append(this.viewer); close.focus({ preventScroll: true });
    }
    closeImage(restoreFocus = true) {
      if (!this.viewer) return;
      this.viewer.remove(); this.viewer = null;
      this.panel.inert = false; this.panel.removeAttribute('aria-hidden');
      if (restoreFocus && this.imageTrigger?.isConnected) this.imageTrigger.focus({ preventScroll: true });
      this.imageTrigger = null;
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
    languageRetry(id, value, mediaId, state, kind) {
      const retry = button('Retry language only', async () => {
        if (this.busy) return;
        this.lock(true);
        try {
          const config = await this.config(undefined, kind);
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
        const config = await this.config(undefined, originalConfig.kind);
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
          block.append(this.languageRetry(result.id, language, config.mediaId, state, config.kind));
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
      const job = { id, url: source.url, kind: config.kind, expires: Date.now() + TTL, state: 'waiting' };
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
      const tab = GM_openInTab(url.href, { active: true, insert: true, setParent: true });
      card.append(element('p', 'In the source tab, resolve any challenge and click “Send artwork to TMDB”. This request expires in 10 minutes.'));
      const timer = root.setTimeout(() => { if (!signal.aborted) { GM_removeValueChangeListener(listener); GM_deleteValue(key); opener.disabled = false; } }, TTL);
      this.jobs.push({ id, listener, timer, tab });
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
        } else if (provider(root.location.href) === 'Apple TV' && job.kind === 'poster') {
          assets = await fetchApplePoster(root.document, root.location.href, crossRequest, root.AbortSignal.timeout(30000));
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
  const api = { QUERY, Cache, pageImages, webURL, regions, targetFromPage, exactMatch, provider, canonicalProvider, searchResults, amazonVariants,
    amazonArtwork, appleArtwork, appleCatalogURL, appleCatalogPoster, fetchApplePoster, disneyArtwork, kanopyAPI, kanopyArtwork, fetchKanopy, manualSource, discoveryLinks, googleQueries, googleResults, cleanGoogleTitle, providerMetadata, crossRequest, extract, uploadConfig, cropPlan, filename, multipart, uploadResult, prepare, App, helper, start };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else start();
})(globalThis);
