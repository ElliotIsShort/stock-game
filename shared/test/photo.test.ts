import { describe, expect, it } from "vitest";
import { MAX_PHOTO_BYTES, parsePhotoDataUrl } from "../src/photo";

const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];

describe("parsePhotoDataUrl", () => {
  it("accepts JPEG, PNG and WebP with matching contents", () => {
    expect(parsePhotoDataUrl(`data:image/jpeg;base64,${b64(JPEG)}`)).toMatchObject({ ok: true, photo: { mime: "image/jpeg" } });
    expect(parsePhotoDataUrl(`data:image/png;base64,${b64(PNG)}`)).toMatchObject({ ok: true });
    expect(parsePhotoDataUrl(`data:image/webp;base64,${b64(WEBP)}`)).toMatchObject({ ok: true });
  });

  it("rejects other types, including SVG (which can carry script)", () => {
    expect(parsePhotoDataUrl(`data:image/svg+xml;base64,${b64([0x3c, 0x73, 0x76, 0x67])}`).ok).toBe(false);
    expect(parsePhotoDataUrl(`data:text/html;base64,${b64(JPEG)}`).ok).toBe(false);
    expect(parsePhotoDataUrl("https://example.com/me.jpg").ok).toBe(false);
    expect(parsePhotoDataUrl(42).ok).toBe(false);
  });

  it("rejects contents that don't match the declared type", () => {
    expect(parsePhotoDataUrl(`data:image/jpeg;base64,${b64(PNG)}`).ok).toBe(false);
  });

  it("rejects photos over the size limit", () => {
    const big = Buffer.alloc(MAX_PHOTO_BYTES + 1);
    big.set(JPEG);
    expect(parsePhotoDataUrl(`data:image/jpeg;base64,${big.toString("base64")}`)).toEqual({ ok: false, error: "Photo is too large." });
  });

  it("rejects empty or malformed base64", () => {
    expect(parsePhotoDataUrl("data:image/jpeg;base64,").ok).toBe(false);
    expect(parsePhotoDataUrl("data:image/jpeg;base64,@@@@").ok).toBe(false);
  });
});
