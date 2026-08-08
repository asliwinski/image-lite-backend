import pick from "../util/pick";
import shouldCompress from "../util/shouldCompress";
import compress from "../util/compress";
import extractTargetUrl from "../util/extractTargetUrl";
import extractOptions from "../util/extractOptions";
import resolveFormat from "../util/resolveFormat";
import {
  ORIGIN_ACCEPT,
  BROWSER_FETCH_HEADERS,
  looksLikeBlockPage,
} from "../util/headers";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { HandlerEvent } from "@netlify/functions";

function convertHeadersToObject(headers: Headers) {
  const result = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function patchContentSecurity(
  headers: Record<string, string | number>,
  host: string,
) {
  const finalHeaders = {};

  const hostWithProtocol = "https://" + host;

  for (const name in headers) {
    switch (true) {
      case /content-security-policy/i.test(name):
        const patchedValue = stripMixedContentCSP(headers[name] as string)
          .replace("img-src", `img-src ${hostWithProtocol}`)
          .replace("default-src", `default-src ${hostWithProtocol}`)
          .replace("connect-src", `connect-src ${hostWithProtocol}`);

        finalHeaders[name] = patchedValue;
        break;
      // case /access-control-allow-origin/i.test(name):
      //   finalHeaders[name] = "*";
      //   break;
      default:
        finalHeaders[name] = headers[name];
    }
  }

  finalHeaders["access-control-allow-origin"] = "*";
  finalHeaders["cross-origin-resource-policy"] = "cross-origin";

  return finalHeaders;
}

function stripMixedContentCSP(CSPHeader: string) {
  return CSPHeader.replace("block-all-mixed-content", "");
}

async function fetchData(url: string, headers: Headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    return { statusCode: response.status || 302 };
  }
  const data = await response.arrayBuffer();
  const type = response.headers.get("content-type") || "";
  return { data, type, headers: response.headers, response };
}

async function compressData(
  data,
  format: string,
  grayscale: boolean,
  quality: number,
  originalSize: number,
  maxWidth: number,
) {
  const { err, output, headers } = await compress(
    data,
    format,
    grayscale,
    quality,
    originalSize,
    maxWidth,
  );
  if (err) {
    console.log("Conversion failed");
    throw err;
  }
  return { output, compressedHeaders: headers };
}

// Send the original (unmodified) image with the proxy's headers — used when the
// image shouldn't be compressed or compression fails.
function sendOriginal(
  response: VercelResponse,
  data,
  type: string,
  headers: Headers,
  host: string,
) {
  const finalHeaders = patchContentSecurity(
    convertHeadersToObject(headers),
    host,
  );
  const isSvg = typeof type === "string" && type.includes("svg");

  for (const header in finalHeaders) {
    if (isSvg) {
      if (header === "content-length") continue;
      if (header === "content-encoding") {
        response.setHeader("content-encoding", "identity");
        continue;
      }
    }
    response.setHeader(header, finalHeaders[header]);
  }

  return response.status(200).send(Buffer.from(data));
}

export default async function (
  request: VercelRequest,
  response: VercelResponse,
) {
  // request.url is the path + raw query (e.g. "/api/index?url=https://..."), so
  // read the target URL verbatim from it rather than the parsed request.query,
  // which splits and re-encodes the image's own query string. See extractTargetUrl.
  const rawQuery = request.url?.split("?").slice(1).join("?");
  let url = extractTargetUrl(rawQuery);
  const opts = extractOptions(rawQuery);

  // If no URL provided, return a default response
  if (!url) {
    return response.status(200).send("Image Lite proxy");
  }

  // Replace specific pattern in the URL
  url = url.replace(/http:\/\/1\.1\.\d\.\d\/bmi\/(https?:\/\/)?/i, "http://");

  // Options come from the URL (cache-key-friendly); fall back to the legacy
  // x-image-lite-* headers for older extension clients, then to defaults.
  const maxWidth = opts.maxWidth;
  const format =
    opts.format ??
    resolveFormat(
      request.headers["x-image-lite-format"] as string,
      request.headers["x-image-lite-jpeg"] as string,
    );
  const quality =
    opts.quality ||
    parseInt(request.headers["x-image-lite-level"] as string, 10) ||
    40;
  const grayscale =
    opts.grayscale ??
    (request.headers["x-image-lite-bw"] != null
      ? request.headers["x-image-lite-bw"] !== "0"
      : true);

  try {
    let requestHeaders = pick(request.headers, [
      "cookie",
      "dnt",
      "referer",
      "user-agent",
      "x-forwarded-for",
      "save-data",
    ]);
    // Ask the origin for WebP so we don't get handed a fat legacy JPEG.
    requestHeaders["accept"] = ORIGIN_ACCEPT;
    Object.assign(requestHeaders, BROWSER_FETCH_HEADERS);

    const fetched = await fetchData(url, requestHeaders);
    if (!fetched.data) {
      // Origin fetch failed (e.g. a CDN that blocks datacenter fetches) — return
      // its status instead of crashing on the missing body.
      return response.status(fetched.statusCode || 502).send("");
    }
    const { data, type, headers } = fetched;
    const originalSize = data.byteLength;

    // Origin served an HTML/text page (a bot challenge or error), not an image.
    // Don't pass it through as an image — it would trip the browser's ORB.
    if (looksLikeBlockPage(type)) {
      console.log(`Non-image response (${type}); refusing to serve`);
      return response.status(403).send("");
    }

    if (!shouldCompress(type, originalSize, format !== "jpeg")) {
      console.log(`Bypassing... Size: ${originalSize}, type: ${type}`);
      return sendOriginal(response, data, type, headers, request.headers.host);
    }

    let output;
    let compressedHeaders;
    try {
      ({ output, compressedHeaders } = await compressData(
        data,
        format,
        grayscale,
        quality,
        originalSize,
        maxWidth,
      ));
    } catch (err) {
      // The proxy couldn't decode/encode this image (e.g. .ico, which sharp
      // can't read) — return the original instead of a 500 / broken image.
      console.error("Compression failed, returning original:", err.message);
      return sendOriginal(response, data, type, headers, request.headers.host);
    }

    // Already-optimized images can come out LARGER after re-encoding. Never send
    // back more bytes than we received — return the original instead.
    if (output.length >= originalSize) {
      console.log(`No gain (${originalSize} -> ${output.length}); sending original`);
      return sendOriginal(response, data, type, headers, request.headers.host);
    }

    console.log(
      `From ${originalSize}, To ${output.length}, Saved: ${(((originalSize - output.length) * 100) / originalSize).toFixed(0)}%`,
    );

    const finalHeaders = patchContentSecurity(
      { ...convertHeadersToObject(headers), ...compressedHeaders },
      request.headers.host,
    );

    for (const header in finalHeaders) {
      response.setHeader(header, finalHeaders[header]);
    }

    response.status(200).send(output);
  } catch (error) {
    console.error(error);
    return response.status(500).send(error.message || "");
  }
}

