// Pure, runtime-agnostic header helpers shared by the Node (Vercel) and edge
// (Cloudflare Worker) entry points. No sharp / no WASM imports here so the edge
// bundle can use it freely.

/** Names of request headers we forward from the browser to the origin image host. */
export const FORWARDED_REQUEST_HEADERS = [
  "cookie",
  "dnt",
  "referer",
  "user-agent",
  "x-forwarded-for",
  // Data Saver: origins that honor it serve smaller images to begin with.
  "save-data",
] as const;

// Accept header we send to the origin. Many CDNs serve a compact WebP to clients
// that advertise support and a much larger legacy JPEG to those that don't — and
// a bare server-side fetch sends no Accept, so we'd get the fat JPEG (then waste
// a round-trip re-compressing it, sometimes to more bytes than the browser would
// have gotten directly). Advertising WebP makes the origin hand us the small
// modern variant. WebP (not AVIF) because both backends decode it and every
// target browser renders it, so passthrough is always safe.
export const ORIGIN_ACCEPT = "image/webp,image/*,*/*";

// Browser-like fetch metadata / client hints. A bare server-side fetch omits
// these, so some CDNs' bot protection 403s it. Sending them mimics a real
// same-site image request. (Won't defeat TLS-fingerprint or IP-based blocks.)
export const BROWSER_FETCH_HEADERS: Record<string, string> = {
  "sec-fetch-dest": "image",
  "sec-fetch-mode": "no-cors",
  "sec-fetch-site": "same-site",
  "accept-language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};

/**
 * True if an image request's response is really an HTML/text/JSON page — i.e. the
 * origin served a bot-challenge or error page instead of an image. Passing that
 * through as an image trips the browser's Opaque Response Blocking (ERR_BLOCKED_BY_ORB),
 * so callers return an error status instead (which the extension auto-heals on).
 * image/svg+xml is fine — the image/ prefix check excludes it before the xml test.
 */
export function looksLikeBlockPage(contentType: string): boolean {
  const t = (contentType || "").toLowerCase();
  if (!t || t.startsWith("image/")) return false;
  return t.startsWith("text/") || /html|json|xml/.test(t);
}

/** True if the header name is a Content-Security-Policy header (any variant). */
export function isCspHeader(name: string): boolean {
  return /content-security-policy/i.test(name);
}

/**
 * Rewrite a CSP header value so the proxied image (served from `host`) is allowed
 * by the page's policy, and mixed-content blocking doesn't drop it.
 */
export function patchCspValue(value: string, host: string): string {
  const hostWithProtocol = "https://" + host;
  return value
    .replace("block-all-mixed-content", "")
    .replace("img-src", `img-src ${hostWithProtocol}`)
    .replace("default-src", `default-src ${hostWithProtocol}`)
    .replace("connect-src", `connect-src ${hostWithProtocol}`);
}
