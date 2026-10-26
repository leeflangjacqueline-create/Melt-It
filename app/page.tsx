"use client";

// "use client" tells Next.js this page runs in the browser (not on the server).
// We need that because we react to clicks and file selection, and we hold
// state (the chosen image) using React's useState hook.

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_SAMPLES_PER_CELL,
  MAX_SAMPLES_PER_CELL,
  MIN_SAMPLES_PER_CELL,
  drawPattern,
  fixFloatingBeads,
  generatePattern,
  loadImageElement,
  mergeColors,
  Pattern,
  recolorCell,
  reduceColors,
} from "@/lib/generatePattern";
import { PERLER_PALETTE } from "@/lib/perlerColors";
import { convertHeicToJpeg, isHeicFile, withJpegExtension } from "@/lib/heicConversion";
import { removeBackground } from "@/lib/backgroundRemoval";
import { savePatternToLibrary } from "@/lib/patternLibrary";
import ManualTouchUp from "./components/ManualTouchUp";
import PatternLibrary from "./components/PatternLibrary";

// The two upload choices. Both use the same file picker under the hood,
// but we remember which one the user picked so later steps can treat
// photos and screenshots differently if we want to.
type UploadSource = "photo" | "screenshot";

type SelectedImage = {
  originalUrl: string; // the image exactly as uploaded (after any HEIC conversion)
  processedUrl: string | null; // set once "Remove background" succeeds
  name: string;
  sizeKb: number;
  source: UploadSource;
};

// A pegboard size is just a width and height, measured in pegs (not pixels).
// This is the shape we'll eventually hand to the grid-generation step.
type BoardSize = {
  width: number;
  height: number;
};

// Standard Perler/Hama pegboard sizes. "id" lets us know which preset
// button (if any) is currently selected.
type BoardPreset = BoardSize & {
  id: string;
  label: string;
  description: string;
};

const BOARD_PRESETS: BoardPreset[] = [
  {
    id: "small-square",
    label: "Small square",
    width: 29,
    height: 29,
    description: "The classic small board",
  },
  {
    id: "small-rectangle",
    label: "Small rectangle",
    width: 14,
    height: 29,
    description: "Half of a small square board",
  },
  {
    id: "large-square",
    label: "Large square",
    width: 58,
    height: 58,
    description: "Four small boards joined together",
  },
];

// Custom sizes are limited to a sensible range. Too few pegs and there's
// nothing recognisable left of the image; too many and the pattern becomes
// impractical to actually bead by hand.
const CUSTOM_SIZE_MIN = 5;
const CUSTOM_SIZE_MAX = 100;

