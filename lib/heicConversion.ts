// iPhones save camera photos as HEIC by default. Safari (and any browser on
// iOS, since Apple requires them all to use its engine) can already display
// HEIC natively -- but Chrome, Firefox, and Edge on a computer generally
// cannot. To make uploads work everywhere, we detect HEIC files and convert
// them to an ordinary JPEG ourselves, right in the browser.

// Some browsers/operating systems label a HEIC file with the MIME type
// "image/heic" or "image/heif". Others (this has been observed with Safari
// in some file-picker situations) hand it over with an empty file.type.
// So we also fall back to checking the file extension.
export function isHeicFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "image/heic" || type === "image/heif") {
    return true;
  }

  const name = file.name.toLowerCase();
  return name.endsWith(".heic") || name.endsWith(".heif");
}

// Converts a HEIC/HEIF file into a JPEG Blob, entirely client-side.
export async function convertHeicToJpeg(file: File): Promise<Blob> {
  // heic2any bundles a WebAssembly HEIC decoder and is fairly large, so we
  // only load it when we actually encounter a HEIC file, instead of making
  // every visitor download it up front.
  const heic2any = (await import("heic2any")).default;

  const result = await heic2any({
    blob: file,
    toType: "image/jpeg",
    quality: 0.9,
  });

  // heic2any returns a single Blob normally, and an array only when the
  // source file bundles multiple images (e.g. a "Live Photo"). We just want
  // the one image.
  return Array.isArray(result) ? result[0] : result;
}

// Swaps a ".heic"/".heif" extension for ".jpg", so the filename we display
// matches what the file actually is after conversion.
export function withJpegExtension(filename: string): string {
  return filename.replace(/\.(heic|heif)$/i, ".jpg");
}
