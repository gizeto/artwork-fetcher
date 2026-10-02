const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const source = fs.readFileSync(path.join(__dirname, '../artwork-fetcher.user.js'), 'utf8');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function environment(t, html = '', url = 'https://www.themoviedb.org/movie/990000001-example-movie-four') {
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
    ['movie-poster-page.html', '/movie/990000001-example-movie-four', 'Example Movie Four', 'movie'],
    ['tv-poster-page.html', '/tv/990000002-example-show/images/posters', 'Example Show', 'tv'],
  ]) {
    const target = api.targetFromPage(doc(fixture(file)), 'https://www.themoviedb.org' + route);
    assert.equal(target.title, title); assert.equal(target.year, '2026'); assert.equal(target.type, type);
  }
  for (const route of ['/tv/990000002/season/1', '/tv/990000002/season/1/episode/2', '/movie/1/edit', '/movie/popular']) {
    assert.equal(api.targetFromPage(doc(fixture('tv-poster-page.html')), 'https://www.themoviedb.org' + route), null);
  }
});

test('regions, title matching, year differences, and provider deduplication', t => {
  const { api } = environment(t);
  assert.deepEqual(Array.from(api.regions('us, gb US;pl')), ['US', 'GB', 'PL']);
  assert.throws(() => api.regions('USA'), /country codes/);
  const data = JSON.parse(fixture('justwatch.json'));
  const target = { title: 'Fixture: A Movie', year: '2017', type: 'movie' };
  const results = api.searchResults([{ country: 'GB', data }, { country: 'US', data }], target);
  assert.equal(results[0].title, target.title);
  assert.equal(results[0].year, 2016);
  assert.equal(results[0].sources.length, 1);
  assert.deepEqual(Array.from(results[0].sources[0].countries), ['GB', 'US']);
  assert.equal(results[0].sources[0].provider, 'Apple TV');
  assert.equal(api.provider('https://amazon.com.evil.test/image'), null);
  assert.equal(api.provider('http://www.amazon.com/title'), null);
  const gti = 'amzn1.dv.gti.00000000-0000-4000-8000-000000000001';
  assert.equal(api.canonicalProvider('https://watch.amazon.com/detail?gti=' + gti), 'https://www.amazon.com/gp/video/detail/' + gti);
  const shows = api.searchResults([{ country: 'GB', data }], { ...target, type: 'tv' });
  assert.ok(shows.length > 0); assert.ok(shows.every(item => item.type === 'SHOW'));
  const offers = [{ presentationType: 'DVD', standardWebURL: 'https://www.amazon.com/dp/DISC' },
    { presentationType: 'HD', standardWebURL: 'https://watch.amazon.com/detail?gti=' + gti },
    { presentationType: 'HD', standardWebURL: 'https://tv.apple.com/us' }];
  const streaming = api.searchResults([{ country: 'US', data: { data: { searchTitles: { edges: [
    { node: { id: 'show1', objectType: 'SHOW', content: { title: 'Example Series Two', originalReleaseYear: 2015 }, offers } },
  ] } } } }], { type: 'tv', title: 'Example Series Two' });
  assert.equal(streaming[0].sources.length, 1); assert.match(streaming[0].sources[0].url, /gp\/video\/detail\/amzn1/);
});

test('Amazon uses current-title hero and packshot, never recommendations', t => {
  const { api, doc } = environment(t);
  const page = doc(fixture('amazon.html'));
  const hero = api.amazonArtwork(page, 'backdrop'); const poster = api.amazonArtwork(page, 'poster');
  assert.equal(hero.length, 1); assert.equal(poster.length, 1);
  assert.match(hero[0].url, /fixture-background/); assert.match(poster[0].url, /fixture-poster/);
  assert.match(hero[0].variants[1], /\._SX4096_FMavif_PQ100_\.jpg$/);
  const fallback = api.amazonArtwork(doc('<div data-automation-id="hero-background"><img src="https://m.media-amazon.com/images/S/pv-target-images/test._SX1080_FMjpg_.jpg" alt="Hero"></div><img src="https://m.media-amazon.com/WRONG.jpg">'), 'backdrop');
  assert.equal(fallback.length, 1); assert.match(fallback[0].variants[0], /test\.jpg$/);
  assert.equal(api.amazonVariants('https://m.media-amazon.com/test.png')[0], 'https://m.media-amazon.com/test.png');
});

test('Apple selects the main title artwork and resolves native dimensions', t => {
  const { api, doc } = environment(t);
  const url = 'https://tv.apple.com/gb/movie/fixture---a-movie/umc.cmc.fixturemovieone';
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
      assert.equal(api.providerMetadata(page, url).title, 'Fixture - A Movie');
    }
    assert.equal(api.appleArtwork(page, 'poster', titleURL + '-wrong/').length, 0);
    assert.throws(() => api.providerMetadata(page, titleURL + '-wrong/'), /unavailable/);
  }
});

test('Kanopy unwraps native images and selects only the requested title and artwork kind', t => {
  const { api } = environment(t);
  const url = 'https://www.kanopy.com/en/product/justwatch-990000003?utm_source=justwatch';
  const data = JSON.parse(fixture('kanopy.json'));
  assert.equal(api.provider(url), 'Kanopy');
  assert.equal(api.kanopyAPI(url), 'https://www.kanopy.com/kapi/videos/alias/justwatch-990000003?webshopId=9');
  for (const [kind, hash] of [['backdrop', '11111111-0000'], ['poster', '22222222-0000']]) {
    const assets = api.kanopyArtwork(data, kind, url);
    assert.equal(assets.length, 1); assert.equal(assets[0].title, 'Example Journey');
    assert.match(assets[0].url, new RegExp('^https://static-assets.kanopy.com/video-images/' + hash));
    assert.equal(assets[0].variants.length, 1); assert.doesNotMatch(assets[0].url, /width=|height=|cdn-cgi/);
  }
  assert.throws(() => api.kanopyArtwork(data, 'poster', url.replace('990000003', '99999999')), /matching title/);
  data.video.images.posters = { large: 'https://attacker.test/untrusted.jpeg' };
  assert.throws(() => api.kanopyArtwork(data, 'poster', url), /no poster artwork/);
  const node = { id: 'kanopy1', objectType: 'MOVIE', content: { title: 'Example Journey', originalReleaseYear: 2024 },
    offers: [{ presentationType: 'HD', standardWebURL: url }] };
  const titles = api.searchResults([{ country: 'US', data: { data: { searchTitles: { edges: [{ node }] } } } }], { type: 'movie', title: 'Example Journey' });
  assert.equal(titles[0].sources[0].provider, 'Kanopy');
});

