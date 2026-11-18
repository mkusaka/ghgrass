import { vValidator } from "@hono/valibot-validator";
import { Hono } from "hono";
import type { Context } from "hono";
import * as v from "valibot";

import { fetchCalendar, GitHubError, installationToken, yearRange } from "./github";
import { renderHtml, renderPng } from "./render";
import { progressiveSvg } from "./streaming";

type Bindings = {
  GITHUB_APP_CLIENT_ID: string;
  // PKCS#8 PEM.
  GITHUB_APP_PRIVATE_KEY: string;
  // Workers Rate Limiting binding.
  RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
};
type Env = { Bindings: Bindings };

const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=0",
  "Cloudflare-CDN-Cache-Control": "public, max-age=600, stale-while-revalidate=3600",
};

// Matches the 600s freshness in CACHE_HEADERS.
const COPY_MAX_AGE_MS = 600_000;
// Usernames whose copy is being regenerated in this isolate.
const refreshing = new Set<string>();

const params = v.object({
  file: v.pipe(
    v.string(),
    // GitHub logins: alphanumerics and single hyphens, no leading/trailing hyphen, max 39.
    // No extension serves the HTML page; ".html" is redirected there.
    v.regex(/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}(?:\.svg|\.png|\.html)?$/i),
    v.transform((file) => {
      const [name, ext] = file.toLowerCase().split(".");
      return { username: name!, image: ext === "svg" || ext === "png" ? ext : undefined };
    }),
  ),
});
const query = v.object({
  theme: v.optional(v.picklist(["light", "dark"]), "light"),
});

function fail(c: Context<Env>, status: 400 | 404 | 429 | 500 | 502 | 503, message: string) {
  return c.text(message, status, { "Cache-Control": "no-store" });
}

const invalid = (result: { success: boolean }, c: Context<Env>) =>
  result.success ? undefined : fail(c, 400, "Bad request");

const app = new Hono<Env>()
  .get(
    "/api/:file",
    vValidator("param", params, invalid),
    vValidator("query", query, invalid),
    async (c) => {
      const { username, image } = c.req.valid("param").file;
      const { theme } = c.req.valid("query");

      // The edge cache is keyed by URL, so letter case and extra parameters are
      // redirected to one canonical URL instead of being cached separately.
      const url = new URL(c.req.url);
      const canonical = `/api/${username}${image ? `.${image}` : ""}${theme === "dark" ? "?theme=dark" : ""}`;
      if (url.pathname + url.search !== canonical) {
        return c.redirect(canonical, 301);
      }
      if (!image) {
        return c.html(renderHtml(username, theme, url.origin), 200, CACHE_HEADERS);
      }

      if (!(await c.env.RATE_LIMITER.limit({ key: username })).success) {
        return fail(c, 429, "Too many requests");
      }

      const { start, end } = yearRange(new Date());
      const credentials = {
        clientId: c.env.GITHUB_APP_CLIENT_ID,
        privateKey: c.env.GITHUB_APP_PRIVATE_KEY,
      };
      try {
        if (image === "png") {
          const days = await fetchCalendar(await installationToken(credentials), username, start, end);
          return c.body(await renderPng(days, theme), 200, { "Content-Type": "image/png", ...CACHE_HEADERS });
        }
        const headers = { "Content-Type": "image/svg+xml; charset=utf-8" };
        // Not tied to the client's connection: a viewer that gives up early (Camo does)
        // must not stop the fetch, or a slow graph would never be stored.
        const generate = async () =>
          progressiveSvg(
            async (options) => fetchCalendar(await installationToken(credentials), username, start, end, options),
            start,
            theme,
          );

        // Graphs that needed streaming are kept as a finished copy under a private key.
        // A streamed response is no-store and would evict the edge cache's entry, and the
        // Cache API has no stale-while-revalidate, so this copy is served as an ordinary
        // cacheable response (which does get it) and refreshed in the background once old.
        const cache = (caches as unknown as { default: Cache }).default;
        const copyKey = new Request(`${url.origin}/copy${canonical}`);
        const store = (text: string) =>
          cache.put(
            copyKey,
            new Response(text, {
              headers: { ...headers, "Cache-Control": "public, max-age=86400", "X-Generated": String(Date.now()) },
            }),
          );
        const copy = await cache.match(copyKey);
        if (copy) {
          const stale = Date.now() - Number(copy.headers.get("X-Generated")) > COPY_MAX_AGE_MS;
          if (stale && !refreshing.has(canonical)) {
            refreshing.add(canonical);
            c.executionCtx.waitUntil(
              generate()
                .then((svg) => (typeof svg === "string" ? svg : new Response(svg).text()))
                .then(store)
                .catch(() => {})
                .finally(() => refreshing.delete(canonical)),
            );
          }
          return c.body(await copy.text(), 200, { ...headers, ...CACHE_HEADERS });
        }

        const svg = await generate();
        if (typeof svg === "string") return c.body(svg, 200, { ...headers, ...CACHE_HEADERS });

        // The stream goes out uncached; the copy is stored only if it ends cleanly, so an
        // incomplete SVG is never stored.
        const [body, whole] = svg.tee();
        c.executionCtx.waitUntil(
          new Response(whole)
            .text()
            .then(store)
            .catch(() => {}),
        );
        return c.body(body, 200, { ...headers, "Cache-Control": "no-store" });
      } catch (error) {
        if (!(error instanceof GitHubError)) throw error;
        if (error.status === 404) return fail(c, 404, "User not found");
        return fail(c, error.status, "GitHub is unavailable");
      }
    },
  )
  .notFound((c) => fail(c, 404, "Not found"))
  .onError((error, c) => {
    console.error(error);
    return fail(c, 500, "Internal error");
  });

export default app;
