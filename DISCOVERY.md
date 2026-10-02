# Provider notes

Public website interfaces are undocumented and may change. Catalog searches can
miss titles whose pages still expose artwork. Discovery uses JustWatch, provider
Google searches, and pasted URLs; results require selection and preview.

- **Amazon:** read current-title hydration metadata, excluding recommendations.
  Compare the original image with `SX4096_FMavif_PQ100`; requested size does not
  guarantee native resolution.
- **Apple TV:** match the title in `serialized-server-data` and resolve wide/tall
  artwork templates at their declared dimensions.
- **Kanopy:** initialize a visitor session with `/kapi/handshake`, then fetch the
  title alias. Unwrap CDN proxies to recover originals. JWTs stay in memory and
  are sent only to Kanopy's API.
- **Disney+:** request anonymous public title HTML and match `pageId` in
  `__NEXT_DATA__`. Read title-level hero and metadata sections. Remove Ripcut
  size/crop parameters to recover native backgrounds and `twitter:image` portraits;
  reject the wrong orientation. Legacy redirects may require **Open source tab**;
  authenticated app shells may require a public entity link or direct image URL.

Generic webpages use static HTML images and metadata, without executing scripts
or crawling linked pages. Google pages needing JavaScript use temporary helper
tabs; consent/challenges need user action. Helper requests expire after ten minutes.