const disneyURL = 'https://www.disneyplus.com/browse/entity-00000000-0000-4000-8000-000000000201';

test('Disney+ recognizes entity and legacy title links in pasted URLs, JustWatch and Google', t => {
  const { api, doc } = environment(t);
  const direct = api.manualSource(disneyURL + '?utm_source=justwatch#tracking');
  assert.equal(direct.provider, 'Disney+'); assert.equal(direct.generic, undefined); assert.equal(direct.url, disneyURL);
  assert.equal(api.provider(disneyURL.replace('www.disneyplus.com', 'disneyplus.com')), 'Disney+');
  assert.equal(api.provider(disneyURL.replace('www.disneyplus.com', 'disneyplus.com.evil.test')), null);
  for (const path of ['/browse', '/browse/entity-invalid', '/login', '/browse/entity-00000000-0000-4000-8000-000000000201/extra']) {
    assert.equal(api.manualSource('https://www.disneyplus.com' + path).generic, true);
  }
  const movie = 'https://www.disneyplus.com/movies/a-movie/ABC123';
  const show = 'https://www.disneyplus.com/en-gb/series/a-show/XYZ789';
  assert.equal(api.manualSource(movie).provider, 'Disney+'); assert.equal(api.manualSource(show).generic, undefined);
  const node = { id: 'disney1', objectType: 'SHOW', content: { title: 'Example Series', originalReleaseYear: 2026 },
    offers: [{ presentationType: 'HD', standardWebURL: disneyURL + '?utm_source=justwatch' }] };
  const results = api.searchResults([{ country: 'US', data: { data: { searchTitles: { edges: [{ node }] } } } }], { type: 'tv' });
  assert.equal(results[0].sources[0].url, disneyURL); assert.equal(results[0].sources[0].provider, 'Disney+');
  const google = doc(`<a href="${disneyURL}"><h3>Example Series | Watch Full Episodes | Disney+</h3></a>
    <a href="${disneyURL.replace('/browse/', '/en-gb/browse/')}"><h3>Duplicate</h3></a>
    <a href="${movie}"><h3>A Movie | Disney+</h3></a><a href="${show}"><h3>A Show | Disney+</h3></a>`);
  const titles = api.googleResults(google, 'tv');
  assert.equal(titles.length, 2); assert.equal(titles[0].title, 'Example Series');
  assert.equal(api.googleResults(google, 'movie').length, 2);
  assert.equal(new URL(api.googleQueries('Example Series')[2]).searchParams.get('q'), 'Example Series disney plus');
});

test('Disney+ extracts native current-title artwork and metadata without logos, episodes or recommendations', t => {
  const { api, doc } = environment(t); const page = doc(fixture('disney.html'));
  const background = api.extract(page, disneyURL, 'backdrop'); const poster = api.extract(page, disneyURL, 'poster');
  assert.equal(background.length, 1); assert.equal(poster.length, 1);
  assert.match(background[0].url, /11111111-0000-4000-8000-000000000202/);
  assert.match(poster[0].url, /22222222-0000-4000-8000-000000000203/);
  assert.doesNotMatch(poster[0].url, /aspectRatio|width=|max=/);
  assert.equal(poster[0].variants.length, 1); assert.equal(poster[0].orientation, 'portrait');
  assert.equal(background[0].orientation, 'landscape'); assert.equal(poster[0].title, 'Example Series');
  const metadata = api.providerMetadata(page, disneyURL + '/');
  assert.equal(metadata.title, 'Example Series'); assert.equal(metadata.year, '2026'); assert.equal(metadata.type, 'TV series');
  const wrong = disneyURL.replace('00000000', 'ffffffff');
  assert.throws(() => api.extract(page, wrong, 'poster'), /No title artwork/);
  assert.throws(() => api.providerMetadata(page, wrong), /unavailable/);
  assert.equal(api.disneyArtwork(doc('<p>Sign in</p>'), 'poster', disneyURL).length, 0);
  const script = page.querySelector('#__NEXT_DATA__'); const data = JSON.parse(script.textContent);
  const blocks = data.props.pageProps.stitchDocument.mainContent;
  const social = blocks.find(b => b._type === 'Metadata').metaTags.find(tag => tag.property === 'twitter:image');
  social.content = 'https://disney.images.edge.bamgrid.com.evil.test/ripcut-delivery/v2/variant/disney/test/compose';
  script.textContent = JSON.stringify(data);
  assert.equal(api.disneyArtwork(page, 'poster', disneyURL).length, 0);
  social.content = 'https://m.media-amazon.com/wrong.jpg'; script.textContent = JSON.stringify(data);
  assert.equal(api.disneyArtwork(page, 'poster', disneyURL).length, 0);
});

