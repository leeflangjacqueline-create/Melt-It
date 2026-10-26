import { PERLER_PALETTE, PerlerColor, nearestColor, hexToRgb } from "./perlerColors";
import { loadImageElement } from "./loadImage";

// Re-exported so other files can keep importing it from here, even though
// the actual code now lives in its own small file.
export { loadImageElement };

export type BoardSize = {
  width: number;
  height: number;
};

export type ColorCount = {
  color: PerlerColor;
  count: number;
};

export type Pattern = {
  width: number;
  height: number;
  // One entry per peg, stored row by row (row-major order): the cell at
  // column x, row y lives at index y * width + x. A cell is null when that
  // spot came from a transparent part of the image (for example, background
  // that was removed) -- meaning "no bead here" rather than any particular
  // color.
  cells: (PerlerColor | null)[];
  // How many beads of each color the pattern needs, most-used first. Cells
  // that are null (no bead) aren't counted.
  counts: ColorCount[];
};

// Pixels this transparent or more are treated as "no bead" rather than being
// matched to a color. Downsampling can leave a pixel partially transparent
// right at the edge of a removed background, so we use a cutoff partway
// through the range (0 = fully see-through, 255 = fully solid) instead of
// requiring exactly 0.
const ALPHA_CUTOFF = 128;

// For each peg, how many source pixels we sample across (in each
// direction) before picking a winner by majority vote. 2 means a 2x2 = 4
// pixel patch of the source image "votes" on what color this one peg
// should be. See the comment above generatePattern for why this matters.
//
// This number is a real trade-off, tested against an actual logo with fine
// detail (baseball stitching) rather than guessed: a bigger number is
// better at ignoring single stray anti-aliased pixels, but it's just as
// good at erasing genuine thin linework -- to a show of votes, a 2-pixel
// -wide intentional detail and a 1-pixel-wide anti-aliasing artifact look
// identical, both are simply "the minority in this patch." Tested 1
// (no voting), 2, 3, and 4 side by side: 2 meaningfully cuts down stray
// one-off colors versus 1, while 3 and 4 already wipe out most fine
// linework. There's no setting that perfectly separates "noise" from
// "thin but real detail" -- they're the same shape of problem -- so this
// is used as the default rather than a fixed rule, and exposed to the
// person as a "Detail" slider (see generatePattern's samplesPerCell
// parameter) so they can choose where on that trade-off their own image
// should land.
const SAMPLES_PER_CELL = 2;

// The range offered on the "Detail" slider. 1 = no voting at all (every
// sample pixel is taken at face value -- sharpest, but most sensitive to
// anti-aliasing speckle). 4 = heavy voting -- smooths out noise well but,
// per the testing above, already erases most fine linework. Exported so
// the UI can build the slider's min/max/default from the same numbers
// this file uses, instead of duplicating them.
export const MIN_SAMPLES_PER_CELL = 1;
export const MAX_SAMPLES_PER_CELL = 4;
export const DEFAULT_SAMPLES_PER_CELL = SAMPLES_PER_CELL;