export default function Home() {
  // Which top-level tab is showing: the create-a-pattern flow (everything
  // this page already did), or the library of previously saved patterns.
  const [activeTab, setActiveTab] = useState<"create" | "library">("create");

  // The currently selected image (or null if nothing chosen yet).
  const [image, setImage] = useState<SelectedImage | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Pegboard size state. "boardSize" is the size that's actually in effect;
  // "selectedPresetId" tracks which preset button (if any) is highlighted,
  // so choosing a custom size can un-highlight all of the presets.
  const [boardSize, setBoardSize] = useState<BoardSize | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customWidth, setCustomWidth] = useState("29");
  const [customHeight, setCustomHeight] = useState("29");
  const [customError, setCustomError] = useState<string | null>(null);

  // True while we're converting an iPhone HEIC photo to JPEG in the
  // background, before it becomes the selected image.
  const [isConvertingHeic, setIsConvertingHeic] = useState(false);

  // Background removal state. "sensitivity" is a 0-100 slider: higher
  // removes a wider range of similar colors around the edges.
  const [isRemovingBackground, setIsRemovingBackground] = useState(false);
  const [bgRemovalError, setBgRemovalError] = useState<string | null>(null);
  const [bgSensitivity, setBgSensitivity] = useState(50);

  // Whether the manual "erase by hand" popup is currently open.
  const [showTouchUp, setShowTouchUp] = useState(false);

  // The generated pattern (null until "Generate pattern" is clicked and
  // succeeds), plus loading/error state for that async step.
  const [pattern, setPattern] = useState<Pattern | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // The pristine, full-color pattern exactly as generatePattern produced it
  // -- kept around so the "Max colors" slider and "Reset colors" link
  // always have a true original to recompute from, no matter how many
  // times the slider's been dragged or colors merged by hand since.
  const [originalPattern, setOriginalPattern] = useState<Pattern | null>(null);

  // The "Max colors" slider's current position. null until a pattern
  // exists; once set, it's always a real color count so the slider has
  // something to show.
  const [maxColors, setMaxColors] = useState<number | null>(null);

  // The "Detail" slider (generatePattern's samplesPerCell). Once a pattern
  // exists, moving this slider regenerates the whole pattern live -- same
  // as "Max colors" below -- so you can actually see what each setting
  // does instead of guessing. Before the first "Generate pattern" click,
  // it just sets the starting value.
  const [detail, setDetail] = useState(DEFAULT_SAMPLES_PER_CELL);

  // Resets every piece of pattern state back to "no pattern yet." Used
  // anywhere the current pattern is about to go stale (a new image, a new
  // board size, a background-removal change, and so on), so there's one
  // place that keeps all three pieces of pattern state in sync instead of
  // three separate setPattern(null) calls quietly drifting apart.
  function clearPattern() {
    setPattern(null);
    setOriginalPattern(null);
    setMaxColors(null);
    setPixelEditMode(false);
    setPixelPaintColorName(null);
  }

  // Whether the per-bead "touch up pixels" tool is active. While on,
  // clicking or dragging over the pattern canvas recolors whatever bead is
  // under the pointer to the currently selected paint color.
  const [pixelEditMode, setPixelEditMode] = useState(false);
  const [pixelPaintColorName, setPixelPaintColorName] = useState<string | null>(null);

  // The cell size (in canvas pixels) drawPattern last used -- needed to
  // translate a click or tap on the canvas back into a (column, row) peg
  // position for the pixel touch-up tool. 0 until a pattern's been drawn.
  const [cellSize, setCellSize] = useState(0);

  // Tracks whether a pointer is currently held down and dragging across
  // the canvas in pixel-touch-up mode, so pointermove knows whether to
  // keep painting or do nothing.
  const isPaintingRef = useRef(false);

  // The <canvas> we draw the pattern onto.
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // A reference to the hidden <input type="file">. The two buttons below
  // "click" it for us, so we only need one input.
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Remembers which button was pressed, so onChange knows the source.
  const pendingSource = useRef<UploadSource>("photo");

  // The image actually used for the preview and for generating a pattern:
  // the background-removed version if we have one, otherwise the original.
  const activeImageUrl = image ? image.processedUrl ?? image.originalUrl : null;

  // Note on cleanup: object URLs (from URL.createObjectURL) use a bit of
  // browser memory until released. They're released automatically when the
  // tab closes, but since this page can swap in a new image or a new
  // background-removed version while staying open, we explicitly revoke the
  // ones we're done with at the exact point we replace them (see
  // handleFileChange, clearImage, handleRemoveBackground, and
  // handleRestoreOriginal below) rather than trying to track it generically.

  // Whenever we get a new pattern, draw it onto the canvas.
  useEffect(() => {
    if (pattern && canvasRef.current) {
      setCellSize(drawPattern(canvasRef.current, pattern));
    }
  }, [pattern]);

  function openPicker(source: UploadSource) {
    pendingSource.current = source;
    fileInputRef.current?.click();
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return; // user cancelled the picker

    // Reset the input so choosing the same file again still triggers onChange.
    event.target.value = "";

    // HEIC photos (the default format for iPhone camera photos) sometimes
    // arrive with an empty file.type instead of "image/heic", so a plain
    // "starts with image/" check isn't enough on its own -- we also treat
    // anything isHeicFile recognises as a valid image.
    const looksLikeImage = file.type.startsWith("image/") || isHeicFile(file);
    if (!looksLikeImage) {
      setError("That file doesn't look like an image. Please choose a PNG, JPG, or similar.");
      return;
    }

    setError(null);
    // A new image invalidates any pattern generated from the old one, and
    // any background-removal result or error from the previous image.
    clearPattern();
    setGenerateError(null);
    setBgRemovalError(null);

    // Replacing the image entirely, so release the previous image's URLs.
    if (image) {
      URL.revokeObjectURL(image.originalUrl);
      if (image.processedUrl) URL.revokeObjectURL(image.processedUrl);
    }

    let fileToUse: File | Blob = file;
    let displayName = file.name;

    if (isHeicFile(file)) {
      setIsConvertingHeic(true);
      try {
        fileToUse = await convertHeicToJpeg(file);
        displayName = withJpegExtension(file.name);
      } catch (err) {
        console.error(err);
        setIsConvertingHeic(false);
        setError(
          "This looks like an iPhone HEIC photo and we couldn't convert it. Please try a JPG or PNG instead."
        );
        return;
      }
      setIsConvertingHeic(false);
    }

    setImage({
      // createObjectURL makes a short-lived link to the file already on the
      // user's computer. Nothing is uploaded to a server.
      originalUrl: URL.createObjectURL(fileToUse),
      processedUrl: null,
      name: displayName,
      sizeKb: Math.round(fileToUse.size / 1024),
      source: pendingSource.current,
    });
  }

  function clearImage() {
    if (image) {
      URL.revokeObjectURL(image.originalUrl);
      if (image.processedUrl) URL.revokeObjectURL(image.processedUrl);
    }
    setImage(null);
    setError(null);
    clearPattern();
    setGenerateError(null);
    setBgRemovalError(null);
  }

  // Resets everything back to the very start -- same as clicking "Remove"
  // on the image, but also clears the pegboard size choice, so the whole
  // page is exactly like a fresh visit. Used by the "Start a new pattern"
  // button at the bottom of a finished pattern, so you don't have to
  // scroll back up to the top just to begin again.
  function startOver() {
    clearImage();
    setBoardSize(null);
    setSelectedPresetId(null);
    setShowCustomForm(false);
    setCustomWidth("29");
    setCustomHeight("29");
    setCustomError(null);
    setDetail(DEFAULT_SAMPLES_PER_CELL);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function handleRemoveBackground() {
    if (!image) return;

    setIsRemovingBackground(true);
    setBgRemovalError(null);

    try {
      // Always remove from the original image, not a previously processed
      // one -- so trying again with a different sensitivity doesn't compound
      // mistakes from the last attempt.
      const resultBlob = await removeBackground(image.originalUrl, bgSensitivity);
      const newProcessedUrl = URL.createObjectURL(resultBlob);

      setImage((prev) => {
        if (!prev) return prev;
        // Release the previous attempt's URL, if there was one.
        if (prev.processedUrl) URL.revokeObjectURL(prev.processedUrl);
        return { ...prev, processedUrl: newProcessedUrl };
      });

      // The image content just changed, so any existing pattern is stale.
      clearPattern();
      setGenerateError(null);
    } catch (err) {
      console.error(err);
      setBgRemovalError("Something went wrong while removing the background. Please try again.");
    } finally {
      setIsRemovingBackground(false);
    }
  }

  function handleRestoreOriginal() {
    if (!image?.processedUrl) return;
    URL.revokeObjectURL(image.processedUrl);
    setImage((prev) => (prev ? { ...prev, processedUrl: null } : prev));
    clearPattern();
    setGenerateError(null);
    setBgRemovalError(null);
  }

  // Called by the ManualTouchUp popup once the user clicks "Apply changes".
  // The hand-edited result becomes the new processedUrl, exactly like a
  // successful automatic background removal does.
  function handleApplyTouchUp(blob: Blob) {
    const newProcessedUrl = URL.createObjectURL(blob);
    setImage((prev) => {
      if (!prev) return prev;
      if (prev.processedUrl) URL.revokeObjectURL(prev.processedUrl);
      return { ...prev, processedUrl: newProcessedUrl };
    });
    clearPattern();
    setGenerateError(null);
    setShowTouchUp(false);
  }

  function selectPreset(preset: BoardPreset) {
    setBoardSize({ width: preset.width, height: preset.height });
    setSelectedPresetId(preset.id);
    setShowCustomForm(false);
    setCustomError(null);
    // The old pattern was generated at a different size, so it's now stale.
    clearPattern();
    setGenerateError(null);
  }

  // Turns a raw string from a number input into a valid peg count, or
  // returns an error message explaining why it isn't one.
  function parseCustomDimension(raw: string): number | string {
    const value = Number(raw);
    if (!raw.trim() || Number.isNaN(value) || !Number.isInteger(value)) {
      return "Please enter a whole number.";
    }
    if (value < CUSTOM_SIZE_MIN || value > CUSTOM_SIZE_MAX) {
      return `Please choose a size between ${CUSTOM_SIZE_MIN} and ${CUSTOM_SIZE_MAX} pegs.`;
    }
    return value;
  }

  function applyCustomSize() {
    const width = parseCustomDimension(customWidth);
    const height = parseCustomDimension(customHeight);

    if (typeof width === "string") {
      setCustomError(width);
      return;
    }
    if (typeof height === "string") {
      setCustomError(height);
      return;
    }

    setCustomError(null);
    setBoardSize({ width, height });
    setSelectedPresetId(null); // no preset matches a custom size
    clearPattern();
    setGenerateError(null);
  }

  // loadImageElement decodes the image fresh every time it's called, which
  // is wasteful if we're about to call it repeatedly in quick succession
  // (dragging the "Detail" slider). This caches the last-decoded element
  // alongside the URL it came from, so re-generating at a new detail level
  // only re-decodes if the image itself actually changed.
  const loadedImageRef = useRef<{ url: string; img: HTMLImageElement } | null>(null);
  async function getLoadedImage(url: string): Promise<HTMLImageElement> {
    if (loadedImageRef.current && loadedImageRef.current.url === url) {
      return loadedImageRef.current.img;
    }
    const img = await loadImageElement(url);
    loadedImageRef.current = { url, img };
    return img;
  }

  // Runs the full generate-from-scratch pipeline at a given detail level,
  // and replaces the pattern entirely -- used both by the first "Generate
  // pattern" click and by the "Detail" slider's live updates afterwards.
  // Because this resamples the source image from zero, it discards any
  // color merges, slider reductions, or pixel touch-ups made on the
  // previous pattern -- there's no way to carry those forward across a
  // change that can move where every bead's color even comes from.
  async function regeneratePattern(samplesPerCell: number) {
    if (!activeImageUrl || !boardSize) return;

    setIsGenerating(true);
    setGenerateError(null);

    try {
      const imgElement = await getLoadedImage(activeImageUrl);
      // fixFloatingBeads runs right away, before this ever becomes
      // originalPattern -- so every bead the sliders and merge dropdown
      // work with is already structurally sound, and nothing downstream
      // needs to worry about reintroducing a floating bead.
      const result = fixFloatingBeads(generatePattern(imgElement, boardSize, PERLER_PALETTE, samplesPerCell));
      setPattern(result);
      // Keep an untouched copy so the "Max colors" slider and "Reset
      // colors" link always have the real original to work from, and
      // start the slider at "no reduction" (every color the pattern
      // actually came out with).
      setOriginalPattern(result);
      setMaxColors(result.counts.length);
      setPixelEditMode(false);
      setPixelPaintColorName(null);
    } catch (err) {
      console.error(err);
      // generatePattern throws a specific, helpful message in some cases
      // (like "nothing left after background removal") -- show that
      // directly instead of a generic one when we have it.
      const message =
        err instanceof Error
          ? err.message
          : "Something went wrong while generating the pattern. Please try a different image.";
      setGenerateError(message);
    } finally {
      setIsGenerating(false);
    }
  }

  function handleGenerate() {
    regeneratePattern(detail);
  }

  // The "Detail" slider: once a pattern already exists, changing it
  // immediately regenerates the whole thing, so you can see exactly what
  // each setting does instead of guessing from a number. Before the first
  // generate, it just remembers the starting value.
  function handleDetailChange(value: number) {
    setDetail(value);
    if (pattern) {
      regeneratePattern(value);
    }
  }

  // "Max colors" slider: always recomputes from the untouched original, so
  // dragging it back up restores colors a lower setting had merged away,
  // and dragging it down again is a fresh reduction rather than compounding
  // on top of whatever the slider last produced.
  function handleMaxColorsChange(value: number) {
    setMaxColors(value);
    if (originalPattern) {
      setPattern(reduceColors(originalPattern, value));
    }
  }

  // The per-color "Merge into…" dropdown: a precise, by-hand alternative to
  // the slider for folding one specific color into another. This applies
  // on top of whatever the pattern currently looks like (after any slider
  // reduction), not the original -- so moving the "Max colors" slider again
  // afterwards will recompute from scratch and lose a manual merge, same as
  // it would lose any other slider-only change. "Reset colors" is the way
  // back to the untouched original if a merge goes the wrong way.
  function handleMergeColor(fromColorName: string, intoColorName: string) {
    if (!pattern || !intoColorName) return;
    const merged = mergeColors(pattern, fromColorName, intoColorName);
    setPattern(merged);
    setMaxColors(merged.counts.length);
  }

  // Discards every merge, slider reduction, and pixel touch-up, back to
  // exactly what generatePattern produced.
  function handleResetColors() {
    if (!originalPattern) return;
    setPattern(originalPattern);
    setMaxColors(originalPattern.counts.length);
  }

  // Turns a click/tap position on the pattern canvas into a (column, row)
  // peg position, accounting for the canvas possibly being displayed at a
  // different size than its actual pixel resolution (it's scaled to fit
  // via CSS). Returns null if the position is outside the board, or if we
  // don't have what we need yet to do the math.
  function canvasPointToCell(
    event: React.PointerEvent<HTMLCanvasElement>
  ): { x: number; y: number } | null {
    const canvas = canvasRef.current;
    if (!canvas || !pattern || !cellSize) return null;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const canvasX = (event.clientX - rect.left) * scaleX;
    const canvasY = (event.clientY - rect.top) * scaleY;

    const x = Math.floor(canvasX / cellSize);
    const y = Math.floor(canvasY / cellSize);
    if (x < 0 || x >= pattern.width || y < 0 || y >= pattern.height) return null;
    return { x, y };
  }

  // Recolors whatever bead is under the pointer to the selected paint
  // color. Clicking an empty cell does nothing -- this tool only ever
  // recolors a bead that's already there, never adds or removes one (see
  // recolorCell's comment for why that matters).
  function paintCellAt(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!pixelEditMode || !pattern || !pixelPaintColorName) return;
    const cell = canvasPointToCell(event);
    if (!cell) return;

    const newColor = pattern.counts.find((entry) => entry.color.name === pixelPaintColorName)?.color;
    if (!newColor) return;

    const index = cell.y * pattern.width + cell.x;
    setPattern((prev) => (prev ? recolorCell(prev, index, newColor) : prev));
  }

  function handleCanvasPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!pixelEditMode) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    isPaintingRef.current = true;
    paintCellAt(event);
  }

  function handleCanvasPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!pixelEditMode || !isPaintingRef.current) return;
    paintCellAt(event);
  }

  function handleCanvasPointerUp() {
    isPaintingRef.current = false;
  }

  function togglePixelEditMode() {
    setPixelEditMode((prev) => {
      const next = !prev;
      if (next) {
        // Entering the tool -- pre-select the most-used color so there's
        // something to paint with right away, instead of making the first
        // click be "pick a color" with no visible feedback yet.
        setPixelPaintColorName(pattern?.counts[0]?.color.name ?? null);
      } else {
        setPixelPaintColorName(null); // leaving the tool -- clear the selected color too
      }
      return next;
    });
  }

  // "Save to My Patterns": a small inline name-entry form, rather than a
  // browser prompt() popup, so it matches the rest of the page and works
  // the same way across desktop and mobile.
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  function openSaveForm() {
    if (!pattern) return;
    setSaveName(`${pattern.width} × ${pattern.height} pattern`);
    setSaveNotice(null);
    setShowSaveForm(true);
  }

  async function handleSaveToLibrary() {
    if (!pattern || !saveName.trim()) return;
    setIsSaving(true);
    try {
      await savePatternToLibrary(saveName.trim(), pattern);
      setShowSaveForm(false);
      setSaveNotice(`Saved "${saveName.trim()}" to My Patterns.`);
    } catch (err) {
      console.error(err);
      setSaveNotice("Something went wrong saving this pattern -- your browser may be blocking local storage.");
    } finally {
      setIsSaving(false);
    }
  }

  function handleDownload() {
    const canvas = canvasRef.current;
    if (!canvas || !pattern) return;

    // canvas.toDataURL turns everything currently drawn on the canvas into a
    // base64-encoded PNG image, right in the browser -- no server involved.
    const dataUrl = canvas.toDataURL("image/png");

    // The trick for triggering a download in the browser: make an <a> tag
    // with a "download" attribute, point it at our image data, and click it
    // programmatically. It's never added to the visible page.
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = `melt-it-pattern-${pattern.width}x${pattern.height}.png`;
    link.click();
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-12">
      {/* 1. Heading */}
      <header className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">Melt-It</h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          Turn any picture into a melty bead pattern.
        </p>
      </header>

      {/* Tabs: the create-a-pattern flow, or the library of saved patterns. */}
      <div className="flex justify-center gap-2" role="tablist" aria-label="Sections">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "create"}
          onClick={() => setActiveTab("create")}
          className={`rounded-full px-5 py-2 text-sm font-semibold transition ${
            activeTab === "create"
              ? "bg-violet-600 text-white"
              : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
          }`}
        >
          Create
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "library"}
          onClick={() => setActiveTab("library")}
          className={`rounded-full px-5 py-2 text-sm font-semibold transition ${
            activeTab === "library"
              ? "bg-violet-600 text-white"
              : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
          }`}
        >
          My Patterns
        </button>
      </div>

      {activeTab === "library" && <PatternLibrary onStartNew={() => setActiveTab("create")} />}

      {activeTab === "create" && (
      <>
      {/* One hidden file input shared by both buttons. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
      />

      {/* 2. The two upload options */}
      <section aria-labelledby="upload-heading">
        <h2 id="upload-heading" className="mb-4 text-lg font-semibold">
          {image ? "Choose a different image" : "Start with an image"}
        </h2>

        {/* Only useful before they've taken/picked the shot -- once an image
            is already selected, this advice comes too late to act on. */}
        {!image && (
          <p className="mb-4 rounded-lg bg-blue-50 p-3 text-sm text-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
            Tip: for the cleanest pattern, use a photo or screenshot with as little busy background
            as possible — a plain wall, table, or solid-color surface works best. You&apos;ll get a
            chance to remove the background automatically later, but a simple background to start
            gives the best results.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => openPicker("photo")}
            disabled={isConvertingHeic || isRemovingBackground}
            className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-pink-400 bg-pink-50 p-6 text-center transition hover:bg-pink-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pink-500 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-pink-950/30 dark:hover:bg-pink-950/50"
          >
            <span className="text-3xl" aria-hidden="true">
              📷
            </span>
            <span className="text-lg font-semibold">Upload a photo</span>
            <span className="text-sm text-zinc-600 dark:text-zinc-400">
              A picture from your camera or gallery
            </span>
          </button>

          <button
            type="button"
            onClick={() => openPicker("screenshot")}
            disabled={isConvertingHeic || isRemovingBackground}
            className="flex flex-col items-center gap-2 rounded-xl border-2 border-solid border-sky-400 bg-sky-50 p-6 text-center transition hover:bg-sky-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-sky-950/30 dark:hover:bg-sky-950/50"
          >
            <span className="text-3xl" aria-hidden="true">
              🖥️
            </span>
            <span className="text-lg font-semibold">Upload a screenshot</span>
            <span className="text-sm text-zinc-600 dark:text-zinc-400">
              Something you captured from a screen
            </span>
          </button>
        </div>

        {/* Shown while an iPhone HEIC photo is being converted in the background */}
        {isConvertingHeic && (
          <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
            Converting your iPhone photo… this only takes a moment.
          </p>
        )}

        {/* Friendly error message if the file wasn't an image */}
        {error && (
          <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}
      </section>

      {/* 3. Preview (only shown once an image is selected) */}
      {image && (
        <section aria-labelledby="preview-heading" className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 id="preview-heading" className="text-lg font-semibold">
              Preview
            </h2>
            <button
              type="button"
              onClick={clearImage}
              className="text-sm text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              Remove
            </button>
          </div>

          <div
            className="flex justify-center rounded-xl border border-zinc-200 p-4 dark:border-zinc-800"
            style={
              image.processedUrl
                ? {
                    // A checkerboard pattern behind a transparent image makes
                    // it obvious which parts of the background were removed
                    // -- the same trick image editors use.
                    backgroundImage:
                      "linear-gradient(45deg, #d4d4d8 25%, transparent 25%), linear-gradient(-45deg, #d4d4d8 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #d4d4d8 75%), linear-gradient(-45deg, transparent 75%, #d4d4d8 75%)",
                    backgroundSize: "16px 16px",
                    backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
                    backgroundColor: "#f4f4f5",
                  }
                : { backgroundColor: "#f4f4f5" }
            }
          >
            {/* We use a plain <img> instead of Next's <Image> because this is a
                temporary local URL, which <Image> can't optimise. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={activeImageUrl ?? undefined}
              alt={`Preview of ${image.name}`}
              className="max-h-[28rem] w-auto max-w-full rounded-lg object-contain"
            />
          </div>

          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {image.name} · {image.sizeKb} KB · uploaded as a{" "}
            {image.source === "photo" ? "photo" : "screenshot"}
            {image.processedUrl && " · edited"}
          </p>
        </section>
      )}

      {/* 4. Background removal (optional, shown once an image is selected) */}
      {image && (
        <section aria-labelledby="bg-heading" className="flex flex-col gap-3">
          <h2 id="bg-heading" className="text-lg font-semibold">
            Remove background <span className="font-normal text-zinc-500">(optional)</span>
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Works best on photos with a plain or solid-color background. It won&apos;t do much for
            a busy or cluttered one.
          </p>

          <label className="flex max-w-xs flex-col gap-1 text-sm">
            Sensitivity: {bgSensitivity}
            <input
              type="range"
              min={0}
              max={100}
              value={bgSensitivity}
              onChange={(e) => setBgSensitivity(Number(e.target.value))}
            />
            <span className="flex justify-between text-xs text-zinc-500">
              <span>Only very close colors</span>
              <span>Wider range of colors</span>
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleRemoveBackground}
              disabled={isRemovingBackground}
              className="rounded-lg bg-amber-600 px-4 py-2 font-semibold text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isRemovingBackground
                ? "Removing…"
                : image.processedUrl
                  ? "Try again"
                  : "Remove background"}
            </button>

            {image.processedUrl && (
              <button
                type="button"
                onClick={handleRestoreOriginal}
                className="text-sm text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                Restore original
              </button>
            )}
          </div>

          {bgRemovalError && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {bgRemovalError}
            </p>
          )}

          <div className="flex items-center gap-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <button
              type="button"
              onClick={() => setShowTouchUp(true)}
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              ✏️ Touch up manually
            </button>
            <span className="text-xs text-zinc-500 dark:text-zinc-500">
              Erase or restore spots by hand — useful when the automatic tool above can&apos;t keep
              up with a busy background.
            </span>
          </div>
        </section>
      )}

      {/* 5. Pegboard size selector (only shown once an image is selected) */}
      {image && (
        <section aria-labelledby="board-heading" className="flex flex-col gap-3">
          <h2 id="board-heading" className="text-lg font-semibold">
            Choose your pegboard size
          </h2>

          <div className="grid gap-3 sm:grid-cols-4">
            {BOARD_PRESETS.map((preset) => {
              const isSelected = selectedPresetId === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => selectPreset(preset)}
                  aria-pressed={isSelected}
                  className={`flex flex-col items-center gap-1 rounded-xl border-2 p-4 text-center transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 ${
                    isSelected
                      ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40"
                      : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
                  }`}
                >
                  <span className="font-semibold">{preset.label}</span>
                  <span className="text-sm text-zinc-600 dark:text-zinc-400">
                    {preset.width} × {preset.height}
                  </span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-500">
                    {preset.description}
                  </span>
                </button>
              );
            })}

            {/* Custom size toggle button, styled like the presets above */}
            <button
              type="button"
              onClick={() => setShowCustomForm(true)}
              aria-pressed={showCustomForm}
              className={`flex flex-col items-center justify-center gap-1 rounded-xl border-2 p-4 text-center transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 ${
                showCustomForm
                  ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40"
                  : "border-dashed border-zinc-300 bg-white hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:hover:bg-zinc-800"
              }`}
            >
              <span className="font-semibold">Custom size</span>
              <span className="text-sm text-zinc-600 dark:text-zinc-400">
                Enter your own
              </span>
            </button>
          </div>

          {/* Custom width/height inputs, only shown once the user asks for them */}
          {showCustomForm && (
            <div className="flex flex-wrap items-end gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <label className="flex flex-col gap-1 text-sm">
                Width (pegs)
                <input
                  type="number"
                  min={CUSTOM_SIZE_MIN}
                  max={CUSTOM_SIZE_MAX}
                  value={customWidth}
                  onChange={(e) => setCustomWidth(e.target.value)}
                  className="w-24 rounded-lg border border-zinc-300 px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Height (pegs)
                <input
                  type="number"
                  min={CUSTOM_SIZE_MIN}
                  max={CUSTOM_SIZE_MAX}
                  value={customHeight}
                  onChange={(e) => setCustomHeight(e.target.value)}
                  className="w-24 rounded-lg border border-zinc-300 px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
                />
              </label>
              <button
                type="button"
                onClick={applyCustomSize}
                className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700"
              >
                Use this size
              </button>
            </div>
          )}

          {customError && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {customError}
            </p>
          )}

          {boardSize && (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Selected board: {boardSize.width} × {boardSize.height} pegs (
              {boardSize.width * boardSize.height} beads total)
            </p>
          )}
        </section>
      )}

      {/* 6. Generate button (only once both an image and a board size are picked) */}
      {image && boardSize && (
        <section className="flex flex-col items-start gap-3">
          <button
            type="button"
            onClick={handleGenerate}
            disabled={isGenerating}
            className="rounded-lg bg-violet-600 px-5 py-2.5 font-semibold text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isGenerating ? "Generating…" : "Generate pattern"}
          </button>

          {generateError && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {generateError}
            </p>
          )}
        </section>
      )}

      {/* 7. The generated pattern: a colored grid plus a bead-count legend */}
      {pattern && (
        <section aria-labelledby="pattern-heading" className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 id="pattern-heading" className="text-lg font-semibold">
              Your pattern
            </h2>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={openSaveForm}
                className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-violet-700"
              >
                💾 Save to My Patterns
              </button>
              <button
                type="button"
                onClick={handleDownload}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                Download PNG
              </button>
            </div>
          </div>

          {showSaveForm && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 p-3 dark:border-violet-900 dark:bg-violet-950/30">
              <label className="flex flex-1 flex-col gap-1 text-sm">
                Name this pattern
                <input
                  type="text"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  autoFocus
                  className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
                />
              </label>
              <button
                type="button"
                onClick={handleSaveToLibrary}
                disabled={isSaving || !saveName.trim()}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSaving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => setShowSaveForm(false)}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
              >
                Cancel
              </button>
            </div>
          )}

          {saveNotice && (
            <p className="text-sm text-emerald-700 dark:text-emerald-400" role="status">
              {saveNotice}
            </p>
          )}

          <div className="flex justify-center overflow-auto rounded-xl border border-zinc-200 bg-zinc-100 p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <canvas
              ref={canvasRef}
              onPointerDown={handleCanvasPointerDown}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={handleCanvasPointerUp}
              onPointerCancel={handleCanvasPointerUp}
              onPointerLeave={handleCanvasPointerUp}
              className={`rounded ${pixelEditMode ? "cursor-crosshair ring-2 ring-emerald-500" : ""}`}
              style={pixelEditMode ? { touchAction: "none" } : undefined}
            />
          </div>

          <div className="flex flex-col gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex max-w-xs flex-col gap-1 text-sm">
                Detail: {detail}
                <input
                  type="range"
                  min={MIN_SAMPLES_PER_CELL}
                  max={MAX_SAMPLES_PER_CELL}
                  value={detail}
                  onChange={(e) => handleDetailChange(Number(e.target.value))}
                />
                <span className="flex justify-between text-xs text-zinc-500">
                  <span>Sharper</span>
                  <span>Smoother</span>
                </span>
              </label>
              {detail !== DEFAULT_SAMPLES_PER_CELL && (
                <button
                  type="button"
                  onClick={() => handleDetailChange(DEFAULT_SAMPLES_PER_CELL)}
                  className="text-sm text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                >
                  Use recommended
                </button>
              )}
            </div>
            <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-500">
              Updates the pattern above live, so you can see exactly what each setting does.
              Sharper follows thin lines and small details more closely but can pick up stray
              specks of color; smoother cuts down on those specks but can smooth away fine detail
              too — there&apos;s no setting that&apos;s perfect for every image. Re-generating like
              this resets any color merges or pixel touch-ups below.
            </p>
          </div>

          {originalPattern && originalPattern.counts.length > 1 && (
            <div className="flex flex-col gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
              <label className="flex max-w-xs flex-col gap-1 text-sm">
                Max colors: {maxColors ?? originalPattern.counts.length}
                <input
                  type="range"
                  min={1}
                  max={originalPattern.counts.length}
                  value={maxColors ?? originalPattern.counts.length}
                  onChange={(e) => handleMaxColorsChange(Number(e.target.value))}
                />
                <span className="flex justify-between text-xs text-zinc-500">
                  <span>Simpler</span>
                  <span>Truer to the original</span>
                </span>
              </label>
              <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-500">
                Automatically folds the least-used colors into whichever remaining color is
                closest, so you can trim the palette down without hand-picking every merge. Use
                the &quot;Merge into…&quot; menu below for precise control over one color at a
                time instead.
              </p>
              {pattern !== originalPattern && (
                <button
                  type="button"
                  onClick={handleResetColors}
                  className="self-start text-sm text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                >
                  Reset colors
                </button>
              )}
            </div>
          )}

          <div>
            <h3 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
              Bead count by color (
              {pattern.counts.reduce((sum, entry) => sum + entry.count, 0)} beads total)
            </h3>
            <ul className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
              {pattern.counts.map(({ color, count }) => (
                <li key={color.name} className="flex items-center gap-2 text-sm">
                  <span
                    className="h-4 w-4 flex-shrink-0 rounded border border-black/10"
                    style={{ backgroundColor: color.hex }}
                    aria-hidden="true"
                  />
                  <span className="flex-1">{color.name}</span>
                  <span className="text-zinc-600 dark:text-zinc-400">{count}</span>
                  {pattern.counts.length > 1 && (
                    <select
                      value=""
                      onChange={(e) => {
                        if (e.target.value) handleMergeColor(color.name, e.target.value);
                      }}
                      aria-label={`Merge ${color.name} into another color`}
                      className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
                    >
                      <option value="">Merge into…</option>
                      {pattern.counts
                        .filter((entry) => entry.color.name !== color.name)
                        .map((entry) => (
                          <option key={entry.color.name} value={entry.color.name}>
                            {entry.color.name}
                          </option>
                        ))}
                    </select>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-col gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={togglePixelEditMode}
                aria-pressed={pixelEditMode}
                className={`inline-flex items-center gap-2 rounded-lg border-2 px-4 py-2.5 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 ${
                  pixelEditMode
                    ? "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700"
                    : "border-teal-600 bg-teal-600 text-white hover:bg-teal-700"
                }`}
              >
                {pixelEditMode ? "✓ Done touching up" : "🖌️ Touch up individual beads"}
              </button>
              {!pixelEditMode && (
                <span className="text-xs text-zinc-500 dark:text-zinc-500">
                  Recolor one bead at a time by hand — handy for a small fix, like an eye that
                  came out a bead too long.
                </span>
              )}
            </div>

            {pixelEditMode && (
              <>
                <p className="text-xs text-zinc-500 dark:text-zinc-500">
                  Pick a color below, then click or drag over beads on the pattern above to
                  recolor them one at a time. This only recolors existing beads — it can&apos;t add
                  or remove one — and &quot;Reset colors&quot; above undoes this too.
                </p>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Paint color">
                  {pattern.counts.map(({ color }) => (
                    <button
                      key={color.name}
                      type="button"
                      onClick={() => setPixelPaintColorName(color.name)}
                      title={color.name}
                      aria-label={`Paint with ${color.name}`}
                      aria-pressed={pixelPaintColorName === color.name}
                      className={`h-8 w-8 flex-shrink-0 rounded-full border-2 transition ${
                        pixelPaintColorName === color.name
                          ? "border-emerald-500 ring-2 ring-emerald-500 ring-offset-2 dark:ring-offset-zinc-900"
                          : "border-black/10"
                      }`}
                      style={{ backgroundColor: color.hex }}
                    />
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="flex justify-center border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <button
              type="button"
              onClick={startOver}
              className="rounded-lg border border-zinc-300 px-5 py-2.5 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              Start a new pattern
            </button>
          </div>
        </section>
      )}

      {showTouchUp && activeImageUrl && (
        <ManualTouchUp
          imageUrl={activeImageUrl}
          onApply={handleApplyTouchUp}
          onCancel={() => setShowTouchUp(false)}
        />
      )}
      </>
      )}
    </main>
  );
}