test('direct URLs preserve provider handlers and accept arbitrary web sources', t => {
  const { api, doc } = environment(t);
  const prime = api.manualSource(' https://www.primevideo.com/-/de/detail/TESTMOVIE000000000000000001, ');
  assert.equal(prime.url, 'https://www.primevideo.com/-/de/detail/TESTMOVIE000000000000000001');
  const url = 'https://tv.apple.com/us/movie/example-i-love-you/umc.cmc.fixturemovietwo';
  assert.equal(api.manualSource(url).provider, 'Apple TV');
  const assets = api.appleArtwork(doc(fixture('apple-unavailable.html')), 'backdrop', url);
  assert.equal(assets.length, 1); assert.equal(assets[0].title, 'Example, I Love You');
  assert.match(assets[0].url, /1920x1080\.jpg$/);
  const config = api.uploadConfig(doc(fixture('movie-poster.html')), 'poster', { type: 'movie' });
  assert.equal(api.cropPlan(400, 574, config).valid, false);
  for (const bad of ['javascript:alert(1)', 'file:///tmp/test.jpg', 'data:image/png;base64,AA', 'https://user:password@tv.apple.com/us/movie/test/umc.cmc.123']) {
    assert.throws(() => api.manualSource(bad));
  }
  const links = api.discoveryLinks('Example, I Love You', { type: 'movie', year: '2025' });
  assert.equal(links.length, 1);
  assert.equal(new URL(links[0][1]).searchParams.get('q'), 'Example, I Love You 2025 online');
  assert.equal(api.manualSource('https://example.test/image?size=large&signature=abc,').url, 'https://example.test/image?size=large&signature=abc,');
  assert.equal(api.manualSource('https://tv.apple.com/us/search?term=test').generic, true);
  assert.equal(api.manualSource('https://watch.amazon.com/detail?gti=amzn1.dv.gti.abc-123').url, 'https://www.amazon.com/gp/video/detail/amzn1.dv.gti.abc-123');
  assert.equal(api.manualSource('https://www.kanopy.com/en/product/justwatch-990000003,').provider, 'Kanopy');
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
  app.open();
  queries.length = 0;

  const search = app.panel.querySelector('[aria-label="Search title"]');
  search.value = 'A Night to Regret';
  search.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
  assert.deepEqual(queries, ['A Night to Regret']);

  const provider = app.panel.querySelector('[aria-label="Image or webpage URL"]');
  provider.value = 'https://www.amazon.com/gp/video/detail/TESTMOVIE2';
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
  app.open(); await tick(); await tick();
  assert.match(app.status.textContent, /US: Search temporarily unavailable/);
  const fetchButton = [...app.results.querySelectorAll('button')].find(b => b.textContent === 'Fetch poster' && !b.disabled);
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
    { provider: 'Apple TV', countries: ['GB'], url: 'https://tv.apple.com/gb/movie/fixture/umc.cmc.fixturemovieone' },
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
  await app.fetchTitle({ sources: [app.target && env.api.manualSource('https://www.kanopy.com/en/product/justwatch-990000003')] });
  assert.equal(reads.length, 2); assert.ok(reads.every(r => r.options.anonymous));
  assert.match(reads[0].url, /\/kapi\/handshake$/);
  assert.equal(reads[0].options.headers.Authorization, undefined);
  assert.equal(reads[1].options.headers.Authorization, 'Bearer synthetic-visitor-token');
  assert.match(reads[1].url, /\/kapi\/videos\/alias\/justwatch-990000003\?webshopId=9$/);
  assert.ok(!JSON.stringify([...env.stored]).includes('synthetic-visitor-token'));
  assert.equal(app.results.querySelectorAll('img').length, 1);
  assert.equal(calls.filter(c => c.body).length, 0);
});

test('Disney+ reuses both artwork kinds and source helpers return native artwork without uploading', async t => {
  const { app, api, calls, w, doc } = mockApp(t, url => url.includes('/backdrops/upload') ?
    fixture('tv-backdrop.html').replace('TvSeries', 'Movie') : undefined); let reads = 0;
  app.cross = async (_url, options) => { reads++; assert.equal(options.anonymous, true); return fixture('disney.html'); };
  const title = { sources: [api.manualSource(disneyURL)] };
  await app.fetchTitle(title, 'poster');
  assert.equal(app.results.querySelectorAll('img').length, 1);
  app.back(); await app.fetchTitle(title, 'backdrop');
  assert.equal(app.results.querySelectorAll('img').length, 1); assert.equal(reads, 1);
  assert.equal(calls.filter(c => c.body).length, 0);
  const id = '11111111-1111-4111-8111-111111111111', key = 'tmdb-artwork-job:' + id;
  const helper = environment(t, fixture('disney.html'), disneyURL + '#tmdb-artwork=' + id);
  helper.w.GM_xmlhttpRequest = () => { throw new Error('Source helpers must not upload'); };
  helper.stored.set(key, { id, url: disneyURL, kind: 'poster', state: 'waiting', expires: Date.now() + 60000 });
  helper.api.start(); helper.w.document.body.lastElementChild.shadowRoot.querySelector('button').click();
  const result = helper.stored.get(key);
  assert.equal(result.state, 'ready'); assert.equal(result.assets.length, 1);
  assert.match(result.assets[0].url, /22222222-0000/); assert.doesNotMatch(result.assets[0].url, /width=|aspectRatio=/);
  // The receiving TMDB tab must accept Disney's CDN through the same helper validation as other providers.
  const listeners = new Map(); let prepared;
  const signal = app.newRequest();
  app.prepare = async asset => { prepared = asset; return { blob: new w.Blob(['jpeg']), crop: { width: 1000, height: 1500 } }; };
  w.GM_addValueChangeListener = (jobKey, callback) => { listeners.set(jobKey, callback); return 99; };
  const card = w.document.createElement('div'); app.results.append(card);
  const config = api.uploadConfig(doc(fixture('movie-poster.html')), 'poster', app.target);
  const opener = w.document.createElement('button');
  app.sourceTab(title.sources[0], card, config, signal, opener);
  const [jobKey, callback] = [...listeners][0];
  await callback(jobKey, null, result);
  assert.match(prepared.url, /22222222-0000/); assert.equal(calls.filter(c => c.body).length, 0);
});

test('Disney+ rejects a landscape social asset as a poster and releases its decoded image', async t => {
  const { api, w, doc, objectURLs } = environment(t);
  w.Image = class { async decode() { this.naturalWidth = 3840; this.naturalHeight = 2160; } };
  const asset = api.disneyArtwork(doc(fixture('disney.html')), 'poster', disneyURL)[0];
  const config = api.uploadConfig(doc(fixture('movie-poster.html')), 'poster', { type: 'movie' });
  await assert.rejects(api.prepare(asset, config, new w.AbortController().signal, async () => new w.Blob(['image'])), /requested orientation/);
  assert.equal(objectURLs.size, 0);
});

