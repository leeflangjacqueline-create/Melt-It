import { loadImageElement } from "./loadImage";

// A simple, no-AI way to remove a background: assume the background is
// roughly one color and touches the edges of the photo (true for a plain
// studio backdrop, a solid-color screenshot border, etc.), then "flood fill"
// inward from every edge pixel that matches it. Whatever the flood fill
// reaches gets marked transparent; anything it can't reach (because it's a
// different color) is left alone, on the assumption that it's the subject.
//
// This works well for photos with a plain or fairly uniform background, and
// won't do much for a busy, multi-colored background -- but it needs no
// machine-learning model, downloads nothing, and runs instantly.

// We don't need full photo resolution to make a good removal decision, and
// working on a smaller image keeps this fast even on an older phone.
const MAX_WORKING_DIMENSION = 800;

function colorDistance(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number
): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// Removes the background from an image and returns a transparent PNG blob.
//
// sensitivity ranges from 0 (only remove colors that match the background
// very closely) to 100 (remove a much wider range of similar colors).
export async function removeBackground(url: string, sensitivity: number): Promise<Blob> {
  const img = await loadImageElement(url);

  const scale = Math.min(1, MAX_WORKING_DIMENSION / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("This browser doesn't support canvas image processing.");
  }

  ctx.drawImage(img, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;

  // Turn the 0-100 sensitivity slider into an actual color-distance
  // threshold. Colors up to this far apart (out of a maximum possible
  // distance of about 441) are considered "the same" as the background.
  const threshold = 10 + (sensitivity / 100) * 90;

  // Figure out what the background color roughly is by averaging every
  // pixel around the border of the image.
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let borderPixelCount = 0;

  function sampleBorderPixel(x: number, y: number) {
    const i = (y * width + x) * 4;
    rSum += data[i];
    gSum += data[i + 1];
    bSum += data[i + 2];
    borderPixelCount++;
  }

  for (let x = 0; x < width; x++) {
    sampleBorderPixel(x, 0);
    sampleBorderPixel(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    sampleBorderPixel(0, y);
    sampleBorderPixel(width - 1, y);
  }

  const refR = rSum / borderPixelCount;
  const refG = gSum / borderPixelCount;
  const refB = bSum / borderPixelCount;

  // Flood fill: start from every border pixel that matches the reference
  // background color, then keep spreading to their neighbors as long as
  // those neighbors also match. We track visited pixels with a plain
  // array of 0s and 1s, and a growing list of "still need to check this
  // pixel's neighbors" work using push/pop (a stack), which is a simple,
  // efficient way to visit every connected matching pixel exactly once.
  const isBackground = new Uint8Array(width * height);
  const stack: number[] = [];

  function tryMarkBackground(x: number, y: number) {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const index = y * width + x;
    if (isBackground[index]) return;

    const i = index * 4;
    const distance = colorDistance(data[i], data[i + 1], data[i + 2], refR, refG, refB);
    if (distance <= threshold) {
      isBackground[index] = 1;
      stack.push(index);
    }
  }

  for (let x = 0; x < width; x++) {
    tryMarkBackground(x, 0);
    tryMarkBackground(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    tryMarkBackground(0, y);
    tryMarkBackground(width - 1, y);
  }

  while (stack.length > 0) {
    const index = stack.pop() as number;
    const x = index % width;
    const y = Math.floor(index / width);
    tryMarkBackground(x + 1, y);
    tryMarkBackground(x - 1, y);
    tryMarkBackground(x, y + 1);
    tryMarkBackground(x, y - 1);
  }

  // Make every background pixel fully transparent.
  for (let index = 0; index < width * height; index++) {
    if (isBackground[index]) {
      data[index * 4 + 3] = 0;
    }
  }

  ctx.putImageData(imageData, 0, 0);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Could not create the background-removed image."));
      }
    }, "image/png");
  });
}
