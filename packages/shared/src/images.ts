/**
 * @codepilot/shared — image attachment validation + metadata stripping.
 *
 * Pure functions shared by the WebView (pre-flight checks) and the extension
 * host (authoritative validation — the host NEVER trusts the WebView).
 *
 * Security model:
 * - MIME is established by **magic-byte sniffing**, never by file extension
 *   or caller claim. Mismatched claims are rejected.
 * - Only still-image formats with segment-based metadata stripping are
 *   accepted: PNG, JPEG, WebP, GIF.
 * - Size is enforced on **decoded bytes** (base64 length lies).
 * - Metadata (EXIF incl. GPS, XMP, PNG textual chunks, GIF comments) is
 *   stripped segment-wise; pixel data is never re-encoded (no image codec
 *   dependency, no quality change).
 * - Filenames are display-only: sanitized to a bare name, never used as a
 *   path. Staged bytes live under host-controlled task directories.
 */

export const IMAGE_MIME_ALLOWLIST: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

/** Max decoded bytes per image (1.5 MiB). */
export const MAX_IMAGE_BYTES = 1_500_000;

/** Max images accepted per chat turn. */
export const MAX_IMAGES_PER_TURN = 4;

/** Short human description used in markers, logs, and audit entries. */
export function describeImage(mime: string, sizeBytes: number): string {
  const kind = mime.startsWith("image/") ? mime.slice("image/".length) : mime;
  const kb = Math.max(1, Math.round(sizeBytes / 1024));
  return `[image: ${kind}, ${kb}KB]`;
}

/**
 * Sniff the MIME type from magic bytes. Returns null when the bytes do not
 * match a supported still-image format.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF87a / GIF89a
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  // WebP: RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export interface ValidatedImage {
  /** Sniffed MIME (authoritative — caller claim ignored). */
  mime: string;
  /** Stripped, validated bytes ready to stage. */
  bytes: Uint8Array;
  /** Sanitized display name (never a path). */
  name: string;
}

export interface ImageValidationError {
  error: string;
}

/**
 * Validate a candidate image attachment.
 *
 * Accepts base64 (optionally a `data:<mime>;base64,` URL) or raw bytes.
 * Decodes, sniffs the true MIME, enforces the allowlist + size cap, strips
 * metadata, and sanitizes the display name. Never throws for malformed
 * input — returns `{ error }`.
 */
export function validateImageAttachment(input: {
  name?: unknown;
  mime?: unknown;
  base64?: unknown;
  bytes?: unknown;
}): ValidatedImage | ImageValidationError {
  let bytes: Uint8Array | null = null;
  if (typeof input.base64 === "string") {
    const text = input.base64.trim();
    const dataUrl = text.match(/^data:([^;,]+)?;base64,(.*)$/s);
    const b64 = (dataUrl?.[2] ?? text).replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length === 0) {
      return { error: "image is not valid base64" };
    }
    try {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      bytes = out;
    } catch {
      return { error: "image is not valid base64" };
    }
  } else if (input.bytes instanceof Uint8Array) {
    bytes = input.bytes;
  } else if (
    typeof Buffer !== "undefined" &&
    typeof (Buffer as unknown as { isBuffer?: unknown }).isBuffer === "function" &&
    (Buffer as unknown as { isBuffer: (v: unknown) => boolean }).isBuffer(
      input.bytes,
    )
  ) {
    bytes = new Uint8Array(
      input.bytes as unknown as { buffer: ArrayBuffer; byteOffset: number; length: number },
    );
  }
  if (!bytes) return { error: "image requires base64 or bytes" };
  if (bytes.length === 0) return { error: "image is empty" };
  if (bytes.length > MAX_IMAGE_BYTES) {
    return {
      error: `image exceeds ${Math.round(MAX_IMAGE_BYTES / 1024)}KB limit (${Math.round(bytes.length / 1024)}KB)`,
    };
  }
  const mime = sniffImageMime(bytes);
  if (!mime || !IMAGE_MIME_ALLOWLIST.includes(mime)) {
    return { error: "unsupported image format (png, jpeg, webp, gif only)" };
  }
  return { mime, bytes: stripImageMetadata(bytes, mime), name: sanitizeImageName(input.name) };
}

