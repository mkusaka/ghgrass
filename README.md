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
`/api/<username>.html` (same `theme` parameter) serves the graph in a page sized
for phones that scrolls sideways to the latest week, like the graph on GitHub.

URLs are normalized for caching: an uppercase username, `theme=light` or unknown
query parameters get a `301` redirect to the canonical URL.

| Status    | Meaning                                       |
| --------- | --------------------------------------------- |
| 200       | SVG, or HTML for `.html`                      |
| 301       | Redirect to the canonical URL                 |
| 400       | Invalid username or parameter                 |
| 404       | GitHub user not found                         |
| 429       | Rate limited by this service (per username)   |
| 502 / 503 | GitHub API failure or rate limit              |

Error responses are never cached.

### Example

<a href="https://ghgrass.polyfill.workers.dev/api/mkusaka.html">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://ghgrass.polyfill.workers.dev/api/mkusaka.svg?theme=dark">
    <img alt="mkusaka's contribution graph" src="https://ghgrass.polyfill.workers.dev/api/mkusaka.svg">
  </picture>
</a>

`<picture>` follows the viewer's GitHub theme. Images in a README are static, so
the link opens the HTML page, where hovering or tapping a day shows its count:

```html
<a href="https://ghgrass.polyfill.workers.dev/api/mkusaka.html">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://ghgrass.polyfill.workers.dev/api/mkusaka.svg?theme=dark">
    <img alt="mkusaka's contribution graph" src="https://ghgrass.polyfill.workers.dev/api/mkusaka.svg">
  </picture>
</a>
```

## How it works

- The calendar is fetched from GitHub's GraphQL API (`contributionCalendar`)
  for the 53 Sunday-based weeks ending today (UTC), using a GitHub App
  installation token that is cached until shortly before it expires.
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

## GitHub App

The Worker authenticates as a GitHub App installation. The App needs no
permissions: public contribution data is readable by any installation.

1. Open <https://github.com/settings/apps/new> (or your organization's
   Settings → Developer settings → GitHub Apps → New GitHub App).
2. Fill in:
   - **GitHub App name**: anything unique, e.g. `ghgrass-<your-name>`.
   - **Homepage URL**: your Worker URL.
   - **Webhook**: uncheck **Active**.
   - **Permissions**: leave everything at **No access**.
   - **Where can this GitHub App be installed?**: **Only on this account**.
3. Click **Create GitHub App** and note the **Client ID** (`Iv23li...`).
4. Under **Credentials** → **Key pairs** (not Client secrets), click **New key**;
   a `.pem` file downloads.
5. Click **Install App** in the sidebar and install it on your account
   (if asked for repositories, any single one will do). The Worker finds the
   installation itself, so the App must have exactly one installation.
6. Convert the key to PKCS#8, which WebCrypto requires, store both secrets and
   delete the local key files:

   ```sh
   openssl pkcs8 -topk8 -nocrypt -in <app>.private-key.pem -out app.pkcs8.pem
   pnpm wrangler secret put GITHUB_APP_CLIENT_ID
   pnpm wrangler secret put GITHUB_APP_PRIVATE_KEY < app.pkcs8.pem
   rm <app>.private-key.pem app.pkcs8.pem
   ```

## Development

```sh
pnpm install
cp .dev.vars.example .dev.vars   # set the GitHub App credentials
pnpm dev
pnpm test
pnpm typecheck
```

## Deploy

1. Set a unique `namespace_id` for the rate limiter in `wrangler.jsonc`.
2. Create the GitHub App and store its secrets (see above).
3. `pnpm deploy`
