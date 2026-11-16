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

/** Renders days (sorted, starting on a Sunday) as GitHub's contribution graph. */
export function renderSvg(days: Day[], theme: Theme) {
  const colors = themes[theme];
  const start = toMs(days[0]?.date ?? "1970-01-04");
  const weeks = Math.max(1, Math.ceil(days.length / 7));
  const gridWidth = weeks * PITCH - 3;
  const width = GRID_X + gridWidth;
  const legendY = GRID_Y + 7 * PITCH - 3 + LEGEND_GAP;
  const height = legendY + CELL;
  const cell = (x: number, y: number, level: number, title?: string) =>
    // Inset by half the stroke so the 1px border stays inside the cell, like GitHub's outline.
    `<rect x="${x + 0.5}" y="${y + 0.5}" width="${CELL - 1}" height="${CELL - 1}" rx="${RADIUS}" ry="${RADIUS}" fill="${colors.levels[level]}"${
      title ? `><title>${escapeXml(title)}</title></rect>` : "/>"
    }`;

  // A month label sits over the first week whose Sunday falls in that month,
  // and is skipped when the month spans a single column (as on GitHub), which also
  // keeps a label for the last column from overflowing the image.
  const months: string[] = [];
  const monthOf = (week: number) => new Date(start + week * 7 * DAY_MS).getUTCMonth();
  for (let week = 0; week < weeks; week++) {
    const month = monthOf(week);
    if (week > 0 && monthOf(week - 1) === month) continue;
    if (week + 1 >= weeks || monthOf(week + 1) !== month) continue;
    months.push(`<text x="${GRID_X + week * PITCH}" y="10">${MONTHS[month]}</text>`);
  }

  const cells = days.map((day) => {
    const offset = Math.round((toMs(day.date) - start) / DAY_MS);
    const x = GRID_X + Math.floor(offset / 7) * PITCH;
    const y = GRID_Y + (offset % 7) * PITCH;
    return cell(x, y, day.level, tooltip(day));
  });

  // GitHub's "in the last year" total: from the same date a year before the last day.
  const last = days.at(-1)?.date ?? "";
  const yearAgo = `${Number(last.slice(0, 4)) - 1}${last.slice(4)}`;
  const total = days.reduce((sum, day) => (day.date >= yearAgo ? sum + day.count : sum), 0);

  const legendEnd = width - MORE_WIDTH;
  const legendCells = [0, 1, 2, 3, 4].map((level) =>
    cell(legendEnd - (5 - level) * (CELL + 4), legendY, level),
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-total="${total}">
<g font-family="${escapeXml(FONT)}" font-size="12" fill="${colors.text}">
${months.join("\n")}
${DAY_LABELS.map(([row, label]) => `<text x="0" y="${GRID_Y + row * PITCH + 9}">${label}</text>`).join("\n")}
<text x="${legendEnd - 5 * (CELL + 4) - 4}" y="${legendY + 9}" text-anchor="end">Less</text>
<text x="${legendEnd}" y="${legendY + 9}">More</text>
</g>
<g stroke="${colors.border}" stroke-opacity="${colors.borderOpacity}" stroke-width="1" shape-rendering="geometricPrecision">
${cells.join("\n")}
${legendCells.join("\n")}
</g>
<g id="tip" visibility="hidden" pointer-events="none" font-family="${escapeXml(FONT)}" font-size="12">
<rect rx="6" fill="${colors.tooltip}"/><path fill="${colors.tooltip}"/><text fill="#ffffff"/>
</g>
<script>${TOOLTIP_SCRIPT}</script>
</svg>`;
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
  // The SVG carries the total, so the page itself needs no data.
  const total = graph.contentDocument?.documentElement.getAttribute("data-total");
  if (total) document.querySelector("h2").textContent =
    \`\${Number(total).toLocaleString("en-US")} contribution\${total === "1" ? "" : "s"} in the last year\`;
}
// Taps inside the graph stay in its document; hide its tooltip on taps outside it.
document.addEventListener("pointerdown", () =>
  document.querySelector("object").contentDocument?.getElementById("tip")?.setAttribute("visibility", "hidden"));
</script>
</html>`;
}


// Link previews (Slack, X, ...) can't show SVG, so og:image is this PNG: the cells only,
// at 2x, since text would need a font. Written by hand as the format is tiny for flat colors.
const PNG_SCALE = 2;
const PNG_PADDING = 16;

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

/** Renders days (sorted, starting on a Sunday) as the graph's cells in a PNG. */
export async function renderPng(days: Day[], theme: Theme) {
  const colors = themes[theme];
  const start = toMs(days[0]?.date ?? "1970-01-04");
  const weeks = Math.max(1, Math.ceil(days.length / 7));
  const pad = PNG_PADDING * PNG_SCALE;
  const width = (weeks * PITCH - 3) * PNG_SCALE + 2 * pad;
  const height = (7 * PITCH - 3) * PNG_SCALE + 2 * pad;
  const row = width * 3 + 1; // filter byte + RGB
  const pixels = new Uint8Array(row * height);
  const fill = (x0: number, y0: number, w: number, h: number, color: number[], radius = 0) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Skip pixels outside the rounded corners.
        const dx = Math.max(radius - x - 0.5, x + 0.5 - (w - radius), 0);
        const dy = Math.max(radius - y - 0.5, y + 0.5 - (h - radius), 0);
        if (dx * dx + dy * dy > radius * radius) continue;
        pixels.set(color, (y0 + y) * row + 1 + (x0 + x) * 3);
      }
    }
  };
  fill(0, 0, width, height, rgb(colors.page));
  for (const day of days) {
    const offset = Math.round((toMs(day.date) - start) / DAY_MS);
    const x = pad + Math.floor(offset / 7) * PITCH * PNG_SCALE;
    const y = pad + (offset % 7) * PITCH * PNG_SCALE;
    fill(x, y, CELL * PNG_SCALE, CELL * PNG_SCALE, rgb(colors.levels[day.level]!), RADIUS * PNG_SCALE);
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2], 8); // 8-bit RGB
  // "deflate" here is the zlib format PNG expects.
  const compressed = await new Response(
    new Blob([pixels]).stream().pipeThrough(new CompressionStream("deflate")),
  ).bytes();
  return new Blob([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", compressed),
    chunk("IEND", new Uint8Array()),
  ]).arrayBuffer();
}
