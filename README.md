# ghgrass

GitHub contribution graphs, without the extras.

A Cloudflare Worker that renders a user's public contribution graph as an SVG
that looks like the one on their GitHub profile, for embedding in READMEs.

## Usage

```md
![contributions](https://<your-worker>/api/<username>.svg)
![contributions](https://<your-worker>/api/<username>.svg?theme=dark)
```

| Parameter | Values          | Default |
| --------- | --------------- | ------- |
| `theme`   | `light`, `dark` | `light` |

Opening the SVG directly shows per-day tooltips; images embedded in a README are static.

URLs are normalized for caching: an uppercase username, `theme=light` or unknown
query parameters get a `301` redirect to the canonical URL.

| Status    | Meaning                                       |
| --------- | --------------------------------------------- |
| 200       | SVG                                           |
| 301       | Redirect to the canonical URL                 |
| 400       | Invalid username or parameter                 |
| 404       | GitHub user not found                         |
| 429       | Rate limited by this service (per username)   |
| 502 / 503 | GitHub API failure or rate limit              |

Error responses are never cached.

## How it works

- The calendar is fetched from GitHub's GraphQL API (`contributionCalendar`)
  for the 53 Sunday-based weeks ending today (UTC), using a service token.
- GitHub fails (502/504, timeouts or "Something went wrong") on ranges with many
  contributions. The whole range is tried first so GitHub's own levels are used.
  On failure it is fetched in 4-week chunks, and failing chunks are halved down to
  single days (at most 45 requests). Because GitHub computes levels relative to the
  requested range, levels are then recomputed over the whole year with GitHub's
  undocumented rule as reverse-engineered by
  [akerl/githubstats](https://github.com/akerl/githubstats): quarters of the
  largest daily count after ignoring the first few outliers in date order. It
  matched every level of 206 sampled ranges.
- Responses are cached by Workers Cache (`cache.enabled`) for 10 minutes and
  served stale for up to an hour while revalidating:
  `Cloudflare-CDN-Cache-Control: public, max-age=600, stale-while-revalidate=3600`,
  `Cache-Control: public, max-age=0`.
- Colors come from `@primer/primitives` 11.10.0.

## Development

```sh
pnpm install
cp .dev.vars.example .dev.vars   # set GITHUB_TOKEN
pnpm dev
pnpm test
pnpm typecheck
```

## Deploy

1. Set a unique `namespace_id` for the rate limiter in `wrangler.jsonc`.
2. Store a GitHub token with no scopes as a secret: `pnpm wrangler secret put GITHUB_TOKEN`.
3. `pnpm deploy`