test('direct URL UI fetches and remembers a source even if JustWatch returns nothing', async t => {
  const env = mockApp(t); const { app, stored, calls } = env;
  app.cross = async url => url.includes('justwatch') ? '{"data":{"searchTitles":{"edges":[]}}}' : fixture('apple-unavailable.html');
  app.open(); await tick();
  const input = app.panel.querySelector('[aria-label="Image or webpage URL"]');
  input.value = 'https://tv.apple.com/us/movie/example-i-love-you/umc.cmc.fixturemovietwo';
  app.directKind.value = 'poster';
  [...app.panel.querySelectorAll('button')].find(b => b.textContent === 'Fetch from URL').click();
  await tick(); await tick();
  assert.equal(app.results.querySelectorAll('img').length, 1);
  assert.equal(stored.get('direct-sources:movie:990000001')[0], input.value);
  assert.equal(calls.filter(c => c.body).length, 0);
  assert.match(app.panel.textContent, /Saved Apple TV link/);
});

test('Kanopy API denial offers a source tab; helper sends only artwork metadata using same-origin fetch', async t => {
  const env = mockApp(t); env.app.cross = async () => { throw new Error('Source returned HTTP 401.'); };
  await env.app.fetchTitle({ sources: [env.api.manualSource('https://www.kanopy.com/en/product/justwatch-990000003')] });
  assert.match(env.app.results.textContent, /Open source tab/);
  assert.equal(env.calls.filter(c => c.body).length, 0);
  const id = '11111111-1111-4111-8111-111111111111';
  const url = 'https://www.kanopy.com/en/product/justwatch-990000003';
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
  const url = 'https://www.kanopy.com/en/product/justwatch-990000003';
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
  assert.match(results[1].title, /Example/);
  assert.equal(api.googleResults(doc('<p>Enable JavaScript / consent / challenge</p>'), 'movie').length, 0);
  assert.equal(api.googleResults(doc(fixture('google.html')), 'tv').filter(r => r.sources[0].provider === 'Apple TV').length, 1);
  assert.equal(new URL(api.googleQueries('Example, I Love You')[0]).searchParams.get('q'), 'Example, I Love You prime video');
});

test('Google title cleanup separates provider labels and relative crawl dates', t => {
  const { api, doc } = environment(t);
  const url = 'https://www.primevideo.com/detail/TESTMOVIE2';
  const results = api.googleResults(doc(`<a href="${url}"><h3>Example Mystery<span>Prime Video</span><span>1 month ago</span></h3></a>`), 'movie');
  assert.equal(results[0].title, 'Example Mystery');
  assert.equal(api.cleanGoogleTitle('Watch Fixture - A Movie - Apple TV'), 'Fixture - A Movie');
  assert.equal(api.cleanGoogleTitle('A Movie from 1984'), 'A Movie from 1984');
});

test('provider metadata reads captured release years only from the current title', t => {
  const { api, doc } = environment(t);
  const amazon = 'https://www.amazon.com/gp/video/detail/TESTMOVIE1';
  const apple = 'https://tv.apple.com/gb/movie/fixture/umc.cmc.fixturemovieone';
  for (const [file, url] of [['amazon-metadata.html', amazon], ['apple-metadata.html', apple]]) {
    const result = api.providerMetadata(doc(fixture(file)), url);
    assert.equal(result.title, 'Fixture - A Movie'); assert.equal(result.year, '2017'); assert.equal(result.type, 'Movie');
  }
  assert.throws(() => api.providerMetadata(doc(fixture('apple-metadata.html')), apple + '-wrong'), /unavailable/);
  const noYear = api.providerMetadata(doc(fixture('amazon.html')), amazon);
  assert.equal(noYear.year, '');
  const ld = '<script type="application/ld+json">' + JSON.stringify({ '@type': 'Movie', name: 'Example Mystery', datePublished: '1965-07-24', url: amazon }) + '</script>';
  assert.equal(api.providerMetadata(doc(ld), amazon).year, '1965');
  assert.throws(() => api.providerMetadata(doc(ld.replace('TESTMOVIE1', 'TESTMOVIE2')), amazon), /unavailable/);
  assert.throws(() => api.providerMetadata(doc('<p>Movie recommendation 2020 · crawled 2026</p>'), amazon), /unavailable/);
});

