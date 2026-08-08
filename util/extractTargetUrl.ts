/**
 * Extract the original image URL from a proxy request WITHOUT losing or
 * mangling the image URL's own query string.
 *
 * The Image Lite extension redirects via declarativeNetRequest with
 * `?url=<ORIGINAL_URL>`, and <ORIGINAL_URL> is inserted verbatim and NOT
 * percent-encoded (DNR's regexSubstitution has no way to encode a capture
 * group). So an image at `https://cdn/img?sig=abc&exp=123` arrives as
 * `/api/index?url=https://cdn/img?sig=abc&exp=123` — the image's own
 * `&exp=123` bleeds into OUR query string.
 *
 * A normal query parser (request.query / queryStringParameters) splits that
 * into `url=https://cdn/img?sig=abc` + a stray `exp=123`, and rebuilding it
 * with URLSearchParams re-encodes the result. For signed CDN URLs (S3 /
 * CloudFront presigned links whose signature is computed over the exact byte
 * sequence) any re-encoding or reordering invalidates the signature → 403 →
 * broken image. That was the main reason images weren't proxied reliably.
 *
 * Instead we take everything after the FIRST `url=` in the raw query string,
 * verbatim. If that isn't a valid absolute URL (e.g. a client that DID
 * percent-encode the value), we fall back to decoding it once.
 *
 * @param rawQuery the raw query string, WITHOUT a leading "?"
 * @returns the target URL, or null if none could be recovered
 */
export default function extractTargetUrl(
  rawQuery: string | undefined | null,
): string | null {
  if (!rawQuery) return null;

  const marker = "url=";
  const idx = rawQuery.indexOf(marker);
  if (idx === -1) return null;

  const raw = rawQuery.slice(idx + marker.length);
  if (!raw) return null;

  const candidates = [raw];
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) candidates.push(decoded);
  } catch {
    // malformed percent-encoding; the verbatim candidate is our best bet
  }

  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line no-new
      new URL(candidate);
      return candidate;
    } catch {
      // not a valid absolute URL; try the next candidate
    }
  }

  return null;
}
