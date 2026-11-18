import { glyphs } from "./glyphs";
import { themes } from "./themes";
import type { Day, Theme } from "./types";

// Measurements from github.com's ContributionCalendar markup.
const CELL = 10;
const PITCH = CELL + 3; // border-spacing: 3px
const RADIUS = 2;
const GRID_X = 31; // 28px label column + spacing
const GRID_Y = 16; // 13px month row + spacing
const LEGEND_GAP = 8;
// ponytail: fixed width for "More" instead of font metrics; tweak if the system font
// renders it noticeably wider.
const MORE_WIDTH = 30;
const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif`;

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_LABELS: [number, string][] = [
  [1, "Mon"],
  [3, "Wed"],
  [5, "Fri"],
];

const escapeXml = (text: string) =>
  text.replace(
    /[<>&"']/g,
    (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char]!,
  );

const toMs = (date: string) => Date.parse(`${date}T00:00:00Z`);

export function tooltip({ date, count }: Day) {
  const d = new Date(toMs(date));
  const when = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  if (count === 0) return `No contributions on ${when}`;
  return `${count} contribution${count === 1 ? "" : "s"} on ${when}`;
}

// Runs when the SVG is opened directly or embedded by the HTML page (<img> never runs
// scripts). Shows a
// GitHub-style tooltip on hover or tap instead of the slow, touch-less native <title>,
// above the cell, or below it when there is no room at the top of the image.
const TOOLTIP_SCRIPT = `<![CDATA[
const tip = document.getElementById("tip"), svg = tip.ownerSVGElement;
const [bg, arrow, label] = tip.children, width = +svg.getAttribute("width");
for (const title of document.querySelectorAll("rect > title")) {
  title.parentNode.dataset.tip = title.textContent;
  title.remove();
}
const hide = () => tip.setAttribute("visibility", "hidden");
const show = (cell) => {
  label.textContent = cell.dataset.tip;
  const w = label.getComputedTextLength() + 16, h = 26;
  const cx = +cell.getAttribute("x") + 4.5, top = +cell.getAttribute("y") - 0.5;
  const below = top - h - 5 < 0, y = below ? top + 15 : top - h - 5;
  const x = Math.min(Math.max(cx - w / 2, 0), width - w);
  bg.setAttribute("x", x); bg.setAttribute("y", y);
  bg.setAttribute("width", w); bg.setAttribute("height", h);
  label.setAttribute("x", x + 8); label.setAttribute("y", y + 17);
  const edge = below ? y : y + h, tipY = below ? y - 5 : y + h + 5;
  arrow.setAttribute("d", "M" + (cx - 5) + " " + edge + "L" + cx + " " + tipY + "L" + (cx + 5) + " " + edge + "Z");
  tip.setAttribute("visibility", "visible");
};
document.addEventListener("pointerover", (e) => (e.target.dataset && e.target.dataset.tip ? show(e.target) : hide()));
// A touch pointer "leaves" right after every tap; keep the tooltip until the next tap.
svg.addEventListener("pointerleave", (e) => e.pointerType === "mouse" && hide());
]]>`;

type Text = { x: number; y: number; text: string; end?: boolean };
type Cell = { x: number; y: number; level: number };
export type Layout = ReturnType<typeof createLayout>;

/**
 * Positions of GitHub's graph, shared by SVG and PNG. `start` is the first Sunday
 * (UTC midnight, from yearRange); the graph always spans 53 weeks, so coordinates
 * depend on dates only, never on which days have arrived.
 */
export function createLayout(start: number) {
  const weeks = 53;
  const width = GRID_X + weeks * PITCH - 3;
  const legendY = GRID_Y + 7 * PITCH - 3 + LEGEND_GAP;
  const height = legendY + CELL;
  const texts: Text[] = [];

  // A month label sits over the first week whose Sunday falls in that month,
  // and is skipped when the month spans a single column (as on GitHub), which also
  // keeps a label for the last column from overflowing the image.
  const monthOf = (week: number) => new Date(start + week * 7 * DAY_MS).getUTCMonth();
  for (let week = 0; week < weeks; week++) {
    const month = monthOf(week);
    if (week > 0 && monthOf(week - 1) === month) continue;
    if (week + 1 >= weeks || monthOf(week + 1) !== month) continue;
    texts.push({ x: GRID_X + week * PITCH, y: 10, text: MONTHS[month]! });
  }
  for (const [row, text] of DAY_LABELS) texts.push({ x: 0, y: GRID_Y + row * PITCH + 9, text });

  const legend: Cell[] = [];
  const legendEnd = width - MORE_WIDTH;
  for (const level of [0, 1, 2, 3, 4]) {
    legend.push({ x: legendEnd - (5 - level) * (CELL + 4), y: legendY, level });
  }
  texts.push({ x: legendEnd - 5 * (CELL + 4) - 4, y: legendY + 9, text: "Less", end: true });
  texts.push({ x: legendEnd, y: legendY + 9, text: "More" });

  const position = (date: string) => {
    const offset = Math.round((toMs(date) - start) / DAY_MS);
    return { x: GRID_X + Math.floor(offset / 7) * PITCH, y: GRID_Y + (offset % 7) * PITCH };
  };
  return { width, height, texts, legend, position };
}

/** GitHub's "in the last year" total: from the same date a year before the last day. */
export function lastYearTotal(days: Day[]) {
  const last = days.at(-1)?.date ?? "";
  const yearAgo = `${Number(last.slice(0, 4)) - 1}${last.slice(4)}`;
  return days.reduce((sum, day) => (day.date >= yearAgo ? sum + day.count : sum), 0);
}

const heading = (total: number) =>
  `${total.toLocaleString("en-US")} contribution${total === 1 ? "" : "s"} in the last year`;

type CellProps = { x: number; y: number; theme: Theme; level: number; day?: Day };

// Inset by half the stroke so the 1px border stays inside the cell, like GitHub's outline.
function GrassCell({ day, x, y, theme, level }: CellProps) {
  return (
    <rect
      id={day && `d-${day.date}`}
      x={x + 0.5}
      y={y + 0.5}
      width={CELL - 1}
      height={CELL - 1}
      rx={RADIUS}
      ry={RADIUS}
      fill={themes[theme].levels[level]}
    >
      {day && <title>{tooltip(day)}</title>}
    </rect>
  );
}

export function GrassChunk({ days, layout, theme }: { days: Day[]; layout: Layout; theme: Theme }) {
  return (
    <>
      {days.map((day) => (
        <GrassCell {...layout.position(day.date)} day={day} level={day.level} theme={theme} />
      ))}
    </>
  );
}

export function GraphLabels({ layout, theme }: { layout: Layout; theme: Theme }) {
  return (
    <g font-family={FONT} font-size="12" fill={themes[theme].text}>
      {layout.texts.map(({ x, y, text, end }) => (
        <text x={x} y={y} text-anchor={end ? "end" : undefined}>{text}</text>
      ))}
    </g>
  );
}

export function GraphLegend({ layout, theme }: { layout: Layout; theme: Theme }) {
  return (
    <>
      {layout.legend.map((cell) => (
        <GrassCell {...cell} theme={theme} />
      ))}
    </>
  );
}

/** CSS that moves cells whose provisional level changed to their final one. */
export function FinalStyles({ levels, theme }: { levels: Map<number, string[]>; theme: Theme }) {
  const css = [...levels]
    .map(([level, dates]) => `${dates.map((date) => `#d-${date}`).join(",")}{fill:${themes[theme].levels[level]}}`)
    .join("");
  return css ? <style dangerouslySetInnerHTML={{ __html: css }} /> : <></>;
}

export function GraphMetadata({ total }: { total: number }) {
  return <metadata id="graph-metadata" data-total={total} />;
}

export function GraphTooltip({ theme }: { theme: Theme }) {
  const fill = themes[theme].tooltip;
  return (
    <>
      <g id="tip" visibility="hidden" pointer-events="none" font-family={FONT} font-size="12">
        <rect rx="6" fill={fill} />
        <path fill={fill} />
        <text fill="#ffffff" />
      </g>
      <script dangerouslySetInnerHTML={{ __html: TOOLTIP_SCRIPT }} />
    </>
  );
}

/** The SVG up to the cells: root tag, labels, legend, and the open cell group. */
export function svgHeader(layout: Layout, theme: Theme) {
  const { width, height } = layout;
  const colors = themes[theme];
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n` +
    String(<GraphLabels layout={layout} theme={theme} />) +
    `\n<g stroke="${colors.border}" stroke-opacity="${colors.borderOpacity}" stroke-width="1" shape-rendering="geometricPrecision">` +
    String(<GraphLegend layout={layout} theme={theme} />)
  );
}