// The core conversion: takes a loaded image and a pegboard size, and returns
// a grid of Perler colors (or null for "no bead") -- one entry per peg.
//
// How it works:
// 1. Crop the image to match the board's aspect ratio (like CSS
//    "object-fit: cover"), so the pattern isn't stretched or squashed.
// 2. Draw that crop onto an *oversized* canvas -- SAMPLES_PER_CELL pixels
//    per peg in each direction, not just one -- with smoothing off, so
//    every one of those pixels is a crisp, unblended sample of the source
//    image rather than an average.
// 3. For each peg, look at its whole block of sample pixels and let them
//    vote: mostly-transparent pixels vote "no bead," everything else votes
//    for whichever palette color it's closest to. Whichever option gets
//    the most votes wins that peg.
//
// Why votes instead of just one sample per peg: real image files -- even
// "flat color" logos and icons -- almost always have a thin ring of
// in-between, blended pixels wherever two colors meet (anti-aliasing,
// invisible at normal viewing size). A single sample can get unlucky and
// land right on one of those pixels, assigning a peg a color that doesn't
// really belong. With dozens of samples voting instead of one, those rare
// edge pixels get outvoted by the much larger number of samples that are
// genuinely deep in one solid-color region or another -- so pegs only end
// up with a "weird" color when a meaningful chunk of that peg's area
// genuinely is that color, not from one unlucky pick.
export function generatePattern(
  img: HTMLImageElement,
  board: BoardSize,
  palette: PerlerColor[] = PERLER_PALETTE,
  samplesPerCell: number = SAMPLES_PER_CELL
): Pattern {
  const sampleWidth = board.width * samplesPerCell;
  const sampleHeight = board.height * samplesPerCell;

  const canvas = document.createElement("canvas");
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("This browser doesn't support canvas image processing.");
  }

  // Note: we deliberately do NOT fill the canvas with a background color
  // first. Canvases start out fully transparent, and we want to preserve
  // that transparency so we can tell "actual image content" apart from
  // "background that was removed" a few steps down.
  //
  // Smoothing stays off here for the same reason described above: we want
  // every sample pixel to be a true, unblended pixel from the source image,
  // not something the browser has already averaged for us.
  ctx.imageSmoothingEnabled = false;

  const boardRatio = board.width / board.height;
  const imageRatio = img.width / img.height;

  let sx = 0;
  let sy = 0;
  let sWidth = img.width;
  let sHeight = img.height;

  if (imageRatio > boardRatio) {
    // Image is relatively wider than the board — crop its left/right edges.
    sWidth = img.height * boardRatio;
    sx = (img.width - sWidth) / 2;
  } else {
    // Image is relatively taller than the board — crop its top/bottom edges.
    sHeight = img.width / boardRatio;
    sy = (img.height - sHeight) / 2;
  }

  ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, sampleWidth, sampleHeight);

  const { data } = ctx.getImageData(0, 0, sampleWidth, sampleHeight);

  const cells: (PerlerColor | null)[] = [];
  const countByName = new Map<string, number>();

  // "votes" is reused for every peg -- cleared and refilled each time --
  // rather than allocated fresh per peg, since this loop runs once per
  // peg on every single pattern generation.
  const votes = new Map<string, number>();

  for (let cellY = 0; cellY < board.height; cellY++) {
    for (let cellX = 0; cellX < board.width; cellX++) {
      votes.clear();
      let noBeadVotes = 0;

      // Walk every sample pixel inside this one peg's patch of the source
      // image, and have it cast a vote.
      for (let sy2 = 0; sy2 < samplesPerCell; sy2++) {
        for (let sx2 = 0; sx2 < samplesPerCell; sx2++) {
          const px = cellX * samplesPerCell + sx2;
          const py = cellY * samplesPerCell + sy2;
          const i = (py * sampleWidth + px) * 4;
          const alpha = data[i + 3];

          if (alpha < ALPHA_CUTOFF) {
            noBeadVotes++;
            continue;
          }

          const match = nearestColor(data[i], data[i + 1], data[i + 2], palette);
          votes.set(match.name, (votes.get(match.name) ?? 0) + 1);
        }
      }

      // Find the winner: "no bead" and every palette color that got at
      // least one vote are all just options competing for the same peg,
      // so we compare them the same way.
      let winnerName: string | null = null;
      let winnerVotes = noBeadVotes;
      for (const [name, count] of votes) {
        if (count > winnerVotes) {
          winnerVotes = count;
          winnerName = name;
        }
      }

      if (winnerName === null) {
        cells.push(null);
      } else {
        // We know this palette color got at least one vote, so it must be
        // in the palette array -- look it up by name to get the full
        // PerlerColor object (hex code and all) rather than just its name.
        const match = palette.find((color) => color.name === winnerName)!;
        cells.push(match);
        countByName.set(match.name, (countByName.get(match.name) ?? 0) + 1);
      }
    }
  }

  const counts: ColorCount[] = palette
    .map((color) => ({ color, count: countByName.get(color.name) ?? 0 }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);

  const totalBeads = counts.reduce((sum, entry) => sum + entry.count, 0);
  if (totalBeads === 0) {
    throw new Error(
      "There's nothing left to turn into beads. Try restoring the original image, or lowering the background removal sensitivity."
    );
  }

  return { width: board.width, height: board.height, cells, counts };
}

