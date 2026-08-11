// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import OpenAI from "openai";
import type { ProviderConfig } from "../config/config.js";
import { resolveAPIKey, getMaxOutputTokens } from "../config/config.js";
import type { ConversationManager, Message } from "../conversation/conversation.js";
import type { StreamEvent } from "./events.js";
import type { LLMClient, MaxTokensSetter } from "./client.js";
import { AuthenticationError, ContextTooLongError, LLMError, NetworkError, RateLimitError } from "./errors.js";

export class OpenAIClient implements LLMClient, MaxTokensSetter {
  private client: OpenAI;
  private model: string;
  private systemPrompt: string;
  private maxOutputTokens: number;

  constructor(cfg: ProviderConfig, systemPrompt: string) {
    const apiKey = resolveAPIKey(cfg);
    if (!apiKey) {
      throw new AuthenticationError(
        "OpenAI API key not found. Set it in config or via OPENAI_API_KEY env var."
      );
    }

    this.client = new OpenAI({ apiKey, baseURL: cfg.base_url });
    this.model = cfg.model;
    this.systemPrompt = systemPrompt;
    this.maxOutputTokens = getMaxOutputTokens(cfg);
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  setMaxOutputTokens(tokens: number): void {
    this.maxOutputTokens = tokens;
  }

  async *stream(
    conv: ConversationManager,
    toolSchemas: Record<string, unknown>[],
    abortSignal?: AbortSignal
  ): AsyncGenerator<StreamEvent> {
    const messages = buildOpenAIInput(conv.getMessages());

    const input: OpenAI.Responses.ResponseCreateParamsStreaming["input"] = [];
    input.push({ role: "system" as const, content: this.systemPrompt });
    for (const msg of messages) {
      input.push(msg as unknown as OpenAI.Responses.ResponseInputItem);
    }

    const tools: OpenAI.Responses.FunctionTool[] = toolSchemas.map((s) => {
      const schema = s.input_schema as Record<string, unknown>;
      return {
        type: "function" as const,
        name: s.name as string,
        description: (s.description as string) ?? "",
        parameters: schema,
        strict: false,
      };
    });

    const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
      model: this.model,
      input,
      stream: true,
      max_output_tokens: this.maxOutputTokens,
      ...(tools.length > 0 ? { tools } : {}),
    };

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadInputTokens = 0;

    try {
      const stream = await this.client.responses.create(params, {
        ...(abortSignal ? { signal: abortSignal } : {}),
      });

      let currentToolName = "";
      let currentToolId = "";
      let jsonAccum = "";
      let reasoningId = "";
      let reasoningText = "";

      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          yield { type: "text_delta", text: event.delta };
        } else if (event.type === "response.reasoning_summary_text.delta") {
          reasoningText += event.delta;
          yield { type: "thinking_delta", text: event.delta };
        } else if (event.type === "response.reasoning_summary_text.done") {
          yield { type: "thinking_complete", thinking: reasoningText, signature: reasoningId };
        } else if (event.type === "response.function_call_arguments.delta") {
          jsonAccum += event.delta;
          yield { type: "tool_call_delta", text: event.delta };
        } else if (event.type === "response.output_item.added") {
          if (event.item.type === "function_call") {
            currentToolName = event.item.name ?? "";
            currentToolId = event.item.call_id ?? "";
            jsonAccum = "";
            yield { type: "tool_call_start", toolName: currentToolName, toolId: currentToolId };
          } else if ((event.item as unknown as Record<string, unknown>).type === "reasoning") {
            reasoningId = (event.item as unknown as Record<string, unknown>).id as string ?? "";
            reasoningText = "";
          }
        } else if (event.type === "response.output_item.done") {
          if (event.item.type === "function_call" && currentToolName) {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(jsonAccum); } catch { args = {}; }
            yield { type: "tool_call_complete", toolId: currentToolId, toolName: currentToolName, arguments: args };
            currentToolName = "";
            currentToolId = "";
            jsonAccum = "";
          }
        } else if (event.type === "response.completed") {
          const usage = event.response.usage;
          if (usage) {
            outputTokens = usage.output_tokens ?? 0;
            // Responses API exposes the cached prefix via
            // input_tokens_details.cached_tokens; absent → 0. There is no
            // cache_creation concept here, so it stays 0.
            cacheReadInputTokens = usage.input_tokens_details?.cached_tokens ?? 0;
            // input_tokens already includes the cached prefix; subtract so the
            // usage anchor (input + cache_read) doesn't double-count it.
            inputTokens = Math.max(0, (usage.input_tokens ?? 0) - cacheReadInputTokens);
          }

          // Parse the actual stop reason from the Responses API. When the
          // response status is "incomplete", check incomplete_details.reason
          // for "max_output_tokens" so the agent loop's max_tokens recovery
          // can trigger. Otherwise default to "end_turn".
          let stopReason = "end_turn";
          const resp = event.response as unknown as Record<string, unknown>;
          if (resp.status === "incomplete") {
            const details = resp.incomplete_details as Record<string, unknown> | undefined;
            if (details?.reason === "max_output_tokens") {
              stopReason = "max_tokens";
            }
          }

          yield {
            type: "stream_end",
            stopReason,
            usage: {
              inputTokens,
              outputTokens,
              cacheReadInputTokens,
              cacheCreationInputTokens: 0,
            },
          };
        }
      }
    } catch (err) {
      throw classifyOpenAIError(err);
    }
  }
}

