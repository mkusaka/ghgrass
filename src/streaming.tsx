import type { FetchCalendarOptions } from "./github";
import { relevel } from "./github";
import { createLayout, FinalStyles, GrassChunk, lastYearTotal, renderSvg, svgFooter, svgHeader } from "./render";
import type { Day, Theme } from "./types";

/**
 * Resolves to the finished SVG when the whole range loads in one request. If it has
 * to fall back to split requests, resolves to a stream instead that writes each chunk
 * as it arrives and ends with CSS correcting levels once the year is complete.
 * A failure after streaming started errors the stream (no closing `</svg>`); before
 * that, the returned promise rejects.
 */
export function progressiveSvg(
  load: (options: FetchCalendarOptions) => Promise<Day[]>,
  start: number,
  theme: Theme,
  signal?: AbortSignal,
): Promise<string | ReadableStream<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const layout = createLayout(start);
    const encoder = new TextEncoder();
    const abort = new AbortController();
    signal?.addEventListener("abort", () => abort.abort(signal.reason));
    // Days received so far (a date seen twice, from overlapping chunks, counts once) and
    // the level each is currently shown with.
    const have = new Map<string, Day>();
    const shown = new Map<string, number>();
    // Cells whose level differs from what is shown, grouped by level for CSS.
    const changes = (days: Day[]) => {
      const byLevel = new Map<number, string[]>();
      for (const { date, level } of days) {
        if (shown.get(date) === level) continue;
        shown.set(date, level);
        byLevel.set(level, [...(byLevel.get(level) ?? []), date]);
      }
      return byLevel;
    };
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let streaming = false;
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => void (controller = c),
      cancel: (reason) => abort.abort(reason),
    });
    const send = (text: string) => {
      if (!abort.signal.aborted) controller.enqueue(encoder.encode(text));
    };

    load({
      signal: abort.signal,
      onFallback: () => {
        streaming = true;
        send(svgHeader(layout, theme));
        resolve(stream);
      },
      onChunk: (days) => {
        const fresh = days.filter((day) => !have.has(day.date));
        for (const day of fresh) have.set(day.date, day);
        // Levels are GitHub's quartiles of the range seen so far: new cells are drawn with
        // them, and already drawn cells that move are overridden by a later <style>.
        const leveled = relevel([...have.values()].sort((a, b) => a.date.localeCompare(b.date)));
        const isFresh = new Set(fresh.map((day) => day.date));
        const moved = changes(leveled.filter((day) => !isFresh.has(day.date)));
        changes(leveled.filter((day) => isFresh.has(day.date)));
        send(String(<GrassChunk days={leveled.filter((day) => isFresh.has(day.date))} layout={layout} theme={theme} />));
        send(String(<FinalStyles levels={moved} theme={theme} />));
      },
    }).then(
      (days) => {
        if (!streaming) return resolve(renderSvg(days, theme, start));
        send(svgFooter(lastYearTotal(days), changes(days), theme));
        if (!abort.signal.aborted) controller.close();
      },
      (error) => {
        if (!streaming) return reject(error);
        if (!abort.signal.aborted) controller.error(error);
      },
    );
  });
}
