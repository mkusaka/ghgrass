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
      try {
        const token = await installationToken({
          clientId: c.env.GITHUB_APP_CLIENT_ID,
          privateKey: c.env.GITHUB_APP_PRIVATE_KEY,
        });
        if (image === "png") {
          const days = await fetchCalendar(token, username, start, end);
          return c.body(await renderPng(days, theme), 200, { "Content-Type": "image/png", ...CACHE_HEADERS });
        }
        const svg = await progressiveSvg(
          (options) => fetchCalendar(token, username, start, end, options),
          start,
          theme,
          c.req.raw.signal,
        );
        const headers = { "Content-Type": "image/svg+xml; charset=utf-8" };
        // A stream can end abnormally, and an incomplete SVG must never be cached.
        return c.body(svg as string, 200, typeof svg === "string" ? { ...headers, ...CACHE_HEADERS } : { ...headers, "Cache-Control": "no-store" });
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
