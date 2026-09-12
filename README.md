# TMDB artwork userscript

## Tampermonkey userscript

[`tmdb-artwork.user.js`](tmdb-artwork.user.js) finds Amazon Video, Apple TV, and Kanopy
backgrounds/posters from a TMDB movie or TV series page. It prepares a JPEG in your
browser and uploads it only when you click **Upload this image** in its preview.
No API key, Python process, or backend is needed.

### Install and use

1. Install [Tampermonkey](https://www.tampermonkey.net/) in a current version of
   Chrome. Enable userscripts as described in its
   [browser setup instructions](https://www.tampermonkey.net/faq.php#Q209).
2. In Tampermonkey, create a new script, replace the template with the entire
   contents of `tmdb-artwork.user.js`, and save it. Allow requests to the provider
   domains listed in the script when Tampermonkey asks.
3. Log in to TMDB and reload a movie or TV series page. The controls appear in
   the bottom-right corner, including on its poster/background gallery pages.
4. Click **Fetch background** or **Fetch poster**. Search starts with the TMDB
   title; edit the query if necessary. Select the matching title and release year.
5. Compare the provider images. Click a preview to enlarge it, review its crop and
   language, then click **Upload this image**. **Save JPEG** downloads the same file
   without uploading it. **Close** cancels pending searches/downloads.

This directory is a standalone Git repository. Run its development commands here;
the parent directory keeps the separate Python downloader and ignored HAR files.

**Settings** saves your JustWatch regions. The default is `US`; for example,
`US, GB, PL` combines those markets. Language is an editable TMDB language tag:
`xx-XX` means no language, `en-US` means English, and `pl-PL` means Polish. The
defaults are no language for backgrounds and English for posters; choose the
language of text visible in the image before uploading.

If a provider request is blocked, click **Open source tab**, resolve any sign-in
or challenge yourself, and click **Send artwork to TMDB** there. Return to TMDB
to review the image. The helper exchanges only artwork metadata, never session
cookies or TMDB tokens, and expires after ten minutes. It does not upload anything.

### Titles without current streaming offers

Expand **No streaming link? Find or paste a provider page**. Use the provider-search
or indexed-web-search links, then paste the Amazon/Prime Video, Apple TV, or Kanopy
title URL into **Fetch from URL**. This path does not require a JustWatch result.
The link is remembered for that TMDB title and can be reused with **Fetch saved
… link**. **Forget saved links** removes those local mappings.

An existing page can retain artwork even when a provider's own search and JustWatch
do not list the title. The discovery buttons open normal browser search tabs;
the script does not scrape search-engine results or silently select a title.
See [the investigation and tested examples](DISCOVERY.md).

### Kanopy

Kanopy links from JustWatch and direct `/product/<alias>` URLs are supported. The
script requests the title's video metadata, selects `landscapes` or `posters`, and
unwraps the image proxy URL to download the original `static-assets.kanopy.com`
file. It does not enlarge Kanopy's 960px thumbnail or request a stretched 4096px copy.

The captured title endpoint is `/kapi/videos/alias/<alias>?webshopId=9`. It returned
200 in the supplied browser capture, but 401 in standalone checks, including after
loading its public page with a fresh cookie jar. The script allows Kanopy-scoped cookies
on this request. If it fails, **Open source tab**, let the Kanopy page load, then
click **Send artwork to TMDB**. The helper makes the same-origin metadata request.
No Kanopy credentials or cookies are copied to TMDB or other tabs. This browser
session path is covered by mocked tests but still needs a real browser check.

### Image processing and limitations

- Providers are shown when JustWatch has video title links for them in your chosen
  regions. Physical disc offers and generic provider homepage links are excluded. One provider
  failing does not discard images already fetched from another.
- Amazon compares the original asset with `SX4096_FMavif_PQ100` and keeps the larger
  decoded result. Apple uses the current title's artwork at its declared source
  dimensions. A large requested URL does not guarantee a large original image.
- Kanopy downloads its original landscape/poster image, with no resizing-proxy
  transformation. In the supplied Travel Socks example those originals are
  1920×1080 and 1548×2189 respectively, before the TMDB crop.
- The image is center-cropped, never enlarged, and saved as JPEG at canvas quality
  `1.0`. Browser JPEG encoding is browser-dependent. The exact final JPEG is shown
  before upload. Amazon's portrait image can have a different ratio from TMDB.
  Some Amazon series supply landscape promotional artwork rather than a portrait
  poster; those previews show an extra crop warning. Provider pages may describe a
  particular season, so check the displayed source title as well as the image.
- Limits are read from TMDB's upload form: currently backgrounds are 16:9,
  1280×720 to 3840×2160; posters are 2:3, 500×750 to 2000×3000. Images too small
  after cropping cannot be uploaded. Larger images are downscaled to the limit.
- Filenames use Unix seconds and the TMDB title/year, e.g.
  `1789226796_flatball-a-history-of-ultimate-2016_bg.jpg` or `_poster.jpg`.
  Downloads use your browser's normal destination, not the Python script's folder.
- Upload uses TMDB's existing browser session and fresh form settings. A response
  marked “processing” means TMDB accepted the image but is still processing it.
  Language assignment is a separate request; **Retry language only** will not
  upload the image a second time.
- An uncertain upload failure disables that submission. Check the gallery before
  starting over, since TMDB may already have received the image.
- Version one supports whole movies and TV series, not seasons or episodes.
  These website interfaces are undocumented and may change. Provider recovery
  requires the source tab to retain the helper fragment and remain on the same
  origin. Currently supported Amazon storefronts are listed in the userscript's
  `@match`/`@connect` header, alongside Prime Video, Apple TV, and Kanopy.

### Development and verification

```sh
npm ci
npm test
node --check tmdb-artwork.user.js
```

Development dependencies provide a simulated DOM and a native canvas renderer;
they are not part of the installed userscript. The small fixtures under
`tests/fixtures/` contain only public title/artwork data and synthetic form tokens.
Raw HARs, browser environments, and downloads remain ignored by Git.

Tests cover provider parsing, region merging, TMDB form variants, real JPEG bytes
and cropping, mocked upload confirmation, cancellation, double-click prevention,
uncertain failures, language-only retries, Kanopy metadata/native image selection,
and direct provider URLs without JustWatch results. Read-only live checks verified
JustWatch search, movie/TV artwork extraction from Amazon and Apple, and Kanopy's
original image downloads. The standalone Kanopy metadata limitation is noted above.

A connected Chrome/Tampermonkey session was unavailable during development, so
extension permissions and the real browser upload flow still need a smoke test.
To do that, fetch and inspect artwork first, close the preview to check cancellation,
then confirm an upload only for an image you intend to contribute. No live uploads
are performed by the automated tests.
