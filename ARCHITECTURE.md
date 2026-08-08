# image-lite-backend — Architecture & Request Contract

This repo is the compression proxy behind the **Image Lite** browser extension
(the extension lives in a separate, local-only repo). It downloads an image on
the user's behalf, compresses/resizes it on the fly (never touching disk), and
streams back a smaller image.

The **same codebase deploys to three runtimes**. Only the image encoder differs,
because `sharp` needs native `libvips` which the Cloudflare Workers runtime
can't load:

| Runtime | Entry | Encoder | Notes |
|---------|-------|---------|-------|
| **Cloudflare Workers** | `worker.ts` | `@jsquash` WASM (`util/compressWasm.ts`) | default proxy; edge; CPU-limited |
| **Vercel** | `api/index.ts` (default export) | `sharp` (`util/compress.ts`) | Node serverless |
| **Netlify** | `netlify/functions/index.ts` → re-exports `handler` from `api/index.ts` | `sharp` | v1 Lambda shape |

Runtime-agnostic logic lives in `util/` (`extractTargetUrl`, `extractOptions`,
`resolveFormat`, `shouldCompress`, `headers`, `pick`).

---

## Request contract

The extension sends:

```
<proxy>?w=<px>&q=<quality>&bw=<0|1>&f=<webp|jpeg|avif>&url=<RAW IMAGE URL>
```

The **cache-key fix** is central to how this is parsed:

- **Options before `url=`** — `extractOptions` reads only the substring **before
  the first `url=`** as an `URLSearchParams`, pulling `w` (maxWidth), `q`
  (quality), `bw` (grayscale), `f` (format). Putting them in the URL (not
  headers) makes them **part of the CDN cache key**, so changing a setting isn't
  masked by the long `cache-control`. Unspecified fields come back as
  `0`/`null`.
- **Raw URL after `url=`** — `extractTargetUrl` returns **everything after the
  first `url=` verbatim**, so the image's own query string (signed URLs, its own
  `w=`/`width=` params) is preserved untouched. `api/index.ts` deliberately
  reads `request.url` raw rather than the framework's parsed `request.query`,
  which would split and re-encode that query string.

### Legacy header fallback

For older extension clients, options fall back to `x-image-lite-*` headers when
absent from the URL (`resolveFormat` maps `x-image-lite-format` /
`x-image-lite-jpeg`), then to defaults (quality 40, grayscale on, format from
resolver). New clients always use the URL form.

---

## Compression behaviour

`shouldCompress` decides whether it's worth it (by content-type and size).
Otherwise, and on **any decode/encode failure**, the proxy returns the
**original** image rather than a 500 or a broken image — important for formats
`sharp` can't read (e.g. `.ico`).

### sharp backends (`util/compress.ts`)

- Reads with `{ animated: true }` so animated GIF/WebP keep their frames.
- **Animated → WebP always** (JPEG can't animate; animated AVIF is unreliable) —
  turning huge animated GIFs into much smaller animated WebP.
- Otherwise honours `f=` (`avif`/`jpeg`/`webp`).
- **Resizes** to `w=` with `withoutEnlargement: true` (never upscales), then
  encodes at `quality`, then grayscale if requested.
- Sets response headers `content-type: image/<fmt>`, `x-original-size`, and
  **`x-bytes-saved`** (the extension's data-saved counter reads this).

### Cloudflare Worker (`util/compressWasm.ts`)

`sharp` can't run in Workers, so it uses `@jsquash` WASM codecs: decode
JPEG/PNG/WebP → resize → grayscale → encode. **Format support is narrower** —
`jpeg` → JPEG, everything else → WebP. **AVIF and GIF re-encode fall back to
WebP.**

> **Cloudflare free-tier limit:** ~10ms CPU per request. Empirically small images
> (≲ 2 MP) AVIF-encode fine, but large sources (~6 MP) hit the CPU cap and 503.
> This is why AVIF and animated-GIF→WebP only reliably apply on the sharp
> (Vercel/Netlify) backends; the Worker falls back to WebP. Bundle must stay
> under the 3 MB gzip limit.

---

## Response headers

`patchContentSecurity` rewrites the origin's headers so the compressed image is
usable cross-origin: adds the proxy host to any `img-src`/`default-src`/
`connect-src` CSP directives, strips `block-all-mixed-content`, and sets
`access-control-allow-origin: *` + `cross-origin-resource-policy: cross-origin`.
SVG passthrough forces `content-encoding: identity` and drops `content-length`.

On origin fetch failure the proxy returns the **origin's status code** (not a
500/crash) — e.g. CDNs like `styles.redditmedia.com` that block datacenter
fetches. (The extension also excludes such domains from proxying entirely.)

---

## Deployment

- **Cloudflare** (default proxy `image-lite-backend.<subdomain>.workers.dev`):
  auto-deploys from CI (`.github/workflows`, `deploy-worker` job, Node 22,
  needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secrets). Local:
  `npm run dev:cf` / `npm run deploy:cf` (after `wrangler login`).
- **Vercel**: auto-deploys on push; endpoint `/api/index`.
- **Netlify**: `netlify.toml` points functions at `netlify/functions/`, with
  `sharp` marked as an external node module. The separate `netlify/functions/
  index.ts` re-export exists so Netlify treats the file as a **v1** function (a
  dual default+`handler` export made it pick the wrong runtime and 502).

Tests: `npm test` (Jest) — covers `extractOptions`, `extractTargetUrl`,
`resolveFormat`, `shouldCompress`.

---

## Notable fixes (history)

- **Cache-key fix** — options moved from headers into the URL prefix so the
  30-day cache varies by format/quality/grayscale.
- **Signed-URL preservation** — read the raw URL after `url=` instead of
  re-parsing the query string.
- **Non-ok origin fetch** no longer crashes (`Buffer.from(undefined)`); returns
  the origin status.
- **`.ico`/undecodable images** return the original instead of 500.
- **Netlify 502** — split into a v1-only re-export with external `sharp`.
- **Animated GIF → WebP** on sharp backends; Worker falls back to WebP.
