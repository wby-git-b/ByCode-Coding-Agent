import { describe, it, expect } from "bun:test";
import { buildChatCompletionMessages } from "../src/llm/openai.js";
import type { Message } from "../src/conversation/conversation.js";

describe("openai-compat chat message building", () => {
  it("preserves assistant tool_calls and tool-result turns", () => {
    const history: Message[] = [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: "",
        toolUses: [{ toolUseId: "c1", toolName: "Bash", arguments: { command: "ls" } }],
      },
      { role: "user", content: "", toolResults: [{ toolUseId: "c1", content: "a.txt", isError: false }] },
      { role: "assistant", content: "Found a.txt" },
    ];

    const msgs = buildChatCompletionMessages(history);

    const assistantWithTools = msgs.find(
      (m) => m.role === "assistant" && "tool_calls" in m && m.tool_calls
    ) as { tool_calls: { id: string; function: { name: string; arguments: string } }[] };
    expect(assistantWithTools).toBeDefined();
    expect(assistantWithTools.tool_calls[0].id).toBe("c1");
    expect(assistantWithTools.tool_calls[0].function.name).toBe("Bash");
    expect(JSON.parse(assistantWithTools.tool_calls[0].function.arguments)).toEqual({ command: "ls" });

    const toolMsg = msgs.find((m) => m.role === "tool") as { tool_call_id: string; content: string };
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe("c1");
    expect(toolMsg.content).toBe("a.txt");

    // The plain user + final assistant turns survive too.
    expect(msgs.some((m) => m.role === "user" && m.content === "list files")).toBe(true);
    expect(msgs.some((m) => m.role === "assistant" && m.content === "Found a.txt")).toBe(true);
  });
});
