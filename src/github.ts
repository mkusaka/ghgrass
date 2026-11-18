import type { Day, Level } from "./types";

const GRAPHQL_URL = "https://api.github.com/graphql";
const DAY_MS = 86_400_000;
const TIMEOUT_MS = 10_000;
// Workers (paid plan) allow 1000 subrequests per invocation; this keeps one graph well
// inside GitHub's hourly App rate limit.
const MAX_REQUESTS = 100;
// Only the whole year matches the profile page's counts; split ranges come back higher.
// The whole year often times out cold and answers in under a second once GitHub has it
// warmed, so it is tried this many times before splitting. Retries get a short timeout:
// a heavy year takes ~11s every time, and three full timeouts alone would use up the 30s
// `waitUntil` window that a background refresh runs in.
const WHOLE_ATTEMPTS = 3;
const RETRY_TIMEOUT_MS = 2_000;
// Failing ranges are split into pieces of the next size down. Each level costs one round
// trip, so three levels (4 weeks, weeks, days) are much faster than bisecting (~9 levels).
const SPLIT_DAYS = [28, 7, 1];

const QUERY = `query ($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        weeks { contributionDays { date contributionCount contributionLevel } }
      }
    }
  }
}`;

const LEVELS: Record<string, Level> = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

type ApiDay = { date: string; contributionCount: number; contributionLevel: string };
type GraphQLResponse = {
  errors?: { type?: string }[];
  data?: {
    user: {
      contributionsCollection?: {
        contributionCalendar?: { weeks: { contributionDays: ApiDay[] }[] };
      } | null;
    } | null;
  } | null;
};

export class GitHubError extends Error {
  constructor(readonly status: 404 | 502 | 503) {
    super(`GitHub request failed with status ${status}`);
  }
}

// Thrown for failures that a smaller date range may avoid.
class SplittableError extends Error {}

export type AppCredentials = { clientId: string; privateKey: string };

const base64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** A short-lived JWT that authenticates as the App itself. */
async function appJwt({ clientId, privateKey }: AppCredentials) {
  // Accepts real newlines or "\n" escapes (single-line .dev.vars values).
  const der = Uint8Array.from(
    atob(privateKey.replace(/-----[^-]+-----|\\n|\s/g, "")),
    (char) => char.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  // iat is backdated for clock drift; GitHub allows at most 10 minutes of lifetime.
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: clientId })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(signature)}`;
}

let cachedToken: { token: string; expiresAt: number } | undefined;

/**
 * Returns an installation token for the App's only installation, reused across
 * requests in this isolate until 5 minutes before it expires (tokens last 1 hour).
 */
export async function installationToken(app: AppCredentials): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 5 * 60_000) return cachedToken.token;
  const init = {
    headers: {
      Authorization: `Bearer ${await appJwt(app)}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ghgrass",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  const call = async (url: string, method = "GET") => {
    const response = await fetch(url, { ...init, method }).catch(() => null);
    if (!response?.ok) throw new GitHubError(503);
    return response.json();
  };
  const [installation] = (await call("https://api.github.com/app/installations")) as { id: number }[];
  if (!installation) throw new GitHubError(503);
  const { token, expires_at } = (await call(
    `https://api.github.com/app/installations/${installation.id}/access_tokens`,
    "POST",
  )) as { token: string; expires_at: string };
  cachedToken = { token, expiresAt: Date.parse(expires_at) };
  return token;
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The range GitHub's profile shows: 53 Sunday-based weeks ending today (UTC). */
export function yearRange(now: Date) {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = end - (now.getUTCDay() + 364) * DAY_MS;
  return { start, end };
}

async function request(
  token: string,
  login: string,
  start: number,
  end: number,
  signal?: AbortSignal,
  timeout = TIMEOUT_MS,
) {
  let response: Response;
  try {
    response = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "ghgrass",
      },
      body: JSON.stringify({
        query: QUERY,
        variables: { login, from: `${isoDate(start)}T00:00:00Z`, to: `${isoDate(end)}T23:59:59Z` },
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    });
  } catch {
    // Timeouts and network errors: heavy ranges often time out on GitHub's side.
    throw new SplittableError();
  }
  // 401 means our own token is broken; 403/429 are GitHub rate limits.
  if ([401, 403, 429].includes(response.status)) throw new GitHubError(503);
  if (!response.ok) throw new SplittableError();

  const json = (await response.json().catch(() => null)) as GraphQLResponse | null;
  if (json?.errors?.some((error) => error.type === "RATE_LIMITED")) throw new GitHubError(503);
  if (json?.data?.user === null) throw new GitHubError(404);
  const calendar = json?.data?.user?.contributionsCollection?.contributionCalendar;
  // "Something went wrong" errors come back as HTTP 200 without a calendar.
  if (!calendar) throw new SplittableError();
  return calendar.weeks.flatMap((week) => week.contributionDays);
}

