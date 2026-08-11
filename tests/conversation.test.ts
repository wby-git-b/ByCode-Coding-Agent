import { describe, it, expect } from "bun:test";
import { ConversationManager } from "../src/conversation/conversation.js";
import { buildAnthropicMessages } from "../src/llm/anthropic.js";
import { buildOpenAIInput } from "../src/llm/openai.js";

describe("ConversationManager", () => {
  it("adds and retrieves messages", () => {
    const mgr = new ConversationManager();
    mgr.addUserMessage("hello");
    mgr.addAssistantMessage("hi there");
    expect(mgr.len()).toBe(2);

    const msgs = mgr.getMessages();
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("hello");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toBe("hi there");
  });

  it("adds tool use and tool result messages", () => {
    const mgr = new ConversationManager();
    mgr.addToolUseMessage("let me read", "tu-1", "ReadFile", { file_path: "/test" });
    mgr.addToolResultMessage("tu-1", "file content here", false);

    const msgs = mgr.getMessages();
    expect(msgs[0].toolUses).toHaveLength(1);
    expect(msgs[0].toolUses![0].toolName).toBe("ReadFile");
    expect(msgs[1].toolResults).toHaveLength(1);
    expect(msgs[1].toolResults![0].content).toBe("file content here");
  });

  it("adds assistant full with thinking and tool uses", () => {
    const mgr = new ConversationManager();
    mgr.addAssistantFull(
      "response text",
      [{ thinking: "let me think...", signature: "sig1" }],
      [{ toolUseId: "tu-1", toolName: "Bash", arguments: { command: "ls" } }]
    );

    const msg = mgr.getMessages()[0];
    expect(msg.thinkingBlocks).toHaveLength(1);
    expect(msg.toolUses).toHaveLength(1);
  });

  it("truncates history", () => {
    const mgr = new ConversationManager();
    mgr.addUserMessage("1");
    mgr.addAssistantMessage("2");
    mgr.addUserMessage("3");
    mgr.truncateTo(1);
    expect(mgr.len()).toBe(1);
    expect(mgr.getMessages()[0].content).toBe("1");
  });

  it("injects long-term memory only once", () => {
    const mgr = new ConversationManager();
    mgr.addUserMessage("hello");
    mgr.injectLongTermMemory("# Instructions\nDo stuff", "");
    mgr.injectLongTermMemory("# Instructions\nDo stuff again", "");
    expect(mgr.len()).toBe(2); // original + injected, not 3
    expect(mgr.getMessages()[0].content).toContain("system-reminder");
  });

  describe("buildAnthropicMessages", () => {
    it("serializes tool use messages", () => {
      const mgr = new ConversationManager();
      mgr.addToolUseMessage("text", "tu-1", "Bash", { command: "ls" });
      const result = buildAnthropicMessages(mgr.getMessages());
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("assistant");
      const content = result[0].content as unknown as Record<string, unknown>[];
      expect(content).toHaveLength(2);
      expect(content[0].type).toBe("text");
      expect(content[1].type).toBe("tool_use");
    });

    it("serializes tool result messages", () => {
      const mgr = new ConversationManager();
      mgr.addToolResultMessage("tu-1", "output", false);
      const result = buildAnthropicMessages(mgr.getMessages());
      expect(result).toHaveLength(1);
      const content = result[0].content as unknown as Record<string, unknown>[];
      expect(content[0].type).toBe("tool_result");
      expect(content[0].tool_use_id).toBe("tu-1");
    });

    it("preserves signed thinking blocks at the head of the assistant message", () => {
      const mgr = new ConversationManager();
      mgr.addAssistantFull(
        "answer",
        [{ thinking: "let me think", signature: "sig-1" }],
        [{ toolUseId: "tu-1", toolName: "Bash", arguments: { command: "ls" } }]
      );
      const result = buildAnthropicMessages(mgr.getMessages());
      expect(result).toHaveLength(1);
      const content = result[0].content as unknown as Record<string, unknown>[];
      expect(content[0].type).toBe("thinking");
      expect(content[0].signature).toBe("sig-1");
      expect(content[content.length - 1].type).toBe("tool_use");
    });
  });

  describe("buildOpenAIInput", () => {
    it("serializes tool uses as function_call", () => {
      const mgr = new ConversationManager();
      mgr.addToolUseMessage("text", "tu-1", "Bash", { command: "ls" });
      const result = buildOpenAIInput(mgr.getMessages());
      expect(result).toHaveLength(2); // text msg + function_call
      expect(result[0].role).toBe("assistant");
      expect(result[1].type).toBe("function_call");
      expect(result[1].name).toBe("Bash");
      expect(result[1].arguments).toBe('{"command":"ls"}');
    });

    it("serializes tool results as function_call_output", () => {
      const mgr = new ConversationManager();
      mgr.addToolResultMessage("tu-1", "output", false);
      const result = buildOpenAIInput(mgr.getMessages());
      expect(result[0].type).toBe("function_call_output");
      expect(result[0].output).toBe("output");
    });
  });
});
