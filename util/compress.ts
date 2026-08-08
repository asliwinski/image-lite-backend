// @ts-ignore
import sharp from "sharp";
import { IMAGE_CACHE_CONTROL } from "./headers";

// AVIF (AV1) encoding is far more CPU-heavy than WebP and can exceed serverless
// limits (Vercel's ~10s function timeout, Cloudflare's 10ms CPU) on larger
// images, returning a 504. We only AVIF-encode when the result is small enough
// to finish in time — otherwise fall back to WebP.
const AVIF_MAX_PIXELS = 2_000_000; // ~2 MP
// sharp's default AVIF effort is 4 (slow). A lower effort trades a little size
// for a much faster encode, keeping us inside the time budget.
const AVIF_EFFORT = 2;

async function compress(
  imagePath: string,
  format: string,
  grayscale: boolean,
  quality: number,
  originalSize: number,
  maxWidth: number = 0,
) {
  try {
    // Read the source with all frames so animated GIFs/WebPs keep their
    // animation (single-frame images are unaffected). One sharp instance for
    // both metadata and the encode pipeline — no double parse of the input.
    const pipeline = sharp(imagePath, { animated: true });
    const meta = await pipeline.metadata();
    const isAnimated = (meta.pages || 1) > 1;

    // Estimate the encoded (post-resize) pixel count so we can keep AVIF within
    // the serverless time budget.
    let outWidth = meta.width || 0;
    let outHeight = meta.height || 0;
    if (maxWidth > 0 && outWidth > maxWidth) {
      outHeight = Math.round((outHeight * maxWidth) / outWidth);
      outWidth = maxWidth;
    }
    const outPixels = outWidth * outHeight;

    // Animated images must go to WebP — JPEG can't animate, and animated AVIF is
    // unreliable. This turns huge animated GIFs into much smaller animated WebP.
    // AVIF is used only when the result is small enough to encode in time (see
    // AVIF_MAX_PIXELS); larger AVIF requests fall back to WebP so we never 504.
    // Everything else uses the requested format.
    let outputFormat: string;
    if (isAnimated) {
      outputFormat = "webp";
    } else if (format === "jpeg") {
      outputFormat = "jpeg";
    } else if (format === "avif" && outPixels > 0 && outPixels <= AVIF_MAX_PIXELS) {
      outputFormat = "avif";
    } else {
      outputFormat = "webp";
    }

    // Resize down to maxWidth (preserving aspect ratio, never enlarging) before
    // encoding, so a webmaster's oversized image doesn't ship full-resolution.
    pipeline.grayscale(grayscale);
    if (maxWidth > 0) {
      pipeline.resize({ width: maxWidth, withoutEnlargement: true });
    }

    // progressive/optimizeScans apply to JPEG; effort applies to AVIF; sharp
    // ignores the ones that don't apply to the chosen format.
    const formatOptions: Record<string, unknown> = {
      quality,
      progressive: true,
      optimizeScans: true,
    };
    if (outputFormat === "avif") formatOptions.effort = AVIF_EFFORT;

    const { data, info } = await pipeline
      .toFormat(outputFormat as any, formatOptions)
      .toBuffer({ resolveWithObject: true });

    const bytesSaved = originalSize - info.size;
    const headers = {
      "cache-control": IMAGE_CACHE_CONTROL,
      "content-type": `image/${outputFormat}`,
      "content-length": info.size,
      "x-original-size": originalSize,
      "x-bytes-saved": bytesSaved,
    };

    return {
      err: null,
      headers,
      output: data,
    };
  } catch (err) {
    // If an error occurs during compression, return the error object
    return { err };
  }
}

export default compress;
