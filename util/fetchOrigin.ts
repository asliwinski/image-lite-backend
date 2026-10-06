// Origin fetch with a cap on how long we wait for the response headers. Shared by
// the Node (Vercel/Netlify) and edge (Cloudflare Worker) entry points.
//
// Some origins silently drop datacenter IPs (e.g. rozklad-pkp.pl) while serving
// browsers fine. Uncapped, the fetch hangs until the platform gives up — the
// Worker's subrequest returns a 522 after ~20s, Vercel kills the function at its
// 10s limit (504), Netlify's fetch throws (500) — and the browser waits that long
// for every image. Failing fast with a gateway status (502/504) lets the
// extension's auto-heal exclude the host and load its images directly sooner.

/**
 * How long to wait for the origin's response headers. Only the headers are timed:
 * once the response starts, a large image may legitimately take longer to
 * download. A slow-but-working origin that misses this just gets loaded directly
 * by the extension (uncompressed) — a safe fallback.
 */
export const ORIGIN_TIMEOUT_MS = 5000;

export default async function fetchOrigin(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = ORIGIN_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    // Clear once the headers are in, so the abort can't cut off the body read.
    clearTimeout(timer);
  }
}

/**
 * Status to answer with when fetchOrigin threw — the origin never responded:
 * 504 if we timed out waiting for it, 502 if the connection failed outright
 * (DNS, refused, reset, TLS). Both are statuses the extension auto-heals on.
 */
export function originErrorStatus(error: unknown): 502 | 504 {
  const name = (error as { name?: string } | null)?.name;
  return name === "AbortError" || name === "TimeoutError" ? 504 : 502;
}
