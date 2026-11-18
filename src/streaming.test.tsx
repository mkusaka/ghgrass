import { expect, test } from "vitest";

import { relevel, type FetchCalendarOptions } from "./github";
import { renderSvg } from "./render";
import { progressiveSvg } from "./streaming";
import type { Day, Level } from "./types";

const DAY_MS = 86_400_000;
const start = Date.parse("2025-11-16T00:00:00Z");
const year: Day[] = Array.from({ length: 365 }, (_, i) => ({
  date: new Date(start + i * DAY_MS).toISOString().slice(0, 10),
  count: i % 9,
  level: 1 as Level,
}));
const final = year.map((day) => ({ ...day, level: (day.count % 5) as Level }));
const read = async (stream: ReadableStream<Uint8Array>) => new Response(stream).text();

test("returns the finished SVG without streaming when no fallback happens", async () => {
  const svg = await progressiveSvg(async () => final, start, "light");
  expect(svg).toBe(renderSvg(final, "light", start));
});

test("streams chunks out of order, then corrects levels to match renderSvg", async () => {
  const svg = await progressiveSvg(
    async ({ onFallback, onChunk }: FetchCalendarOptions) => {
      await onFallback?.();
      // Chunks arrive in reverse, with one overlapping day.
      await onChunk?.(year.slice(200));
      await onChunk?.(year.slice(0, 201));
      return final;
    },
    start,
    "light",
  );
  const text = await read(svg as ReadableStream<Uint8Array>);
  expect(text.match(/<rect id="d-/g)).toHaveLength(365);
  expect(text.indexOf(`id="d-${year[300]!.date}"`)).toBeLessThan(text.indexOf(`id="d-${year[0]!.date}"`));
  expect(text.endsWith("</svg>")).toBe(true);
  // Applying the final CSS yields renderSvg's colors.
  const colors = ["#eff2f5", "#aceebb", "#4ac26b", "#2da44e", "#116329"];
  const css = new Map<string, string>();
  for (const [, ids, fill] of text.matchAll(/((?:#d-[\d-]+,?)+)\{fill:(#\w+)\}/g)) {
    for (const id of ids!.split(",")) css.set(id.slice(1), fill!);
  }
  for (const day of final) {
    const attr = text.match(new RegExp(`id="d-${day.date}"[^>]*fill="(#\\w+)"`))![1];
    expect(css.get(`d-${day.date}`) ?? attr).toBe(colors[day.level]);
  }
  expect(text).toContain(renderSvg(final, "light", start).match(/<metadata[^>]*><\/metadata>/)![0]);
});

test("errors the stream without a closing tag when a fetch fails midway", async () => {
  const svg = await progressiveSvg(
    async ({ onFallback, onChunk }: FetchCalendarOptions) => {
      await onFallback?.();
      await onChunk?.(year.slice(0, 28));
      throw new Error("boom");
    },
    start,
    "light",
  );
  await expect(read(svg as ReadableStream<Uint8Array>)).rejects.toThrow("boom");
});

test("rejects before streaming starts", async () => {
  await expect(progressiveSvg(async () => Promise.reject(new Error("early")), start, "light")).rejects.toThrow("early");
});

test("draws early chunks with levels from the data so far and recolors them as more arrives", async () => {
  const low = year.slice(0, 28).map((day) => ({ ...day, count: 1 }));
  const high = year.slice(28, 56).map((day) => ({ ...day, count: 100 }));
  const svg = await progressiveSvg(
    async ({ onFallback, onChunk }: FetchCalendarOptions) => {
      await onFallback?.();
      await onChunk?.(low);
      await onChunk?.(high);
      return relevel([...low, ...high]);
    },
    start,
    "light",
  );
  const text = await read(svg as ReadableStream<Uint8Array>);
  // Alone, count 1 is the maximum, so it starts at the top level; the later chunk demotes it.
  expect(text).toMatch(new RegExp(`id="d-${low[0]!.date}"[^>]*fill="#116329"`));
  expect(text).toMatch(new RegExp(`#d-${low[0]!.date}[^{]*\\{fill:#eff2f5|#d-${low[0]!.date}[^{]*\\{fill:#aceebb`));
  expect(text.endsWith("</svg>")).toBe(true);
});