export class OpenAICompatClient implements LLMClient, MaxTokensSetter {
  private client: OpenAI;
  private model: string;
  private systemPrompt: string;
  private maxOutputTokens: number;

  constructor(cfg: ProviderConfig, systemPrompt: string) {
    const apiKey = resolveAPIKey(cfg);
    if (!apiKey) {
      throw new AuthenticationError("API key not found.");
    }

    this.client = new OpenAI({ apiKey, baseURL: cfg.base_url });
    this.model = cfg.model;
    this.systemPrompt = systemPrompt;
    this.maxOutputTokens = getMaxOutputTokens(cfg);
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  setMaxOutputTokens(tokens: number): void {
    this.maxOutputTokens = tokens;
  }

  async *stream(
    conv: ConversationManager,
    toolSchemas: Record<string, unknown>[],
    abortSignal?: AbortSignal
  ): AsyncGenerator<StreamEvent> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: this.systemPrompt },
      ...buildChatCompletionMessages(conv.getMessages()),
    ];

    const tools: OpenAI.ChatCompletionTool[] = toolSchemas.map((s) => ({
      type: "function" as const,
      function: {
        name: s.name as string,
        description: (s.description as string) ?? "",
        parameters: s.input_schema as Record<string, unknown>,
      },
    }));

    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: this.maxOutputTokens,
      ...(tools.length > 0 ? { tools } : {}),
    };

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadInputTokens = 0;

    try {
      const stream = await this.client.chat.completions.create(params, {
        ...(abortSignal ? { signal: abortSignal } : {}),
      });

      const toolCalls = new Map<number, { id: string; name: string; args: string }>();
      let finishReason: string | null = null;
      let reasoningAccum = "";

      for await (const chunk of stream) {
        // Usage may arrive in a trailing chunk with empty choices,
        // so check it before the delta guard.
        if (chunk.usage) {
          outputTokens = chunk.usage.completion_tokens ?? 0;
          cacheReadInputTokens =
            chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          inputTokens = Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cacheReadInputTokens);
        }

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          yield { type: "text_delta", text: delta.content };
        }

        // reasoning_content（DeepSeek/小米等 provider 的非标准字段）
        const rc = (delta as Record<string, unknown>).reasoning_content as string | undefined;
        if (rc) {
          reasoningAccum += rc;
          yield { type: "thinking_delta", text: rc };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCalls.has(tc.index)) {
              toolCalls.set(tc.index, {
                id: tc.id ?? "",
                name: tc.function?.name ?? "",
                args: "",
              });
              if (tc.id) {
                yield {
                  type: "tool_call_start",
                  toolName: tc.function?.name ?? "",
                  toolId: tc.id,
                };
              }
            }
            const existing = toolCalls.get(tc.index)!;
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) {
              existing.args += tc.function.arguments;
              yield { type: "tool_call_delta", text: tc.function.arguments };
            }
          }
        }

        if (chunk.choices?.[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
          if (reasoningAccum) {
            yield { type: "thinking_complete", thinking: reasoningAccum, signature: "" };
            reasoningAccum = "";
          }
          for (const [, tc] of toolCalls) {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.args); } catch { args = {}; }
            yield {
              type: "tool_call_complete",
              toolId: tc.id,
              toolName: tc.name,
              arguments: args,
            };
          }
        }
      }

      // Map Chat Completions finish_reason to our internal stop reason.
      // "length" means the model hit max_tokens; "tool_calls" means tool use;
      // "stop" (or anything else) means normal end_turn.
      let stopReason: string;
      if (finishReason === "length") {
        stopReason = "max_tokens";
      } else if (finishReason === "tool_calls" || toolCalls.size > 0) {
        stopReason = "tool_use";
      } else {
        stopReason = "end_turn";
      }
      yield {
        type: "stream_end",
        stopReason,
        usage: {
          inputTokens,
          outputTokens,
          cacheReadInputTokens,
          cacheCreationInputTokens: 0,
        },
      };
    } catch (err) {
      throw classifyOpenAIError(err);
    }
  }
}

