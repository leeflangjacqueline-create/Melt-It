import { Pattern, drawPattern } from "./generatePattern";

// A small library of saved patterns, so a finished pattern doesn't only
// exist as a PNG you have to go track down in your phone or computer's
// files app. Give it a name here, and come back to look at it full-screen
// (or download it) any time, right inside the app.
//
// This lives entirely in IndexedDB, in this one browser -- nothing here
// talks to a server. That also means a saved pattern doesn't follow you to
// a different device, and doesn't survive clearing site data. If sign-in
// and cloud storage get built later, this is the piece that would grow to
// sync a copy there too; for now it's deliberately kept simple and
// backend-free, like the rest of the app's image processing.
//
// IndexedDB (rather than localStorage) is the right tool here because a
// saved pattern -- especially a large board, plus its thumbnail image --
// can be a few hundred KB, well past localStorage's ~5-10MB *total* limit
// across everything a site stores. IndexedDB has no such practical cap,
// and unlike localStorage it can store a plain JS object (our Pattern)
// directly, with no need to serialize it to a string first.

export type SavedPattern = {
  id: string;
  name: string;
  createdAt: number; // Date.now() at the moment it was first saved
  pattern: Pattern;
  thumbnail: string; // small PNG data URL, just for the library grid
};

// Everything the library grid needs to render one card, without having to
// load every saved pattern's full cell grid (which could be thousands of
// cells) just to show a thumbnail and a name.
export type SavedPatternSummary = {
  id: string;
  name: string;
  createdAt: number;
  thumbnail: string;
  width: number;
  height: number;
  beadCount: number;
};

const DB_NAME = "melt-it";
const DB_VERSION = 1;
const STORE_NAME = "patterns";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser doesn't support saving patterns locally."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Renders a small preview of a pattern for the library grid. Draws onto its
// own throwaway <canvas> -- never added to the page -- so this can't
// interfere with the real pattern canvas the main page uses.
function makeThumbnail(pattern: Pattern, maxSize = 200): string {
  const canvas = document.createElement("canvas");
  drawPattern(canvas, pattern, maxSize);
  return canvas.toDataURL("image/png");
}

export async function savePatternToLibrary(name: string, pattern: Pattern): Promise<string> {
  const db = await openDb();
  const id = crypto.randomUUID();
  const record: SavedPattern = {
    id,
    name,
    createdAt: Date.now(),
    pattern,
    thumbnail: makeThumbnail(pattern),
  };

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  db.close();
  return id;
}

export async function listSavedPatterns(): Promise<SavedPatternSummary[]> {
  const db = await openDb();

  const records = await new Promise<SavedPattern[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result as SavedPattern[]);
    request.onerror = () => reject(request.error);
  });

  db.close();

  return records
    .map((record) => ({
      id: record.id,
      name: record.name,
      createdAt: record.createdAt,
      thumbnail: record.thumbnail,
      width: record.pattern.width,
      height: record.pattern.height,
      beadCount: record.pattern.counts.reduce((sum, entry) => sum + entry.count, 0),
    }))
    .sort((a, b) => b.createdAt - a.createdAt); // newest first
}

export async function getSavedPattern(id: string): Promise<SavedPattern | null> {
  const db = await openDb();

  const record = await new Promise<SavedPattern | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result as SavedPattern | undefined);
    request.onerror = () => reject(request.error);
  });

  db.close();
  return record ?? null;
}

export async function renameSavedPattern(id: string, newName: string): Promise<void> {
  const db = await openDb();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => {
      const record = request.result as SavedPattern | undefined;
      if (record) {
        record.name = newName;
        store.put(record);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  db.close();
}

export async function deleteSavedPattern(id: string): Promise<void> {
  const db = await openDb();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  db.close();
}