test('Google cards enrich titles and years, highlight matches, and show one deduplicated count below results', async t => {
  const { app, calls, w } = mockApp(t);
  app.target = { ...app.target, title: 'Fixture: A Movie', year: '2017' };
  const amazon = 'https://www.amazon.com/gp/video/detail/TESTMOVIE1';
  const apple = 'https://tv.apple.com/gb/movie/fixture/umc.cmc.fixturemovieone';
  const search = `<a href="${amazon}"><h3>FixturePrime Video1 month ago</h3></a><a href="${apple}"><h3>Fixture - Apple TV</h3></a>`;
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
  assert.equal(section.querySelector('.google-heading').textContent, 'Google Search results');
  assert.doesNotMatch(section.textContent, /No exact JustWatch match|Check the title|month ago/);
  assert.equal(section.querySelectorAll('.google-card.exact-match').length, 2);
  for (const card of section.querySelectorAll('.google-card')) {
    assert.equal(card.querySelector('strong').textContent, 'Fixture - A Movie');
    assert.match(card.querySelector('.google-meta').textContent, /Movie · 2017$/);
    assert.equal(card.querySelector('.match-label').hidden, false);
    assert.equal(card.querySelector('.google-actions').children.length, 3);
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
  app.cache.clear();
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
  const pending = app.search('Example'); await tick();
  const before = app.results.textContent;
  app.close.click(); release.forEach(resolve => resolve(fixture('amazon-metadata.html'))); await pending;
  assert.equal(app.results.querySelectorAll('.exact-match').length, 0);
  assert.doesNotMatch(app.results.textContent, /Fixture/);
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
  await app.search('Example, I Love You');
  assert.equal(app.results.querySelectorAll('button').length, 4); // Two artwork actions per source.
  assert.equal(app.results.querySelectorAll('img').length, 0); assert.equal(calls.length, 0);
  jw = fixture('justwatch.json');
  app.cache.clear();
  await app.search('Example, I Love You');
  assert.equal(reads.filter(url => url.includes('google.com')).length, 6);
  const apple = [...app.results.querySelectorAll('.google-card')].find(card => card.querySelector('.google-meta')?.textContent.includes('Apple TV'));
  [...apple.querySelectorAll('button')].find(b => b.textContent === 'Fetch poster').click(); await tick(); await tick();
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
  await app.search('Fixture: A Movie'); assert.equal(searches, 0);
  for (const { node } of data.data.searchTitles.edges) node.offers = [];
  app.cache.clear();
  await app.search('Fixture: A Movie'); assert.equal(searches, 3);
  assert.match(app.results.textContent, /Searching in a background tab/);
});

test('Google errors retain readable results; closing aborts late search output', async t => {
  const { app, calls } = mockApp(t);
  app.cross = async url => {
    if (url.includes('justwatch')) throw new Error('JustWatch unavailable');
    if (new URL(url).searchParams.get('q').endsWith('prime video')) throw new Error('HTTP 429');
    return fixture('google.html');
  };
  await app.search('Example');
  assert.match(app.results.textContent, /Example, I Love You/);
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
  app.cross = async () => '{}'; await app.search('Example, I Love You');
  assert.equal(app.jobs.length, 3); assert.equal(tabs.length, 3); assert.ok(tabs.every(tab => !tab.options.active));
  const opened = tabs[0].url;
  const key = [...stored.keys()].find(k => k.startsWith('tmdb-artwork-job:'));
  const helper = environment(t, fixture('google.html'), opened);
  helper.stored.set(key, stored.get(key)); helper.api.start();
  const result = helper.stored.get(key);
  assert.equal(result.state, 'ready'); assert.equal(result.titles.length, 2); assert.equal(result.assets, undefined);
  await listeners.get(key)(key, null, result);
  assert.match(app.results.textContent, /Example, I Love You/);
  assert.equal(tabs[0].closed, true);
  assert.equal(calls.length, 0);
  const expired = environment(t, fixture('google.html'), opened);
  expired.stored.set(key, { ...result, state: 'waiting', expires: Date.now() - 1 }); expired.api.start();
  assert.equal(expired.stored.has(key), false);
  const wrong = environment(t, fixture('google.html'), opened.replace('Example', 'Different'));
  wrong.stored.set(key, { ...result, state: 'waiting' }); wrong.api.helper();
  assert.equal(wrong.stored.get(key).state, 'waiting');
  app.close.click(); assert.equal(tabs[1].closed, true); assert.equal(stored.has(key), false);
  const before = app.results.textContent;
  [...listeners.values()][1]('unused', null, result); assert.equal(app.results.textContent, before);
});

test('Google helper collects delayed results without a click and ignores cancelled or changed searches', async t => {
  const id = '11111111-1111-4111-8111-111111111111', key = 'tmdb-artwork-job:' + id;
  const url = 'https://www.google.com/search?q=Example';
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
  app.cross = async () => '{}'; await app.search('Example');
  assert.ok(tabs.every(tab => !tab.options.active));
  timers.find(timer => timer.delay === 20000).fn();
  const recover = [...app.results.querySelectorAll('button')].find(b => b.textContent === 'Open Google to resolve');
  assert.ok(recover); recover.click(); assert.equal(tabs[0].closed, true); assert.equal(tabs[3].options.active, true);
  timers.filter(timer => timer.delay === 600000).forEach(timer => timer.fn());
  assert.ok(tabs.every(tab => tab.closed)); assert.equal(stored.size, 0);
  recover.click(); assert.equal(tabs.length, 4); assert.equal(calls.length, 0);
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
    { node: { id: '1', objectType: 'MOVIE', content: { title: 'EXAMPLE MOVIE, FOUR!', originalReleaseYear: 2026 }, offers: [] } },
    { node: { id: '2', objectType: 'MOVIE', content: { title: 'Example Movie Four', originalReleaseYear: 2025 }, offers: [] } },
  ] } } });
  app.open(); await tick();
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
  const direct = await api.prepare({ generic: true, url: 'https://example.test/extensionless', variants: ['https://example.test/extensionless'], blob: input }, config, new w.AbortController().signal,
    async () => { throw new Error('The winning download must be reused'); });
  const directBytes = Buffer.from(await direct.blob.arrayBuffer());
  assert.equal(directBytes.subarray(0, 3).toString('hex'), 'ffd8ff');
  assert.equal((await loadImage(directBytes)).height, 3000); assert.equal(objectURLs.size, 0);
});

test('single toolbar entry opens dual artwork actions and exact streaming search links', async t => {
  const { app, api, w } = mockApp(t);
  const toolbar = app.shadow.querySelector('.toolbar');
  assert.deepEqual([...toolbar.querySelectorAll('button')].map(b => b.textContent), ['Fetch artwork', 'Settings']);
  app.target.title = 'Fixture: A Movie';
  toolbar.querySelector('button').click(); await tick(); await tick();
  const card = app.results.querySelector('.card');
  assert.deepEqual([...card.querySelectorAll('button')].map(b => b.textContent), ['Fetch background', 'Fetch poster']);
  assert.equal(app.directKind.value, 'backdrop');
  const input = app.panel.querySelector('[aria-label="Search title"]');
  input.value = 'Changed title'; input.dispatchEvent(new w.Event('input'));
  const links = app.discovery.querySelectorAll('details a');
  assert.equal(links.length, 1);
  assert.equal(new URL(links[0].href).searchParams.get('q'), `Changed title ${app.target.year} online`);
  assert.equal(new URL(api.discoveryLinks('Lost', { type: 'tv', year: '2004' })[0][1]).searchParams.get('q'), 'Lost tv show online');
  assert.equal(new URL(api.discoveryLinks('Unknown', { type: 'movie' })[0][1]).searchParams.get('q'), 'Unknown online');
});

test('Back preserves discovery state, ignores late work, and remains available on form failure', async t => {
  const { app, api, calls } = mockApp(t);
  app.target.title = 'Fixture: A Movie';
  app.open(); await tick(); await tick();
  const results = app.results, status = app.status, before = results.textContent;
  app.panel.querySelector('[aria-label="Search title"]').value = 'Kept query';
  app.panel.querySelector('[aria-label="Image or webpage URL"]').value = 'https://example.test/kept';
  app.panel.scrollTop = 83;
  let release;
  app.cross = () => new Promise(resolve => { release = resolve; });
  const selected = { sources: [api.manualSource('https://tv.apple.com/gb/movie/fixture/umc.cmc.fixturemovieone')] };
  const pending = app.fetchTitle(selected, 'poster'); await tick();
  const oldSignal = app.controller.signal;
  assert.match(app.status.textContent, /Fetching artwork/);
  app.preview.querySelector('button').click();
  assert.equal(oldSignal.aborted, true); assert.equal(app.results, results); assert.equal(app.status, status);
  assert.equal(app.panel.scrollTop, 83); assert.equal(app.discovery.hidden, false);
  assert.equal(app.panel.querySelector('[aria-label="Search title"]').value, 'Kept query');
  assert.equal(app.panel.querySelector('[aria-label="Image or webpage URL"]').value, 'https://example.test/kept');
  assert.equal(app.directKind.value, 'poster');
  release(fixture('apple.html')); await pending;
  assert.equal(results.textContent, before); assert.equal(calls.filter(c => c.body).length, 0);
  assert.equal(app.cache.get('provider:' + selected.sources[0].url), undefined);
  app.request = async () => { throw new Error('Sign in first'); };
  await app.fetchTitle(selected, 'poster'); assert.match(app.status.textContent, /Sign in first/);
  app.back(); assert.equal(app.results, results);
});

