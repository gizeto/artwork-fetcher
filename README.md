# artwork-fetcher

Find Amazon/Prime Video, Apple TV, Kanopy, and Disney+ backgrounds and posters from TMDB,
or use an image or webpage URL from another site.
Preview a high-quality JPEG, then upload only when you confirm. No API key or backend.
Currently supports movies and whole TV series, including image galleries; TVDB is not supported yet.

## Install and update

1. Install [Tampermonkey](https://www.tampermonkey.net/) and [enable userscripts](https://www.tampermonkey.net/faq.php#Q209).
2. **[Install artwork-fetcher](https://raw.githubusercontent.com/gizeto/artwork-fetcher/main/artwork-fetcher.user.js)** and allow its host permissions. Version 1.6 adds Disney+ title artwork, discovery, and helper pages. Version 1.5 added wildcard connection permission for pasted webpages and their image CDNs; Tampermonkey may ask you to allow a new host. The script runs only on TMDB and the provider/Google helper pages.
3. Log into TMDB and reload a movie or TV series page.

Tampermonkey checks the same raw URL for updates. These links become available
once this repository is published as `gizeto/artwork-fetcher` on branch `main`.
For local installation, paste [the script](artwork-fetcher.user.js) into Tampermonkey.
If upgrading from **TMDB artwork finder**, disable the old script before installing
this renamed version to avoid duplicate scripts.

## Use

- Click **Fetch artwork**, then choose **Fetch background** or **Fetch poster**
  on a matching result card.
  A subtle green highlight marks results whose title and known year match TMDB,
  ignoring capitalization, punctuation, and spacing. Different years remain selectable.
- **Settings** saves JustWatch regions (`US` by default; e.g. `US, GB, PL`).
  **Clear cache** clears fetched data while keeping settings and saved links.
- If JustWatch lacks an exact match with a usable provider link, Google searches
  automatically. If its HTML needs JavaScript, temporary background tabs collect
  results and close automatically. No send click is needed. Consent/challenges
  still require you to use **Open Google to resolve**. Search terms go to Google;
  results are candidates and may have no reliable year.
- **Search Google** also runs those provider searches manually, appending cards
  alongside JustWatch results, even when JustWatch has an exact match.
- **Disney+** title links work in JustWatch results, Google searches, and pasted URLs,
  including `/browse/entity-…` links. Native backgrounds and portraits are fetched
  without the webpage's resizing and social-image crops. If the native social image
  is landscape-only, poster fetching reports an error so you can choose another source.
- Below results, **Find or paste an image or webpage URL** accepts and remembers
  HTTP(S) URLs. Select Background or Poster, then **Fetch from URL**. Recognized
  provider title pages use their dedicated handlers. Direct image links, including
  extensionless links, go straight to JPEG preparation. Other webpages use the
  largest downloadable image with the requested orientation that meets TMDB's
  crop limits. Actual decoded dimensions determine size; square images are skipped.
  Only fetched HTML is inspected, including responsive/lazy images and image
  metadata. For pages requiring JavaScript or a challenge, paste a direct image URL.
- **Search Google for streaming options** opens `<title> <year> online` for movies
  (omitting an unknown year) or `<title> tv show online` for series.
- **Back to results** cancels unfinished fetching and restores your query, cards,
  pasted URL, and scroll position. Choose another source or artwork type, including
  after an upload. Navigation is disabled while an upload is in progress.
- Review the exact JPEG, crop, and image language before **Upload this image**.
  Backgrounds default to no language; posters to English. **Save JPEG** downloads
  locally. The top-right **×** cancels searches/downloads and closes temporary Google tabs.

Search results, provider metadata for both artwork types, webpage image candidates,
and measured image dimensions are cached for **15 minutes across tabs and reloads**.
Persistent cache storage is bounded to 200 records and about 5 MiB. Downloaded images
are reused for 15 minutes within the TMDB tab, up to 50 MiB; larger images still work
without being cached. Failed/cancelled requests and challenges are retried. Kanopy
credentials and TMDB upload forms/tokens are never persisted in this cache, and the
upload session is checked afresh before every upload.

Images use the largest available source, are center-cropped to 16:9 or 2:3, and
converted to JPEG at 90% quality to keep file sizes reasonable. TMDB's live limits determine downscaling; images
are never enlarged. If a provider blocks fetching, **Open source tab** and use
**Send artwork to TMDB** after resolving the challenge.

Uploads always require confirmation. **Retry language only** cannot duplicate an
upload; after an ambiguous upload failure, check the gallery before trying again.
Helper requests expire after ten minutes and share only title/artwork metadata.
See [DISCOVERY.md](DISCOVERY.md) for provider findings and limitations.

## Development

```sh
npm ci
npm test
node --check artwork-fetcher.user.js
```

Tests cover provider parsing (including Disney+), matching, real JPEG output, manual/automatic Google searches,
Back navigation, cache expiry and limits, arbitrary URL image selection,
cancellation, and mocked uploads. Fixtures contain public metadata and synthetic
tokens; keep HARs and secrets out of Git. Live HTTP checks verified provider
artwork and Kanopy's visitor handshake. Chrome/Tampermonkey smoke testing remains
outstanding; automated tests perform no live uploads.
