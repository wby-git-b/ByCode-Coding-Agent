import { describe, it, expect } from "bun:test";
import { resolveModelId } from "../src/llm/model-resolver.js";
import { BUILTIN_AGENTS } from "../src/agents/definition.js";

describe("model alias resolution", () => {
  it("resolves short aliases to full model ids", () => {
    expect(resolveModelId("haiku")).toBe("claude-haiku-4-5-20251001");
    expect(resolveModelId("sonnet")).toContain("sonnet");
    expect(resolveModelId("opus")).toContain("opus");
  });

  it("passes through an unknown / already-full model id unchanged", () => {
    expect(resolveModelId("claude-some-future-model")).toBe("claude-some-future-model");
  });

  it("the explore builtin runs on the cheaper haiku model", () => {
    const explore = BUILTIN_AGENTS.find((a) => a.name === "explore");
    expect(explore?.model).toBe("haiku");
  });
});
