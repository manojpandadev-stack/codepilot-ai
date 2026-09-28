/**
 * Minimal PNG sniff/strip helper for @codepilot/llm tests.
 *
 * packages/llm does NOT depend on @codepilot/shared. This helper mirrors the
 * production contract (magic-byte sniff, size cap) for the single 12-byte PNG
 * fixture used in providers.test.ts — it is test-only and must not drift
 * into a second validation implementation.
 */
export function validateImageAttachment(input: {
  bytes: Uint8Array;
  claimedMime: string;
  name: string;
}): { mime: string; bytes: Uint8Array } | { error: string } {
  const { bytes, claimedMime } = input;
  if (bytes.length < 12) return { error: "image too small" };
  const isPng =
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  if (!isPng) return { error: "unsupported image type" };
  if (claimedMime !== "image/png") return { error: "mime mismatch" };
  return { mime: "image/png", bytes };
}
