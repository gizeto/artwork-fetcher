const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const source = fs.readFileSync(path.join(__dirname, '../artwork-fetcher.user.js'), 'utf8');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function environment(t, html = '', url = 'https://www.themoviedb.org/movie/1508520-four-birds') {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const w = dom.window, stored = new Map(), objectURLs = new Map();
  t.after(() => w.close());
  w.module = { exports: {} };
  w.GM_getValue = (key, fallback) => stored.has(key) ? stored.get(key) : fallback;
  w.GM_setValue = (key, value) => stored.set(key, value);
  w.GM_deleteValue = key => stored.delete(key);
  w.GM_listValues = () => [...stored.keys()];
  w.GM_addValueChangeListener = () => 1;
  w.GM_removeValueChangeListener = () => {};
  w.GM_openInTab = () => ({ close() {} });
  w.URL.createObjectURL = blob => { const key = 'blob:test-' + objectURLs.size; objectURLs.set(key, blob); return key; };
  w.URL.revokeObjectURL = key => objectURLs.delete(key);
  w.eval(source);
  return { w, api: w.module.exports, stored, objectURLs, doc: html => new w.DOMParser().parseFromString(html, 'text/html') };
}

test('detect movie/series pages and galleries; exclude seasons, episodes and unrelated routes', t => {
  const { api, doc } = environment(t);
  for (const [file, route, title, type] of [
    ['movie-poster-page.html', '/movie/1508520-four-birds', 'Four Birds', 'movie'],
    ['tv-poster-page.html', '/tv/95350-lanterns/images/posters', 'Lanterns', 'tv'],
  ]) {
    const target = api.targetFromPage(doc(fixture(file)), 'https://www.themoviedb.org' + route);
    assert.equal(target.title, title); assert.equal(target.year, '2026'); assert.equal(target.type, type);
  }
  for (const route of ['/tv/95350/season/1', '/tv/95350/season/1/episode/2', '/movie/1/edit', '/movie/popular']) {
    assert.equal(api.targetFromPage(doc(fixture('tv-poster-page.html')), 'https://www.themoviedb.org' + route), null);
  }
});

test('regions, title matching, year differences, and provider deduplication', t => {
  const { api } = environment(t);
  assert.deepEqual(Array.from(api.regions('us, gb US;pl')), ['US', 'GB', 'PL']);
  assert.throws(() => api.regions('USA'), /country codes/);
  const data = JSON.parse(fixture('justwatch.json'));
  const target = { title: 'Flatball: A History of Ultimate', year: '2017', type: 'movie' };
  const results = api.searchResults([{ country: 'GB', data }, { country: 'US', data }], target);
  assert.equal(results[0].title, target.title);
  assert.equal(results[0].year, 2016);
  assert.equal(results[0].sources.length, 1);
  assert.deepEqual(Array.from(results[0].sources[0].countries), ['GB', 'US']);
  assert.equal(results[0].sources[0].provider, 'Apple TV');
  assert.equal(api.provider('https://amazon.com.evil.test/image'), null);
  assert.equal(api.provider('http://www.amazon.com/title'), null);
  const gti = 'amzn1.dv.gti.a26036c4-8a27-41bf-9fb2-88093572a369';
  assert.equal(api.canonicalProvider('https://watch.amazon.com/detail?gti=' + gti), 'https://www.amazon.com/gp/video/detail/' + gti);
  const shows = api.searchResults([{ country: 'GB', data }], { ...target, type: 'tv' });
  assert.ok(shows.length > 0); assert.ok(shows.every(item => item.type === 'SHOW'));
  const offers = [{ presentationType: 'DVD', standardWebURL: 'https://www.amazon.com/dp/DISC' },
    { presentationType: 'HD', standardWebURL: 'https://watch.amazon.com/detail?gti=' + gti },
    { presentationType: 'HD', standardWebURL: 'https://tv.apple.com/us' }];
  const streaming = api.searchResults([{ country: 'US', data: { data: { searchTitles: { edges: [
    { node: { id: 'show1', objectType: 'SHOW', content: { title: 'The Expanse', originalReleaseYear: 2015 }, offers } },
  ] } } } }], { type: 'tv', title: 'The Expanse' });
  assert.equal(streaming[0].sources.length, 1); assert.match(streaming[0].sources[0].url, /gp\/video\/detail\/amzn1/);
});

test('Amazon uses current-title hero and packshot, never recommendations', t => {
  const { api, doc } = environment(t);
  const page = doc(fixture('amazon.html'));
  const hero = api.amazonArtwork(page, 'backdrop'); const poster = api.amazonArtwork(page, 'poster');
  assert.equal(hero.length, 1); assert.equal(poster.length, 1);
  assert.match(hero[0].url, /dfa97464729/); assert.match(poster[0].url, /a4feac61b151/);
  assert.match(hero[0].variants[1], /\._SX4096_FMavif_PQ100_\.jpg$/);
  const fallback = api.amazonArtwork(doc('<div data-automation-id="hero-background"><img src="https://m.media-amazon.com/images/S/pv-target-images/test._SX1080_FMjpg_.jpg" alt="Hero"></div><img src="https://m.media-amazon.com/WRONG.jpg">'), 'backdrop');
  assert.equal(fallback.length, 1); assert.match(fallback[0].variants[0], /test\.jpg$/);
  assert.equal(api.amazonVariants('https://m.media-amazon.com/test.png')[0], 'https://m.media-amazon.com/test.png');
});

test('Apple selects the main title artwork and resolves native dimensions', t => {
  const { api, doc } = environment(t);
  const url = 'https://tv.apple.com/gb/movie/flatball---a-history-of-ultimate/umc.cmc.drnve62utn2ny5vtx4jlq8e6';
  const hero = api.appleArtwork(doc(fixture('apple.html')), 'backdrop', url);
  const poster = api.appleArtwork(doc(fixture('apple.html')), 'poster', url);
  assert.equal(hero.length, 1); assert.match(hero[0].url, /1920x1080\.jpg$/);
  assert.equal(poster.length, 1); assert.match(poster[0].url, /2000x3000\.jpg$/);
  assert.equal(api.appleArtwork(doc(fixture('apple.html')), 'poster', url + '-wrong').length, 0);
});

