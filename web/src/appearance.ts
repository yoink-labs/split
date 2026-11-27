// Appearance: a mode (system, light, dark) plus a palette for light mode and one for dark mode.
// CSS reads data-theme and data-palette on <html>; Cobalt is the token set in :root, so it has no attribute.
export type Mode = "system" | "light" | "dark";
export interface Palette {
  id: string;
  label: string;
  note: string;
  light: { bg: string; surface: string; primary: string; ink: string };
  dark: { bg: string; surface: string; primary: string; ink: string };
}
export const PALETTES: Palette[] = [
  { id: "evergreen", label: "Evergreen", note: "Forest green ledger",
    light: { bg: "#f7f8f5", surface: "#ffffff", primary: "#166534", ink: "#13201a" },
    dark: { bg: "#0c120f", surface: "#131b16", primary: "#4ade80", ink: "#ecf3ee" } },
  { id: "graphite", label: "Graphite", note: "Monochrome, sharp",
    light: { bg: "#f6f6f5", surface: "#ffffff", primary: "#18181b", ink: "#111111" },
    dark: { bg: "#0b0b0c", surface: "#141415", primary: "#fafafa", ink: "#f5f5f4" } },
  { id: "ocean", label: "Ocean", note: "Calm deep teal",
    light: { bg: "#f5f9fa", surface: "#ffffff", primary: "#0e7490", ink: "#0b1f26" },
    dark: { bg: "#071216", surface: "#0e1b21", primary: "#22d3ee", ink: "#e8f4f6" } },
  { id: "cobalt", label: "Cobalt", note: "Crisp financial blue",
    light: { bg: "#f8f9fb", surface: "#ffffff", primary: "#2563eb", ink: "#0f172a" },
    dark: { bg: "#0b0e14", surface: "#131822", primary: "#3b82f6", ink: "#f1f5f9" } },
  { id: "plum", label: "Plum", note: "Friendly violet",
    light: { bg: "#f8f7fc", surface: "#ffffff", primary: "#6d28d9", ink: "#1a1530" },
    dark: { bg: "#0e0b17", surface: "#161222", primary: "#a78bfa", ink: "#f3f0fb" } },
  { id: "terracotta", label: "Terracotta", note: "Warm travel orange",
    light: { bg: "#faf7f2", surface: "#fffdfa", primary: "#c2410c", ink: "#1c1917" },
    dark: { bg: "#12100e", surface: "#1b1815", primary: "#fb923c", ink: "#f6f1eb" } },
];
export const DEFAULT_PALETTE = "evergreen";
export interface Appearance { mode: Mode; light: string; dark: string }

const known = (id: string | null) => (id && PALETTES.some((p) => p.id === id) ? id : null);
export function readAppearance(): Appearance {
  const mode = localStorage.getItem("split-theme");
  return {
    mode: mode === "light" || mode === "dark" ? mode : "system",
    light: known(localStorage.getItem("split-palette-light")) ?? DEFAULT_PALETTE,
    dark: known(localStorage.getItem("split-palette-dark")) ?? DEFAULT_PALETTE,
  };
}
const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
export function applyAppearance(a: Appearance = readAppearance()) {
  const root = document.documentElement;
  root.dataset.theme = a.mode;
  const dark = a.mode === "dark" || (a.mode === "system" && systemDark());
  const palette = dark ? a.dark : a.light;
  if (palette === "cobalt") delete root.dataset.palette;
  else root.dataset.palette = palette;
}
export function saveAppearance(a: Appearance) {
  localStorage.setItem("split-theme", a.mode);
  localStorage.setItem("split-palette-light", a.light);
  localStorage.setItem("split-palette-dark", a.dark);
  applyAppearance(a);
}
export function startAppearance() {
  // ?palette=NAME previews one palette in both modes.
  const asked = known(new URLSearchParams(location.search).get("palette"));
  if (asked) saveAppearance({ ...readAppearance(), light: asked, dark: asked });
  else applyAppearance();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyAppearance());
}
