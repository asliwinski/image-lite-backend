import http from "http";
import type { AddressInfo } from "net";
import fetchOrigin, { originErrorStatus } from "../util/fetchOrigin";

// fetchOrigin caps the wait for an origin's response HEADERS, so an origin that
// silently drops the proxy's connection fails fast with a gateway status instead
// of hanging until the platform's own timeout. Exercised against real local
// servers so the abort goes through the runtime's actual fetch.
function listen(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function urlOf(server: http.Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/img.png`;
}

function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("fetchOrigin", () => {
  it("gives up on an origin that never responds → 504", async () => {
    const server = await listen(() => {}); // accepts, never answers
    try {
      const error = await fetchOrigin(urlOf(server), {}, 100).catch((e) => e);
      // fetch's errors come from Node's realm, not Jest's, so check by name
      // rather than instanceof.
      expect(error.name).toBe("AbortError");
      expect(originErrorStatus(error)).toBe(504);
    } finally {
      await close(server);
    }
  });

  it("doesn't cut off a body that streams past the timeout", async () => {
    const server = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.write("first-");
      setTimeout(() => res.end("second"), 250);
    });
    try {
      const response = await fetchOrigin(urlOf(server), {}, 100);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("first-second");
    } finally {
      await close(server);
    }
  });

  it("fails a refused connection → 502", async () => {
    const server = await listen(() => {});
    const url = urlOf(server);
    await close(server); // nothing listens on that port now
    const error = await fetchOrigin(url, {}, 1000).catch((e) => e);
    expect(error.name).toBe("TypeError"); // "fetch failed" (ECONNREFUSED)
    expect(originErrorStatus(error)).toBe(502);
  });
});

describe("originErrorStatus", () => {
  it("maps aborts/timeouts to 504 and anything else to 502", () => {
    expect(originErrorStatus({ name: "AbortError" })).toBe(504);
    expect(originErrorStatus({ name: "TimeoutError" })).toBe(504);
    expect(originErrorStatus(new TypeError("fetch failed"))).toBe(502);
    expect(originErrorStatus(null)).toBe(502);
  });
});