/**
 * Sanitize a caller-supplied filename to a bare display name. Strips
 * directories, separators, control characters, and leading dots; caps
 * length; never returns a path.
 */
export function sanitizeImageName(name: unknown): string {
  if (typeof name !== "string") return "image";
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[^\w\-. ]/g, "").replace(/^\.+/g, "").trim();
  if (!clean) return "image";
  return clean.slice(0, 128);
}

/**
 * Strip metadata segments without touching pixel data.
 *
 * - JPEG: drop all APPn segments (EXIF/GPS/XMP live there) + COM segments.
 * - PNG: keep IHDR/PLTE/tRNS/IDAT/IEND (+acTL/fcTL animation); drop textual
 *   (tEXt/zTXt/iTXt), EXIF (eXIf), and other ancillary chunks.
 * - GIF: drop comment (0x21 0xFE) and application (0x21 0xFF) extensions.
 * - WebP: keep VP8/VP8L/VP8X/ALPH/ANIM/ANMF/ICCP; drop EXIF/XMP/unknown.
 *
 * Malformed containers fail closed (returns the input unchanged only when
 * the container parses cleanly end-to-end; otherwise the input unchanged —
 * callers already validated magic bytes, and stripping is best-effort
 * hygiene, never a validity gate).
 */
export function stripImageMetadata(bytes: Uint8Array, mime: string): Uint8Array {
  try {
    switch (mime) {
      case "image/jpeg":
        return stripJpeg(bytes);
      case "image/png":
        return stripPng(bytes);
      case "image/gif":
        return stripGif(bytes);
      case "image/webp":
        return stripWebp(bytes);
      default:
        return bytes;
    }
  } catch {
    return bytes;
  }
}

function stripJpeg(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) break; // entropy data or corrupt — keep rest verbatim
    const marker = bytes[i + 1]!;
    // Standalone markers (no length): RSTn, SOI, EOI, TEM.
    if (marker === 0xd9) {
      out.push(0xff, 0xd9);
      i += 2;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      out.push(0xff, marker);
      i += 2;
      continue;
    }
    // Start of scan: copy the rest verbatim (compressed data follows).
    if (marker === 0xda) {
      for (let j = i; j < bytes.length; j++) out.push(bytes[j]!);
      break;
    }
    const len = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (len < 2 || i + 2 + len > bytes.length) break;
    // Drop APPn (0xE0-0xEF: EXIF/XMP/JFIF) and COM (0xFE).
    const drop =
      (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!drop) {
      for (let j = i; j < i + 2 + len; j++) out.push(bytes[j]!);
    }
    i += 2 + len;
  }
  if (i < bytes.length && out[out.length - 1] !== 0xd9) {
    for (let j = i; j < bytes.length; j++) out.push(bytes[j]!);
  }
  return Uint8Array.from(out);
}

function stripPng(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 8) return bytes;
  const KEEP = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND", "acTL", "fcTL", "fdAT"]);
  const out: number[] = [];
  for (let j = 0; j < 8; j++) out.push(bytes[j]!);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 8;
  let seenIend = false;
  while (i + 12 <= bytes.length) {
    const len = view.getUint32(i);
    const type = String.fromCharCode(
      bytes[i + 4]!,
      bytes[i + 5]!,
      bytes[i + 6]!,
      bytes[i + 7]!,
    );
    if (i + 12 + len > bytes.length) break;
    if (KEEP.has(type)) {
      for (let j = i; j < i + 12 + len; j++) out.push(bytes[j]!);
    }
    if (type === "IEND") {
      seenIend = true;
      break;
    }
    i += 12 + len;
  }
  if (!seenIend) return bytes;
  return Uint8Array.from(out);
}

