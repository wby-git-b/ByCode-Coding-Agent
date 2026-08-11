import { describe, it, expect } from "bun:test";
import { Agent } from "../src/agent/agent.js";
import { ConversationManager } from "../src/conversation/conversation.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { PermissionChecker } from "../src/permissions/checker.js";
import { HookEngine } from "../src/hooks/hooks.js";
import type { LLMClient } from "../src/llm/client.js";
import type { StreamEvent, UsageInfo } from "../src/llm/events.js";
import type { Tool } from "../src/tools/types.js";
import type { AgentEvent } from "../src/agent/events.js";

const USAGE: UsageInfo = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
const end = (reason = "end_turn"): StreamEvent => ({ type: "stream_end", stopReason: reason, usage: USAGE });

class MockClient implements LLMClient {
  calls = 0;
  maxTokensSet: number | null = null;
  constructor(private scripts: StreamEvent[][]) {}
  async *stream(): AsyncGenerator<StreamEvent> {
    const script = this.scripts[this.calls++] ?? [end()];
    for (const ev of script) yield ev;
  }
  setMaxOutputTokens(n: number): void {
    this.maxTokensSet = n;
  }
}

const echoTool: Tool = {
  name: "Echo",
  description: "echo",
  category: "read",
  schema: () => ({ name: "Echo", description: "echo", input_schema: { type: "object", properties: {} } }),
  execute: async () => ({ output: "echoed", isError: false }),
};

async function runAgent(
  client: LLMClient,
  opts: { tool?: Tool; hookEngine?: HookEngine } = {}
): Promise<{ events: AgentEvent[]; conv: ConversationManager }> {
  const conv = new ConversationManager();
  conv.addUserMessage("hi");
  const registry = new ToolRegistry();
  if (opts.tool) registry.register(opts.tool);
  const agent = new Agent({
    client,
    registry,
    checker: new PermissionChecker(process.cwd(), "bypassPermissions"),
    conversation: conv,
    workDir: process.cwd(),
    hookEngine: opts.hookEngine,
  });
  const events: AgentEvent[] = [];
  for await (const e of agent.run()) events.push(e);
  return { events, conv };
}

describe("Agent loop", () => {
  it("streams text and completes on end_turn", async () => {
    const client = new MockClient([[{ type: "text_delta", text: "hello" }, end()]]);
    const { events, conv } = await runAgent(client);

    expect(events.some((e) => e.type === "stream_text" && e.text === "hello")).toBe(true);
    const lc = events.find((e) => e.type === "loop_complete");
    expect(lc && lc.type === "loop_complete" && lc.stopReason).toBe("end_turn");

    const last = conv.getMessages().at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.content).toBe("hello");
  });

  it("executes a tool turn then completes", async () => {
    const client = new MockClient([
      [{ type: "tool_call_complete", toolId: "t1", toolName: "Echo", arguments: {} }, end("tool_use")],
      [{ type: "text_delta", text: "done" }, end()],
    ]);
    const { events } = await runAgent(client, { tool: echoTool });

    expect(events.some((e) => e.type === "tool_use" && e.toolName === "Echo")).toBe(true);
    const tr = events.find((e) => e.type === "tool_result");
    expect(tr && tr.type === "tool_result" && tr.output).toBe("echoed");
    expect(tr && tr.type === "tool_result" && tr.isError).toBe(false);
    expect(events.some((e) => e.type === "turn_complete")).toBe(true);
    expect(events.some((e) => e.type === "loop_complete")).toBe(true);
  });

  it("escalates output ceiling and retries on max_tokens", async () => {
    const client = new MockClient([
      [{ type: "text_delta", text: "partial" }, end("max_tokens")],
      [{ type: "text_delta", text: " done" }, end()],
    ]);
    const { events } = await runAgent(client);

    expect(events.some((e) => e.type === "retry" && e.reason.includes("max_tokens"))).toBe(true);
    expect(client.maxTokensSet).toBe(64000);
    expect(events.some((e) => e.type === "loop_complete")).toBe(true);
  });

  it("aborts after 3 consecutive unknown tool calls", async () => {
    const unknownTurn = (id: string): StreamEvent[] => [
      { type: "tool_call_complete", toolId: id, toolName: "Nope", arguments: {} },
      end("tool_use"),
    ];
    const client = new MockClient([unknownTurn("x1"), unknownTurn("x2"), unknownTurn("x3"), unknownTurn("x4")]);
    const { events } = await runAgent(client); // no Echo registered → Nope is unknown

    const err = events.find((e) => e.type === "error");
    expect(err && err.type === "error" && err.error.message).toContain("unknown tool calls");
  });

  it("propagates cache token fields from stream_end through the usage event", async () => {
    const usageWithCache: UsageInfo = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 200,
    };
    const client = new MockClient([
      [
        { type: "text_delta", text: "hi" },
        { type: "stream_end", stopReason: "end_turn", usage: usageWithCache },
      ],
    ]);
    const { events } = await runAgent(client);

    const usage = events.find((e) => e.type === "usage");
    expect(usage && usage.type === "usage" && usage.usage.cacheReadInputTokens).toBe(1000);
    expect(usage && usage.type === "usage" && usage.usage.cacheCreationInputTokens).toBe(200);
  });

  it("surfaces lifecycle-hook output as a system reminder on the next turn", async () => {
    const hookEngine = new HookEngine([
      { event: "turn_start", action: { type: "prompt", prompt: "REMINDER_NOTE" } },
    ]);
    const client = new MockClient([
      [{ type: "tool_call_complete", toolId: "t1", toolName: "Echo", arguments: {} }, end("tool_use")],
      [{ type: "text_delta", text: "done" }, end()],
    ]);
    const { conv } = await runAgent(client, { tool: echoTool, hookEngine });

    expect(conv.getMessages().some((m) => m.content.includes("REMINDER_NOTE"))).toBe(true);
  });
});
