# Finding artwork when streaming links disappear

Investigated on September 12, 2026. Availability, search indexes, and website
responses can vary by country and change over time.

## What works

A provider title page can remain accessible after it disappears from a streaming
availability search. Once its URL is known, the userscript can read its artwork
without requiring an active rental/subscription offer.

For **Bigfoot, I Love You**, the supplied
[Prime Video page](https://www.primevideo.com/-/de/detail/0ISBAPQV85YPX8VRKEZT6I3WMC)
returned its title and hero image in `dv-web-page-hydration-data`. The supplied
[Apple TV page](https://tv.apple.com/us/movie/bigfoot-i-love-you/umc.cmc.70td6qpxeljnbp2jd9425btiw)
returned both artwork templates in `serialized-server-data`. Its downloaded
background is 1920×1080; its poster is 400×574 and is too small for TMDB, even
before cropping. The script does not upscale it.

The userscript now supports direct provider URLs and remembers them by TMDB movie
or series ID. This separates image retrieval from current streaming availability.

## Discovery methods checked

| Method | Result for this example | Practical use |
| --- | --- | --- |
| JustWatch US title search | No matching title in the tested results | First choice for current offers; additional regions may help, without guaranteeing coverage. |
| Apple TV US website search, full title and “Bigfoot” | Did not return the supplied title ID | Useful interactive search, but not a complete index of surviving pages. |
| iTunes Search API, US movie search | Zero results | Official catalog API, but not a reliable fallback for unavailable titles. |
| Prime Video website search, German route and full title | Returned a page without the supplied title ID | Can miss pages that still open directly. |
| Public web search | Found the Apple TV page in another storefront | Search indexed provider pages, and verify the title/year/cast before using one. |

Apple documents [movie/TV searches and ID lookups in its iTunes Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/index.html).
Its existence does not guarantee that an unavailable Apple TV title remains in
that catalog. A movie title alone cannot be converted into Apple's opaque
`umc.cmc.…` ID or Amazon's catalog ID.

The captured JustWatch `OffersHistory` query includes provider packages and date
ranges, but no former provider URLs. That captured query therefore does not solve
the missing-link problem; this is not a claim that every internal history field
has been ruled out.

Useful searches are `"Bigfoot, I Love You" site:tv.apple.com` and
`"Bigfoot, I Love You" (site:primevideo.com OR site:amazon.com)`. Cast/director names
can help disambiguate poorly indexed titles. Cross-storefront results should be
opened and verified, rather than synthesizing a new content ID from their slugs.

## Implemented approach

1. Keep JustWatch as the normal discovery path and search the configured regions.
2. Offer direct provider-search and site-restricted web-search links for misses.
3. Accept a pasted provider title URL, fetch its artwork, and show the source title
   and final JPEG before upload confirmation.
4. Remember manually supplied links under the TMDB title ID for later reuse, even
   when there are still no JustWatch offers. The user can forget those links.

Fully automatic indexed-web discovery would require integrating a search service
and its credentials, or maintaining search-result scraping with challenge and
markup failures. This change deliberately supplies interactive discovery links
and remembered mappings; it does not claim exhaustive automatic discovery.
