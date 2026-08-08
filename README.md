# Image Lite Backend

The image-compression proxy behind the **Image Lite** browser extension. It
downloads an image on the user's behalf, resizes and re-encodes it on the fly
(never touching disk) to a smaller **WebP / AVIF / JPEG**, and streams it back —
so pages load less image data.

> It fetches images on the user's behalf, passing through the browser's cookies,
> referer, and IP to the origin host.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the request contract, the
per-runtime encoders, and the design decisions.

## Runtimes

The **same codebase deploys to three runtimes**; only the image encoder differs,
because `sharp` needs native `libvips` which the Cloudflare Workers runtime can't
load. Runtime-agnostic logic lives in `util/`.

| Runtime | Entry | Encoder |
|---|---|---|
| **Cloudflare Workers** | `worker.ts` | `@jsquash` WASM codecs |
| **Vercel** | `api/index.ts` (default export) | `sharp` |
| **Netlify** | `netlify/functions/index.ts` → `handler` in `api/index.ts` | `sharp` |

## Request contract

```
<proxy>?w=<px>&q=<quality>&bw=<0|1>&f=<webp|jpeg|avif>&url=<RAW IMAGE URL>
```

Compression options come **before** `url=` (so they're part of the CDN cache
key); the raw image URL is everything **after the first `url=`**, verbatim (so
signed-URL query strings survive). See `util/extractOptions` and
`util/extractTargetUrl`.

## Develop & deploy

```sh
npm install
npm test              # jest

# Cloudflare Worker
npm run dev:cf        # local dev
npm run deploy:cf     # deploy (after `wrangler login`)
```

Vercel and Netlify deploy automatically from the connected repo. Then point the
extension's proxy list at whichever endpoint(s) you deployed.