export type FetchCalendarOptions = {
  /** Called once, before the first split, when the whole range failed. */
  onFallback?: () => void | Promise<void>;
  /** Called with each successfully fetched chunk (GitHub's own levels, not yet releveled). */
  onChunk?: (days: Day[]) => void | Promise<void>;
  signal?: AbortSignal;
};

const toDay = (day: ApiDay): Day => ({
  date: day.date,
  count: day.contributionCount,
  level: LEVELS[day.contributionLevel] ?? 0,
});

/**
 * Fetches the contribution calendar for [start, end] (UTC midnights).
 *
 * GitHub's GraphQL API fails (502/504, timeouts or "Something went wrong") on
 * ranges with many contributions. The whole range is tried first so GitHub's own
 * levels can be used (retried, see WHOLE_ATTEMPTS); on failure it is split into 4-week
 * chunks, failing chunks into weeks, and failing weeks into days.
 */
export async function fetchCalendar(
  token: string,
  login: string,
  start: number,
  end: number,
  { onFallback, onChunk, signal }: FetchCalendarOptions = {},
): Promise<Day[]> {
  let requests = 0;
  let fellBack = false;
  const fetchRange = async (from: number, to: number, retries = 0, retry = false): Promise<ApiDay[]> => {
    signal?.throwIfAborted();
    if (++requests > MAX_REQUESTS) throw new GitHubError(503);
    try {
      const days = await request(token, login, from, to, signal, retry ? RETRY_TIMEOUT_MS : TIMEOUT_MS);
      if (fellBack) await onChunk?.(days.map(toDay));
      return days;
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof SplittableError)) throw error;
      if (retries > 0) return fetchRange(from, to, retries - 1, true);
      if (from === to) throw new GitHubError(502);
      if (!fellBack) {
        fellBack = true;
        await onFallback?.();
      }
      const size = (to - from) / DAY_MS + 1;
      const step = SPLIT_DAYS.find((days) => days < size)! * DAY_MS;
      const parts: Promise<ApiDay[]>[] = [];
      for (let a = from; a <= to; a += step) parts.push(fetchRange(a, Math.min(a + step - DAY_MS, to)));
      return (await Promise.all(parts)).flat();
    }
  };

  const apiDays = await fetchRange(start, end, WHOLE_ATTEMPTS - 1);
  const days = [...new Map(apiDays.map((day) => [day.date, day])).values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(toDay);
  return fellBack ? relevel(days) : days;
}

// Outlier z-score threshold, from https://github.com/akerl/githubstats.
const OUTLIER_Z = 3.77972616981;

/**
 * GitHub computes levels relative to the requested range, so levels from split
 * requests disagree with each other and are recomputed over the whole range.
 *
 * GitHub's undocumented rule, as reverse-engineered by akerl/githubstats: counts
 * more than OUTLIER_Z sample standard deviations from the mean are outliers; the
 * first 3 distinct outlier counts in date order (only 1 when the maximum is small)
 * are ignored, and levels are quarters of the largest remaining count. Unlike
 * githubstats, outliers apply even with fewer than 5 distinct counts. This matched
 * every level of 206 GraphQL ranges (23,860 days) from 36 public profiles.
 */
export function relevel(days: Day[]): Day[] {
  const counts = days.map((day) => day.count);
  const n = counts.length;
  const mean = counts.reduce((sum, count) => sum + count, 0) / n;
  const sd = Math.sqrt(counts.reduce((sum, count) => sum + (count - mean) ** 2, 0) / (n - 1));
  const max = Math.max(...counts);
  const outliers = [...new Set(counts.filter((count) => Math.abs(count - mean) / sd > OUTLIER_Z))]
    .slice(0, max - mean < 6 || max < 15 ? 1 : 3);
  const cap = Math.max(0, ...counts.filter((count) => !outliers.includes(count)));
  return days.map((day) => ({
    ...day,
    level: (day.count === 0 ? 0 : Math.min(4, Math.ceil((day.count * 4) / cap))) as Level,
  }));
}