function classifyOpenAIError(err: unknown): Error {
  if (err instanceof OpenAI.APIError) {
    if (err.status === 413 || (err.status === 400 && containsContextLengthError(err.message))) {
      return new ContextTooLongError(`Context too long: ${err.message}`);
    }
    if (err.status === 401) return new AuthenticationError(`Invalid API key: ${err.message}`);
    if (err.status === 429) return new RateLimitError("Rate limited. Please wait.");
    return new LLMError(`API error (${err.status}): ${err.message}`);
  }
  return new NetworkError(`Network error: ${String(err)}`);
}

function containsContextLengthError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("context_length_exceeded") ||
    lower.includes("maximum context length") ||
    lower.includes("prompt is too long")
  );
}

// Convert MewCode's conversation into Chat Completions messages, preserving
// assistant tool_calls and tool-result (role:"tool") turns so multi-turn tool
// use works over the openai-compat (Chat Completions) endpoint. Mirrors Go
// buildChatCompletionMessages.
export function buildChatCompletionMessages(
  history: Message[]
): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [];
  for (const m of history) {
    // 拼接 thinking blocks 为 reasoning_content（DeepSeek/小米等 provider 要求）
    const reasoning = m.thinkingBlocks?.map((tb) => tb.thinking).join("") ?? "";

    if (m.toolUses && m.toolUses.length > 0) {
      const msg: Record<string, unknown> = {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolUses.map((tu) => ({
          id: tu.toolUseId,
          type: "function" as const,
          function: { name: tu.toolName, arguments: JSON.stringify(tu.arguments) },
        })),
      };
      if (reasoning) msg.reasoning_content = reasoning;
      out.push(msg as unknown as OpenAI.ChatCompletionMessageParam);
    } else if (m.toolResults && m.toolResults.length > 0) {
      for (const tr of m.toolResults) {
        out.push({ role: "tool", tool_call_id: tr.toolUseId, content: tr.content });
      }
    } else if (m.role === "assistant") {
      const msg: Record<string, unknown> = { role: "assistant", content: m.content };
      if (reasoning) msg.reasoning_content = reasoning;
      out.push(msg as unknown as OpenAI.ChatCompletionMessageParam);
    } else {
      out.push({ role: m.role === "system" ? "system" : "user", content: m.content });
    }
  }
  return out;
}

// Convert MewCode's conversation into Responses API input items: assistant
// tool calls become function_call items and tool results become
// function_call_output items, so multi-turn tool use works over the Responses
// endpoint. Mirrors Go buildOpenAIInput.
export function buildOpenAIInput(history: Message[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const m of history) {
    // Thinking blocks 作为 reasoning item 回传（Responses API）
    if (m.thinkingBlocks) {
      for (const tb of m.thinkingBlocks) {
        result.push({
          type: "reasoning",
          id: tb.signature,
          summary: [{ type: "summary_text", text: tb.thinking }],
        });
      }
    }

    if (m.toolUses && m.toolUses.length > 0) {
      if (m.content) {
        result.push({ role: "assistant", content: m.content });
      }
      for (const tu of m.toolUses) {
        result.push({
          type: "function_call",
          name: tu.toolName,
          call_id: tu.toolUseId,
          arguments: JSON.stringify(tu.arguments),
        });
      }
    } else if (m.toolResults && m.toolResults.length > 0) {
      for (const tr of m.toolResults) {
        result.push({
          type: "function_call_output",
          call_id: tr.toolUseId,
          output: tr.content,
        });
      }
    } else {
      result.push({ role: m.role, content: m.content });
    }
  }
  return result;
}
