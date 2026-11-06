"use client";

// A crop-and-zoom popup, shown right after picking or taking a photo and
// before any other editing. The idea: show the image inside a fixed window
// ("the frame"), let you zoom in with a slider and drag the image around
// underneath the frame with your finger or mouse, and treat whatever's
// visible inside the frame when you hit "Apply" as the new image going
// forward.
//
// If you never touch the zoom slider, the whole image exactly fills the
// frame and nothing is cropped -- so this tool is always safe to open and
// close without changing anything, and only actually crops once you
// deliberately zoom in.

import { useEffect, useRef, useState } from "react";

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.1;

type Props = {
  // The image to crop/zoom -- always the "base" image (before background
  // removal), since cropping is meant to happen first.
  imageUrl: string;
  // Called with the finished PNG when the user clicks "Apply".
  onApply: (blob: Blob) => void;
  // Called when the user cancels -- nothing they did in the popup should
  // affect the main page.
  onCancel: () => void;
};

type Offset = { x: number; y: number };

export default function ImageCropZoom({ imageUrl, onApply, onCancel }: Props) {
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  // The image's real pixel dimensions, once it's loaded -- used both to
  // size the frame (so its shape matches the photo) and to work out the
  // crop math below.
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);

  // The actual <img> we display and drag around.
  const imgRef = useRef<HTMLImageElement>(null);
  // The fixed-size window the image is seen through -- this is the part
  // that defines what counts as "in" or "out" of the crop.
  const frameRef = useRef<HTMLDivElement>(null);

  // Where the image is currently positioned relative to the frame, in
  // on-screen pixels. Kept in a ref (not React state) and applied directly
  // to the image's CSS transform, so dragging stays smooth at 60fps instead
  // of waiting on a React re-render for every tiny movement.
  const offsetRef = useRef<Offset>({ x: 0, y: 0 });
  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startOffset: Offset;
  } | null>(null);

  // How much the image is scaled up just to fully cover the frame with no
  // gaps, before the zoom slider adds any extra zoom on top. This is what
  // "zoom = 1" (the slider's minimum) means -- the smallest the image is
  // ever shown, and the only zoom level that's guaranteed to crop nothing
  // beyond whatever shape the frame itself is.
  function getCoverScale(): number {
    const frame = frameRef.current;
    if (!frame || !naturalSize) return 1;
    const rect = frame.getBoundingClientRect();
    if (!rect.width || !rect.height) return 1;
    return Math.max(rect.width / naturalSize.width, rect.height / naturalSize.height);
  }

  // Keeps the image from being dragged or zoomed so far that empty space
  // would show inside the frame -- the image's edges are never allowed to
  // move past the frame's edges.
  function clampOffset(offset: Offset, scale: number): Offset {
    const frame = frameRef.current;
    if (!frame || !naturalSize) return offset;
    const rect = frame.getBoundingClientRect();
    const displayWidth = naturalSize.width * scale;
    const displayHeight = naturalSize.height * scale;

    const x =
      displayWidth <= rect.width
        ? (rect.width - displayWidth) / 2
        : Math.min(0, Math.max(rect.width - displayWidth, offset.x));
    const y =
      displayHeight <= rect.height
        ? (rect.height - displayHeight) / 2
        : Math.min(0, Math.max(rect.height - displayHeight, offset.y));
    return { x, y };
  }

  function centeredOffset(scale: number): Offset {
    const frame = frameRef.current;
    if (!frame || !naturalSize) return { x: 0, y: 0 };
    const rect = frame.getBoundingClientRect();
    return {
      x: (rect.width - naturalSize.width * scale) / 2,
      y: (rect.height - naturalSize.height * scale) / 2,
    };
  }

  // Pushes the current zoom + pan onto the actual <img> element's style.
  // Called directly (not through React render) so dragging and the zoom
  // slider both feel immediate.
  function applyTransform() {
    const img = imgRef.current;
    if (!img || !naturalSize) return;
    const scale = getCoverScale() * zoom;
    img.style.width = `${naturalSize.width * scale}px`;
    img.style.height = `${naturalSize.height * scale}px`;
    img.style.transform = `translate(${offsetRef.current.x}px, ${offsetRef.current.y}px)`;
  }

  // The moment the image finishes loading, we know its real size, which is
  // also when the frame (sized to match that aspect ratio) settles into its
  // final on-screen dimensions -- so this is the right time to center the
  // image at the minimum zoom.
  function handleImageLoad() {
    const img = imgRef.current;
    if (!img) return;
    setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
    setIsLoading(false);
  }

  useEffect(() => {
    if (!naturalSize) return;
    // Wait a frame so the frame element has actually taken on its new
    // (aspect-ratio-dependent) size before we measure it.
    const raf = requestAnimationFrame(() => {
      offsetRef.current = centeredOffset(getCoverScale() * MIN_ZOOM);
      applyTransform();
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [naturalSize]);

  // Whenever the zoom slider moves, re-clamp the current pan so the image
  // still fully covers the frame at the new zoom level, then redraw.
  useEffect(() => {
    if (!naturalSize) return;
    offsetRef.current = clampOffset(offsetRef.current, getCoverScale() * zoom);
    applyTransform();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  // The frame is sized with CSS (percentage width + aspect-ratio), so it can
  // genuinely change size if the window is resized or the phone is rotated
  // -- re-clamp in that case too, so the image never ends up showing a gap.
  useEffect(() => {
    function handleResize() {
      if (!naturalSize) return;
      offsetRef.current = clampOffset(offsetRef.current, getCoverScale() * zoom);
      applyTransform();
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [naturalSize, zoom]);

  // While the popup is open, stop the page underneath from scrolling --
  // otherwise dragging to pan on a touchscreen can also drag the page.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // Let Escape close the popup, same as clicking Cancel.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  // --- Dragging: one set of pointer handlers covers mouse, touch, and
  // stylus input, since browsers report all three as "pointer" events.

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (isLoading || !naturalSize) return;
    // Ignore a second finger if one is already dragging.
    if (dragRef.current !== null) return;
    frameRef.current?.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startOffset: { ...offsetRef.current },
    };
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const scale = getCoverScale() * zoom;
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    offsetRef.current = clampOffset(
      { x: drag.startOffset.x + dx, y: drag.startOffset.y + dy },
      scale
    );
    applyTransform();
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
  }

  function handleResetZoom() {
    setZoom(MIN_ZOOM);
    // The effect watching [zoom] re-clamps and redraws, but since 1 might
    // already be the current value (no state change -> no effect run), also
    // re-center directly so "Reset" always visibly does something.
    if (naturalSize) {
      offsetRef.current = centeredOffset(getCoverScale() * MIN_ZOOM);
      applyTransform();
    }
  }

  function handleApply() {
    const img = imgRef.current;
    const frame = frameRef.current;
    if (!img || !frame || !naturalSize) return;

    const rect = frame.getBoundingClientRect();
    const scale = getCoverScale() * zoom;
    const offset = offsetRef.current;

    // Work out which rectangle of the original, full-resolution image is
    // currently visible inside the frame -- the inverse of the pan+scale
    // we've been displaying it with.
    const cropX = -offset.x / scale;
    const cropY = -offset.y / scale;
    const cropWidth = rect.width / scale;
    const cropHeight = rect.height / scale;

    const canvas = document.createElement("canvas");
    // Draw at the crop's own native resolution, not the frame's on-screen
    // size -- we're cropping, not resizing, so zooming in on a phone
    // shouldn't blur the result.
    canvas.width = Math.max(1, Math.round(cropWidth));
    canvas.height = Math.max(1, Math.round(cropHeight));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setLoadError("This browser doesn't support canvas image editing.");
      return;
    }
    ctx.drawImage(img, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (blob) onApply(blob);
    }, "image/png");
  }

  const aspectRatio = naturalSize ? naturalSize.width / naturalSize.height : 1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="crop-heading"
    >
      <div className="flex max-h-full w-full max-w-2xl flex-col gap-4 overflow-auto rounded-xl bg-white p-5 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <h2 id="crop-heading" className="text-lg font-semibold">
            Crop &amp; zoom
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            Cancel
          </button>
        </div>

        {loadError && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {loadError}
          </p>
        )}

        {!loadError && (
          <>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Drag the image to move it, or use the slider to zoom in and crop out anything you
              don&apos;t want. Nothing is cropped unless you zoom in.
            </p>

            <label className="flex max-w-xs flex-col gap-1 text-sm">
              Zoom: {zoom.toFixed(1)}×
              <input
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={ZOOM_STEP}
                value={zoom}
                disabled={isLoading}
                onChange={(e) => setZoom(Number(e.target.value))}
              />
            </label>

            <div
              ref={frameRef}
              onPointerDown={isLoading ? undefined : handlePointerDown}
              onPointerMove={isLoading ? undefined : handlePointerMove}
              onPointerUp={isLoading ? undefined : endDrag}
              onPointerCancel={isLoading ? undefined : endDrag}
              onPointerLeave={isLoading ? undefined : endDrag}
              className="relative mx-auto w-full max-w-md overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
              style={{
                aspectRatio: String(aspectRatio),
                maxHeight: "60vh",
                // Stops the browser's own touch-scroll/zoom from competing
                // with dragging the image around on a touchscreen.
                touchAction: "none",
                cursor: isLoading ? "default" : "grab",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imgRef}
                src={imageUrl}
                alt="Image being cropped"
                onLoad={handleImageLoad}
                draggable={false}
                className="absolute left-0 top-0 max-w-none select-none"
              />
              {isLoading && (
                <p className="absolute inset-0 flex items-center justify-center text-sm text-zinc-600 dark:text-zinc-400">
                  Loading image…
                </p>
              )}
            </div>

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={handleResetZoom}
                disabled={isLoading}
                className="text-sm text-zinc-600 underline hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                Reset
              </button>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={onCancel}
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleApply}
                  disabled={isLoading}
                  className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
