// Loads a URL (including a temporary object URL from a file picker) into an
// <img> element we can then draw onto a canvas. Wrapped in a promise because
// image loading is asynchronous.
export function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load the image."));
    img.src = url;
  });
}
