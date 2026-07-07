/**
 * arvcoin — design tokens (premium futuristic dark theme)
 */
export const colors = {
  bg: "#05060f",
  bg2: "#0a0c1c",
  card: "rgba(255,255,255,0.05)",
  cardSolid: "#0e1124",
  cardSolid2: "#141833",
  stroke: "rgba(255,255,255,0.10)",
  strokeStrong: "rgba(255,255,255,0.18)",
  text: "#eef1ff",
  muted: "#9aa3c7",
  muted2: "#6b7299",
  violet: "#7c5cff",
  cyan: "#00e0ff",
  mint: "#00ffa3",
  up: "#2fe08a",
  down: "#ff5d6c",
  btc: "#f7931a",
  eth: "#9d8bff",
  sol: "#00ffa3",
};

export const gradient = {
  brand: ["#7c5cff", "#00e0ff", "#00ffa3"] as const,
  brand2: ["#00e0ff", "#00ffa3"] as const,
  down: ["#ff5d6c", "#ff9aa4"] as const,
  violetCyan: ["#7c5cff", "#00e0ff"] as const,
  card: ["rgba(124,92,255,0.16)", "rgba(0,224,255,0.06)"] as const,
  darkCard: ["#141833", "#0b0e1f"] as const,
};

export const radius = {
  sm: 12,
  md: 18,
  lg: 24,
  xl: 32,
  pill: 999,
};

export const spacing = (n: number) => n * 4;

export const font = {
  // System fonts keep bundle light; swap for Sora/Space Grotesk later.
  regular: undefined as string | undefined,
};

export const shadow = {
  card: {
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 16 },
    elevation: 10,
  },
  glow: {
    shadowColor: "#00e0ff",
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
};
