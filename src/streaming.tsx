import type { FetchCalendarOptions } from "./github";
import { createLayout, GrassChunk, lastYearTotal, renderSvg, svgFooter, svgHeader } from "./render";
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
    // Provisional level per date, by arrival; a date seen twice (overlapping chunks) is drawn once.
    const drawn = new Map<string, number>();
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
        const fresh = days.filter((day) => !drawn.has(day.date));
        for (const day of fresh) drawn.set(day.date, day.level);
        send(String(<GrassChunk days={fresh} layout={layout} theme={theme} />));
      },
    }).then(
      (days) => {
        if (!streaming) return resolve(renderSvg(days, theme, start));
        const changed = new Map<number, string[]>();
        for (const { date, level } of days) {
          if (drawn.get(date) !== level) changed.set(level, [...(changed.get(level) ?? []), date]);
        }
        send(svgFooter(lastYearTotal(days), changed, theme));
        if (!abort.signal.aborted) controller.close();
      },
      (error) => {
        if (!streaming) return reject(error);
        if (!abort.signal.aborted) controller.error(error);
      },
    );
  });
}
