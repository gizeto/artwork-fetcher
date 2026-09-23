# Discovery notes

Checked September 12, 2026. Availability and search indexes vary by region and time.

## Unavailable titles

**Example, I Love You** was absent from the tested JustWatch US results, Apple/iTunes
search, and Prime Video search, but its [Prime page](https://www.primevideo.com/-/de/detail/TESTMOVIE000000000000000001)
still exposed hero artwork. Its [Apple page](https://tv.apple.com/us/movie/example-i-love-you/umc.cmc.fixturemovietwo)
provided a 1920×1080 background and a 400×574 poster (too small for TMDB).
The captured JustWatch offers-history response contained no former provider URLs.

The script searches JustWatch first, then Google for `<title> prime video` and
`<title> apple tv` when an exact match lacks supported links. Google results are
deduplicated candidates requiring selection. Pasted provider URLs also work and
are remembered per TMDB title.

Version 1.5 also lets users run these Google queries manually alongside JustWatch
results. Search and provider metadata are reused for 15 minutes across reloads.
Arbitrary HTTP(S) URLs can supply a direct image or static HTML image candidates;
the largest decoded image of the requested orientation that meets TMDB crop limits
is selected. Generic extraction does not execute page scripts or crawl linked pages
or stylesheets. Existing provider handlers remain the preferred path for title URLs.

Google's HTTP response may require JavaScript. The script then uses a temporary
background tab, observes rendered links, returns them automatically, and closes
the tab. Consent/CAPTCHA still needs user action. This uses
[Tampermonkey's tab API](https://www.tampermonkey.net/documentation.php?locale=en&q=GM_openInTab);
background-tab integration is tested with mocks, not yet in live Chrome.

## Artwork sources

- **Amazon:** current-title hydration metadata; compare the original image with
  `SX4096_FMavif_PQ100`. Requested size does not guarantee native resolution.
- **Apple:** current-title artwork templates in `serialized-server-data`, resolved
  at declared dimensions. A surviving page can be absent from catalog searches.
- **Kanopy:** `/kapi/handshake` supplies a visitor JWT and storefront ID before
  `/kapi/videos/alias/<alias>`. This fixed the metadata 401 in a live HTTP check.
  Unwrap the image proxy to fetch originals; Example Journey supplied 1920×1080
  landscape and 1548×2189 portrait images. Tokens stay in memory and go only to Kanopy.

These website interfaces are undocumented and may change. Discovery is best effort;
always verify the selected title and final JPEG before uploading.
