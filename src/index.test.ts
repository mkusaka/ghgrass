import { afterEach, expect, test, vi } from "vitest";

import app from "./index";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const allow = { limit: async () => ({ success: true }) };
const { privateKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const pkcs8 = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey))));
const env = {
  GITHUB_APP_CLIENT_ID: "Iv23liTest",
  // A single-line key with "\n" escapes, as in .dev.vars (PEM armor omitted).
  GITHUB_APP_PRIVATE_KEY: pkcs8.replace(/.{64}/g, "$&\\n"),
  RATE_LIMITER: allow,
};

// Answers the App token endpoints with "secret-token" and GraphQL with `graphql()`.
function stubGitHub(graphql: () => Response = () => Response.json({ data: { user: { contributionsCollection: {
  contributionCalendar: { weeks: [{ contributionDays: [
    { date: "2026-11-15", contributionCount: 3, contributionLevel: "FOURTH_QUARTILE" },
  ] }] },
} } } })) {
  const fetchMock = vi.fn(async (url: string, _init: RequestInit) => {
    if (url.endsWith("/app/installations")) return Response.json([{ id: 1 }]);
    if (url.endsWith("/access_tokens")) {
      return Response.json({ token: "secret-token", expires_at: "2999-01-01T00:00:00Z" });
    }
    return graphql();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const graphqlCalls = (fetchMock: ReturnType<typeof stubGitHub>) =>
  fetchMock.mock.calls.filter(([url]) => url.endsWith("/graphql"));

test("returns the graph as cacheable SVG", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-15T12:00:00Z"), toFake: ["Date"] });
  const fetchMock = stubGitHub();
  const response = await app.request("/api/octocat.svg", {}, env);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
  expect(response.headers.get("Cache-Control")).toBe("public, max-age=0");
  expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBe(
    "public, max-age=600, stale-while-revalidate=3600",
  );
  expect(await response.text()).toContain("3 contributions on Nov 15, 2026");

  const [, init] = graphqlCalls(fetchMock)[0]!;
  expect(new Headers(init.headers).get("Authorization")).toBe("Bearer secret-token");
  expect(JSON.parse(init.body as string).variables).toEqual({
    login: "octocat",
    from: "2025-11-16T00:00:00Z",
    to: "2026-11-15T23:59:59Z",
  });
});

test("serves a cacheable HTML page that embeds the SVG URL without calling GitHub", async () => {
  const fetchMock = stubGitHub();
  const response = await app.request("/api/octocat?theme=dark", {}, env);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
  expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBe(
    "public, max-age=600, stale-while-revalidate=3600",
  );
  const html = await response.text();
  expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1"/>');
  expect(html).toContain("<title>octocat&#39;s contributions</title>");
  expect(html).toContain('<link rel="icon" href="data:image/svg+xml,');
  expect(html).toContain('<meta property="og:image" content="http://localhost/api/octocat.png?theme=dark"/>');
  expect(html).toContain("background:#0d1117");
  expect(html).toContain('data="/api/octocat.svg?theme=dark"');
  expect(html).toContain("color:#f0f6fc");
  expect(html).toContain("in the last year");
  expect(html).toContain('<a href="/api/octocat">☀ Light</a>');
  expect(fetchMock).not.toHaveBeenCalled();
});

test("returns the graph as PNG", async () => {
  stubGitHub();
  const response = await app.request("/api/octocat.png", {}, env);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("image/png");
  const png = new Uint8Array(await response.arrayBuffer());
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer);
  const chunks: Record<string, Uint8Array<ArrayBuffer>> = {};
  for (let at = 8; at < png.length; at += 12 + view.getUint32(at)) {
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    chunks[type] = png.subarray(at + 8, at + 8 + view.getUint32(at));
  }
  const width = view.getUint32(16), height = view.getUint32(20);
  const raw = await new Response(
    new Blob([chunks.IDAT!]).stream().pipeThrough(new DecompressionStream("deflate")),
  ).bytes();
  expect(raw.length).toBe((width + 1) * height);
  // The heading's solid color (light theme #1f2328) is in the palette and drawn.
  const palette = chunks.PLTE!;
  const solid = [...Array(palette.length / 3).keys()].find(
    (i) => palette[i * 3] === 0x1f && palette[i * 3 + 1] === 0x23 && palette[i * 3 + 2] === 0x28,
  );
  expect(raw).toContain(solid);
});

test("renders the dark theme", async () => {
  stubGitHub();
  const response = await app.request("/api/octocat.svg?theme=dark", {}, env);
  expect(await response.text()).toContain("#56d364");
});

test.each([
  ["/api/Octocat.svg", "/api/octocat.svg"],
  ["/api/octocat.svg?theme=light", "/api/octocat.svg"],
  ["/api/octocat.svg?theme=dark&utm=x", "/api/octocat.svg?theme=dark"],
  ["/api/Octocat?theme=light", "/api/octocat"],
  ["/api/octocat.html?theme=dark", "/api/octocat?theme=dark"],
])("redirects %s to the canonical URL", async (path, location) => {
  const fetchMock = stubGitHub();
  const response = await app.request(path, {}, env);
  expect(response.status).toBe(301);
  expect(response.headers.get("Location")).toBe(location);
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([
  "/api/-octocat.svg",
  "/api/octo--cat.svg",
  "/api/octocat-.svg",
  `/api/${"a".repeat(40)}.svg`,
  "/api/octocat.jpg",
  "/api/octocat.svg.html",
  "/api/octo.cat",
  "/api/octocat.svg?theme=blue",
])("rejects %s with an uncached 400", async (path) => {
  const response = await app.request(path, {}, env);
  expect(response.status).toBe(400);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
});

test("returns 404 for missing users", async () => {
  stubGitHub(() => Response.json({ data: { user: null }, errors: [{ type: "NOT_FOUND" }] }));
  const response = await app.request("/api/nobody.svg", {}, env);
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test("returns 429 when the rate limiter refuses", async () => {
  const fetchMock = stubGitHub();
  const response = await app.request("/api/octocat.svg", {}, {
    ...env,
    RATE_LIMITER: { limit: async () => ({ success: false }) },
  });
  expect(response.status).toBe(429);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("hides GitHub failures and the token behind an uncached 503", async () => {
  stubGitHub(() => new Response("bad credentials secret-token", { status: 401 }));
  const response = await app.request("/api/octocat.svg", {}, env);
  expect(response.status).toBe(503);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
  expect(await response.text()).not.toContain("secret-token");
});

test("hides unexpected errors behind an uncached 500", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await app.request("/api/octocat.svg", {}, {
    ...env,
    RATE_LIMITER: { limit: async () => { throw new Error("secret-token"); } },
  });
  expect(response.status).toBe(500);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.text()).not.toContain("secret-token");
});

test("returns an uncached 404 for other paths", async () => {
  const response = await app.request("/", {}, env);
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test("streams the SVG uncached when the whole range needs splitting", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-15T12:00:00Z"), toFake: ["Date"] });
  let first = true;
  stubGitHub(() => {
    if (first) return (first = false), new Response("", { status: 502 });
    return Response.json({ data: { user: { contributionsCollection: { contributionCalendar: { weeks: [{ contributionDays: [
      { date: "2026-11-15", contributionCount: 3, contributionLevel: "FOURTH_QUARTILE" },
    ] }] } } } } });
  });
  const put = vi.fn(async (_request: Request, _response: Response) => {});
  vi.stubGlobal("caches", { default: { put } });
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} };
  const response = await app.request("/api/octocat.svg", {}, env, ctx as never);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const text = await response.text();
  expect(text).toContain('id="d-2026-11-15"');
  expect(text.endsWith("</svg>")).toBe(true);

  // The completed copy is cached with the normal headers.
  await Promise.all(pending);
  expect(put).toHaveBeenCalledOnce();
  const stored = put.mock.calls[0]![1];
  expect(stored.headers.get("Cache-Control")).toBe("public, max-age=600, stale-while-revalidate=3600");
  expect(await stored.text()).toBe(text);
});

test("does not cache a stream that ends abnormally", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-15T12:00:00Z"), toFake: ["Date"] });
  let calls = 0;
  stubGitHub(() => {
    // Whole range fails, one chunk succeeds, the rest fail down to single days.
    if (++calls === 2) {
      return Response.json({ data: { user: { contributionsCollection: { contributionCalendar: { weeks: [{ contributionDays: [
        { date: "2026-11-15", contributionCount: 3, contributionLevel: "FOURTH_QUARTILE" },
      ] }] } } } } });
    }
    return new Response("", { status: 502 });
  });
  const put = vi.fn();
  vi.stubGlobal("caches", { default: { put } });
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} };
  const response = await app.request("/api/octocat.svg", {}, env, ctx as never);
  await expect(response.text()).rejects.toThrow();
  await Promise.all(pending);
  expect(put).not.toHaveBeenCalled();
});
