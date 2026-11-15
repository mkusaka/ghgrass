import type { Theme } from "./types";

// From @primer/primitives 11.10.0 (dist/css/functional/themes/{light,dark}.css):
// --contribution-default-bgColor-0..4, --contribution-default-borderColor-0, --fgColor-muted,
// --tooltip-bgColor, --bgColor-default, --fgColor-default.
// The border colors are 8-digit hex there; split into color + opacity for SVG 1.1.
export const themes: Record<
  Theme,
  { levels: readonly string[]; border: string; borderOpacity: number; text: string; tooltip: string; page: string; heading: string }
> = {
  light: {
    levels: ["#eff2f5", "#aceebb", "#4ac26b", "#2da44e", "#116329"],
    border: "#1f2328",
    borderOpacity: 0.05,
    text: "#59636e",
    tooltip: "#25292e",
    page: "#ffffff",
    heading: "#1f2328",
  },
  dark: {
    levels: ["#151b23", "#033a16", "#196c2e", "#2ea043", "#56d364"],
    border: "#010409",
    borderOpacity: 0.05,
    text: "#9198a1",
    tooltip: "#3d444d",
    page: "#0d1117",
    heading: "#f0f6fc",
  },
};
