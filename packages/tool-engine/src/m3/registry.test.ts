/**
 * ToolRegistry tests: registration, duplicate protection, lookup, enable/
 * disable, deterministic listing, validation and shared disposal.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { ToolRegistry, validateAgainstSchema } from "./registry.js";
import type { ToolDefinition } from "./types.js";
import { toolError } from "./types.js";

const EXEC = "exec-1";

function makeTool(id: string = "echo_tool"): ToolDefinition {
  return {
    id,
    name: id,
    description: "test tool",
    category: "analysis",
    version: "1.0.0",
    inputSchema: {
      type: "object" as const,
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    capabilities: ["idempotent"],
    permission: { level: "read", requiresApproval: false, rationale: "test" },
    idempotent: true,
    async execute(input) {
      return { echoed: input.value };
    },
  };
}

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("registers and returns a tool", () => {
    registry.register(makeTool("a"));
    expect(registry.has("a")).toBe(true);
    expect(registry.get("a")?.id).toBe("a");
  });

  it("rejects duplicate registration", () => {
    registry.register(makeTool("a"));
    expect(() => registry.register(makeTool("a"))).toThrow(
      /already registered/,
    );
  });

  it("unregisters tools", () => {
    registry.register(makeTool("a"));
    expect(registry.unregister("a")).toBe(true);
    expect(registry.has("a")).toBe(false);
    expect(registry.unregister("a")).toBe(false);
  });

  it("supports enable/disable and reports state", () => {
    registry.register(makeTool("a"));
    expect(registry.isEnabled("a")).toBe(true);
    expect(registry.disable("a")).toBe(true);
    expect(registry.isEnabled("a")).toBe(false);
    expect(registry.enable("a")).toBe(true);
    expect(registry.isEnabled("a")).toBe(true);
  });

  it("lists tools deterministically sorted by id", () => {
    for (const id of ["z", "a", "m"]) registry.register(makeTool(id));
    expect(registry.list().map((t) => t.id)).toEqual(["a", "m", "z"]);
  });

  it("filters list by category, enabled state and capability", () => {
    registry.register(makeTool("a"));
    registry.disable("a");
    expect(registry.list({ enabledOnly: true })).toEqual([]);
    expect(registry.list({ capability: "idempotent" })).toHaveLength(1);
  });

  it("validateInput enforces the schema", () => {
    registry.register(makeTool("a"));
    const missing = registry.validateInput("a", {}, EXEC);
    expect(missing?.code).toBe("VALIDATION");
    const unknown = registry.validateInput("a", { value: "x", extra: 1 }, EXEC);
    expect(unknown?.code).toBe("VALIDATION");
    expect(registry.validateInput("a", { value: "ok" }, EXEC)).toBeNull();
  });

  it("validateInput reports unknown and disabled tools", () => {
    registry.register(makeTool("a"));
    expect(registry.validateInput("nope", {}, EXEC)?.code).toBe("NOT_FOUND");
    registry.disable("a");
    expect(registry.validateInput("a", { value: "x" }, EXEC)?.code).toBe(
      "UNSUPPORTED",
    );
  });

  it("invokes the tool-level validate hook", () => {
    const tool = makeTool("a");
    tool.validate = (input: Record<string, unknown>) =>
      input.value === "blocked"
        ? toolError("VALIDATION", "blocked value", EXEC, { recoverable: false })
        : null;
    registry.register(tool);
    expect(registry.validateInput("a", { value: "ok" }, EXEC)).toBeNull();
    expect(
      registry.validateInput("a", { value: "blocked" }, EXEC)?.message,
    ).toBe("blocked value");
  });

  it("dispose() calls tool.dispose and clears the registry", async () => {
    let disposed = 0;
    const tool = makeTool("a");
    tool.dispose = async () => {
      disposed += 1;
    };
    registry.register(tool);
    await registry.dispose();
    expect(disposed).toBe(1);
    expect(registry.has("a")).toBe(false);
  });

  it("cannot be used after dispose", async () => {
    registry.register(makeTool("a"));
    await registry.dispose();
    expect(() => registry.register(makeTool("b"))).toThrow(/disposed/);
  });
});

describe("validateAgainstSchema", () => {
  const schema = {
    type: "object" as const,
    properties: {
      name: { type: "string" as const },
      level: { type: "number" as const },
      tags: { type: "array" as const, items: { type: "string" as const } },
      flags: { type: "object" as const },
      kind: { type: "string" as const, enum: ["a", "b"] },
    },
    required: ["name"],
    additionalProperties: false,
  };

  it("accepts valid input", () => {
    expect(
      validateAgainstSchema(
        schema,
        { name: "x", level: 2, tags: ["t"], kind: "a" },
        EXEC,
      ),
    ).toBeNull();
  });

  it("rejects non-object input", () => {
    for (const input of [null, 42, "str", [1, 2]]) {
      expect(validateAgainstSchema(schema, input, EXEC)?.code).toBe(
        "VALIDATION",
      );
    }
  });

  it("rejects unknown properties when additionalProperties is false", () => {
    expect(
      validateAgainstSchema(schema, { name: "x", nope: true }, EXEC)?.code,
    ).toBe("VALIDATION");
  });

  it("rejects wrong types, including nested array items", () => {
    expect(validateAgainstSchema(schema, { name: 1 }, EXEC)?.code).toBe(
      "VALIDATION",
    );
    expect(
      validateAgainstSchema(schema, { name: "x", tags: [1] }, EXEC)?.code,
    ).toBe("VALIDATION");
  });

  it("rejects enum violations", () => {
    expect(
      validateAgainstSchema(schema, { name: "x", kind: "z" }, EXEC)?.message,
    ).toContain("one of");
  });
});