test('Apple title selection tolerates trailing slashes without selecting another title', t => {
  const { api, doc } = environment(t);
  const page = doc(fixture('apple.html'));
  const script = page.querySelector('#serialized-server-data');
  const data = JSON.parse(script.textContent);
  const canonical = new URL(data.data[0].data.canonicalURL);
  const titleURL = canonical.origin + canonical.pathname;

  for (const canonicalSuffix of ['', '/']) {
    data.data[0].data.canonicalURL = titleURL + canonicalSuffix;
    script.textContent = JSON.stringify(data);
    for (const requestedSuffix of ['', '/']) {
      const url = titleURL + requestedSuffix;
      assert.equal(api.appleArtwork(page, 'poster', url).length, 1);
      assert.equal(api.providerMetadata(page, url).title, 'Flatball - A History of Ultimate');
    }
    assert.equal(api.appleArtwork(page, 'poster', titleURL + '-wrong/').length, 0);
    assert.throws(() => api.providerMetadata(page, titleURL + '-wrong/'), /unavailable/);
  }
});

test('Kanopy unwraps native images and selects only the requested title and artwork kind', t => {
  const { api } = environment(t);
  const url = 'https://www.kanopy.com/en/product/justwatch-16504352?utm_source=justwatch';
  const data = JSON.parse(fixture('kanopy.json'));
  assert.equal(api.provider(url), 'Kanopy');
  assert.equal(api.kanopyAPI(url), 'https://www.kanopy.com/kapi/videos/alias/justwatch-16504352?webshopId=9');
  for (const [kind, hash] of [['backdrop', '6d67aec6-e51b'], ['poster', 'f09ff003-8d56']]) {
    const assets = api.kanopyArtwork(data, kind, url);
    assert.equal(assets.length, 1); assert.equal(assets[0].title, 'Travel Socks');
    assert.match(assets[0].url, new RegExp('^https://static-assets.kanopy.com/video-images/' + hash));
    assert.equal(assets[0].variants.length, 1); assert.doesNotMatch(assets[0].url, /width=|height=|cdn-cgi/);
  }
  assert.throws(() => api.kanopyArtwork(data, 'poster', url.replace('16504352', '99999999')), /matching title/);
  data.video.images.posters = { large: 'https://attacker.test/untrusted.jpeg' };
  assert.throws(() => api.kanopyArtwork(data, 'poster', url), /no poster artwork/);
  const node = { id: 'kanopy1', objectType: 'MOVIE', content: { title: 'Travel Socks', originalReleaseYear: 2024 },
    offers: [{ presentationType: 'HD', standardWebURL: url }] };
  const titles = api.searchResults([{ country: 'US', data: { data: { searchTitles: { edges: [{ node }] } } } }], { type: 'movie', title: 'Travel Socks' });
  assert.equal(titles[0].sources[0].provider, 'Kanopy');
});

test('direct unavailable-title URLs work without JustWatch and reject unrelated destinations', t => {
  const { api, doc } = environment(t);
  const prime = api.manualSource(' https://www.primevideo.com/-/de/detail/0ISBAPQV85YPX8VRKEZT6I3WMC, ');
  assert.equal(prime.url, 'https://www.primevideo.com/-/de/detail/0ISBAPQV85YPX8VRKEZT6I3WMC');
  const url = 'https://tv.apple.com/us/movie/bigfoot-i-love-you/umc.cmc.70td6qpxeljnbp2jd9425btiw';
  assert.equal(api.manualSource(url).provider, 'Apple TV');
  const assets = api.appleArtwork(doc(fixture('apple-unavailable.html')), 'backdrop', url);
  assert.equal(assets.length, 1); assert.equal(assets[0].title, 'Bigfoot, I Love You');
  assert.match(assets[0].url, /1920x1080\.jpg$/);
  const config = api.uploadConfig(doc(fixture('movie-poster.html')), 'poster', { type: 'movie' });
  assert.equal(api.cropPlan(400, 574, config).valid, false);
  for (const bad of ['https://attacker.test/movie/1', 'https://tv.apple.com/us/search?term=test', 'https://www.kanopy.com/kapi/videos/1', 'https://user:password@tv.apple.com/us/movie/test/umc.cmc.123']) {
    assert.throws(() => api.manualSource(bad));
  }
  const links = api.discoveryLinks('Bigfoot, I Love You', 'GB');
  assert.match(links[0][1], /^https:\/\/tv.apple.com\/gb\/search\?term=/);
  assert.ok(links.some(([text]) => text === 'Find indexed Amazon pages'));
});

test('all captured TMDB upload forms provide tokens, media types and image limits', t => {
  const { api, doc } = environment(t);
  for (const [name, type, kind, max] of [
    ['movie-poster', 'movie', 'poster', 2000], ['tv-poster', 'tv', 'poster', 2000], ['tv-backdrop', 'tv', 'backdrop', 3840],
  ]) {
    const c = api.uploadConfig(doc(fixture(name + '.html')), kind, { type });
    assert.equal(c.token, 'fixture-token'); assert.equal(c.maxWidth, max);
    assert.equal(c.mediaType, type === 'tv' ? 'TvSeries' : 'Movie');
  }
  assert.throws(() => api.uploadConfig(doc('<p>Sign in</p>'), 'poster', { type: 'movie' }), /Sign in/);
  assert.throws(() => api.uploadConfig(doc(fixture('tv-poster.html')), 'poster', { type: 'movie' }), /unexpected/);
  const incomplete = doc(fixture('movie-poster.html'));
  incomplete.querySelector('.image_cropper').removeAttribute('data-aspect-ratio');
  assert.throws(() => api.uploadConfig(incomplete, 'poster', { type: 'movie' }), /missing required settings/);
});