test('Back after upload allows another kind and cached provider artwork uses fresh TMDB forms', async t => {
  const { app, api, calls, doc } = mockApp(t);
  let reads = 0, releaseUpload;
  const originalRequest = app.request;
  app.request = async (url, options) => {
    if (url === '/image') { await new Promise(resolve => { releaseUpload = resolve; }); }
    return originalRequest(url, options);
  };
  const formKinds = [];
  app.config = async (_signal, kind = app.kind) => {
    formKinds.push(kind);
    const config = api.uploadConfig(doc(fixture('movie-poster.html')), 'poster', app.target);
    return { ...config, kind, ratioWidth: kind === 'poster' ? 2 : 16, ratioHeight: kind === 'poster' ? 3 : 9 };
  };
  app.cross = async () => { reads++; return fixture('apple.html'); };
  const selected = { sources: [api.manualSource('https://tv.apple.com/gb/movie/fixture/umc.cmc.fixturemovieone')] };
  await app.fetchTitle(selected, 'poster');
  const oldBlock = app.results;
  const upload = [...oldBlock.querySelectorAll('button')].find(b => b.textContent === 'Upload this image');
  upload.click(); await tick();
  assert.equal(app.preview.querySelector('button').disabled, true);
  app.back(); assert.equal(app.previewing, true);
  releaseUpload(); await tick(); await tick();
  assert.equal(app.preview.querySelector('button').disabled, false);
  assert.match(oldBlock.textContent, /Uploaded/);
  app.back(); await app.fetchTitle(selected, 'backdrop');
  assert.equal(reads, 1); assert.deepEqual(formKinds, ['poster', 'poster', 'backdrop']);
  assert.equal(app.results.querySelector('[aria-label="Image language"]').value, 'xx-XX');
  upload.click(); await tick(); assert.equal(calls.filter(c => c.url === '/image').length, 1);
});

test('manual Google adds cards beside JustWatch and deduplicates concurrent and repeated searches', async t => {
  const { app } = mockApp(t); const reads = [];
  app.target.title = 'Fixture: A Movie';
  app.cross = async url => {
    reads.push(url);
    if (url.includes('justwatch')) return fixture('justwatch.json');
    if (url.includes('google.com')) return fixture('google.html');
    return fixture('apple-unavailable.html');
  };
  app.open(); await tick(); await tick();
  const first = app.results.firstElementChild;
  assert.equal(app.results.querySelector('.google-section'), null);
  await Promise.all([app.manualGoogle('Example'), app.manualGoogle('Example')]);
  await app.manualGoogle('Example');
  assert.equal(app.results.firstElementChild, first);
  assert.equal(app.results.querySelectorAll('.google-section').length, 1);
  assert.equal(app.results.querySelectorAll('.google-card').length, 2);
  assert.equal(reads.filter(url => url.includes('google.com')).length, 3);
});

test('cache shares results across app instances, isolates query/region keys, expires and clears without deleting preferences', async t => {
  const { app, api, w, stored } = mockApp(t);
  let now = 1000, reads = 0; w.Date.now = () => now;
  app.cross = async () => { reads++; return fixture('justwatch.json'); };
  await app.search('Fixture: A Movie');
  const second = new api.App(app.target, { cross: app.cross }); t.after(() => second.cleanup());
  second.shell('Second'); second.results = w.document.createElement('div'); second.status = w.document.createElement('p');
  await second.search('Fixture: A Movie'); assert.equal(reads, 1);
  stored.set('regions', ['US', 'GB']);
  await second.search('Fixture: A Movie'); assert.equal(reads, 2);
  now += 15 * 60 * 1000 + 1;
  await second.search('Fixture: A Movie'); assert.equal(reads, 4);
  await app.cached('query:one', app.controller.signal, async () => ++reads);
  await app.cached('query:two', app.controller.signal, async () => ++reads); assert.equal(reads, 6);
  stored.set('direct-sources:movie:1', ['https://example.test/image']);
  second.settings(); [...second.panel.querySelectorAll('button')].find(b => b.textContent === 'Clear cache').click();
  assert.ok(stored.has('regions')); assert.ok(stored.has('direct-sources:movie:1'));
  assert.equal([...stored.keys()].filter(k => k.startsWith('tmdb-artwork-cache:')).length, 0);
});

test('cache limits, failed/cancelled requests and unavailable storage preserve uncached fetching', async t => {
  const { app, api, stored, w } = mockApp(t);
  const cache = new api.Cache(); let time = 0; w.Date.now = () => ++time;
  for (let i = 0; i < 201; i++) cache.set(String(i), i);
  assert.equal(cache.get('0'), undefined); assert.equal(cache.records().length, 200);
  cache.clear();
  cache.set('large1', 'x'.repeat(1500000)); cache.set('large2', 'x'.repeat(1500000));
  assert.equal(cache.get('large1'), undefined); assert.ok(cache.get('large2'));
  cache.set('too-large', 'x'.repeat(3 * 1024 * 1024)); assert.equal(cache.get('too-large'), undefined);
  let attempts = 0;
  for (let i = 0; i < 2; i++) await assert.rejects(app.cached('fail', app.controller.signal, async () => { attempts++; throw new Error('Denied'); }), /Denied/);
  assert.equal(attempts, 2); assert.equal(cache.get('fail'), undefined);
  const controller = new w.AbortController();
  await assert.rejects(app.cached('cancel', controller.signal, async () => { controller.abort(); return 'late'; }), /Cancelled/);
  assert.equal(cache.get('cancel'), undefined);
  w.GM_getValue = w.GM_setValue = w.GM_listValues = () => { throw new Error('Storage unavailable'); };
  assert.equal(await app.cached('offline-storage', app.controller.signal, async () => 'network result'), 'network result');
  assert.ok(stored.size > 0);
});

