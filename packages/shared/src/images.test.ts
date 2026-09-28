/**
 * Image attachment validation + metadata stripping (shared, host-authoritative).
 *
 * No filesystem, no network: magic-byte fixtures are constructed inline.
 */
import { describe, expect, it } from "vitest";
import {
  IMAGE_MIME_ALLOWLIST,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_TURN,
  describeImage,
  estimateImageTokens,
  sanitizeImageName,
  sniffImageMime,
  stripImageMetadata,
  validateImageAttachment,
} from "./images.js";

function bytesOf(arr: number[]): Uint8Array {
  return Uint8Array.from(arr);
}

/** Minimal PNG: signature + IHDR + tEXt (metadata) + IDAT + IEND. */
function pngWithText(): Uint8Array {
  const out: number[] = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ];
  const chunk = (type: string, data: number[]) => {
    const len = data.length;
    out.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
    for (const c of type) out.push(c.charCodeAt(0));
    out.push(...data);
    out.push(0xde, 0xad, 0xbe, 0xef); // CRC unchecked by the stripper
  };
  chunk("IHDR", new Array(13).fill(1));
  chunk("tEXt", [72, 101, 108, 108, 111]); // "Hello" metadata
  chunk("IDAT", [9, 9, 9]);
  chunk("IEND", []);
  return bytesOf(out);
}

/** Minimal JPEG: SOI + APP1(EXIF) + DQT + SOF0 + SOS + payload + EOI. */
function jpegWithExif(): Uint8Array {
  const seg = (marker: number, data: number[]) => [
    0xff,
    marker,
    (data.length + 2) >>> 8,
    (data.length + 2) & 0xff,
    ...data,
  ];
  return bytesOf([
    0xff, 0xd8,
    ...seg(0xe1, [69, 120, 105, 102, 0, 0, 71, 80, 83]), // APP1 "Exif..GPS"
    ...seg(0xdb, [1, 2, 3]), // DQT (kept)
    ...seg(0xc0, [4, 5, 6]), // SOF0 (kept)
    ...seg(0xda, [7, 8]), // SOS (kept, rest verbatim)
    0xaa, 0xbb,
    0xff, 0xd9,
  ]);
}

/** Minimal GIF89a with a comment extension. */
function gifWithComment(): Uint8Array {
  return bytesOf([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
    0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, // LSD, no GCT
    0x21, 0xfe, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, // comment "hello"
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // descriptor
    0x02, 0x01, 0x44, 0x00, // image data
    0x3b, // trailer
  ]);
}

/** Minimal WebP: RIFF + VP8 + EXIF chunks. */
function webpWithExif(): Uint8Array {
  const chunk = (type: string, data: number[]) => {
    const out = [...type].map((c) => c.charCodeAt(0));
    out.push(data.length & 0xff, (data.length >>> 8) & 0xff, (data.length >>> 16) & 0xff, (data.length >>> 24) & 0xff);
    out.push(...data);
    if (data.length % 2 === 1) out.push(0);
    return out;
  };
  const vp8 = [1, 2, 3, 4];
  const exif = [5, 6, 7, 8];
  const body = [...chunk("VP8 ", vp8), ...chunk("EXIF", exif)];
  const total = 4 + body.length; // "WEBP" + chunks
  return bytesOf([
    0x52, 0x49, 0x46, 0x46,
    total & 0xff, (total >>> 8) & 0xff, (total >>> 16) & 0xff, (total >>> 24) & 0xff,
    0x57, 0x45, 0x42, 0x50,
    ...body,
  ]);
}

describe("sniffImageMime", () => {
  it("identifies png, jpeg, gif, webp by magic bytes", () => {
    expect(sniffImageMime(pngWithText())).toBe("image/png");
    expect(sniffImageMime(jpegWithExif())).toBe("image/jpeg");
    expect(sniffImageMime(gifWithComment())).toBe("image/gif");
    expect(sniffImageMime(webpWithExif())).toBe("image/webp");
  });

  it("rejects short, random, text, and BMP payloads", () => {
    expect(sniffImageMime(bytesOf([0xff, 0xd8]))).toBeNull();
    expect(sniffImageMime(bytesOf(new Array(32).fill(7)))).toBeNull();
    expect(
      sniffImageMime(
        new TextEncoder().encode("this is definitely not an image file...."),
      ),
    ).toBeNull();
    // BMP magic is not allowlisted.
    expect(
      sniffImageMime(bytesOf([0x42, 0x4d, ...new Array(30).fill(0)])),
    ).toBeNull();
  });

  it("ignores claimed extensions (sniffs bytes only)", () => {
    // JPEG bytes named .png still sniff as jpeg.
    expect(sniffImageMime(jpegWithExif())).toBe("image/jpeg");
  });
});