test('center cropping respects maximum size, exact ratio and no upscaling', t => {
  const { api, doc } = environment(t);
  const c = api.uploadConfig(doc(fixture('tv-backdrop.html')), 'backdrop', { type: 'tv' });
  const p = api.cropPlan(4096, 2304, c);
  assert.equal(p.width, 3840); assert.equal(p.height, 2160); assert.equal(p.valid, true);
  const square = api.cropPlan(2000, 2000, c);
  assert.equal(square.x, 0); assert.equal(square.y, 437.5); assert.equal(square.width / square.height, 16 / 9);
  const small = api.cropPlan(640, 480, c);
  assert.equal(small.valid, false); assert.equal(small.width, 640);
});

test('multipart uses a JPEG file and the captured field names; response parses safely', t => {
  const { api, w, doc } = environment(t);
  const c = api.uploadConfig(doc(fixture('movie-poster.html')), 'poster', { type: 'movie' });
  const form = api.multipart(new w.Blob(['jpeg'], { type: 'image/jpeg' }), 'poster.jpg', c);
  assert.equal(form.get('upload_files').name, 'poster.jpg');
  assert.equal(form.get('upload_files').type, 'image/jpeg');
  assert.equal(form.get('media_type'), 'Movie'); assert.equal(form.get('authenticity_token'), 'fixture-token');
  assert.equal(form.get('crop_area'), ''); assert.equal(form.get('translate'), 'false');
  const result = api.uploadResult(JSON.parse(fixture('upload-response.json')));
  assert.equal(result.id, '6aa570adad664af83832f79d'); assert.equal(result.processing, true);
  assert.throws(() => api.uploadResult({ success: false, message: 'Duplicate image' }), /Duplicate/);
  assert.equal(api.uploadResult({ success: true, html: '<script>bad()</script>' }).id, null);
  assert.match(api.filename({ title: 'A / Title: Ünicode', year: '2020' }, 'poster'), /^\d+_a-title-ünicode-2020_poster\.jpg$/);
});

function mockApp(t, customRequest) {
  const env = environment(t, fixture('movie-poster-page.html'));
  const { api, w } = env; const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (customRequest) { const custom = await customRequest(url, options); if (custom !== undefined) return custom; }
    if (url.endsWith('/upload')) return fixture('movie-poster.html');
    if (url === '/image') return JSON.parse(fixture('upload-response.json'));
    return { success: true };
  };
  const target = api.targetFromPage(w.document, w.location.href);
  const app = new api.App(target, { request, waf: async () => {}, cross: async () => JSON.stringify(JSON.parse(fixture('justwatch.json'))),
    prepare: async () => ({ blob: new w.Blob(['jpeg'], { type: 'image/jpeg' }), crop: { width: 2000, height: 3000 }, sourceWidth: 2000, sourceHeight: 3000 }) });
  t.after(() => app.cleanup());
  app.shell('Test'); app.kind = 'poster';
  app.results = w.document.createElement('div'); app.status = w.document.createElement('p'); app.panel.append(app.results, app.status);
  return { ...env, app, calls };
}

async function addPreview(env) {
  const { app, api, doc, w } = env;
  const card = w.document.createElement('div'); app.results.append(card);
  const config = api.uploadConfig(doc(fixture('movie-poster.html')), 'poster', app.target);
  await app.addAssets([{ title: 'Test image', url: 'https://m.media-amazon.com/test.jpg', variants: [] }], {}, card, config, app.controller.signal);
  return [...card.querySelectorAll('button')].find(b => b.textContent === 'Upload this image');
}

test('typing a language stays inside the popup and leaves normal keyboard behavior available', async t => {
  const env = mockApp(t);
  const { app, w, calls } = env;
  await addPreview(env);
  const language = app.panel.querySelector('[aria-label="Image language"]');
  const pageKeys = [];
  const inputKeys = [];
  for (const type of ['keydown', 'keypress', 'keyup']) {
    w.document.addEventListener(type, event => pageKeys.push(event.key));
    language.addEventListener(type, event => inputKeys.push(event.key));
  }
  language.focus();
  for (const key of ['e', 'Tab', 'ArrowDown']) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      const event = new w.KeyboardEvent(type, { key, bubbles: true, composed: true, cancelable: true });
      language.dispatchEvent(event);
      assert.equal(event.defaultPrevented, false, 'typing, tabbing, and datalist navigation must remain available');
    }
  }
  assert.equal(inputKeys.length, 9);
  assert.deepEqual(pageKeys, [], 'TMDB shortcuts must not receive keys typed into the popup');
  assert.equal(calls.length, 0, 'typing must not submit an image');

  w.document.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'e', bubbles: true }));
  assert.deepEqual(pageKeys, ['e'], 'page shortcuts still work outside the popup');
});

test('isolating popup keyboard events preserves Enter actions in search and provider fields', t => {
  const { app, w, stored } = mockApp(t);
  const queries = [];
  const titles = [];
  const pageKeys = [];
  app.search = query => queries.push(query);
  app.fetchTitle = title => titles.push(title);
  w.document.addEventListener('keydown', event => pageKeys.push(event.key));
  app.open('poster');
  queries.length = 0;

  const search = app.panel.querySelector('[aria-label="Search title"]');
  search.value = 'A Night to Regret';
  search.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
  assert.deepEqual(queries, ['A Night to Regret']);

  const provider = app.panel.querySelector('[aria-label="Provider title URL"]');
  provider.value = 'https://www.amazon.com/gp/video/detail/B012345678';
  provider.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
  assert.equal(titles[0].sources[0].url, provider.value);
  assert.deepEqual(Array.from(stored.get(`direct-sources:${app.target.type}:${app.target.id}`)), [provider.value]);

  app.settings();
  const regions = app.panel.querySelector('[aria-label="JustWatch regions"]');
  regions.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'e', bubbles: true, composed: true }));
  assert.deepEqual(pageKeys, []);
});

