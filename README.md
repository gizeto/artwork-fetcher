# artwork-fetcher

A Tampermonkey userscript for finding and previewing TMDB backgrounds and posters
from Amazon/Prime Video, Apple TV, Kanopy, Disney+, or a pasted image/webpage URL.
Supports movies and whole TV series. No API key or backend required.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) and enable userscripts.
2. [Install the script](https://raw.githubusercontent.com/gizeto/artwork-fetcher/main/artwork-fetcher.user.js)
   and allow its host permissions. Tampermonkey checks this URL for updates.
3. Sign into TMDB and reload a movie, series, or artwork gallery page.

## Use

- Click **Fetch artwork**, then **Fetch background** or **Fetch poster** on a result.
  Green highlights mark matching titles and years; always review the image.
- JustWatch searches first; Google runs automatically when no exact usable match
  exists. **Search Google** runs it manually. **Settings** selects JustWatch regions.
- Paste an image or webpage URL and choose **Fetch from URL**. Generic webpages use
  static HTML; if JavaScript is required, paste a direct image URL.
- If fetching is blocked, use **Open source tab**, resolve the challenge, and click
  **Send artwork to TMDB**. Google consent/challenges use **Open Google to resolve**.
- Review the JPEG, crop, and language, then **Upload this image** or **Save JPEG**.
  Images are center-cropped to 16:9 or 2:3 within TMDB's limits, without enlarging.
- **Back to results** restores the search; **×** cancels work and closes Google helpers.
  Results are cached for 15 minutes; **Clear cache** keeps settings and saved links.

Uploads require confirmation. After an ambiguous failure, check the gallery before
retrying; **Retry language only** never uploads the image again.
See [DISCOVERY.md](DISCOVERY.md) for provider details and limitations.

## Development

```sh
npm ci
npm test
node --check artwork-fetcher.user.js
```

Tests use synthetic titles, URLs, and tokens, with mocked requests and no live uploads.
Live Chrome/Tampermonkey smoke testing remains outstanding.