test('blob cache expires and evicts without retaining oversized images', t => {
  const { api, w } = environment(t); const cache = new api.Cache(); let now = 0; w.Date.now = () => now;
  const blob = { size: 30 * 1024 * 1024 };
  cache.setBlob('one', blob); cache.setBlob('two', blob);
  assert.equal(cache.getBlob('one'), undefined); assert.equal(cache.getBlob('two'), blob);
  cache.setBlob('huge', { size: 51 * 1024 * 1024 }); assert.equal(cache.getBlob('huge'), undefined);
  now = 15 * 60 * 1000; assert.equal(cache.getBlob('two'), undefined);
});

test('detailed cross-origin responses preserve MIME and redirected URL without changing old callers', async t => {
  const { api, w } = environment(t); const blob = new w.Blob(['image'], { type: 'image/png' });
  w.GM_xmlhttpRequest = options => {
    queueMicrotask(() => options.onload({ status: 200, response: blob, responseText: 'text', responseHeaders: 'Content-Type: image/png\r\n', finalUrl: 'https://cdn.test/final' }));
    return { abort() {} };
  };
  const response = await api.crossRequest('https://example.test/redirect', { blob: true, detailed: true });
  assert.equal(response.body, blob); assert.equal(response.contentType, 'image/png'); assert.equal(response.finalURL, 'https://cdn.test/final');
  assert.equal(await api.crossRequest('https://example.test/old'), 'text');
});

test('generic HTML discovers responsive, lazy, structured and inline images relative to the redirected base', t => {
  const { api, doc } = environment(t);
  const html = `<base href="../assets/"><meta property="og:image" content="poster.jpg"><meta name="twitter:image" content="poster.jpg">
    <picture><source srcset="small.jpg 400w, large.jpg 2000w"><img src="fallback.jpg" width="9000" height="12000" data-original="lazy.jpg" data-srcset="lazy2.jpg 2x"></picture>
    <div style="background-image:url('wide.jpg')"></div>
    <script type="application/ld+json">{"image":[{"url":"structured.jpg"}],"subjectOf":{"@type":"ImageObject","contentUrl":"nested.jpg"}}</script>
    <img src="javascript:alert(1)"><img src="https://user:password@host.test/private"><img src="/root.jpg?size=large&token=abc,">`;
  const urls = Array.from(api.pageImages(doc(html), 'https://example.test/redirect/page'));
  assert.deepEqual(urls, ['small.jpg', 'large.jpg', 'fallback.jpg', 'lazy.jpg', 'lazy2.jpg', '/root.jpg?size=large&token=abc,', 'poster.jpg', 'wide.jpg', 'structured.jpg', 'nested.jpg'].map(p => new URL(p, 'https://example.test/assets/').href));
  assert.deepEqual(Array.from(api.pageImages(doc('<base href="javascript:bad"><img src="a.jpg">'), 'https://example.test/path/page')), ['https://example.test/path/a.jpg']);
});

function genericApp(t) {
  const env = mockApp(t); const { app } = env; const reads = []; const sizes = new Map();
  const pageURL = 'https://example.test/page?keep=1';
  app.decode = async blob => {
    if (!blob.dimensions) throw new Error('Not an image');
    return { ...blob.dimensions, close() {} };
  };
  app.cross = async (url, options) => {
    reads.push(url);
    if (options.detailed) return { body: new Blob([`<img src="/a.jpg" width="99999" height="99999"><img src="/b.jpg"><img src="/wide.jpg"><img src="/square.jpg"><img src="/broken.jpg">`], { type: 'text/html' }), contentType: 'text/html', finalURL: pageURL };
    if (!sizes.has(url)) throw new Error('HTTP 404');
    return { size: 100, dimensions: sizes.get(url) };
  };
  sizes.set('https://example.test/a.jpg', { width: 1000, height: 1500 });
  sizes.set('https://example.test/b.jpg', { width: 2000, height: 3000 });
  sizes.set('https://example.test/wide.jpg', { width: 3840, height: 2160 });
  sizes.set('https://example.test/square.jpg', { width: 6000, height: 6000 });
  return { ...env, reads, sizes, pageURL, source: env.api.manualSource(pageURL), config: { kind: 'poster', ratioWidth: 2, ratioHeight: 3, minWidth: 500, minHeight: 750, maxWidth: 2000, maxHeight: 3000 } };
}

test('generic selection measures actual size, filters orientation, caches candidates and reuses the winning blob', async t => {
  const { app, source, config, reads, stored, w } = genericApp(t); const signal = app.controller.signal;
  let now = 1000; w.Date.now = () => now;
  const poster = await app.genericAssets(source, config, signal);
  assert.equal(poster[0].url, 'https://example.test/b.jpg'); assert.ok(poster[0].blob);
  const entry = [...stored.keys()].find(key => key.includes('page:'));
  const expiry = stored.get(entry).expires; now += 10000;
  const before = reads.length;
  const background = await app.genericAssets(source, { ...config, kind: 'backdrop', ratioWidth: 16, ratioHeight: 9 }, signal);
  assert.equal(background[0].url, 'https://example.test/wide.jpg');
  assert.equal(reads.length, before + 1); // Only the failed candidate is retried.
  assert.equal(reads.filter(url => url === source.url).length, 1);
  assert.equal(app.cache.get('dimensions:https://example.test/a.jpg').width, 1000);
  assert.equal(stored.get(entry).expires, expiry);
});