/** Everything after the last chunk. */
export const svgFooter = (total: number, levels: Map<number, string[]>, theme: Theme) =>
  `</g>\n${<FinalStyles levels={levels} theme={theme} />}${<GraphMetadata total={total} />}${<GraphTooltip theme={theme} />}\n</svg>`;

/** Renders days (sorted, starting on `start`'s Sunday) as GitHub's contribution graph. */
export function renderSvg(days: Day[], theme: Theme, start = toMs(days[0]?.date ?? "1970-01-04")) {
  const layout = createLayout(start);
  return (
    svgHeader(layout, theme) +
    String(<GrassChunk days={days} layout={layout} theme={theme} />) +
    svgFooter(lastYearTotal(days), new Map(), theme)
  );
}

// A 2x2 grid of contribution cells.
const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${themes.light.levels
    .slice(1)
    .map((fill, i) => `<rect x="${(i % 2) * 8 + 0.5}" y="${Math.floor(i / 2) * 8 + 0.5}" width="7" height="7" rx="1.5" fill="${fill}"/>`)
    .join("")}</svg>`,
)}`;

/**
 * A phone-sized page that scrolls sideways to the latest week, as on GitHub. It embeds
 * the SVG URL rather than the SVG, so the page needs no data and shares the SVG's cache.
 */