describe("validateImageAttachment", () => {
  const pngB64 = Buffer.from(pngWithText()).toString("base64");

  it("accepts valid base64 png and strips metadata", () => {
    const r = validateImageAttachment({ name: "shot.png", base64: pngB64 });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.mime).toBe("image/png");
    expect(r.name).toBe("shot.png");
    const text = new TextDecoder().decode(r.bytes);
    expect(text).not.toContain("Hello");
  });

  it("accepts data URLs and ignores the claimed MIME", () => {
    const r = validateImageAttachment({
      name: "x.gif",
      base64: `data:image/gif;base64,${pngB64}`,
    });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    // Bytes win over the data-URL claim.
    expect(r.mime).toBe("image/png");
  });

  it("accepts raw bytes", () => {
    const r = validateImageAttachment({ bytes: jpegWithExif() });
    expect("error" in r).toBe(false);
  });

  it("rejects empty, non-base64, oversized, and unsupported payloads", () => {
    expect(validateImageAttachment({ base64: "" })).toEqual({
      error: expect.any(String),
    });
    expect(validateImageAttachment({ base64: "!!!not-base64!!!" })).toEqual({
      error: expect.any(String),
    });
    expect(validateImageAttachment({})).toEqual({ error: expect.any(String) });
    expect(
      validateImageAttachment({
        bytes: new Uint8Array(MAX_IMAGE_BYTES + 1),
      }),
    ).toEqual({ error: expect.stringContaining("exceeds") });
    expect(
      validateImageAttachment({
        bytes: new TextEncoder().encode("plain text, not an image......"),
      }),
    ).toEqual({ error: expect.stringContaining("unsupported") });
  });
});

describe("stripImageMetadata", () => {
  it("drops JPEG APPn/COM but keeps image segments and scan data", () => {
    const stripped = stripImageMetadata(jpegWithExif(), "image/jpeg");
    const text = new TextDecoder().decode(stripped);
    expect(text).not.toContain("Exif");
    // DQT/SOF/SOS markers and payload survive.
    const raw = Array.from(stripped);
    expect(raw).toContain(0xdb);
    expect(raw).toContain(0xda);
    expect(raw.slice(-2)).toEqual([0xff, 0xd9]);
  });

  it("drops PNG textual chunks but keeps IDAT/IEND", () => {
    const stripped = stripImageMetadata(pngWithText(), "image/png");
    expect(new TextDecoder().decode(stripped)).not.toContain("Hello");
    expect(stripped.length).toBeLessThan(pngWithText().length);
    // Still ends with a well-formed IEND chunk (len + "IEND" + CRC).
    expect(Array.from(stripped.slice(-12))).toEqual([
      0, 0, 0, 0, 73, 69, 78, 68, 0xde, 0xad, 0xbe, 0xef,
    ]);
  });

  it("drops GIF comment extensions but keeps the trailer", () => {
    const stripped = stripImageMetadata(gifWithComment(), "image/gif");
    expect(new TextDecoder().decode(stripped)).not.toContain("hello");
    expect(stripped[stripped.length - 1]).toBe(0x3b);
  });

  it("drops WebP EXIF and fixes the RIFF size", () => {
    const original = webpWithExif();
    const stripped = stripImageMetadata(original, "image/webp");
    expect(stripped.length).toBeLessThan(original.length);
    const view = new DataView(
      stripped.buffer,
      stripped.byteOffset,
      stripped.byteLength,
    );
    expect(view.getUint32(4, true)).toBe(stripped.length - 8);
    expect(sniffImageMime(stripped)).toBe("image/webp");
  });

  it("returns input unchanged for unknown mime or corrupt containers", () => {
    const junk = bytesOf(new Array(40).fill(3));
    expect(stripImageMetadata(junk, "image/png")).toBe(junk);
    expect(stripImageMetadata(junk, "application/octet-stream")).toBe(junk);
  });
});

describe("sanitizeImageName", () => {
  it("strips directories, separators, and traversal", () => {
    expect(sanitizeImageName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeImageName("C:\\Users\\x\\pic.png")).toBe("pic.png");
    expect(sanitizeImageName("/abs/path.jpg")).toBe("path.jpg");
  });

  it("falls back and caps length", () => {
    expect(sanitizeImageName("")).toBe("image");
    expect(sanitizeImageName("...")).toBe("image");
    expect(sanitizeImageName(undefined)).toBe("image");
    expect(sanitizeImageName("a".repeat(500)).length).toBeLessThanOrEqual(128);
  });
});

describe("limits and helpers", () => {
  it("exposes sane caps and descriptions", () => {
    expect(IMAGE_MIME_ALLOWLIST).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ]);
    expect(MAX_IMAGE_BYTES).toBeGreaterThan(0);
    expect(MAX_IMAGES_PER_TURN).toBeGreaterThan(0);
    expect(describeImage("image/png", 240 * 1024)).toContain("png");
    expect(estimateImageTokens(0)).toBeGreaterThan(0);
    expect(estimateImageTokens(1_000_000)).toBeGreaterThan(
      estimateImageTokens(1_000),
    );
  });
});
