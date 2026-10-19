/**
 * Stock photos are small square images stored as data URLs in
 * photos/{uid}. The client resizes before upload; the server re-validates
 * with parsePhotoDataUrl so a hand-crafted request can't store anything else.
 */

/** Edge length (px) the client resizes photos to. */
export const PHOTO_SIZE_PX = 256;
/** Max decoded image size accepted by the server. */
export const MAX_PHOTO_BYTES = 200_000;

export type PhotoMime = "image/jpeg" | "image/png" | "image/webp";

export interface ParsedPhoto {
  mime: PhotoMime;
  bytes: number;
}

const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

function matchesMagic(mime: PhotoMime, b: Uint8Array): boolean {
  if (mime === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === "image/png") return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  // RIFF....WEBP
  return (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  );
}

/**
 * Validates a base64 image data URL. Returns the parsed photo, or an error
 * message suitable for showing to the user.
 */
export function parsePhotoDataUrl(dataUrl: unknown): { ok: true; photo: ParsedPhoto } | { ok: false; error: string } {
  if (typeof dataUrl !== "string") return { ok: false, error: "Photo must be a data URL." };
  // Cheap length guard before running the regex: base64 is ~4/3 of the bytes.
  if (dataUrl.length > Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 64) return { ok: false, error: "Photo is too large." };
  const m = DATA_URL.exec(dataUrl);
  if (!m) return { ok: false, error: "Photo must be a JPEG, PNG or WebP image." };
  const mime = m[1] as PhotoMime;
  let raw: string;
  try {
    raw = atob(m[2]);
  } catch {
    return { ok: false, error: "Photo data is corrupt." };
  }
  if (raw.length === 0) return { ok: false, error: "Photo is empty." };
  if (raw.length > MAX_PHOTO_BYTES) return { ok: false, error: "Photo is too large." };
  const head = new Uint8Array(Math.min(12, raw.length));
  for (let i = 0; i < head.length; i++) head[i] = raw.charCodeAt(i);
  if (!matchesMagic(mime, head)) return { ok: false, error: "Photo contents don't match its image type." };
  return { ok: true, photo: { mime, bytes: raw.length } };
}
