// A curated set of standard Perler/Hama bead colors, as hex codes. These are
// close approximations of real bead colors — a good stand-in until we let
// users pick a specific manufacturer's official palette later.

export type PerlerColor = {
  name: string;
  hex: string; // e.g. "#ffffff"
};

export const PERLER_PALETTE: PerlerColor[] = [
  { name: "White", hex: "#f5f5f0" },
  { name: "Black", hex: "#1a1a1a" },
  { name: "Red", hex: "#d0121b" },
  { name: "Orange", hex: "#f47b20" },
  { name: "Yellow", hex: "#fde01a" },
  { name: "Pastel Yellow", hex: "#fbe8a6" },
  { name: "Cream", hex: "#f3e5c3" },
  { name: "Tan", hex: "#d8b487" },
  { name: "Peach", hex: "#f4c6a0" },
  { name: "Brown", hex: "#6b4226" },
  { name: "Dark Brown", hex: "#3b2417" },
  { name: "Pink", hex: "#f6a6c1" },
  { name: "Hot Pink", hex: "#e8368f" },
  { name: "Magenta", hex: "#9c1f5c" },
  { name: "Purple", hex: "#6a3fa0" },
  { name: "Lavender", hex: "#b9a3d3" },
  { name: "Dark Blue", hex: "#1b3f8b" },
  { name: "Blue", hex: "#1e6fd9" },
  { name: "Light Blue", hex: "#8fcbe8" },
  { name: "Turquoise", hex: "#1fa198" },
  { name: "Dark Green", hex: "#22582e" },
  { name: "Green", hex: "#3f9b3a" },
  { name: "Light Green", hex: "#a4d65e" },
  { name: "Gray", hex: "#8b8b8b" },
  { name: "Light Gray", hex: "#c7c7c7" },
];

// Turns "#rrggbb" into [r, g, b] (each 0-255).
export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return [r, g, b];
}

// Finds the palette color closest to the given RGB value.
//
// "Closest" here means smallest Euclidean distance in RGB space — treating
// red, green and blue as three axes and measuring straight-line distance.
// It's not exactly how human eyes perceive color difference, but it's simple
// and works well enough for this.
export function nearestColor(
  r: number,
  g: number,
  b: number,
  palette: PerlerColor[] = PERLER_PALETTE
): PerlerColor {
  let best = palette[0];
  let bestDistance = Infinity;

  for (const candidate of palette) {
    const [cr, cg, cb] = hexToRgb(candidate.hex);
    const dr = r - cr;
    const dg = g - cg;
    const db = b - cb;
    const distance = dr * dr + dg * dg + db * db;

    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  return best;
}
