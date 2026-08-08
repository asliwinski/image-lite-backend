import extractTargetUrl from "../util/extractTargetUrl";

describe("extractTargetUrl", () => {
  it("returns null when the query string is missing or empty", () => {
    expect(extractTargetUrl(undefined)).toBeNull();
    expect(extractTargetUrl(null)).toBeNull();
    expect(extractTargetUrl("")).toBeNull();
  });

  it("returns null when there is no url= parameter", () => {
    expect(extractTargetUrl("foo=bar&baz=qux")).toBeNull();
  });

  it("returns null when url= is present but empty", () => {
    expect(extractTargetUrl("url=")).toBeNull();
  });

  it("extracts a simple URL", () => {
    expect(extractTargetUrl("url=https://cdn.example.com/img.jpg")).toBe(
      "https://cdn.example.com/img.jpg",
    );
  });

  it("preserves the image's own query string (the param-bleed bug)", () => {
    // The image's own `&name=small` bleeds into the proxy's query string when
    // the extension redirects with an unencoded ?url=. It must survive intact.
    expect(
      extractTargetUrl(
        "url=https://pbs.twimg.com/media/ABC?format=jpg&name=small",
      ),
    ).toBe("https://pbs.twimg.com/media/ABC?format=jpg&name=small");
  });

  it("preserves a signed CDN URL byte-for-byte (no re-encoding → no 403)", () => {
    const signed =
      "https://s3.amazonaws.com/bucket/img.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc%2Fdef123&X-Amz-Expires=900";
    expect(extractTargetUrl(`url=${signed}`)).toBe(signed);
  });

  it("keeps a nested url= parameter belonging to the image URL", () => {
    expect(
      extractTargetUrl("url=https://cdn.example.com/render?url=inner.jpg&w=600"),
    ).toBe("https://cdn.example.com/render?url=inner.jpg&w=600");
  });

  it("only splits on the FIRST url= occurrence", () => {
    expect(
      extractTargetUrl("url=https://a.example.com/x?url=https://b.example.com/y"),
    ).toBe("https://a.example.com/x?url=https://b.example.com/y");
  });

  it("decodes a percent-encoded value when the verbatim form is not a valid URL", () => {
    // Some clients DO percent-encode the value.
    expect(
      extractTargetUrl("url=https%3A%2F%2Fcdn.example.com%2Fimg.jpg%3Fa%3Db"),
    ).toBe("https://cdn.example.com/img.jpg?a=b");
  });

  it("prefers the verbatim (unencoded) value when it is already a valid URL", () => {
    const raw = "https://cdn.example.com/a+b/img.jpg?q=1";
    // A raw value is a valid URL as-is, so it is returned unchanged rather than
    // being decoded a second time.
    expect(extractTargetUrl(`url=${raw}`)).toBe(raw);
  });

  it("recovers gracefully from malformed percent-encoding", () => {
    // A stray % that isn't valid percent-encoding must not throw; the verbatim
    // value is still a usable URL.
    expect(
      extractTargetUrl("url=https://cdn.example.com/100%discount.jpg"),
    ).toBe("https://cdn.example.com/100%discount.jpg");
  });
});