test('preview is local; only a confirmation click uploads; double-click cannot duplicate it', async t => {
  const env = mockApp(t); const { app, calls } = env;
  const upload = await addPreview(env);
  assert.equal(calls.length, 0);
  upload.click(); upload.click();
  await tick(); await tick();
  assert.equal(calls.filter(c => c.url === '/image').length, 1);
  assert.equal(calls.filter(c => c.url.endsWith('/language')).length, 1);
  assert.equal(calls.find(c => c.url === '/image').body.get('upload_files').type, 'image/jpeg');
  assert.equal(upload.disabled, true); assert.equal(app.busy, false);
  assert.match(app.panel.textContent, /TMDB is processing/);
});

test('complete search-to-preview UI keeps successful regions and waits for upload confirmation', async t => {
  const env = mockApp(t); const { app, stored, calls } = env;
  stored.set('regions', ['US', 'GB']);
  app.cross = async (url, options) => {
    if (url.includes('justwatch')) {
      if (options.json.variables.country === 'US') throw new Error('Search temporarily unavailable');
      return fixture('justwatch.json');
    }
    return fixture('apple.html');
  };
  app.open('poster'); await tick(); await tick();
  assert.match(app.status.textContent, /US: Search temporarily unavailable/);
  const fetchButton = [...app.results.querySelectorAll('button')].find(b => b.textContent === 'Fetch artwork' && !b.disabled);
  assert.ok(fetchButton); fetchButton.click(); await tick(); await tick();
  assert.equal(app.results.querySelectorAll('img').length, 1);
  assert.equal(calls.filter(c => c.body).length, 0);
  const upload = [...app.results.querySelectorAll('button')].find(b => b.textContent === 'Upload this image');
  upload.click(); await tick(); await tick();
  assert.equal(calls.filter(c => c.url === '/image').length, 1);
});

test('one failed provider does not discard another provider preview', async t => {
  const env = mockApp(t); const { app, calls } = env;
  app.cross = async url => {
    if (url.includes('amazon')) throw new Error('Provider blocked');
    return fixture('apple.html');
  };
  await app.fetchTitle({ sources: [
    { provider: 'Apple TV', countries: ['GB'], url: 'https://tv.apple.com/gb/movie/flatball/umc.cmc.drnve62utn2ny5vtx4jlq8e6' },
    { provider: 'Amazon', countries: ['US'], url: 'https://www.amazon.com/gp/video/detail/test' },
  ] });
  assert.equal(app.results.querySelectorAll('img').length, 1);
  assert.match(app.results.textContent, /Provider blocked/);
  assert.match(app.results.textContent, /Open source tab/);
  assert.equal(calls.filter(c => c.body).length, 0);
});

test('Kanopy performs an anonymous visitor handshake and retains the upload confirmation gate', async t => {
  const env = mockApp(t); const { app, calls } = env;
  const reads = [];
  app.cross = async (url, options) => { reads.push({ url, options }); return fixture(url.endsWith('/handshake') ? 'kanopy-handshake.json' : 'kanopy.json'); };
  await app.fetchTitle({ sources: [app.target && env.api.manualSource('https://www.kanopy.com/en/product/justwatch-16504352')] });
  assert.equal(reads.length, 2); assert.ok(reads.every(r => r.options.anonymous));
  assert.match(reads[0].url, /\/kapi\/handshake$/);
  assert.equal(reads[0].options.headers.Authorization, undefined);
  assert.equal(reads[1].options.headers.Authorization, 'Bearer synthetic-visitor-token');
  assert.match(reads[1].url, /\/kapi\/videos\/alias\/justwatch-16504352\?webshopId=9$/);
  assert.equal(env.stored.size, 0);
  assert.equal(app.results.querySelectorAll('img').length, 1);
  assert.equal(calls.filter(c => c.body).length, 0);
});

test('direct URL UI fetches and remembers a source even if JustWatch returns nothing', async t => {
  const env = mockApp(t); const { app, stored, calls } = env;
  app.cross = async url => url.includes('justwatch') ? '{"data":{"searchTitles":{"edges":[]}}}' : fixture('apple-unavailable.html');
  app.open('poster'); await tick();
  const input = app.panel.querySelector('[aria-label="Provider title URL"]');
  input.value = 'https://tv.apple.com/us/movie/bigfoot-i-love-you/umc.cmc.70td6qpxeljnbp2jd9425btiw';
  [...app.panel.querySelectorAll('button')].find(b => b.textContent === 'Fetch from URL').click();
  await tick(); await tick();
  assert.equal(app.results.querySelectorAll('img').length, 1);
  assert.equal(stored.get('direct-sources:movie:1508520')[0], input.value);
  assert.equal(calls.filter(c => c.body).length, 0);
  assert.match(app.panel.textContent, /Fetch saved Apple TV link/);
});

