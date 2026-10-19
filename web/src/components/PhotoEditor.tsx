"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { MAX_PHOTO_BYTES, PHOTO_SIZE_PX } from "@fsm/shared";
import { api, errorMessage } from "@/lib/api";
import { Avatar } from "./Avatar";
import { useGame } from "./GameProvider";

/** Largest file we'll try to decode in the browser before resizing. */
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;

/** Centre-crop to a square and resize to PHOTO_SIZE_PX, re-encoding as JPEG to stay under MAX_PHOTO_BYTES. */
async function toSquareJpeg(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = PHOTO_SIZE_PX;
  canvas.height = PHOTO_SIZE_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser can't process images.");
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, PHOTO_SIZE_PX, PHOTO_SIZE_PX);
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.5]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    // base64 length × 3/4 ≈ decoded bytes
    if (url.length * 0.75 < MAX_PHOTO_BYTES) return url;
  }
  throw new Error("Couldn't make that photo small enough.");
}

/** Lets a player set or remove the photo on their own stock. */
export function PhotoEditor() {
  const { me, photoOf } = useGame();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!me?.isActive) return null;
  const hasPhoto = Boolean(photoOf(me.uid));

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    if (!file.type.startsWith("image/")) return setError("Choose an image file.");
    if (file.size > MAX_SOURCE_BYTES) return setError("That image is over 15 MB.");
    setBusy(true);
    try {
      await api.setStockPhoto(await toSquareJpeg(file));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.setStockPhoto(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="row wrap photo-editor">
      <Avatar uid={me.uid} name={me.displayName} size={64} />
      <input ref={input} type="file" accept="image/*" className="sr-only" id="stock-photo" onChange={onFile} disabled={busy} />
      <button type="button" onClick={() => input.current?.click()} disabled={busy}>
        {busy ? "Saving…" : hasPhoto ? "Change photo" : "Add a photo"}
      </button>
      {hasPhoto && (
        <button type="button" className="link danger small" onClick={remove} disabled={busy}>Remove</button>
      )}
      {error && <p className="error small" role="alert">{error}</p>}
    </div>
  );
}
