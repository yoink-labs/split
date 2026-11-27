export interface CategoryMeta {
  id: string;
  label: string;
  color: string;
  bg: string;
  glyph: string;
}

export const CATEGORIES: CategoryMeta[] = [
  { id: "Dining", label: "Dining", color: "#EA580C", bg: "rgba(234,88,12,0.12)", glyph: "utensils" },
  { id: "Lodging", label: "Lodging", color: "#4F46E5", bg: "rgba(79,70,229,0.12)", glyph: "bed" },
  { id: "Flights", label: "Flights", color: "#0284C7", bg: "rgba(2,132,199,0.12)", glyph: "plane" },
  { id: "Transport", label: "Transport", color: "#0891B2", bg: "rgba(8,145,178,0.12)", glyph: "car" },
  { id: "Groceries", label: "Groceries", color: "#16A34A", bg: "rgba(22,163,74,0.12)", glyph: "cart" },
  { id: "Drinks", label: "Drinks & Coffee", color: "#9333EA", bg: "rgba(147,51,234,0.12)", glyph: "cup" },
  { id: "Activities", label: "Activities", color: "#DB2777", bg: "rgba(219,39,119,0.12)", glyph: "ticket" },
  { id: "Rent & Utilities", label: "Rent & Utilities", color: "#2563EB", bg: "rgba(37,99,235,0.12)", glyph: "home" },
  { id: "Shopping", label: "Shopping", color: "#D97706", bg: "rgba(217,119,6,0.12)", glyph: "bag" },
  { id: "Other", label: "Other", color: "#64748B", bg: "rgba(100,116,139,0.14)", glyph: "tag" },
];

export function categoryMeta(name?: string | null): CategoryMeta {
  if (!name) return CATEGORIES[CATEGORIES.length - 1];
  const lower = name.trim().toLowerCase();
  const found = CATEGORIES.find(
    (c) =>
      c.id.toLowerCase() === lower ||
      c.label.toLowerCase() === lower ||
      (lower.includes("food") && c.id === "Dining") ||
      (lower.includes("hotel") && c.id === "Lodging") ||
      (lower.includes("rent") && c.id === "Rent & Utilities") ||
      (lower.includes("util") && c.id === "Rent & Utilities") ||
      (lower.includes("coffee") && c.id === "Drinks") ||
      (lower.includes("taxi") && c.id === "Transport") ||
      (lower.includes("uber") && c.id === "Transport"),
  );
  return found ?? { id: name, label: name, color: "#475569", bg: "rgba(71,85,105,0.12)", glyph: "tag" };
}

export const AVATAR_PRESETS = [
  { id: "preset:cobalt", label: "Cobalt", bg: "#2563EB", fg: "#FFFFFF" },
  { id: "preset:indigo", label: "Indigo", bg: "#4F46E5", fg: "#FFFFFF" },
  { id: "preset:emerald", label: "Emerald", bg: "#059669", fg: "#FFFFFF" },
  { id: "preset:rose", label: "Rose", bg: "#E11D48", fg: "#FFFFFF" },
  { id: "preset:amber", label: "Amber", bg: "#D97706", fg: "#FFFFFF" },
  { id: "preset:teal", label: "Teal", bg: "#0D9488", fg: "#FFFFFF" },
  { id: "preset:violet", label: "Violet", bg: "#7C3AED", fg: "#FFFFFF" },
  { id: "preset:slate", label: "Slate", bg: "#334155", fg: "#FFFFFF" },
] as const;

export function avatarStyleFor(name: string, avatarURL?: string | null) {
  if (avatarURL?.startsWith("preset:")) {
    const p = AVATAR_PRESETS.find((x) => x.id === avatarURL);
    if (p) return { bg: p.bg, fg: p.fg, image: null as string | null };
  }
  if (avatarURL && (avatarURL.startsWith("https://") || avatarURL.startsWith("data:image/"))) {
    return { bg: "#E2E8F0", fg: "#0F172A", image: avatarURL };
  }
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const pick = AVATAR_PRESETS[Math.abs(hash) % AVATAR_PRESETS.length];
  return { bg: pick.bg, fg: pick.fg, image: null as string | null };
}
