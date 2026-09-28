/**
 * Image attachments host integration (deterministic, stubbed provider).
 *
 * REAL path throughout: WebView `chat/send` dispatcher → host validation
 * (magic bytes, allowlist, size) → metadata stripping → task-scoped
 * staging → native session with image blocks → stubbed Ollama wire →
 * TaskStore persistence (fileRefs only) → audit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  freshHost,
  sleep,
  DEBOUNCE_WAIT_MS,
  type FreshHost,
} from "./vscode-integration-harness";
import {
  stubOllamaFetch,
  type OllamaStub,
} from "../packages/agent-runtime/src/ollama-fetch-stub.js";
import { TaskStore } from "../packages/agent-runtime/src/m12-task-store.js";

// 1x1 transparent PNG (valid magic, strippable).
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

interface CapturedMessage {
  type: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

describe("image attachments host integration", () => {
  let host: FreshHost;
  let captured: CapturedMessage[];
  let workspaceDir = "";
  let stub: OllamaStub | null = null;

  beforeEach(async () => {
    host = await freshHost();
    captured = [];
    host.ext.__setWebviewSinkForIntegrationTest((m) => {
      captured.push(m as CapturedMessage);
    });
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-img-ws-"));
    (
      host.vscodeStub as unknown as {
        workspace: { workspaceFolders: Array<{ uri: { fsPath: string } }> };
      }
    ).workspace.workspaceFolders.push({ uri: { fsPath: workspaceDir } });
  });

  afterEach(async () => {
    stub?.restore();
    stub = null;
    vi.unstubAllGlobals();
    host.ext.__clearWebviewSinkForIntegrationTest();
    await host.ext.deactivate().catch(() => {});
    host.cleanup();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  function sendChat(
    text: string,
    context?: Record<string, unknown>,
    tag = "img",
  ) {
    return host.seams.handleMessage({
      type: "chat/send" as never,
      id: `${tag}-${Date.now()}`,
      payload: { text, mode: "act", requestId: tag, context },
      timestamp: Date.now(),
    });
  }

  function lastError(): string {
    const errors = captured.filter((m) => m.type === "error");
    return errors
      .map((m) => JSON.stringify(m.payload ?? {}))
      .join("\n");
  }

  it("rejects non-image bytes with a user-facing error and no phantom task", async () => {
    await sendChat("look", {
      images: [{ name: "evil.txt", data: btoa("not an image at all....") }],
    });
    await sleep(DEBOUNCE_WAIT_MS);
    expect(lastError()).toContain("image rejected");
    const store = new TaskStore(host.tasksDir);
    expect(await store.list()).toHaveLength(0);
  });

  it("rejects oversized images before any model request", async () => {
    // Valid PNG magic, then padding past the cap.
    const bigBytes = new Uint8Array(2_000_000);
    bigBytes[0] = 0x89;
    bigBytes[1] = 0x50;
    bigBytes[2] = 0x4e;
    bigBytes[3] = 0x47;
    bigBytes[4] = 0x0d;
    bigBytes[5] = 0x0a;
    bigBytes[6] = 0x1a;
    bigBytes[7] = 0x0a;
    let binary = "";
    for (let i = 0; i < bigBytes.length; i++) {
      binary += String.fromCharCode(bigBytes[i]!);
    }
    await sendChat("look", {
      images: [{ name: "big.png", data: btoa(binary) }],
    });
    await sleep(DEBOUNCE_WAIT_MS);
    expect(lastError()).toContain("image rejected");
  });

  it("rejects more than the per-turn cap without starting a session", async () => {
    const images = Array.from({ length: 5 }, (_, i) => ({
      name: `s${i}.png`,
      data: PNG_DATA_URL,
    }));
    await sendChat("look", { images });
    await sleep(DEBOUNCE_WAIT_MS);
    expect(lastError()).toContain("too many images");
  });

  it("valid image reaches the provider wire and persists as fileRef only", async () => {
    // qwen3:8b is catalogued text-only (fail-closed); use an unlisted local
    // model id whose capabilities are statically unknowable, so the gate
    // allows and the stubbed endpoint serves the turn.
    (
      host.vscodeStub as unknown as {
        configOverrides: Map<string, string>;
      }
    ).configOverrides.set("model", "llava:13b");
    stub = stubOllamaFetch([{ texts: ["a tiny transparent pixel."] }]);
    await sendChat(
      "What is in this image?",
      { images: [{ name: "shot.png", data: PNG_DATA_URL }] },
      "img-live",
    );
    await sleep(DEBOUNCE_WAIT_MS);
    const taskId = host.seams.getActiveTaskId();
    expect(taskId).not.toBeNull();
    await host.seams.drainPersistence(taskId!);

    // Transport proof: Ollama images[] on the first request (later loop
    // iterations re-send history, so later requests may repeat it).
    const chats = stub.requests.filter((r) => r.url.includes("/api/chat"));
    expect(chats.length).toBeGreaterThan(0);
    const first = chats[0]!.body as {
      messages: Array<{ images?: string[]; content?: unknown }>;
    };
    const withImages = first.messages.filter((m) => m.images?.length === 1);
    expect(withImages).toHaveLength(1);
    expect(typeof withImages[0]!.images?.[0]).toBe("string");

    // Completion surfaced to the UI.
    const completions = captured.filter(
      (m) =>
        m.type === "agent/status" && m.payload?.["status"] === "completed",
    );
    expect(completions.length).toBeGreaterThanOrEqual(1);

    // Persistence proof: fileRef blocks, zero inline bytes on disk.
    const store = new TaskStore(host.tasksDir);
    const task = await store.get(taskId!);
    expect(task).toBeDefined();
    const raw = JSON.stringify(task);
    expect(raw).not.toContain("dataBase64");
    expect(raw).not.toContain(PNG_B64);
    const imageBlocks = (task?.conversation ?? []).flatMap((e) =>
      (e.blocks ?? []).filter((b) => b.type === "image"),
    );
    expect(imageBlocks).toHaveLength(1);
    expect(imageBlocks[0]).toMatchObject({
      mime: "image/png",
      name: "shot.png",
    });
    const ref = (imageBlocks[0] as { fileRef?: string }).fileRef ?? "";
    expect(ref.startsWith("images/")).toBe(true);
    // Staged bytes resolve from disk for future resumes.
    expect(store.readStagedImage(taskId!, ref)).not.toBeNull();
  });
});