export function renderHtml(username: string, theme: Theme, origin: string) {
  const themeQuery = theme === "dark" ? "?theme=dark" : "";
  const svgUrl = `/api/${username}.svg${themeQuery}`;
  // A plain link to the other theme's canonical page, so each theme stays cacheable.
  const toggle = theme === "dark" ? [`/api/${username}`, "☀ Light"] : [`/api/${username}?theme=dark`, "☾ Dark"];
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(username)}'s contributions</title>
<link rel="icon" href="${FAVICON}">
<meta property="og:title" content="${escapeXml(username)}'s contributions">
<meta property="og:description" content="${escapeXml(username)}'s GitHub contribution graph for the last year">
<meta property="og:type" content="website">
<meta property="og:site_name" content="ghgrass">
<meta property="og:image" content="${escapeXml(`${origin}/api/${username}.png${themeQuery}`)}">
<meta name="twitter:card" content="summary_large_image">
<style>body{margin:0;padding:16px;background:${themes[theme].page}}header{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}h2{margin:0;min-height:24px;font:400 16px/24px ${FONT};color:${themes[theme].heading}}a{font:12px ${FONT};color:${themes[theme].text};text-decoration:none;white-space:nowrap}div{overflow-x:auto}object{display:block}</style>
<header><h2></h2><a href="${escapeXml(toggle[0]!)}">${toggle[1]}</a></header>
<div><object type="image/svg+xml" data="${escapeXml(svgUrl)}" onload="loaded(this)">${escapeXml(username)}'s contribution graph</object></div>
<script>
function loaded(graph) {
  graph.parentNode.scrollLeft = graph.parentNode.scrollWidth;
  // The SVG carries the total, so the page itself needs no data. It is in a trailing
  // <metadata>; older SVGs had it on the root.
  const doc = graph.contentDocument;
  const total = (doc?.getElementById("graph-metadata") ?? doc?.documentElement)?.getAttribute("data-total");
  if (total) document.querySelector("h2").textContent =
    \`\${Number(total).toLocaleString("en-US")} contribution\${total === "1" ? "" : "s"} in the last year\`;
}
// Taps inside the graph stay in its document; hide its tooltip on taps outside it.
document.addEventListener("pointerdown", () =>
  document.querySelector("object").contentDocument?.getElementById("tip")?.setAttribute("visibility", "hidden"));
</script>
</html>`;
}

// Link previews (Slack, X, ...) can't show SVG, so og:image is this PNG: the HTML page's
// heading and graph at 2x. Written by hand with prerendered glyphs, as a real rasterizer
// costs more CPU than the Workers free plan allows. ponytail: no kerning or cell borders.
const PNG_SCALE = 2;
const PNG_PADDING = 16;
const HEADING_HEIGHT = 32; // 24px line + 8px margin, as on the HTML page
const HEADING_BASELINE = 18;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