// Returns a new pattern with every "floating" bead fixed, so the finished
// piece actually holds together once ironed. Perler beads only fuse to
// whatever they're really touching on a flat side -- a bead with no bead
// directly above, below, left, or right of it isn't attached to anything,
// even if it happens to touch another bead at a corner (that corner-only
// touch is unreliable -- "sketchy" -- compared to a proper side-by-side
// connection).
//
// Two different fixes, depending on what's around the floating bead:
// - If it touches another bead only at a corner, one of the two empty
//   cells that sit "between" them (the ones that would complete an L
//   connecting them) gets filled in with the floating bead's own color.
//   That turns the corner-only touch into a real side-by-side connection
//   -- so this adds one bead rather than deleting a piece of the design.
// - If it isn't touching anything at all, not even a corner, there's
//   nothing nearby to bridge to, so the bead is removed. In practice this
//   is almost always a single stray pixel the sampling step picked up by
//   mistake (see generatePattern above), not an intentional design
//   element meant to float in empty space.
//
// Cells are checked top-to-bottom, left-to-right, and each check looks at
// the grid as already patched by any earlier cell in this same pass. So
// when two floating beads are diagonal neighbors of each other (a common
// case), fixing the first one also happens to connect the second, and the
// second is left alone rather than adding a redundant bridge.
//
// This only needs to run once, right after generatePattern -- merging or
// reducing colors later only ever changes a bead's *color*, never whether
// a cell has a bead at all, so it can't undo the connectivity fixed here.
export function fixFloatingBeads(pattern: Pattern): Pattern {
  const { width, height } = pattern;
  const cells = pattern.cells.slice(); // a working copy we patch in place as we go

  const inBounds = (x: number, y: number) => x >= 0 && x < width && y >= 0 && y < height;
  const at = (x: number, y: number) => (inBounds(x, y) ? cells[y * width + x] : null);

  const ORTHOGONAL: [number, number][] = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ];
  const DIAGONAL: [number, number][] = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = at(x, y);
      if (!color) continue; // no bead here -- nothing to check

      const hasOrthogonalNeighbor = ORTHOGONAL.some(([dx, dy]) => at(x + dx, y + dy) !== null);
      if (hasOrthogonalNeighbor) continue; // already properly attached

      // Not attached on any side -- look for a corner (diagonal) neighbor
      // to bridge to instead.
      let bridged = false;
      for (const [dx, dy] of DIAGONAL) {
        if (!at(x + dx, y + dy)) continue; // no bead in that corner

        // The two cells "between" (x, y) and that diagonal neighbor --
        // filling either turns the corner touch into a side-by-side one.
        // Both are guaranteed empty here: each is also an orthogonal
        // neighbor of (x, y), and we already know (x, y) has none.
        const elbow: [number, number] = at(x + dx, y) === null ? [x + dx, y] : [x, y + dy];
        cells[elbow[1] * width + elbow[0]] = color;
        bridged = true;
        break;
      }

      if (!bridged) {
        // Nothing nearby at all, not even a corner touch -- remove it.
        cells[y * width + x] = null;
      }
    }
  }

  const countByName = new Map<string, number>();
  for (const cell of cells) {
    if (cell) countByName.set(cell.name, (countByName.get(cell.name) ?? 0) + 1);
  }

  const counts: ColorCount[] = pattern.counts
    .map((entry) => ({ color: entry.color, count: countByName.get(entry.color.name) ?? 0 }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);

  return { width, height, cells, counts };
}

// Returns a new pattern with every bead of one color reassigned to another
// already-present color -- for simplifying a palette by hand, e.g. folding
// a handful of stray "Hot Pink" pegs into the "Red" that's already there.
// The original pattern is left untouched (nothing here mutates its inputs),
// so callers can keep the untouched version around for an "undo this"
// option.
export function mergeColors(pattern: Pattern, fromColorName: string, intoColorName: string): Pattern {
  if (fromColorName === intoColorName) return pattern;

  const intoEntry = pattern.counts.find((entry) => entry.color.name === intoColorName);
  if (!intoEntry) return pattern; // target color isn't actually in this pattern -- nothing to do

  const intoColor = intoEntry.color;

  const cells = pattern.cells.map((cell) => (cell && cell.name === fromColorName ? intoColor : cell));

  // Recount from scratch rather than trying to adjust the old counts in
  // place -- simpler to get right, and this only runs when someone clicks
  // a merge option, not on every render.
  const countByName = new Map<string, number>();
  for (const cell of cells) {
    if (cell) countByName.set(cell.name, (countByName.get(cell.name) ?? 0) + 1);
  }

  const counts: ColorCount[] = pattern.counts
    .filter((entry) => entry.color.name !== fromColorName)
    .map((entry) => ({ color: entry.color, count: countByName.get(entry.color.name) ?? 0 }))
    .sort((a, b) => b.count - a.count);

  return { width: pattern.width, height: pattern.height, cells, counts };
}