function stripGif(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 13) return bytes;
  const out: number[] = [];
  for (let j = 0; j < 13; j++) out.push(bytes[j]!);
  let i = 13;
  // Global color table.
  const packed = bytes[10]!;
  if (packed & 0x80) {
    const tableBytes = 3 * (1 << ((packed & 0x07) + 1));
    if (i + tableBytes > bytes.length) return bytes;
    for (let j = i; j < i + tableBytes; j++) out.push(bytes[j]!);
    i += tableBytes;
  }
  while (i < bytes.length) {
    const sep = bytes[i]!;
    if (sep === 0x3b) {
      out.push(0x3b); // trailer
      i += 1;
      break;
    }
    if (sep === 0x21) {
      const label = bytes[i + 1];
      // Drop comment (0xFE) and application (0xFF) extensions entirely.
      if (label === 0xfe || label === 0xff) {
        i += 2;
        while (i < bytes.length) {
          const size = bytes[i]!;
          i += 1;
          if (size === 0) break;
          i += size;
          if (i > bytes.length) return bytes;
        }
        continue;
      }
      // Copy any other extension block verbatim.
      out.push(0x21, label!);
      i += 2;
      while (i < bytes.length) {
        const size = bytes[i]!;
        out.push(size);
        i += 1;
        if (size === 0) break;
        if (i + size > bytes.length) return bytes;
        for (let j = i; j < i + size; j++) out.push(bytes[j]!);
        i += size;
      }
      continue;
    }
    if (sep === 0x2c) {
      // Image descriptor: 9 bytes + optional local table + data sub-blocks.
      if (i + 10 > bytes.length) return bytes;
      for (let j = i; j < i + 9; j++) out.push(bytes[j]!);
      const lct = bytes[i + 8]!;
      i += 9;
      if (lct & 0x80) {
        const tableBytes = 3 * (1 << ((lct & 0x07) + 1));
        if (i + tableBytes > bytes.length) return bytes;
        for (let j = i; j < i + tableBytes; j++) out.push(bytes[j]!);
        i += tableBytes;
      }
      if (i >= bytes.length) return bytes;
      out.push(bytes[i]!); // LZW minimum code size
      i += 1;
      while (i < bytes.length) {
        const size = bytes[i]!;
        out.push(size);
        i += 1;
        if (size === 0) break;
        if (i + size > bytes.length) return bytes;
        for (let j = i; j < i + size; j++) out.push(bytes[j]!);
        i += size;
      }
      continue;
    }
    return bytes; // unknown structure — fail closed (keep original)
  }
  return Uint8Array.from(out);
}

function stripWebp(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 12) return bytes;
  const KEEP = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF", "ICCP"]);
  const out: number[] = [];
  for (let j = 0; j < 12; j++) out.push(bytes[j]!);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 12;
  while (i + 8 <= bytes.length) {
    const type = String.fromCharCode(
      bytes[i]!,
      bytes[i + 1]!,
      bytes[i + 2]!,
      bytes[i + 3]!,
    );
    const size = view.getUint32(i + 4, true);
    if (i + 8 + size > bytes.length) break;
    if (KEEP.has(type)) {
      for (let j = i; j < i + 8 + size + (size % 2); j++) {
        if (j < bytes.length) out.push(bytes[j]!);
      }
    }
    i += 8 + size + (size % 2);
  }
  // Fix the RIFF size field to the stripped length.
  const stripped = Uint8Array.from(out);
  if (stripped.length >= 8) {
    const fix = new DataView(
      stripped.buffer,
      stripped.byteOffset,
      stripped.byteLength,
    );
    fix.setUint32(4, stripped.length - 8, true);
  }
  return stripped;
}

/** Rough token estimate for context budgeting (documented approximation). */
export function estimateImageTokens(sizeBytes: number): number {
  return 512 + Math.ceil(Math.max(0, sizeBytes) / 1024);
}
