"use client";

// A manual "paint the background away by hand" tool. It opens as a popup
// over the current page and lets you erase (or restore) pixels by
// dragging your finger or mouse over the image -- the same idea as the
// eraser tool in a basic paint program.
//
// Why this exists: the automatic background removal (lib/backgroundRemoval.ts)
// guesses based on color alone, and some photos -- a busy background, or
// camouflage clothing that's *designed* to match its surroundings -- defeat
// that guess no matter how the sensitivity slider is set. A person looking
// at the photo can always do better than a color-distance guess, so this
// gives you a direct, manual way to finish the job.

import { useEffect, useRef, useState } from "react";
import { loadImageElement } from "@/lib/loadImage";

// We don't need full camera resolution to paint accurately, and working on
// a smaller canvas keeps every stroke smooth even on an older phone. This
// matches the cap used for automatic background removal, for the same
// reason.
const MAX_WORKING_DIMENSION = 800;

// How many strokes of undo history to keep. Each entry is a full snapshot
// of the canvas, so this is a memory/undo-depth tradeoff -- 15 is generous
// for a "fix a few spots" tool without using an unreasonable amount of
// memory on a phone.
const MAX_UNDO_STEPS = 15;

type Mode = "erase" | "restore";

type Props = {
  // The image to touch up -- whatever's currently showing in the preview
  // (the original, or the result of automatic background removal).
  imageUrl: string;
  // Called with the finished PNG when the user clicks "Apply changes".
  onApply: (blob: Blob) => void;
  // Called when the user cancels -- nothing they did in the popup should
  // affect the main page.
  onCancel: () => void;
};

