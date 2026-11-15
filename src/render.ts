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
    `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="${RADIUS}" ry="${RADIUS}" fill="${colors.levels[level]}"${
      title ? `><title>${escapeXml(title)}</title></rect>` : "/>"
    }`;

  // A month label sits over the first week whose Sunday falls in that month,
  // and is skipped when the month spans a single column (as on GitHub).
  const months: string[] = [];
  const monthOf = (week: number) => new Date(start + week * 7 * DAY_MS).getUTCMonth();
  for (let week = 0; week < weeks; week++) {
    const month = monthOf(week);
    if (week > 0 && monthOf(week - 1) === month) continue;
    if (week + 1 < weeks && monthOf(week + 1) !== month) continue;
    months.push(`<text x="${GRID_X + week * PITCH}" y="10">${MONTHS[month]}</text>`);
  }

  const cells = days.map((day) => {
    const offset = Math.round((toMs(day.date) - start) / DAY_MS);
    const x = GRID_X + Math.floor(offset / 7) * PITCH;
    const y = GRID_Y + (offset % 7) * PITCH;
    return cell(x, y, day.level, tooltip(day));
  });

  const legendEnd = width - MORE_WIDTH;
  const legendCells = [0, 1, 2, 3, 4].map((level) =>
    cell(legendEnd - (5 - level) * (CELL + 4), legendY, level),
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
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
</svg>`;
}
