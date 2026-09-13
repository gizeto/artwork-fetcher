# artwork-fetcher

Find Amazon/Prime Video, Apple TV, and Kanopy backgrounds and posters from TMDB.
Preview a high-quality JPEG, then upload only when you confirm. No API key or backend.
Currently supports movies and whole TV series, including image galleries; TVDB is not supported yet.

## Install and update

1. Install [Tampermonkey](https://www.tampermonkey.net/) and [enable userscripts](https://www.tampermonkey.net/faq.php#Q209).
2. **[Install artwork-fetcher](https://raw.githubusercontent.com/gizeto/artwork-fetcher/main/artwork-fetcher.user.js)** and allow its listed host permissions.
3. Log into TMDB and reload a movie or TV series page.

Tampermonkey checks the same raw URL for updates. These links become available
once this repository is published as `gizeto/artwork-fetcher` on branch `main`.
For local installation, paste [the script](artwork-fetcher.user.js) into Tampermonkey.
If upgrading from **TMDB artwork finder**, disable the old script before installing
this renamed version to avoid duplicate scripts.

## Use

- Click **Fetch background** or **Fetch poster**, then choose a matching title.
  A subtle green highlight marks results whose title and known year match TMDB,
  ignoring capitalization, punctuation, and spacing. Different years remain selectable.
- **Settings** saves JustWatch regions (`US` by default; e.g. `US, GB, PL`).
- If JustWatch lacks an exact match with a usable provider link, Google searches
  automatically. If its HTML needs JavaScript, temporary background tabs collect
  results and close automatically. No send click is needed. Consent/challenges
  still require you to use **Open Google to resolve**. Search terms go to Google;
  results are candidates and may have no reliable year.
- Below results, **No streaming link? Find or paste a provider page** accepts and
  remembers provider URLs, including titles no longer offered for streaming.
- Review the exact JPEG, crop, and image language before **Upload this image**.
  Backgrounds default to no language; posters to English. **Save JPEG** downloads
  locally. The top-right **×** cancels searches/downloads and closes temporary Google tabs.

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

Tests cover parsing, matching, real JPEG output, automatic Google helpers,
cancellation, and mocked uploads. Fixtures contain public metadata and synthetic
tokens; keep HARs and secrets out of Git. Live HTTP checks verified provider
artwork and Kanopy's visitor handshake. Chrome/Tampermonkey smoke testing remains
outstanding; automated tests perform no live uploads.