export default function ManualTouchUp({ imageUrl, onApply, onCancel }: Props) {
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("erase");
  const [brushSize, setBrushSize] = useState(30);
  // We only re-render to enable/disable the Undo button, so we track the
  // stack's length in state but keep the actual snapshots in a ref (putting
  // image data in React state would cause a lot of unnecessary re-renders).
  const [undoCount, setUndoCount] = useState(0);

  // The canvas the user actually sees and draws on.
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // An offscreen, never-displayed canvas holding the image exactly as it
  // was when this popup opened. "Restore" paints pixels back from here --
  // so restoring undoes *your* edits, not the automatic removal that may
  // have run before you opened this tool.
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // A small floating circle that follows the pointer, so you can see how
  // big your brush is before you commit to a stroke. Updated directly
  // (not through React state) since pointer-move fires very often.
  const cursorRef = useRef<HTMLDivElement>(null);

  const undoStackRef = useRef<ImageData[]>([]);
  const isDrawingRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  // Load the image once when the popup opens.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const img = await loadImageElement(imageUrl);
        if (cancelled) return;

        const scale = Math.min(1, MAX_WORKING_DIMENSION / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));

        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          setLoadError("This browser doesn't support canvas image editing.");
          setIsLoading(false);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);

        // Keep an untouched copy for the "restore" brush and the "Reset"
        // button.
        const source = document.createElement("canvas");
        source.width = width;
        source.height = height;
        source.getContext("2d")?.drawImage(canvas, 0, 0);
        sourceCanvasRef.current = source;

        undoStackRef.current = [];
        setUndoCount(0);
        setIsLoading(false);
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setLoadError("Couldn't load this image for editing. Please try again.");
          setIsLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  // While the popup is open, stop the page underneath from scrolling --
  // otherwise dragging to erase on a touchscreen can also drag the page.
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

  // Converts a pointer event's screen position into a position on the
  // canvas's own pixel grid. This matters because the canvas is often
  // displayed smaller or larger on screen than its actual pixel size (for
  // example, shrunk to fit a phone screen), so "where the finger is on
  // screen" and "which pixel that corresponds to" aren't the same number.
  function getCanvasPoint(canvas: HTMLCanvasElement, e: React.PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  // Paints one circular "dab" of the current brush at (x, y).
  function drawDab(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const radius = brushSize / 2;
    if (mode === "erase") {
      // destination-out is a canvas blending mode that *removes* whatever
      // you draw, instead of adding color -- it's the actual mechanism
      // behind "erasing" on a transparent image.
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
    } else {
      // Restore: reveal the untouched source image, but only inside this
      // circle -- clip to the circle, clear that patch, then redraw the
      // source underneath it.
      const source = sourceCanvasRef.current;
      if (!source) return;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.clearRect(x - radius, y - radius, radius * 2, radius * 2);
      ctx.drawImage(source, 0, 0);
      ctx.restore();
    }
  }

  // Draws a straight line of dabs between two points, so a fast drag
  // doesn't leave gaps -- without this, quick strokes would look like a
  // dotted line instead of a solid one.
  function drawStroke(
    ctx: CanvasRenderingContext2D,
    from: { x: number; y: number },
    to: { x: number; y: number }
  ) {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const step = Math.max(1, brushSize / 4);
    const steps = Math.max(1, Math.ceil(distance / step));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      drawDab(ctx, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    }
  }

  function pushUndoSnapshot() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    undoStackRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (undoStackRef.current.length > MAX_UNDO_STEPS) {
      undoStackRef.current.shift();
    }
    setUndoCount(undoStackRef.current.length);
  }

  function handleUndo() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const last = undoStackRef.current.pop();
    if (!canvas || !ctx || !last) return;
    ctx.putImageData(last, 0, 0);
    setUndoCount(undoStackRef.current.length);
  }

  function handleReset() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const source = sourceCanvasRef.current;
    if (!canvas || !ctx || !source) return;
    // Record the pre-reset state so Reset itself can be undone too.
    pushUndoSnapshot();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0);
  }

  // --- Pointer handling: this one set of handlers covers mouse, touch,
  // and stylus input, since browsers report all three as "pointer" events.
  // That's what lets the same code work whether you're on a laptop with a
  // mouse or on your phone with a finger.

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    // Ignore a second finger if one is already drawing.
    if (activePointerIdRef.current !== null) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    canvas.setPointerCapture(e.pointerId);
    activePointerIdRef.current = e.pointerId;
    isDrawingRef.current = true;

    pushUndoSnapshot();
    const point = getCanvasPoint(canvas, e);
    lastPointRef.current = point;
    drawDab(ctx, point.x, point.y);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const point = getCanvasPoint(canvas, e);

    // Move the brush-size preview circle to follow the pointer, in display
    // (CSS) pixels rather than canvas pixels.
    if (cursorRef.current) {
      const rect = canvas.getBoundingClientRect();
      const displayRadius = (brushSize / 2) * (rect.width / canvas.width);
      cursorRef.current.style.left = `${e.clientX}px`;
      cursorRef.current.style.top = `${e.clientY}px`;
      cursorRef.current.style.width = `${displayRadius * 2}px`;
      cursorRef.current.style.height = `${displayRadius * 2}px`;
    }

    if (!isDrawingRef.current || activePointerIdRef.current !== e.pointerId) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const from = lastPointRef.current ?? point;
    drawStroke(ctx, from, point);
    lastPointRef.current = point;
  }

  function endStroke(e: React.PointerEvent<HTMLCanvasElement>) {
    if (activePointerIdRef.current !== e.pointerId) return;
    isDrawingRef.current = false;
    activePointerIdRef.current = null;
    lastPointRef.current = null;
  }

  function handleApply() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (blob) onApply(blob);
    }, "image/png");
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="touchup-heading"
    >
      <div className="flex max-h-full w-full max-w-2xl flex-col gap-4 overflow-auto rounded-xl bg-white p-5 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <h2 id="touchup-heading" className="text-lg font-semibold">
            Touch up manually
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

        {/* This whole block stays mounted even while the image is still
            loading -- the canvas element needs to exist in the page for
            the loading code to get a reference to it and draw onto it.
            We just disable the controls and overlay a "Loading…" message
            until it's ready, rather than hiding the canvas entirely. */}
        {!loadError && (
          <>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Drag to erase. Switch to &quot;Restore&quot; and drag to bring spots back. Works with
              your finger on a touchscreen too.
            </p>

            <div className="flex flex-wrap items-center gap-4">
              <div className="flex overflow-hidden rounded-lg border border-zinc-300 dark:border-zinc-700">
                <button
                  type="button"
                  onClick={() => setMode("erase")}
                  disabled={isLoading}
                  aria-pressed={mode === "erase"}
                  className={`px-3 py-1.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
                    mode === "erase"
                      ? "bg-amber-600 text-white"
                      : "bg-white text-zinc-700 hover:bg-zinc-100 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                  }`}
                >
                  Erase
                </button>
                <button
                  type="button"
                  onClick={() => setMode("restore")}
                  disabled={isLoading}
                  aria-pressed={mode === "restore"}
                  className={`px-3 py-1.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
                    mode === "restore"
                      ? "bg-emerald-600 text-white"
                      : "bg-white text-zinc-700 hover:bg-zinc-100 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                  }`}
                >
                  Restore
                </button>
              </div>

              <label className="flex flex-1 min-w-[10rem] flex-col gap-1 text-sm">
                Brush size: {brushSize}
                <input
                  type="range"
                  min={10}
                  max={80}
                  value={brushSize}
                  disabled={isLoading}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                />
              </label>

              <button
                type="button"
                onClick={handleUndo}
                disabled={isLoading || undoCount === 0}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                Undo
              </button>

              <button
                type="button"
                onClick={handleReset}
                disabled={isLoading}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                Reset
              </button>
            </div>

            <div
              className="relative flex min-h-[12rem] justify-center overflow-hidden rounded-xl border border-zinc-200 p-2 dark:border-zinc-800"
              style={{
                backgroundImage:
                  "linear-gradient(45deg, #d4d4d8 25%, transparent 25%), linear-gradient(-45deg, #d4d4d8 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #d4d4d8 75%), linear-gradient(-45deg, transparent 75%, #d4d4d8 75%)",
                backgroundSize: "16px 16px",
                backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
                backgroundColor: "#f4f4f5",
              }}
            >
              <canvas
                ref={canvasRef}
                onPointerDown={isLoading ? undefined : handlePointerDown}
                onPointerMove={isLoading ? undefined : handlePointerMove}
                onPointerUp={isLoading ? undefined : endStroke}
                onPointerCancel={isLoading ? undefined : endStroke}
                onPointerLeave={isLoading ? undefined : endStroke}
                // Stops the browser's own touch scrolling/zooming from
                // competing with drawing a stroke on a touchscreen.
                style={{ touchAction: "none" }}
                className="max-h-[60vh] w-auto max-w-full cursor-none rounded-lg"
              />
              {isLoading && (
                <p className="absolute inset-0 flex items-center justify-center text-sm text-zinc-600 dark:text-zinc-400">
                  Loading image…
                </p>
              )}
            </div>

            <div className="flex justify-end gap-3">
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
                Apply changes
              </button>
            </div>
          </>
        )}
      </div>

      {/* The brush-size preview circle. Fixed-position so it can follow the
          pointer anywhere over the canvas; pointer-events-none so it never
          itself blocks a click or drag. */}
      <div
        ref={cursorRef}
        className="pointer-events-none fixed z-50 rounded-full border-2 border-white mix-blend-difference"
        style={{ transform: "translate(-50%, -50%)", display: isLoading ? "none" : "block" }}
      />
    </div>
  );
}