test('Kanopy API denial offers a source tab; helper sends only artwork metadata using same-origin fetch', async t => {
  const env = mockApp(t); env.app.cross = async () => { throw new Error('Source returned HTTP 401.'); };
  await env.app.fetchTitle({ sources: [env.api.manualSource('https://www.kanopy.com/en/product/justwatch-16504352')] });
  assert.match(env.app.results.textContent, /Open source tab/);
  assert.equal(env.calls.filter(c => c.body).length, 0);
  const id = '11111111-1111-4111-8111-111111111111';
  const url = 'https://www.kanopy.com/en/product/justwatch-16504352';
  const helper = environment(t, '', url + '#tmdb-artwork=' + id);
  helper.stored.set('tmdb-artwork-job:' + id, { id, url, kind: 'poster', state: 'waiting', expires: Date.now() + 60000 });
  const reads = [];
  helper.w.fetch = async (url, options) => { reads.push({ url, options }); return { ok: true, text: async () => fixture(url.endsWith('/handshake') ? 'kanopy-handshake.json' : 'kanopy.json') }; };
  helper.api.helper(); helper.w.document.body.lastElementChild.shadowRoot.querySelector('button').click(); await tick();
  assert.equal(reads.length, 2); assert.equal(reads[0].options.credentials, 'same-origin');
  assert.equal(reads[1].options.headers.Authorization, 'Bearer synthetic-visitor-token');
  const result = helper.stored.get('tmdb-artwork-job:' + id);
  assert.equal(result.state, 'ready'); assert.match(result.assets[0].url, /static-assets.kanopy.com/);
  assert.equal(result.video, undefined); assert.equal(result.cookies, undefined);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-visitor-token/);
});

test('Kanopy validates initialization, uses the returned region, and stops on cancellation', async t => {
  const { api, w } = environment(t);
  const url = 'https://www.kanopy.com/en/product/justwatch-16504352';
  let calls = 0;
  await assert.rejects(api.fetchKanopy(url, 'poster', async () => { calls++; return '{}'; }), /initialization failed/);
  assert.equal(calls, 1);
  const controller = new w.AbortController();
  await assert.rejects(api.fetchKanopy(url, 'poster', async () => {
    controller.abort(); return fixture('kanopy-handshake.json');
  }, controller.signal), /Cancelled/);
  await api.fetchKanopy(url, 'poster', async (url, options) => {
    if (url.endsWith('/handshake')) return JSON.stringify({ jwt: 'fake', webshopId: 12 });
    assert.match(url, /webshopId=12$/); assert.equal(options.headers.Authorization, 'Bearer fake');
    return fixture('kanopy.json');
  });
});

test('cross-origin transport forwards visitor headers and omits cookies', async t => {
  const { api, w } = environment(t);
  let options;
  w.GM_xmlhttpRequest = input => {
    options = input; queueMicrotask(() => input.onload({ status: 200, responseText: '{}' })); return { abort() {} };
  };
  await api.crossRequest('https://www.kanopy.com/kapi/handshake', { headers: { 'X-Version': 'test' } });
  assert.equal(options.anonymous, true); assert.equal(options.headers['X-Version'], 'test');
});

test('Google parsing accepts title links, unwraps redirects, deduplicates storefronts, and filters media type', t => {
  const { api, doc } = environment(t);
  const results = api.googleResults(doc(fixture('google.html')), 'movie');
  assert.equal(results.length, 2);
  assert.equal(results[0].sources[0].provider, 'Amazon');
  assert.equal(results[1].sources[0].provider, 'Apple TV');
  assert.match(results[1].title, /Bigfoot/);
  assert.equal(api.googleResults(doc('<p>Enable JavaScript / consent / challenge</p>'), 'movie').length, 0);
  assert.equal(api.googleResults(doc(fixture('google.html')), 'tv').filter(r => r.sources[0].provider === 'Apple TV').length, 1);
  assert.equal(new URL(api.googleQueries('Bigfoot, I Love You')[0]).searchParams.get('q'), 'Bigfoot, I Love You prime video');
});

test('Google title cleanup separates provider labels and relative crawl dates', t => {
  const { api, doc } = environment(t);
  const url = 'https://www.primevideo.com/detail/B012345678';
  const results = api.googleResults(doc(`<a href="${url}"><h3>The Possessed<span>Prime Video</span><span>1 month ago</span></h3></a>`), 'movie');
  assert.equal(results[0].title, 'The Possessed');
  assert.equal(api.cleanGoogleTitle('Watch Flatball - A History of Ultimate - Apple TV'), 'Flatball - A History of Ultimate');
  assert.equal(api.cleanGoogleTitle('A Movie from 1984'), 'A Movie from 1984');
});

test('provider metadata reads captured release years only from the current title', t => {
  const { api, doc } = environment(t);
  const amazon = 'https://www.amazon.com/gp/video/detail/B0FVFQ9Q5B';
  const apple = 'https://tv.apple.com/gb/movie/flatball/umc.cmc.drnve62utn2ny5vtx4jlq8e6';
  for (const [file, url] of [['amazon-metadata.html', amazon], ['apple-metadata.html', apple]]) {
    const result = api.providerMetadata(doc(fixture(file)), url);
    assert.equal(result.title, 'Flatball - A History of Ultimate'); assert.equal(result.year, '2017'); assert.equal(result.type, 'Movie');
  }
  assert.throws(() => api.providerMetadata(doc(fixture('apple-metadata.html')), apple + '-wrong'), /unavailable/);
  const noYear = api.providerMetadata(doc(fixture('amazon.html')), amazon);
  assert.equal(noYear.year, '');
  const ld = '<script type="application/ld+json">' + JSON.stringify({ '@type': 'Movie', name: 'The Possessed', datePublished: '1965-07-24', url: amazon }) + '</script>';
  assert.equal(api.providerMetadata(doc(ld), amazon).year, '1965');
  assert.throws(() => api.providerMetadata(doc(ld.replace('B0FVFQ9Q5B', 'B012345678')), amazon), /unavailable/);
  assert.throws(() => api.providerMetadata(doc('<p>Movie recommendation 2020 · crawled 2026</p>'), amazon), /unavailable/);
});

