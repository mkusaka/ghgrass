import { afterEach, expect, test, vi } from "vitest";

import app from "./index";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const allow = { limit: async () => ({ success: true }) };
const env = { GITHUB_TOKEN: "secret-token", RATE_LIMITER: allow };

function stubGitHub(body: unknown = { data: { user: { contributionsCollection: { contributionCalendar: { weeks: [{ contributionDays: [
  { date: "2026-11-15", contributionCount: 3, contributionLevel: "FOURTH_QUARTILE" },
] }] } } } } }) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => Response.json(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

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

  const [, init] = fetchMock.mock.calls[0]!;
  expect(new Headers(init.headers).get("Authorization")).toBe("Bearer secret-token");
  expect(JSON.parse(init.body as string).variables).toEqual({
    login: "octocat",
    from: "2025-11-16T00:00:00Z",
    to: "2026-11-15T23:59:59Z",
  });
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
  "/api/octocat.png",
  "/api/octocat.svg?theme=blue",
])("rejects %s with an uncached 400", async (path) => {
  const response = await app.request(path, {}, env);
  expect(response.status).toBe(400);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
});

test("returns 404 for missing users", async () => {
  stubGitHub({ data: { user: null }, errors: [{ type: "NOT_FOUND" }] });
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
  vi.stubGlobal("fetch", vi.fn(async () => new Response("bad credentials secret-token", { status: 401 })));
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
