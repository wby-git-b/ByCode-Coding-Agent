import { describe, it, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryExtractor } from "../src/memory/extractor.js";
import type { LLMClient } from "../src/llm/client.js";
import type { StreamEvent } from "../src/llm/events.js";

class MockClient implements LLMClient {
  constructor(private text: string) {}
  async *stream(): AsyncGenerator<StreamEvent> {
    yield { type: "text_delta", text: this.text };
    yield { type: "stream_end", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } };
  }
}

const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

/**
 * Simulates a memory-extraction subagent: on the first stream call it writes the
 * two memory files via WriteFile, then on the next call it reports completion.
 */
class ToolCallingMockClient implements LLMClient {
  private calls = 0;

  constructor(
    private buildCmdPath: string,
    private apiDocsPath: string
  ) {}

  async *stream(): AsyncGenerator<StreamEvent> {
    this.calls++;
    if (this.calls === 1) {
      yield { type: "tool_call_start", toolName: "WriteFile", toolId: "call-1" };
      yield {
        type: "tool_call_complete",
        toolId: "call-1",
        toolName: "WriteFile",
        arguments: {
          file_path: this.buildCmdPath,
          content: [
            "---",
            "name: build-cmd",
            "description: how to build",
            "type: project",
            "---",
            "Run bun run build.",
          ].join("\n"),
        },
      };
      yield { type: "tool_call_start", toolName: "WriteFile", toolId: "call-2" };
      yield {
        type: "tool_call_complete",
        toolId: "call-2",
        toolName: "WriteFile",
        arguments: {
          file_path: this.apiDocsPath,
          content: [
            "---",
            "name: api-docs",
            "description: api reference link",
            "type: reference",
            "---",
            "See https://example.com/api",
          ].join("\n"),
        },
      };
      yield { type: "stream_end", stopReason: "tool_use", usage };
      return;
    }
    yield { type: "text_delta", text: "All memories saved." };
    yield { type: "stream_end", stopReason: "end_turn", usage };
  }
}

describe("MemoryExtractor", () => {
  it("parses memory blocks and routes project/reference memories to the project dir", async () => {
    // Only project-scoped types so the test writes into the temp workDir,
    // never the real home directory.
    const workDir = mkdtempSync(join(tmpdir(), "mewcode-mem-"));
    const memDir = join(workDir, ".mewcode", "memory");
    const mock = new ToolCallingMockClient(
      join(memDir, "build-cmd.md"),
      join(memDir, "api-docs.md")
    );
    const saved = await new MemoryExtractor(mock, workDir).extract("conversation");

    expect(saved.sort()).toEqual(["api-docs", "build-cmd"]);

    expect(existsSync(join(memDir, "build-cmd.md"))).toBe(true);
    expect(existsSync(join(memDir, "api-docs.md"))).toBe(true);
    const file = readFileSync(join(memDir, "build-cmd.md"), "utf-8");
    expect(file).toContain("name: build-cmd");
    expect(file).toContain("type: project");
    expect(file).toContain("Run bun run build.");

    const index = readFileSync(join(memDir, "MEMORY.md"), "utf-8");
    expect(index).toContain("build-cmd");
    expect(index).toContain("api-docs");
  });

  it("returns nothing when the model says NONE", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "mewcode-mem-"));
    const saved = await new MemoryExtractor(new MockClient("NONE"), workDir).extract("conversation");
    expect(saved).toEqual([]);
  });
});
