// Cloudflare Workers entry point — the edge equivalent of the Vercel function
// in api/index.ts. Same request/response contract with the Image Lite
// extension, but image encoding runs on WASM (util/compressWasm.ts) instead of
// sharp, since native libvips can't run in the Workers runtime.

import extractTargetUrl from "./util/extractTargetUrl";
import extractOptions from "./util/extractOptions";
import resolveFormat from "./util/resolveFormat";
import shouldCompress from "./util/shouldCompress";
import compressWasm, { canCompress } from "./util/compressWasm";
import {
  FORWARDED_REQUEST_HEADERS,
  ORIGIN_ACCEPT,
  BROWSER_FETCH_HEADERS,
  IMAGE_CACHE_CONTROL,
  looksLikeBlockPage,
  isCspHeader,
  patchCspValue,
} from "./util/headers";

/** Clone origin headers, patch any CSP value, and add the proxy's CORS headers. */
function buildHeaders(origin: Headers, host: string): Headers {
  const headers = new Headers();
  origin.forEach((value, name) => {
    headers.set(name, isCspHeader(name) ? patchCspValue(value, host) : value);
  });
  headers.set("access-control-allow-origin", "*");
  headers.set("cross-origin-resource-policy", "cross-origin");
  return headers;
}

/** Passthrough of the original image bytes (bypass / compression-failed cases). */
function passthroughImage(
  buffer: ArrayBuffer,
  origin: Headers,
  host: string,
  isSvg: boolean,
): Response {
  const headers = buildHeaders(origin, host);
  // We send identity bytes we already read, so the origin's transfer-encoding
  // metadata no longer applies.
  headers.delete("content-length");
  if (isSvg) {
    headers.set("content-encoding", "identity");
  } else {
    headers.delete("content-encoding");
  }
  return new Response(buffer, { status: 200, headers });
}

export default {
  async fetch(request: Request): Promise<Response> {
    // Read the target URL verbatim from the raw query so the image's own query
    // string (signatures, sizing) survives intact. See util/extractTargetUrl.
    const rawQuery = request.url.split("?").slice(1).join("?");
    let url = extractTargetUrl(rawQuery);
    const opts = extractOptions(rawQuery);

    if (!url) {
      return new Response("Image Lite proxy", { status: 200 });
    }

    url = url.replace(/http:\/\/1\.1\.\d\.\d\/bmi\/(https?:\/\/)?/i, "http://");

    // Options from the URL (cache-key-friendly); fall back to the legacy
    // x-image-lite-* headers for older clients, then defaults.
    const bw = request.headers.get("x-image-lite-bw");
    const maxWidth = opts.maxWidth;
    const format =
      opts.format ??
      resolveFormat(
        request.headers.get("x-image-lite-format"),
        request.headers.get("x-image-lite-jpeg"),
      );
    const quality =
      opts.quality ||
      parseInt(request.headers.get("x-image-lite-level") || "", 10) ||
      40;
    const grayscale = opts.grayscale ?? (bw != null ? bw !== "0" : true);

    const host = new URL(request.url).host;

    try {
      // Forward a safe subset of the browser's headers to the origin.
      const originHeaders = new Headers();
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = request.headers.get(name);
        if (value) originHeaders.set(name, value);
      }
      // Ask the origin for WebP so we don't get handed a fat legacy JPEG.
      originHeaders.set("accept", ORIGIN_ACCEPT);
      // Browser-like fetch metadata / client hints to get past some bot checks.
      for (const [k, v] of Object.entries(BROWSER_FETCH_HEADERS)) {
        originHeaders.set(k, v);
      }

      const originResponse = await fetch(url, { headers: originHeaders });

      if (!originResponse.ok) {
        // Stream the origin's failure through (with CORS) so the browser can
        // fall back to normal behavior.
        return new Response(originResponse.body, {
          status: originResponse.status,
          statusText: originResponse.statusText,
          headers: buildHeaders(originResponse.headers, host),
        });
      }

      const type = originResponse.headers.get("content-type") || "";

      // Origin served an HTML/text page (bot challenge/error), not an image —
      // refuse it rather than pass HTML through as an image (would trip ORB).
      if (looksLikeBlockPage(type)) {
        console.log(`Non-image response (${type}); refusing to serve`);
        return new Response("", {
          status: 403,
          headers: buildHeaders(originResponse.headers, host),
        });
      }

      const buffer = await originResponse.arrayBuffer();
      const originalSize = buffer.byteLength;
      const isSvg = type.includes("svg");

      if (
        !canCompress(type) ||
        !shouldCompress(type, originalSize, format !== "jpeg")
      ) {
        console.log(`Bypassing... Size: ${originalSize}, type: ${type}`);
        return passthroughImage(buffer, originResponse.headers, host, isSvg);
      }

      try {
        const { data, contentType } = await compressWasm(
          buffer,
          type,
          format,
          grayscale,
          quality,
          maxWidth,
        );

        const saved = originalSize - data.byteLength;

        // Already-optimized images (e.g. a small, well-tuned JPEG) can come out
        // LARGER after re-encoding. Never send back more bytes than we received —
        // pass the original through instead.
        if (data.byteLength >= originalSize) {
          console.log(
            `No gain (${originalSize} -> ${data.byteLength}); sending original`,
          );
          return passthroughImage(buffer, originResponse.headers, host, isSvg);
        }

        console.log(
          `From ${originalSize}, To ${data.byteLength}, Saved: ${((saved * 100) / originalSize).toFixed(0)}%`,
        );

        const headers = buildHeaders(originResponse.headers, host);
        headers.set("content-type", contentType);
        headers.delete("content-length");
        headers.delete("content-encoding");
        headers.set("cache-control", IMAGE_CACHE_CONTROL);
        headers.set("x-original-size", String(originalSize));
        headers.set("x-bytes-saved", String(saved));
        return new Response(data, { status: 200, headers });
      } catch (err) {
        // Unsupported/corrupt image — return the original rather than 500.
        console.error("WASM compression failed:", (err as Error).message);
        return passthroughImage(buffer, originResponse.headers, host, isSvg);
      }
    } catch (error) {
      console.error(error);
      return new Response((error as Error).message || "", { status: 500 });
    }
  },
};
