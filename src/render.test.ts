import { describe, expect, test } from "vitest";

import { renderSvg, tooltip } from "./render";
import type { Day, Level } from "./types";

const DAY_MS = 86_400_000;
const start = Date.parse("2025-11-16T00:00:00Z");
const year: Day[] = Array.from({ length: 365 }, (_, i) => ({
  date: new Date(start + i * DAY_MS).toISOString().slice(0, 10),
  count: i * 7,
  level: (i % 5) as Level,
}));

describe("tooltip", () => {
  test.each([
    [12, "12 contributions on Nov 14, 2026"],
    [1, "1 contribution on Nov 14, 2026"],
    [0, "No contributions on Nov 14, 2026"],
  ])("%i", (count, text) => {
    expect(tooltip({ date: "2026-11-14", count, level: 1 })).toBe(text);
  });
});

describe("renderSvg", () => {
  const svg = renderSvg(year, "light");

  test("lays out 53 Sunday-based weeks with one titled cell per day", () => {
    expect(svg.match(/<title>/g)).toHaveLength(365);
    // Last column holds only Sunday 2026-11-15.
    expect(svg).toContain(`<rect x="707.5" y="16.5" width="9" height="9" rx="2" ry="2" fill="#116329"><title>2548 contributions on Nov 15, 2026</title>`);
    expect(svg).toContain('viewBox="0 0 717 122"');
  });

  test("shows no counts inside cells, only labels and legend text", () => {
    const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
    expect(texts).toEqual([
      "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov",
      "Mon", "Wed", "Fri", "Less", "More",
    ]);
  });

  test("skips a month label that would only cover the last column", () => {
    // Ends on Sunday 2026-12-06, the first Sunday of December.
    const shifted = year.map((day) => ({
      ...day,
      date: new Date(Date.parse(`${day.date}T00:00:00Z`) + 21 * DAY_MS).toISOString().slice(0, 10),
    }));
    const labels = [...renderSvg(shifted, "light").matchAll(/<text x="(\d+)" y="10">(\w+)/g)];
    expect(labels.at(-1)?.[2]).toBe("Nov");
    expect(labels.every(([, x]) => Number(x) <= 717 - 26)).toBe(true);
  });

  test("uses the theme palette", () => {
    const dark = renderSvg(year, "dark");
    expect(dark).toContain('fill="#56d364"');
    expect(dark).not.toContain("#116329");
    expect(svg).toContain('fill="#116329"');
  });

  test("is self-contained SVG 1.1", () => {
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" version="1.1"/);
    expect(svg).not.toMatch(/<script [^>]*src=|href=|@import|url\(|var\(/);
  });

  test("embeds one inline tooltip script in the theme's tooltip color", () => {
    expect(svg.match(/<script>/g)).toHaveLength(1);
    expect(svg).toContain('<g id="tip" visibility="hidden"');
    expect(svg).toContain('fill="#25292e"');
    expect(renderSvg(year, "dark")).toContain('fill="#3d444d"');
  });
});