// Returns a new pattern with exactly one cell recolored to a different,
// already-present palette color -- for a pixel-level touch-up tool, where
// someone fixes one specific bead by hand (e.g. "this eye is a bead too
// long, make the bottom one the background color instead").
//
// This deliberately only ever recolors a cell that already has a bead --
// it can't create a bead in an empty cell, and can't remove one either
// (there's no "no bead" option to paint with). That's what keeps it
// incapable of ever reintroducing a floating bead: it never changes which
// cells have a bead at all, only what color an existing one is, exactly
// like mergeColors above. So fixFloatingBeads never needs to run again
// after this -- whatever connectivity generatePattern produced stays
// exactly as connected.
export function recolorCell(pattern: Pattern, index: number, newColor: PerlerColor): Pattern {
  const existing = pattern.cells[index];
  if (!existing || existing.name === newColor.name) return pattern; // no bead there, or already that color

  const cells = pattern.cells.slice();
  cells[index] = newColor;

  const countByName = new Map<string, number>();
  for (const cell of cells) {
    if (cell) countByName.set(cell.name, (countByName.get(cell.name) ?? 0) + 1);
  }

  const counts: ColorCount[] = pattern.counts
    .map((entry) => ({ color: entry.color, count: countByName.get(entry.color.name) ?? 0 }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);

  return { width: pattern.width, height: pattern.height, cells, counts };
}

// Returns a new pattern with its color palette simplified down to at most
// maxColors colors, by repeatedly folding the least-used remaining color
// into whichever other remaining color is closest to it (by plain RGB
// distance -- the same "closest color" idea nearestColor uses for matching
// pixels to the bead palette in the first place). Used for the "Max
// colors" slider: an automatic, repeatable version of the same merge the
// person can also do by hand with mergeColors.
//
// Folding the *least-used* color each time (rather than, say, always the
// two closest colors) means the colors that matter most to the picture --
// the ones with the most beads -- are the last to get touched, and a
// single stray fleck of an odd color is usually the very first thing to
// go.
export function reduceColors(pattern: Pattern, maxColors: number): Pattern {
  let current = pattern;

  while (current.counts.length > maxColors && current.counts.length > 1) {
    // counts is already sorted most-used first, so the last entry is the
    // least-used color still remaining.
    const leastUsed = current.counts[current.counts.length - 1];
    const [lr, lg, lb] = hexToRgb(leastUsed.color.hex);

    let closest: ColorCount | null = null;
    let closestDistance = Infinity;
    for (const entry of current.counts) {
      if (entry.color.name === leastUsed.color.name) continue;
      const [er, eg, eb] = hexToRgb(entry.color.hex);
      const dr = lr - er;
      const dg = lg - eg;
      const db = lb - eb;
      const distance = dr * dr + dg * dg + db * db;
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = entry;
      }
    }

    if (!closest) break; // shouldn't happen once length > 1, but keeps this safe

    current = mergeColors(current, leastUsed.color.name, closest.color.name);
  }

  return current;
}

// How bright a color has to be (0 = black, 255 = white, using the standard
// "perceived brightness" weighting that counts green more than red or blue,
// and blue least of all) before we treat it as "light enough to get lost
// against a white page background." White, cream, and pastel yellow beads
// all land above this; saturated colors (even light blue or light green)
// stay below it because their hue already sets them apart from an empty,
// transparent cell.
const LIGHT_BEAD_LUMINANCE_THRESHOLD = 200;

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// Draws a pattern onto a <canvas> element as a grid of colored squares,
// scaling each peg up so the whole board fits within maxDisplaySize pixels.
// Cells with no bead are simply left transparent. Returns the cell size (in
// canvas pixels) it ended up using, so a caller that wants to turn a click
// or tap on the canvas back into a (column, row) peg position -- the pixel
// touch-up tool -- can do that math without duplicating this formula.
export function drawPattern(canvas: HTMLCanvasElement, pattern: Pattern, maxDisplaySize = 560): number {
  const cellSize = Math.max(4, Math.floor(maxDisplaySize / Math.max(pattern.width, pattern.height)));
  canvas.width = pattern.width * cellSize;
  canvas.height = pattern.height * cellSize;

  const ctx = canvas.getContext("2d");
  if (!ctx) return cellSize;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < pattern.height; y++) {
    for (let x = 0; x < pattern.width; x++) {
      const color = pattern.cells[y * pattern.width + x];
      if (!color) continue; // no bead here -- leave it transparent
      ctx.fillStyle = color.hex;
      ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);

      // A white (or near-white) bead would otherwise look exactly like an
      // empty, transparent "no bead" cell sitting on a white page -- so
      // give light-colored beads their own visible outline, independent of
      // the faint overall gridlines below, so "there's a bead here" is
      // never ambiguous.
      if (luminance(color.hex) > LIGHT_BEAD_LUMINANCE_THRESHOLD) {
        const outlineWidth = Math.max(1, Math.round(cellSize / 8));
        ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
        ctx.lineWidth = outlineWidth;
        ctx.strokeRect(
          x * cellSize + outlineWidth / 2,
          y * cellSize + outlineWidth / 2,
          cellSize - outlineWidth,
          cellSize - outlineWidth
        );
      }
    }
  }

  // Faint gridlines between pegs, but only when there's enough room to see
  // them — on a big board with tiny cells they'd just look like noise.
  if (cellSize >= 6) {
    ctx.strokeStyle = "rgba(0, 0, 0, 0.08)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= pattern.width; x++) {
      ctx.beginPath();
      ctx.moveTo(x * cellSize + 0.5, 0);
      ctx.lineTo(x * cellSize + 0.5, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y <= pattern.height; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * cellSize + 0.5);
      ctx.lineTo(canvas.width, y * cellSize + 0.5);
      ctx.stroke();
    }
  }

  return cellSize;
}