test('generic candidates limit concurrency, skip small crops, and rank equal areas by aspect ratio', async t => {
  const { app, source, config, sizes } = genericApp(t); let active = 0, maxActive = 0;
  const cross = app.cross;
  app.cross = async (url, options) => {
    if (options.detailed) return cross(url, options);
    active++; maxActive = Math.max(maxActive, active);
    await tick(); const result = await cross(url, options).finally(() => active--); return result;
  };
  sizes.set('https://example.test/a.jpg', { width: 1500, height: 4000 }); // Same area, poorer crop.
  sizes.set('https://example.test/wide.jpg', { width: 200, height: 90000 }); // Largest area, too narrow.
  const assets = await app.genericAssets(source, config, app.controller.signal);
  assert.equal(assets[0].url, 'https://example.test/b.jpg'); assert.equal(maxActive, 3);
});

test('direct extensionless images support redirects and non-image responses fail without caching', async t => {
  const { app, source, config, reads } = genericApp(t);
  const blob = { size: 100, dimensions: { width: 1600, height: 2400 } }; let requests = 0;
  app.cross = async () => { requests++; return { body: blob, contentType: 'application/octet-stream', finalURL: 'https://cdn.test/no-extension' }; };
  const assets = await app.genericAssets(source, config, app.controller.signal);
  assert.equal(assets[0].blob, blob); assert.equal(assets[0].generic, true);
  await app.genericAssets(source, config, app.controller.signal); assert.equal(requests, 1);
  app.cache.clear();
  app.cross = async () => ({ body: new Blob(['<h1>Nothing here</h1>']), contentType: 'application/octet-stream', finalURL: source.url });
  await assert.rejects(app.genericAssets(source, config, app.controller.signal), /No suitable image/);
  assert.equal(app.cache.get('page:' + source.url), undefined); assert.equal(reads.length, 0);
});

test('generic fetch cancellation discards late images and no matching orientation gives an actionable error', async t => {
  const { app, source, config, sizes } = genericApp(t);
  for (const key of sizes.keys()) sizes.set(key, { width: 2000, height: 1000 });
  await assert.rejects(app.genericAssets(source, config, app.controller.signal), /No suitable image/);
  assert.equal(app.cache.get('page:' + source.url), undefined);
  app.cache.clear(); let release;
  app.cross = () => new Promise(resolve => { release = resolve; });
  const pending = app.genericAssets(source, config, app.controller.signal);
  app.controller.abort(); release({ body: new Blob(['']), contentType: 'text/html', finalURL: source.url });
  await assert.rejects(pending, /Cancelled/); assert.equal(app.cache.get('page:' + source.url), undefined);
});

test('returning from preview retries interrupted Google work without duplicate or stale cards', async t => {
  const { app, api } = mockApp(t); const pending = [];
  app.cross = async url => url.includes('justwatch') ? '{}' : url.includes('google.com') ? fixture('google.html') : new Promise(resolve => pending.push(resolve));
  const searching = app.search('Example'); await tick();
  assert.equal(app.results.querySelectorAll('.google-card').length, 2);
  const provider = api.manualSource('https://www.kanopy.com/en/product/justwatch-990000003');
  app.config = async () => { throw new Error('No session'); };
  await app.fetchTitle({ sources: [provider] }, 'poster'); app.back();
  assert.match(app.results.textContent, /Search paused/);
  assert.doesNotMatch(app.results.textContent, /Reading year/);
  app.cross = async () => fixture('apple-unavailable.html');
  await app.manualGoogle('Example');
  pending.forEach(resolve => resolve(fixture('amazon-metadata.html'))); await searching;
  assert.equal(app.results.querySelectorAll('.google-section').length, 1);
  assert.equal(app.results.querySelectorAll('.google-card').length, 2);
  assert.doesNotMatch(app.results.textContent, /Fixture|Search paused|Reading year/);
});

test('retrying an expired Google section closes any remaining old helpers', async t => {
  const { app, w } = mockApp(t); const tabs = [];
  w.GM_openInTab = () => { const tab = { closed: false, close() { this.closed = true; } }; tabs.push(tab); return tab; };
  app.cross = async () => '{}'; await app.search('Example');
  const section = app.results.querySelector('.google-section');
  section.dataset.interrupted = 'true';
  await app.manualGoogle('Example');
  assert.equal(tabs.length, 6); assert.ok(tabs.slice(0, 3).every(tab => tab.closed));
  assert.equal(app.results.querySelectorAll('.google-section').length, 1);
  app.cleanup(); assert.ok(tabs.every(tab => tab.closed));
});

test('Back cancels JPEG preparation and provider helpers, with no stale previews or upload controls', async t => {
  const { app, api, objectURLs, w } = mockApp(t); let release;
  const selected = { sources: [api.manualSource('https://tv.apple.com/gb/movie/fixture/umc.cmc.fixturemovieone')] };
  app.cross = async () => fixture('apple.html');
  app.prepare = () => new Promise(resolve => { release = resolve; });
  const pending = app.fetchTitle(selected, 'poster'); await tick();
  app.back();
  release({ blob: new w.Blob(['jpeg']), crop: { width: 2000, height: 3000 }, sourceWidth: 2000, sourceHeight: 3000 });
  await pending;
  assert.equal(objectURLs.size, 0); assert.equal(app.results.querySelectorAll('img').length, 0);
  app.cache.clear(); app.cross = async () => { throw new Error('Provider challenge'); };
  let closed = false; w.GM_openInTab = () => ({ close() { closed = true; } });
  await app.fetchTitle(selected, 'poster');
  [...app.results.querySelectorAll('button')].find(b => b.textContent === 'Open source tab').click();
  app.back(); assert.equal(closed, true); assert.equal(app.jobs.length, 0);
});

test('cached dimensions cannot make an unavailable image beat a downloadable candidate', async t => {
  const { app, source, config, sizes } = genericApp(t);
  await app.genericAssets(source, config, app.controller.signal);
  app.cache.blobs.clear(); sizes.delete('https://example.test/b.jpg');
  const assets = await app.genericAssets(source, config, app.controller.signal);
  assert.equal(assets[0].url, 'https://example.test/a.jpg');
});

test('upload retains its preview kind even if the next selection changes', async t => {
  const env = mockApp(t); const upload = await addPreview(env);
  env.app.kind = 'backdrop'; upload.click(); await tick(); await tick();
  assert.ok(env.calls.some(c => c.url.endsWith('/posters/upload')));
  assert.ok(!env.calls.some(c => c.url.endsWith('/backdrops/upload')));
  assert.equal(env.calls.filter(c => c.url === '/image').length, 1);
});
