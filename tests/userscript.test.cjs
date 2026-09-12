const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const source = fs.readFileSync(path.join(__dirname, '../tmdb-artwork.user.js'), 'utf8');
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

test('Kanopy fetch uses its destination session and retains the upload confirmation gate', async t => {
  const env = mockApp(t); const { app, calls } = env;
  const reads = [];
  app.cross = async (url, options) => { reads.push({ url, options }); return fixture('kanopy.json'); };
  await app.fetchTitle({ sources: [app.target && env.api.manualSource('https://www.kanopy.com/en/product/justwatch-16504352')] });
  assert.equal(reads.length, 1); assert.equal(reads[0].options.anonymous, false);
  assert.match(reads[0].url, /\/kapi\/videos\/alias\/justwatch-16504352\?webshopId=9$/);
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
  helper.w.fetch = async (url, options) => { reads.push({ url, options }); return { ok: true, json: async () => JSON.parse(fixture('kanopy.json')) }; };
  helper.api.helper(); helper.w.document.body.lastElementChild.shadowRoot.querySelector('button').click(); await tick();
  assert.equal(reads.length, 1); assert.equal(reads[0].options.credentials, 'same-origin');
  const result = helper.stored.get('tmdb-artwork-job:' + id);
  assert.equal(result.state, 'ready'); assert.match(result.assets[0].url, /static-assets.kanopy.com/);
  assert.equal(result.video, undefined); assert.equal(result.cookies, undefined);
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
  let failures = 1;
  const env = mockApp(t, async url => { if (url.endsWith('/language') && failures-- > 0) throw new Error('Language offline'); });
  const upload = await addPreview(env); upload.click(); await tick(); await tick();
  const retry = [...env.app.panel.querySelectorAll('button')].find(b => b.textContent === 'Retry language only');
  assert.ok(retry); retry.click(); await tick(); await tick();
  assert.equal(env.calls.filter(c => c.url === '/image').length, 1);
  assert.equal(env.calls.filter(c => c.url.endsWith('/language')).length, 2);
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
  assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff'); assert.equal(quality, 1);
  const image = await loadImage(bytes); assert.equal(image.width, 2000); assert.equal(image.height, 3000);
  assert.equal(result.sourceWidth, 2400); assert.equal(result.sourceHeight, 3200);
  assert.equal(objectURLs.size, 0);
});