const alphaCache = new Map<string, Uint8Array>();
const alphaOf = (data: string) => {
  let alpha = alphaCache.get(data);
  if (!alpha) alphaCache.set(data, (alpha = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))));
  return alpha;
};

// Text is antialiased against the page background in this many steps per text color.
const TEXT_SHADES = 16;

/**
 * Renders the HTML page's heading and graph for days (sorted, starting on a Sunday) as a PNG.
 * It is indexed color (1 byte per pixel) to keep compression, most of the CPU time, small.
 */
export async function renderPng(days: Day[], theme: Theme) {
  const colors = themes[theme];
  const graph = createLayout(toMs(days[0]?.date ?? "1970-01-04"));
  const total = lastYearTotal(days);
  const scale = (n: number) => Math.round(n * PNG_SCALE);
  const left = PNG_PADDING;
  const top = PNG_PADDING + HEADING_HEIGHT;
  const width = scale(graph.width + 2 * PNG_PADDING);
  const height = scale(top + graph.height + PNG_PADDING);
  const row = width + 1; // filter byte + palette indexes

  // Palette: the page, the 5 levels, then the shades of each text color over the page.
  const page = rgb(colors.page);
  const textColors = [colors.heading, colors.text];
  const palette = [page, ...colors.levels.map(rgb)];
  for (const color of textColors.map(rgb)) {
    for (let shade = 1; shade <= TEXT_SHADES; shade++) {
      const a = shade / TEXT_SHADES;
      palette.push(page.map((p, i) => Math.round(p * (1 - a) + color[i]! * a)));
    }
  }
  const textIndex = (color: number, alpha: number) =>
    alpha < 8 ? 0 : 6 + color * TEXT_SHADES + Math.round((alpha * TEXT_SHADES) / 255) - 1;

  const pixels = new Uint8Array(row * height); // all page background (index 0)
  // x and baseline y in 1x units; `end` right-aligns at x, like text-anchor="end".
  const text = ({ x, y, text, end }: Text, size: number, color: number) => {
    const font = glyphs[size]!;
    const chars = [...text].map((char) => font[char]!);
    let pen = scale(x) - (end ? chars.reduce((sum, glyph) => sum + glyph.advance, 0) : 0);
    for (const glyph of chars) {
      const alpha = alphaOf(glyph.alpha);
      const x0 = Math.round(pen) + glyph.x, y0 = scale(y) + glyph.y;
      for (let i = 0; i < alpha.length; i++) {
        const at = (y0 + Math.floor(i / glyph.width)) * row + 1 + x0 + (i % glyph.width);
        // Glyphs may overlap slightly; keep the darker coverage.
        pixels[at] = Math.max(pixels[at]!, textIndex(color, alpha[i]!));
      }
      pen += glyph.advance;
    }
  };
  text({ x: left, y: PNG_PADDING + HEADING_BASELINE, text: heading(total) }, 16, 0);
  for (const label of graph.texts) text({ ...label, x: left + label.x, y: top + label.y }, 12, 1);

  // One row of a cell, inside its rounded corners, per y.
  const size = scale(CELL), radius = scale(RADIUS);
  const spans = Array.from({ length: size }, (_, y) => {
    const dy = Math.max(radius - y - 0.5, y + 0.5 - (size - radius), 0);
    const inset = dy === 0 ? 0 : Math.ceil(radius - 0.5 - Math.sqrt(radius * radius - dy * dy));
    return [inset, size - inset];
  });
  const cells = [...days.map((day) => ({ ...graph.position(day.date), level: day.level })), ...graph.legend];
  for (const { x, y, level } of cells) {
    const x0 = scale(left + x) + 1, y0 = scale(top + y);
    spans.forEach(([from, to], dy) => pixels.fill(1 + level, (y0 + dy) * row + x0 + from!, (y0 + dy) * row + x0 + to!));
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 3], 8); // 8-bit indexed color
  // "deflate" here is the zlib format PNG expects.
  const compressed = await new Response(
    new Blob([pixels]).stream().pipeThrough(new CompressionStream("deflate")),
  ).bytes();
  return new Blob([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("PLTE", new Uint8Array(palette.flat())),
    chunk("IDAT", compressed),
    chunk("IEND", new Uint8Array()),
  ]).arrayBuffer();
}
