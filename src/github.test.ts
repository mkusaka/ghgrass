import { afterEach, describe, expect, test, vi } from "vitest";

import { fetchCalendar, relevel, yearRange } from "./github";
import type { Day } from "./types";

afterEach(() => vi.unstubAllGlobals());

const DAY_MS = 86_400_000;
const { start, end } = yearRange(new Date("2026-11-15T12:00:00Z"));

// Answers like GitHub: ranges longer than `maxDays` fail; a day's count is its day of month.
function stubGitHub(maxDays: number, failure: () => Response = () => new Response("", { status: 502 })) {
  const ranges: [string, string][] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const { from, to } = JSON.parse(init.body as string).variables;
    ranges.push([from.slice(0, 10), to.slice(0, 10)]);
    const first = Date.parse(from);
    const last = Date.parse(to.slice(0, 10));
    if ((last - first) / DAY_MS + 1 > maxDays) return failure();
    const contributionDays = [];
    for (let t = first; t <= last; t += DAY_MS) {
      contributionDays.push({
        date: new Date(t).toISOString().slice(0, 10),
        contributionCount: new Date(t).getUTCDate(),
        contributionLevel: "FIRST_QUARTILE",
      });
    }
    return Response.json({
      data: { user: { contributionsCollection: { contributionCalendar: { weeks: [{ contributionDays }] } } } },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, ranges };
}

describe("yearRange", () => {
  test("ends today and starts on the Sunday 52 weeks before this week", () => {
    expect(new Date(start).toISOString().slice(0, 10)).toBe("2025-11-16");
    expect(new Date(end).toISOString().slice(0, 10)).toBe("2026-11-15");
    const saturday = yearRange(new Date("2026-11-14T23:59:59Z"));
    expect(new Date(saturday.start).toISOString().slice(0, 10)).toBe("2025-11-09");
    expect((saturday.end - saturday.start) / DAY_MS + 1).toBe(371);
  });
});

describe("fetchCalendar", () => {
  test("uses GitHub's levels when the whole range succeeds in one request", async () => {
    const { fetchMock, ranges } = stubGitHub(400);
    const days = await fetchCalendar("token", "octocat", start, end);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ranges[0]).toEqual(["2025-11-16", "2026-11-15"]);
    expect(days).toHaveLength(365);
    expect(days.every((day) => day.level === 1)).toBe(true);
  });

  test.each([
    ["HTTP 502", () => new Response("", { status: 502 })],
    ["a GraphQL error without data", () => Response.json({ errors: [{ message: "Something went wrong" }] })],
  ])("splits failing ranges on %s and recomputes levels", async (_name, failure) => {
    const { fetchMock, ranges } = stubGitHub(14, failure);
    const days = await fetchCalendar("token", "octocat", start, end);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(15);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(45);
    expect(ranges.slice(1, 3)).toEqual([
      ["2025-11-16", "2025-12-13"],
      ["2025-12-14", "2026-01-10"],
    ]);
    expect(days.map((day) => day.date)).toEqual(
      Array.from({ length: 365 }, (_, i) => new Date(start + i * DAY_MS).toISOString().slice(0, 10)),
    );
    // Counts are the day of month (max 31), so levels follow the whole range.
    expect(days.find((day) => day.date === "2025-12-31")?.level).toBe(4);
    expect(days.find((day) => day.date === "2025-12-01")?.level).toBe(1);
  });

  test("splits on timeouts", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (calls++ === 0) throw new DOMException("timed out", "TimeoutError");
        return Response.json({
          data: { user: { contributionsCollection: { contributionCalendar: { weeks: [] } } } },
        });
      }),
    );
    await fetchCalendar("token", "octocat", start, end);
    expect(calls).toBe(15);
  });

  test("does not split when the user does not exist", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: { user: null }, errors: [{ type: "NOT_FOUND" }] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchCalendar("token", "nobody", start, end)).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test.each([
    ["HTTP 401", () => new Response("", { status: 401 })],
    ["HTTP 403", () => new Response("", { status: 403 })],
    ["HTTP 429", () => new Response("", { status: 429 })],
    ["RATE_LIMITED", () => Response.json({ errors: [{ type: "RATE_LIMITED" }] })],
  ])("maps %s to 503 without splitting", async (_name, failure) => {
    const fetchMock = vi.fn(async () => failure());
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchCalendar("token", "octocat", start, end)).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("fails with 502 when a single day cannot be fetched", async () => {
    stubGitHub(0);
    await expect(fetchCalendar("token", "octocat", end, end)).rejects.toMatchObject({ status: 502 });
  });

  test("gives up with 503 before exceeding the subrequest budget", async () => {
    // Only single days succeed, so every chunk halves all the way down.
    const { fetchMock } = stubGitHub(1);
    await expect(fetchCalendar("token", "octocat", start, end)).rejects.toMatchObject({ status: 503 });
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(45);
  });
});

describe("relevel", () => {
  // Counts and levels GitHub's GraphQL API returned for real public ranges.
  const levelsOf = (first: string, counts: number[]) =>
    relevel(
      counts.map((count, i) => ({
        date: new Date(Date.parse(first) + i * DAY_MS).toISOString().slice(0, 10),
        count,
        level: 0,
      })),
    )
      .map((day) => day.level)
      .join("");

  test("ignores the first outliers in date order", () => {
    // torvalds, 2026-02-01..2026-03-31: 47 and 45 are outliers, so the cap is 28.
    const counts = [
      6, 2, 3, 5, 6, 10, 5, 2, 47, 45, 28, 25, 9, 9, 7, 10, 15, 8, 2, 21, 13, 6, 2, 2, 3, 10, 11, 6, 10, 1,
      3, 5, 5, 19, 12, 3, 0, 2, 2, 6, 16, 6, 11, 2, 3, 5, 5, 15, 4, 9, 1, 6, 4, 8, 18, 4, 13, 5, 4,
    ];
    expect(levelsOf("2026-02-01", counts)).toBe(
      "11111211444422123213211112212111132101113121111312111231211",
    );
  });

  test("ignores a single outlier when counts are small", () => {
    // getify, 2025-11-27..2026-01-10: only 4 is ignored, so the cap is 2.
    const counts = [
      1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 0, 2, 0, 0, 0, 1, 0, 0, 2, 1, 1, 0, 0, 0, 2, 0, 4,
      0, 1, 2, 0, 1, 0, 0, 0, 0, 0, 0,
    ];
    expect(levelsOf("2025-11-27", counts)).toBe("200200000000000420400020042200040402402000000");
  });

  test("keeps a large day that comes after the first 3 outliers", () => {
    // Synthetic: 300 is the 4th outlier by date, so it stays and becomes the cap.
    const counts = [...Array<number>(400).fill(5), 160, 170, 180, 300];
    expect(levelsOf("2026-01-01", counts).slice(-4)).toBe("3334");
  });

  test("keeps every level at 0 without contributions", () => {
    expect(relevel([{ date: "2026-01-01", count: 0, level: 0 }])[0]?.level).toBe(0);
  });
});