test('Google cards enrich titles and years, highlight matches, and show one deduplicated count below results', async t => {
  const { app, calls, w } = mockApp(t);
  app.target = { ...app.target, title: 'Flatball: A History of Ultimate', year: '2017' };
  const amazon = 'https://www.amazon.com/gp/video/detail/B0FVFQ9Q5B';
  const apple = 'https://tv.apple.com/gb/movie/flatball/umc.cmc.drnve62utn2ny5vtx4jlq8e6';
  const search = `<a href="${amazon}"><h3>FlatballPrime Video1 month ago</h3></a><a href="${apple}"><h3>Flatball - Apple TV</h3></a>`;
  const reads = [];
  app.cross = async url => {
    reads.push(url);
    if (url.includes('justwatch')) return '{}';
    if (url.includes('google.com')) return search;
    return fixture(url === amazon ? 'amazon-metadata.html' : 'apple-metadata.html');
  };
  await app.search(app.target.title);
  assert.equal(reads.filter(url => url === amazon).length, 1); assert.equal(reads.filter(url => url === apple).length, 1);
  const section = app.results.querySelector('.google-section');
  assert.equal(section.querySelector('.google-heading').textContent, 'Google Search fallback');
  assert.doesNotMatch(section.textContent, /No exact JustWatch match|Check the title|month ago/);
  assert.equal(section.querySelectorAll('.google-card.exact-match').length, 2);
  for (const card of section.querySelectorAll('.google-card')) {
    assert.equal(card.querySelector('strong').textContent, 'Flatball - A History of Ultimate');
    assert.match(card.querySelector('.google-meta').textContent, /Movie · 2017$/);
    assert.equal(card.querySelector('.match-label').hidden, false);
    assert.equal(card.querySelector('.google-actions').children.length, 2);
  }
  const summary = section.querySelector('.google-summary');
  assert.equal(summary.textContent, '2 provider pages found'); assert.equal(section.lastElementChild, summary);
  assert.ok(section.querySelector('.grid').compareDocumentPosition(summary) & w.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(calls.length, 0);

  app.cross = async url => {
    if (url.includes('justwatch')) return '{}';
    if (url.includes('google.com')) return search;
    if (url === amazon) throw new Error('HTTP 403');
    return fixture('apple-metadata.html').replace('2017', '2016');
  };
  await app.search(app.target.title);
  assert.equal(app.results.querySelectorAll('.google-card').length, 2);
  assert.equal(app.results.querySelectorAll('.google-card.exact-match').length, 0);
  assert.match(app.results.textContent, /Year unknown/); assert.match(app.results.textContent, /Movie · 2016/);
  assert.equal(app.results.querySelector('.google-summary').textContent, '2 provider pages found');
  assert.equal(calls.length, 0);
});

test('cancelling Google provider enrichment ignores late metadata and never highlights or uploads', async t => {
  const { app, calls } = mockApp(t);
  const release = [];
  app.cross = async url => {
    if (url.includes('justwatch')) return '{}';
    if (url.includes('google.com')) return fixture('google.html');
    return new Promise(resolve => release.push(resolve));
  };
  const pending = app.search('Bigfoot'); await tick();
  const before = app.results.textContent;
  app.close.click(); release.forEach(resolve => resolve(fixture('amazon-metadata.html'))); await pending;
  assert.equal(app.results.querySelectorAll('.exact-match').length, 0);
  assert.doesNotMatch(app.results.textContent, /Flatball/);
  assert.match(before, /Reading year/); assert.equal(calls.length, 0);
});

test('Google fallback handles empty or unrelated JustWatch matches and requires source selection before preview', async t => {
  const env = mockApp(t); const { app, calls } = env;
  let jw = '{"data":{"searchTitles":{"edges":[]}}}'; const reads = [];
  app.cross = async url => {
    reads.push(url);
    if (url.includes('justwatch')) return jw;
    if (url.includes('google.com')) return fixture('google.html');
    return fixture('apple-unavailable.html');
  };
  await app.search('Bigfoot, I Love You');
  assert.equal(app.results.querySelectorAll('button').length, 2); // Two deduplicated sources; no manual Google step.
  assert.equal(app.results.querySelectorAll('img').length, 0); assert.equal(calls.length, 0);
  jw = fixture('justwatch.json');
  await app.search('Bigfoot, I Love You');
  assert.equal(reads.filter(url => url.includes('google.com')).length, 4);
  const apple = [...app.results.querySelectorAll('.google-card')].find(card => card.querySelector('.google-meta')?.textContent.includes('Apple TV'));
  apple.querySelector('button').click(); await tick(); await tick();
  assert.equal(app.results.querySelectorAll('img').length, 1);
  assert.equal(calls.filter(c => c.body).length, 0);
});

test('an exact usable JustWatch match skips Google; missing offers triggers it', async t => {
  const { app } = mockApp(t); let searches = 0;
  const data = JSON.parse(fixture('justwatch.json'));
  app.cross = async url => {
    if (url.includes('google.com')) { searches++; return ''; }
    return JSON.stringify(data);
  };
  await app.search('Flatball: A History of Ultimate'); assert.equal(searches, 0);
  for (const { node } of data.data.searchTitles.edges) node.offers = [];
  await app.search('Flatball: A History of Ultimate'); assert.equal(searches, 2);
  assert.match(app.results.textContent, /Searching in a background tab/);
});

test('Google errors retain readable results; closing aborts late search output', async t => {
  const { app, calls } = mockApp(t);
  app.cross = async url => {
    if (url.includes('justwatch')) throw new Error('JustWatch unavailable');
    if (new URL(url).searchParams.get('q').endsWith('prime video')) throw new Error('HTTP 429');
    return fixture('google.html');
  };
  await app.search('Bigfoot');
  assert.match(app.results.textContent, /Bigfoot, I Love You/);
  assert.match(app.results.textContent, /Searching in a background tab/);
  const releases = [];
  app.cross = async url => url.includes('justwatch') ? '{}' : new Promise(resolve => { releases.push(resolve); });
  const pending = app.search('Another title'); await tick();
  app.close.click(); releases.forEach(resolve => resolve(fixture('google.html'))); await pending;
  assert.equal(app.results.querySelectorAll('button').length, 0);
  assert.equal(calls.filter(c => c.body).length, 0);
});

test('Google background exchange is automatic, request-specific, closes tabs, and never uploads artwork', async t => {
  const env = mockApp(t); const { app, w, stored, calls } = env;
  const tabs = [], listeners = new Map();
  w.GM_openInTab = (url, options) => {
    const tab = { url, options, closed: false, close() { this.closed = true; } }; tabs.push(tab); return tab;
  };
  w.GM_addValueChangeListener = (key, callback) => { listeners.set(key, callback); return listeners.size; };
  app.cross = async () => '{}'; await app.search('Bigfoot, I Love You');
  assert.equal(app.jobs.length, 2); assert.equal(tabs.length, 2); assert.ok(tabs.every(tab => !tab.options.active));
  const opened = tabs[0].url;
  const key = [...stored.keys()].find(k => k.startsWith('tmdb-artwork-job:'));
  const helper = environment(t, fixture('google.html'), opened);
  helper.stored.set(key, stored.get(key)); helper.api.start();
  const result = helper.stored.get(key);
  assert.equal(result.state, 'ready'); assert.equal(result.titles.length, 2); assert.equal(result.assets, undefined);
  await listeners.get(key)(key, null, result);
  assert.match(app.results.textContent, /Bigfoot, I Love You/);
  assert.equal(tabs[0].closed, true);
  assert.equal(calls.length, 0);
  const expired = environment(t, fixture('google.html'), opened);
  expired.stored.set(key, { ...result, state: 'waiting', expires: Date.now() - 1 }); expired.api.start();
  assert.equal(expired.stored.has(key), false);
  const wrong = environment(t, fixture('google.html'), opened.replace('Bigfoot', 'Different'));
  wrong.stored.set(key, { ...result, state: 'waiting' }); wrong.api.helper();
  assert.equal(wrong.stored.get(key).state, 'waiting');
  app.close.click(); assert.equal(tabs[1].closed, true); assert.equal(stored.has(key), false);
  const before = app.results.textContent;
  [...listeners.values()][1]('unused', null, result); assert.equal(app.results.textContent, before);
});

test('Google helper collects delayed results without a click and ignores cancelled or changed searches', async t => {
  const id = '11111111-1111-4111-8111-111111111111', key = 'tmdb-artwork-job:' + id;
  const url = 'https://www.google.com/search?q=Bigfoot';
  for (const scenario of ['results', 'cancel', 'navigate']) {
    const env = environment(t, '<p>Loading…</p>', url + '#tmdb-artwork=' + id);
    env.stored.set(key, { id, url, mode: 'search', type: 'movie', state: 'waiting', expires: Date.now() + 60000 });
    env.api.start();
    if (scenario === 'cancel') env.stored.delete(key);
    if (scenario === 'navigate') env.w.history.replaceState(null, '', '/search?q=SomethingElse');
    env.w.document.body.innerHTML = fixture('google.html');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(env.stored.get(key)?.state, scenario === 'results' ? 'ready' : scenario === 'cancel' ? undefined : 'waiting');
  }
});

test('Google attention recovery opens only on request, and pending background tabs expire', async t => {
  const { app, w, stored, calls } = mockApp(t);
  const timers = [], tabs = [];
  w.setTimeout = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
  w.clearTimeout = () => {};
  w.GM_openInTab = (url, options) => {
    const tab = { options, closed: false, close() { this.closed = true; } }; tabs.push(tab); return tab;
  };
  app.cross = async () => '{}'; await app.search('Bigfoot');
  assert.ok(tabs.every(tab => !tab.options.active));
  timers.find(timer => timer.delay === 20000).fn();
  const recover = [...app.results.querySelectorAll('button')].find(b => b.textContent === 'Open Google to resolve');
  assert.ok(recover); recover.click(); assert.equal(tabs[0].closed, true); assert.equal(tabs[2].options.active, true);
  timers.filter(timer => timer.delay === 600000).forEach(timer => timer.fn());
  assert.ok(tabs.every(tab => tab.closed)); assert.equal(stored.size, 0);
  recover.click(); assert.equal(tabs.length, 3); assert.equal(calls.length, 0);
});

test('exact-match highlighting requires the TMDB title and known year; popup uses an accessible corner close', async t => {
  const env = mockApp(t); const { app, api, w } = env;
  const target = { title: "It's: A Test!", year: '2020' };
  assert.equal(api.exactMatch({ title: 'ITS A TEST', year: 2020 }, target), true);
  for (const item of [{ title: 'ITS A TEST', year: 2021 }, { title: 'ITS A TEST' }, { title: 'Test', year: 2020 }]) {
    assert.equal(api.exactMatch(item, target), false);
  }
  assert.equal(api.exactMatch({ title: 'Test' }, { title: 'Test' }), false);
  app.cross = async () => JSON.stringify({ data: { searchTitles: { edges: [
    { node: { id: '1', objectType: 'MOVIE', content: { title: 'FOUR, BIRDS!', originalReleaseYear: 2026 }, offers: [] } },
    { node: { id: '2', objectType: 'MOVIE', content: { title: 'Four Birds', originalReleaseYear: 2025 }, offers: [] } },
  ] } } });
  app.open('poster'); await tick();
  const details = app.panel.querySelector('details');
  assert.ok(app.results.compareDocumentPosition(details) & w.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(app.results.querySelectorAll('.exact-match').length, 1);
  assert.match(app.results.querySelector('.exact-match').textContent, /Title & year match/);
  await app.search('Different edited query');
  assert.equal(app.results.querySelectorAll('.exact-match').length, 1); // Still compares with TMDB.
  assert.equal(app.close.getAttribute('aria-label'), 'Close'); assert.equal(app.close.textContent, '×');
  assert.equal(app.close.parentElement.className, 'dialog-header');
  app.close.click(); assert.equal(app.overlay.isConnected, false);
});

test('closing a preview and cancelling search never upload', async t => {
  const env = mockApp(t); const upload = await addPreview(env);
  env.app.close.click();
  assert.equal(env.app.controller.signal.aborted, true);
  assert.equal(env.calls.length, 0);
  assert.equal(env.app.overlay.isConnected, false);
  // Detached controls must not submit after cancellation.
  upload.click(); await tick();
  assert.equal(env.calls.filter(c => c.url === '/image').length, 0);
});

test('ambiguous upload failure cannot be retried with the same confirmation', async t => {
  const env = mockApp(t, async url => { if (url === '/image') throw new Error('Timed out'); });
  const upload = await addPreview(env); upload.click(); await tick(); await tick(); upload.click();
  assert.equal(env.calls.filter(c => c.url === '/image').length, 1);
  assert.match(env.app.panel.textContent, /may already have reached TMDB/);
  assert.equal(upload.disabled, true);
});

test('language-only retry never sends the image again', async t => {
  let failures = 2;
  const env = mockApp(t, async url => { if (url.endsWith('/language') && failures-- > 0) throw new Error('Language offline'); });
  const upload = await addPreview(env); upload.click(); await tick(); await tick();
  const retry = [...env.app.panel.querySelectorAll('button')].find(b => b.textContent === 'Retry language only');
  assert.ok(retry); retry.click(); await tick(); await tick();
  assert.equal(env.calls.filter(c => c.url === '/image').length, 1);
  assert.equal(env.calls.filter(c => c.url.endsWith('/language')).length, 2);
  assert.equal(upload.disabled, true);
  assert.equal(retry.disabled, false);
  assert.match(env.app.panel.textContent, /Image is already uploaded. Language update failed/);
  retry.click(); await tick(); await tick();
  assert.equal(env.calls.filter(c => c.url === '/image').length, 1);
  assert.equal(env.calls.filter(c => c.url.endsWith('/language')).length, 3);
  assert.equal(upload.disabled, true); assert.match(env.app.panel.textContent, /language updated/);
});

test('expired form or changed media ID blocks submission before POST', async t => {
  const env = mockApp(t, async url => {
    if (url.endsWith('/upload')) return fixture('movie-poster.html').replace('68689dbbdc61d3bf9653f314', 'different-title');
  });
  const upload = await addPreview(env); upload.click(); await tick();
  assert.equal(env.calls.filter(c => c.url === '/image').length, 0);
  assert.match(env.app.panel.textContent, /settings changed/);
});

test('source helper requires a current matching request and cannot upload', t => {
  const id = '11111111-1111-4111-8111-111111111111';
  const url = 'https://www.amazon.com/gp/video/detail/title';
  const { api, w, stored } = environment(t, fixture('amazon.html'), url + '#tmdb-artwork=' + id);
  let requestCount = 0; w.fetch = () => { requestCount++; }; w.GM_xmlhttpRequest = () => { requestCount++; };
  api.helper(); assert.equal(w.document.body.children.length, 0);
  stored.set('tmdb-artwork-job:' + id, { id, url, kind: 'poster', state: 'waiting', expires: Date.now() + 60000 });
  api.helper(); const host = w.document.body.lastElementChild;
  host.shadowRoot.querySelector('button').click();
  assert.equal(stored.get('tmdb-artwork-job:' + id).state, 'ready');
  assert.equal(stored.get('tmdb-artwork-job:' + id).assets.length, 1);
  assert.equal(requestCount, 0);
});

test('real JPEG encoding preserves center crop and chooses larger source without upscaling', async t => {
  const { api, w, objectURLs, doc } = environment(t);
  // Use a native canvas only in tests. The shipped script uses the browser canvas.
  const canvases = new WeakMap(); const sourceCanvas = createCanvas(2400, 3200); const ctx = sourceCanvas.getContext('2d');
  ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 2400, 3200);
  ctx.fillStyle = 'blue'; ctx.fillRect(200, 0, 2000, 3200);
  const input = new Blob([sourceCanvas.toBuffer('image/png')], { type: 'image/png' });
  const smaller = createCanvas(500, 750);
  const smallInput = new Blob([smaller.toBuffer('image/png')], { type: 'image/png' });
  w.GM_xmlhttpRequest = options => {
    queueMicrotask(() => options.onload({ status: 200, response: options.url.includes('SX4096') ? smallInput : input }));
    return { abort() {} };
  };
  w.Image = class {
    async decode() { this.native = await loadImage(Buffer.from(await objectURLs.get(this.src).arrayBuffer())); this.naturalWidth = this.native.width; this.naturalHeight = this.native.height; }
  };
  w.HTMLCanvasElement.prototype.getContext = function () {
    const canvas = createCanvas(this.width, this.height); canvases.set(this, canvas);
    const ctx = canvas.getContext('2d'); const draw = ctx.drawImage.bind(ctx); ctx.drawImage = (image, ...args) => draw(image.native, ...args); return ctx;
  };
  let quality;
  w.HTMLCanvasElement.prototype.toBlob = function (callback, type, q) {
    assert.equal(type, 'image/jpeg'); quality = q;
    callback(new Blob([canvases.get(this).toBuffer('image/jpeg', Math.round(q * 100))], { type }));
  };
  const config = api.uploadConfig(doc(fixture('movie-poster.html')), 'poster', { type: 'movie' });
  const result = await api.prepare({ variants: ['https://m.media-amazon.com/test.jpg', 'https://m.media-amazon.com/test._SX4096_FMavif_PQ100_.jpg'] }, config, new w.AbortController().signal);
  const bytes = Buffer.from(await result.blob.arrayBuffer());
  assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff'); assert.equal(quality, 0.9);
  const image = await loadImage(bytes); assert.equal(image.width, 2000); assert.equal(image.height, 3000);
  assert.equal(result.sourceWidth, 2400); assert.equal(result.sourceHeight, 3200);
  assert.equal(objectURLs.size, 0);
});
