"use client";

// "My Patterns": a library of previously-saved patterns, stored locally in
// this browser (see lib/patternLibrary.ts for why IndexedDB and not a
// server). Lets you name a finished pattern, come back to browse a grid of
// everything you've saved, and open any one of them full-screen -- instead
// of a downloaded PNG being the only way to see it again.

import { useEffect, useState } from "react";
import { drawPattern, Pattern } from "@/lib/generatePattern";
import {
  SavedPatternSummary,
  deleteSavedPattern,
  getSavedPattern,
  listSavedPatterns,
  renameSavedPattern,
} from "@/lib/patternLibrary";

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

type Props = {
  // Lets a card's "Create a pattern" prompt (shown when the library is
  // empty) switch the page back to the create tab.
  onStartNew: () => void;
};

export default function PatternLibrary({ onStartNew }: Props) {
  const [patterns, setPatterns] = useState<SavedPatternSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  // The pattern currently shown full-screen, if any. Loaded fresh from the
  // database by id rather than reusing the summary, since the summary
  // doesn't include the full cell grid.
  const [openId, setOpenId] = useState<string | null>(null);
  const [openPattern, setOpenPattern] = useState<Pattern | null>(null);
  const [openName, setOpenName] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);

  // A plain async function, called from event handlers (rename, delete)
  // after they change something, to pull a fresh list. Not called directly
  // from an effect -- see the mount effect below, which fetches on its own
  // instead of calling this, so a setState from this async work is never
  // reachable as a direct, synchronous consequence of an effect running.
  async function refresh() {
    try {
      setPatterns(await listSavedPatterns());
      setLoadError(null);
    } catch (err) {
      console.error(err);
      setLoadError("Couldn't load your saved patterns. Your browser may be blocking local storage.");
    }
  }

  // Load the list once, when the library tab first mounts.
  useEffect(() => {
    let cancelled = false;
    listSavedPatterns()
      .then((list) => {
        if (cancelled) return;
        setPatterns(list);
        setLoadError(null);
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) {
          setLoadError("Couldn't load your saved patterns. Your browser may be blocking local storage.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the full pattern for whichever card was opened full-screen.
  useEffect(() => {
    if (!openId) return;
    let cancelled = false;
    getSavedPattern(openId)
      .then((record) => {
        if (cancelled) return;
        if (!record) {
          setOpenError("That pattern couldn't be found -- it may have been deleted.");
          return;
        }
        setOpenPattern(record.pattern);
        setOpenName(record.name);
        setOpenError(null);
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setOpenError("Something went wrong opening this pattern.");
      });
    return () => {
      cancelled = true;
    };
  }, [openId]);

  const fullCanvasRef = (canvas: HTMLCanvasElement | null) => {
    if (canvas && openPattern) {
      drawPattern(canvas, openPattern, 1400);
    }
  };

  function startRename(entry: SavedPatternSummary) {
    setRenamingId(entry.id);
    setRenameValue(entry.name);
    setConfirmingDeleteId(null);
  }

  async function saveRename() {
    if (!renamingId || !renameValue.trim()) return;
    await renameSavedPattern(renamingId, renameValue.trim());
    setRenamingId(null);
    if (openId === renamingId) setOpenName(renameValue.trim());
    refresh();
  }

  async function confirmDelete(id: string) {
    await deleteSavedPattern(id);
    setConfirmingDeleteId(null);
    if (openId === id) {
      setOpenId(null);
      setOpenPattern(null);
    }
    refresh();
  }

  function handleDownloadOpen() {
    if (!openPattern) return;
    const canvas = document.createElement("canvas");
    drawPattern(canvas, openPattern, 1400);
    const dataUrl = canvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = `melt-it-pattern-${openPattern.width}x${openPattern.height}.png`;
    link.click();
  }

  return (
    <section aria-labelledby="library-heading" className="flex flex-col gap-4">
      <h2 id="library-heading" className="text-lg font-semibold">
        My Patterns
      </h2>

      {loadError && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {loadError}
        </p>
      )}

      {patterns === null && !loadError && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading your saved patterns…</p>
      )}

      {patterns !== null && patterns.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            You haven&apos;t saved any patterns yet. Generate one, then click &quot;Save to My
            Patterns&quot; to keep it here.
          </p>
          <button
            type="button"
            onClick={onStartNew}
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-700"
          >
            Create a pattern
          </button>
        </div>
      )}

      {patterns !== null && patterns.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
          {patterns.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-col gap-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800"
            >
              <button
                type="button"
                onClick={() => setOpenId(entry.id)}
                className="flex items-center justify-center overflow-hidden rounded-lg bg-zinc-100 p-2 transition hover:opacity-80 dark:bg-zinc-900"
                aria-label={`Open ${entry.name} full-screen`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={entry.thumbnail}
                  alt=""
                  className="h-32 w-full object-contain"
                  style={{ imageRendering: "pixelated" }}
                />
              </button>

              {renamingId === entry.id ? (
                <div className="flex gap-1">
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    autoFocus
                    className="flex-1 rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                  />
                  <button
                    type="button"
                    onClick={saveRename}
                    className="rounded bg-emerald-600 px-2 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenamingId(null)}
                    className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => startRename(entry)}
                  className="truncate text-left text-sm font-semibold hover:underline"
                  title="Click to rename"
                >
                  {entry.name}
                </button>
              )}

              <p className="text-xs text-zinc-500 dark:text-zinc-500">
                {entry.width} × {entry.height} · {entry.beadCount} beads · {formatDate(entry.createdAt)}
              </p>

              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setOpenId(entry.id)}
                  className="rounded-lg border border-zinc-300 px-3 py-1 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                  Open
                </button>

                {confirmingDeleteId === entry.id ? (
                  <div className="flex items-center gap-1 text-xs">
                    <span className="text-zinc-600 dark:text-zinc-400">Delete?</span>
                    <button
                      type="button"
                      onClick={() => confirmDelete(entry.id)}
                      className="rounded bg-red-600 px-2 py-1 font-semibold text-white hover:bg-red-700"
                    >
                      Yes
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingDeleteId(null)}
                      className="rounded border border-zinc-300 px-2 py-1 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
                    >
                      No
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmingDeleteId(entry.id)}
                    className="text-xs text-red-700 underline hover:text-red-900 dark:text-red-400 dark:hover:text-red-300"
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Full-screen view of one saved pattern */}
      {openId && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/80 p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="truncate text-lg font-semibold text-white">{openName || "Pattern"}</h3>
            <button
              type="button"
              onClick={() => {
                setOpenId(null);
                setOpenPattern(null);
              }}
              aria-label="Close"
              className="rounded-lg border border-white/30 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              ✕ Close
            </button>
          </div>

          {openError && (
            <p role="alert" className="mt-4 rounded-lg bg-red-950/60 p-3 text-sm text-red-200">
              {openError}
            </p>
          )}

          {openPattern && (
            <>
              <div className="mt-4 flex flex-1 items-center justify-center overflow-auto">
                <canvas
                  ref={fullCanvasRef}
                  className="rounded bg-white"
                  style={{ maxWidth: "95vw", maxHeight: "70vh", width: "auto", height: "auto", imageRendering: "pixelated" }}
                />
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-center gap-4">
                <button
                  type="button"
                  onClick={handleDownloadOpen}
                  className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-100"
                >
                  Download PNG
                </button>
                <p className="text-sm text-white/80">
                  {openPattern.width} × {openPattern.height} pegs ·{" "}
                  {openPattern.counts.reduce((sum, entry) => sum + entry.count, 0)} beads
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
