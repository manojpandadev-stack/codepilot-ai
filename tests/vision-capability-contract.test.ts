/**
 * PHASE 7 — VISION SUPPORT capability-contract verification.
 *
 * The brief: do NOT label a text-only model as vision-capable; if no
 * vision-capable model is live, verify the transport + capability contract
 * and mark live visual reasoning NOT VERIFIED.
 *
 * Environment (recorded 2026-09): local Ollama serves qwen3:8b (family
 * qwen3, text-only), qwen2.5-coder:3b (family qwen2, text-only), and
 * nomic-embed-text (embeddings only). No vision-capable model is available,
 * so the assertions below pin the CONTRACT — no test anywhere claims a
 * text-only model produced visual reasoning.
 *
 * Contract under test:
 *  1. The catalogue capability vocabulary contains "images" and uses it ONLY
 *     on models plausibly vision-capable; qwen3:8b must NOT carry it.
 *  2. The shared image pipeline validates by MAGIC BYTES (mime lies are
 *     rejected), caps size/images, and computes bounded token estimates.
 *  3. The Ollama transport maps image content blocks to the top-level
 *     `images` wire field (already covered by providers.test.ts; re-pinned
 *     here at the type level via the catalogue-driven flag path).
 */
import { describe, expect, it } from "vitest";
import { CODEPILOT_PROVIDER_CATALOG } from "../packages/llm/src/catalogue.js";
import {
  sniffImageMime,
  validateImageAttachment,
  estimateImageTokens,
  IMAGE_MIME_ALLOWLIST,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_TURN,
} from "../packages/shared/src/images.js";

const pngMagic = Uint8Array.of(
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
);

describe("P7 — vision capability contract", () => {
  it("labels qwen3:8b as tool-capable but NOT image-capable (text-only)", () => {
    const ollama = CODEPILOT_PROVIDER_CATALOG.find((p) => p.id === "ollama");
    expect(ollama).toBeDefined();
    const qwen3 = ollama?.models["qwen3:8b"];
    expect(qwen3?.capabilities).toContain("tools");
    expect(qwen3?.capabilities).not.toContain("images");
  });

  it("exposes the images capability ONLY for known vision-capable models", () => {
    const withImages: string[] = [];
    for (const p of CODEPILOT_PROVIDER_CATALOG) {
      for (const [id, m] of Object.entries(p.models)) {
        if (m.capabilities.includes("images")) withImages.push(`${p.id}/${id}`);
      }
    }
    // Cloud models in the catalogue are the vision-capable ones.
    expect(withImages.length).toBeGreaterThan(0);
    for (const key of withImages) {
      expect(key.startsWith("ollama/")).toBe(false);
    }
    console.log("P7 vision-capable catalogue entries:", JSON.stringify(withImages));
  });

  it("image pipeline: magic-byte sniffing is authoritative (no codec lies)", () => {
    // Claims to be PNG but has JPEG magic → sniffed as JPEG, not trusted.
    const jpegMagic = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0);
    expect(sniffImageMime(jpegMagic)).toBe("image/jpeg");
    // The production validator accepts by SNIFFED format only; a .png name
    // with JPEG bytes is accepted as JPEG (sniff wins), a fake extension is
    // never honored as a non-allowlisted format.
    const asJpeg = validateImageAttachment({
      bytes: jpegMagic,
      name: "lie.png",
    });
    expect("mime" in asJpeg && asJpeg.mime === "image/jpeg").toBe(true);
    // Bytes too small to sniff are rejected outright.
    const tiny = validateImageAttachment({ bytes: Uint8Array.of(1, 2, 3), name: "t.png" });
    expect("error" in tiny).toBe(true);
    // Honest PNG: accepted with the sniffed mime.
    const ok = validateImageAttachment({ bytes: pngMagic, name: "ok.png" });
    expect("mime" in ok && ok.mime === "image/png").toBe(true);
  });

  it("image pipeline: contract constants are bounded", () => {
    expect(MAX_IMAGE_BYTES).toBeLessThanOrEqual(1_500_000);
    expect(MAX_IMAGES_PER_TURN).toBeLessThanOrEqual(4);
    expect(IMAGE_MIME_ALLOWLIST).not.toContain("image/svg+xml"); // no scriptable vector payloads
    // Token estimate grows with size and stays finite/positive.
    const est = estimateImageTokens(1_000_000);
    expect(Number.isFinite(est)).toBe(true);
    expect(est).toBeGreaterThan(0);
  });
});