// Netlify Functions (v1) entry point. Same behavior as the Vercel handler above,
// but in the Lambda-style request/response shape Netlify expects. Netlify uses
// this `handler` export; Vercel uses the default export.
export async function handler(event: HandlerEvent) {
  let url = extractTargetUrl(event.rawQuery);
  const opts = extractOptions(event.rawQuery);

  if (!url) {
    return { statusCode: 200, body: "Image Lite proxy" };
  }

  url = url.replace(/http:\/\/1\.1\.\d\.\d\/bmi\/(https?:\/\/)?/i, "http://");

  // URL options first (cache-key-friendly), then legacy headers, then defaults.
  const maxWidth = opts.maxWidth;
  const format =
    opts.format ??
    resolveFormat(
      event.headers["x-image-lite-format"],
      event.headers["x-image-lite-jpeg"],
    );
  const quality =
    opts.quality || parseInt(event.headers["x-image-lite-level"], 10) || 40;
  const grayscale =
    opts.grayscale ??
    (event.headers["x-image-lite-bw"] != null
      ? event.headers["x-image-lite-bw"] !== "0"
      : true);

  try {
    const requestHeaders = pick(event.headers, [
      "cookie",
      "dnt",
      "referer",
      "user-agent",
      "x-forwarded-for",
      "save-data",
    ]);
    // Ask the origin for WebP so we don't get handed a fat legacy JPEG.
    requestHeaders["accept"] = ORIGIN_ACCEPT;
    Object.assign(requestHeaders, BROWSER_FETCH_HEADERS);

    const fetched = await fetchData(url, requestHeaders);
    if (!fetched.data) {
      return { statusCode: fetched.statusCode || 502, body: "" };
    }
    const { data, type, headers } = fetched;

    const originalSize = data.byteLength;

    // Origin served an HTML/text page (bot challenge/error), not an image —
    // refuse it rather than pass HTML through as an image (would trip ORB).
    if (looksLikeBlockPage(type)) {
      console.log(`Non-image response (${type}); refusing to serve`);
      return { statusCode: 403, body: "" };
    }

    // Return the original image (base64) with proxied headers.
    const sendOriginal = () => {
      const finalHeaders = patchContentSecurity(
        convertHeadersToObject(headers),
        event.headers.host,
      );
      if (typeof type === "string" && type.includes("svg")) {
        finalHeaders["content-encoding"] = "identity";
        delete finalHeaders["content-length"];
      }
      return {
        statusCode: 200,
        body: Buffer.from(data).toString("base64"),
        isBase64Encoded: true,
        headers: finalHeaders,
      };
    };

    if (!shouldCompress(type, originalSize, format !== "jpeg")) {
      console.log(`Bypassing... Size: ${originalSize}, type: ${type}`);
      return sendOriginal();
    }

    let output;
    let compressedHeaders;
    try {
      ({ output, compressedHeaders } = await compressData(
        data,
        format,
        grayscale,
        quality,
        originalSize,
        maxWidth,
      ));
    } catch (err) {
      // e.g. .ico, which sharp can't decode — return the original.
      console.error("Compression failed, returning original:", err.message);
      return sendOriginal();
    }

    // Already-optimized images can come out LARGER after re-encoding. Never send
    // back more bytes than we received — return the original instead.
    if (output.length >= originalSize) {
      console.log(`No gain (${originalSize} -> ${output.length}); sending original`);
      return sendOriginal();
    }

    return {
      statusCode: 200,
      body: output.toString("base64"),
      isBase64Encoded: true,
      headers: patchContentSecurity(
        { ...convertHeadersToObject(headers), ...compressedHeaders },
        event.headers.host,
      ),
    };
  } catch (error) {
    console.error(error);
    return { statusCode: 500, body: error.message || "" };
  }
}
