import type { Day, Level } from "./types";

const GRAPHQL_URL = "https://api.github.com/graphql";
const DAY_MS = 86_400_000;
const TIMEOUT_MS = 10_000;
// Workers allow 50 subrequests per invocation on the free plan.
const MAX_REQUESTS = 45;
// The first fallback step: 4-week chunks, as a week-aligned stand-in for months.
const CHUNK_DAYS = 28;

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

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The range GitHub's profile shows: 53 Sunday-based weeks ending today (UTC). */
export function yearRange(now: Date) {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = end - (now.getUTCDay() + 364) * DAY_MS;
  return { start, end };
}

async function request(token: string, login: string, start: number, end: number) {
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
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

function chunks(start: number, end: number, days: number) {
  const result: [number, number][] = [];
  for (let from = start; from <= end; from += days * DAY_MS) {
    result.push([from, Math.min(from + (days - 1) * DAY_MS, end)]);
  }
  return result;
}

/**
 * Fetches the contribution calendar for [start, end] (UTC midnights).
 *
 * GitHub's GraphQL API fails (502/504, timeouts or "Something went wrong") on
 * ranges with many contributions. The whole range is tried first so GitHub's own
 * levels can be used; on failure it is fetched in 4-week chunks, and any chunk
 * that still fails is halved down to single days.
 */
export async function fetchCalendar(
  token: string,
  login: string,
  start: number,
  end: number,
): Promise<Day[]> {
  let requests = 0;
  const fetchRange = async (from: number, to: number, size: number): Promise<ApiDay[]> => {
    if (++requests > MAX_REQUESTS) throw new GitHubError(503);
    try {
      return await request(token, login, from, to);
    } catch (error) {
      if (!(error instanceof SplittableError)) throw error;
      if (from === to) throw new GitHubError(502);
      const parts = chunks(from, to, size > CHUNK_DAYS ? CHUNK_DAYS : Math.ceil(size / 2));
      const results = await Promise.all(
        parts.map(([a, b]) => fetchRange(a, b, (b - a) / DAY_MS + 1)),
      );
      return results.flat();
    }
  };

  const apiDays = await fetchRange(start, end, (end - start) / DAY_MS + 1);
  const days = [...new Map(apiDays.map((day) => [day.date, day])).values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => ({
      date: day.date,
      count: day.contributionCount,
      level: LEVELS[day.contributionLevel] ?? 0,
    }));
  return requests > 1 ? relevel(days) : days;
}

/**
 * GitHub computes levels relative to the requested range, so levels from split
 * requests disagree with each other and are recomputed over the whole range.
 *
 * ponytail: GitHub's rule is undocumented. Its levels behave like quarters of a cap
 * that ignores a few outlier days; using the third-largest count as that cap
 * mismatched 63 of 2190 days across six sampled public profiles (plain maximum:
 * 184). Revisit if GitHub documents the algorithm.
 */
export function relevel(days: Day[]): Day[] {
  const cap = [...days.map((day) => day.count)].sort((a, b) => b - a).slice(0, 3).at(-1) ?? 0;
  return days.map((day) => ({
    ...day,
    level: (day.count === 0 ? 0 : Math.min(4, Math.ceil((day.count * 4) / cap))) as Level,
  }));
}
