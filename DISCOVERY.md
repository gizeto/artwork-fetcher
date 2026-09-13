# Discovery notes

Checked September 12, 2026. Availability and search indexes vary by region and time.

## Unavailable titles

**Bigfoot, I Love You** was absent from the tested JustWatch US results, Apple/iTunes
search, and Prime Video search, but its [Prime page](https://www.primevideo.com/-/de/detail/0ISBAPQV85YPX8VRKEZT6I3WMC)
still exposed hero artwork. Its [Apple page](https://tv.apple.com/us/movie/bigfoot-i-love-you/umc.cmc.70td6qpxeljnbp2jd9425btiw)
provided a 1920×1080 background and a 400×574 poster (too small for TMDB).
The captured JustWatch offers-history response contained no former provider URLs.

The script searches JustWatch first, then Google for `<title> prime video` and
`<title> apple tv` when an exact match lacks supported links. Google results are
deduplicated candidates requiring selection. Pasted provider URLs also work and
are remembered per TMDB title.

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
  Unwrap the image proxy to fetch originals; Travel Socks supplied 1920×1080
  landscape and 1548×2189 portrait images. Tokens stay in memory and go only to Kanopy.

These website interfaces are undocumented and may change. Discovery is best effort;
always verify the selected title and final JPEG before uploading.
