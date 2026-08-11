// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import Anthropic from "@anthropic-ai/sdk";
import type { ProviderConfig } from "../config/config.js";
import { getContextWindow, getMaxOutputTokens, resolveAPIKey } from "../config/config.js";
import type { ConversationManager } from "../conversation/conversation.js";
import type { Message } from "../conversation/conversation.js";
import type { StreamEvent } from "./events.js";
import type { LLMClient, MaxTokensSetter } from "./client.js";
import {
  AuthenticationError,
  ContextTooLongError,
  LLMError,
  NetworkError,
  RateLimitError,
} from "./errors.js";

// Auto-fetch the context window for an anthropic-protocol provider by hitting
// GET {base_url}/v1/models/{model} and reading ModelInfo.max_input_tokens.
//
// This is layer 2 of the context-window fallback chain. It MUST be best-effort:
// any failure (network error, non-200, missing field, timeout, non-anthropic
// endpoint that doesn't speak this API) silently returns 0 so the caller can
// degrade to the built-in table / default. It never throws and never blocks
// startup beyond a short timeout.
const MODEL_FETCH_TIMEOUT_MS = 3000;

export async function fetchModelContextWindow(
  cfg: ProviderConfig
): Promise<number> {
  if (cfg.protocol !== "anthropic") return 0;
  const apiKey = resolveAPIKey(cfg);
  const base = cfg.base_url.replace(/\/+$/, "");
  const url = `${base}/v1/models/${encodeURIComponent(cfg.model)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "anthropic-version": "2023-06-01",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) return 0;
    const body = (await res.json()) as { max_input_tokens?: number | null };
    const window = body?.max_input_tokens;
    return typeof window === "number" && window > 0 ? window : 0;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

function supportsAdaptiveThinking(model: string): boolean {
  for (const family of ["claude-opus-4-", "claude-sonnet-4-"]) {
    if (model.startsWith(family)) {
      const rest = model.slice(family.length);
      if (rest.length > 0 && rest[0] >= "6" && rest[0] <= "9") {
        return true;
      }
    }
  }
  return false;
}

export class AnthropicClient implements LLMClient, MaxTokensSetter {
  private client: Anthropic;
  private model: string;
  private thinking: boolean;
  private systemPrompt: string;
  private maxOutputTokens: number;
  private contextWindow: number;

  constructor(cfg: ProviderConfig, systemPrompt: string) {
    const apiKey = resolveAPIKey(cfg);
    if (!apiKey) {
      throw new AuthenticationError(
        "Anthropic API key not found. Set it in .mewcode/config.yaml or via ANTHROPIC_API_KEY env var."
      );
    }

    this.client = new Anthropic({
      apiKey,
      baseURL: cfg.base_url,
    });
    this.model = cfg.model;
    this.thinking = cfg.thinking ?? false;
    this.systemPrompt = systemPrompt;
    this.maxOutputTokens = getMaxOutputTokens(cfg);
    this.contextWindow = getContextWindow(cfg);
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
    const messages = buildAnthropicMessages(conv.getMessages());

    const tools: Anthropic.Tool[] = toolSchemas.map((s) => {
      const inputSchema = s.input_schema as Record<string, unknown> | undefined;
      return {
        name: s.name as string,
        description: (s.description as string) ?? "",
        input_schema: {
          type: "object" as const,
          properties: (inputSchema?.properties as Record<string, unknown>) ?? {},
          required: (inputSchema?.required as string[]) ?? [],
        },
      };
    });

    // Mark last tool for cache control
    if (tools.length > 0) {
      (tools[tools.length - 1] as unknown as Record<string, unknown>).cache_control = {
        type: "ephemeral",
      };
    }

    // Mark last user message tail for cache control
    markLastUserTailForCache(messages);

    const params: Anthropic.MessageCreateParamsStreaming = {
      model: this.model,
      max_tokens: this.maxOutputTokens,
      stream: true,
      system: [
        {
          type: "text",
          text: this.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
      ...(tools.length > 0 ? { tools } : {}),
    };

    if (this.thinking) {
      if (supportsAdaptiveThinking(this.model)) {
        (params as unknown as Record<string, unknown>).thinking = {
          type: "enabled",
          budget_tokens: this.maxOutputTokens - 1,
        };
      } else {
        (params as unknown as Record<string, unknown>).thinking = {
          type: "enabled",
          budget_tokens: this.maxOutputTokens - 1,
        };
      }
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadInputTokens = 0;
    let cacheCreationInputTokens = 0;
    let stopReason = "end_turn";

    let currentToolName = "";
    let currentToolId = "";
    let jsonAccum = "";
    let thinkingAccum = "";
    let thinkingSignature = "";
    let inThinking = false;

    try {
      const response = this.client.messages.stream(params, {
        ...(abortSignal ? { signal: abortSignal } : {}),
      });

      for await (const event of response) {
        switch (event.type) {
          case "content_block_start": {
            const block = event.content_block;
            if (block.type === "thinking") {
              inThinking = true;
              thinkingAccum = "";
              thinkingSignature = "";
            } else if (block.type === "tool_use") {
              currentToolName = block.name;
              currentToolId = block.id;
              jsonAccum = "";
              yield { type: "tool_call_start", toolName: currentToolName, toolId: currentToolId };
            }
            break;
          }

          case "content_block_delta": {
            const delta = event.delta;
            if (delta.type === "thinking_delta") {
              thinkingAccum += delta.thinking;
              yield { type: "thinking_delta", text: delta.thinking };
            } else if (delta.type === "signature_delta") {
              thinkingSignature = delta.signature;
            } else if (delta.type === "text_delta") {
              yield { type: "text_delta", text: delta.text };
            } else if (delta.type === "input_json_delta") {
              jsonAccum += delta.partial_json;
              yield { type: "tool_call_delta", text: delta.partial_json };
            }
            break;
          }

          case "content_block_stop": {
            if (inThinking) {
              yield {
                type: "thinking_complete",
                thinking: thinkingAccum,
                signature: thinkingSignature,
              };
              inThinking = false;
            }
            if (currentToolName) {
              let args: Record<string, unknown> = {};
              if (jsonAccum) {
                try {
                  args = JSON.parse(jsonAccum);
                } catch {
                  args = {};
                }
              }
              yield {
                type: "tool_call_complete",
                toolId: currentToolId,
                toolName: currentToolName,
                arguments: args,
              };
              currentToolName = "";
              currentToolId = "";
              jsonAccum = "";
            }
            break;
          }

          case "message_delta": {
            if (event.delta.stop_reason) {
              stopReason = event.delta.stop_reason;
            }
            if (event.usage) {
              outputTokens = event.usage.output_tokens;
              if ((event.usage as any).input_tokens) {
                inputTokens = (event.usage as any).input_tokens;
              }
              if ((event.usage as any).cache_read_input_tokens) {
                cacheReadInputTokens = (event.usage as any).cache_read_input_tokens;
              }
              if ((event.usage as any).cache_creation_input_tokens) {
                cacheCreationInputTokens = (event.usage as any).cache_creation_input_tokens;
              }
            }
            break;
          }

          case "message_start": {
            if (event.message.usage) {
              inputTokens = event.message.usage.input_tokens;
              outputTokens = event.message.usage.output_tokens;
              cacheReadInputTokens =
                event.message.usage.cache_read_input_tokens ?? 0;
              cacheCreationInputTokens =
                event.message.usage.cache_creation_input_tokens ?? 0;
            }
            break;
          }
        }
      }

      yield {
        type: "stream_end",
        stopReason,
        usage: {
          inputTokens,
          outputTokens,
          cacheReadInputTokens,
          cacheCreationInputTokens,
        },
      };
    } catch (err) {
      throw classifyAnthropicError(err);
    }
  }
}

function markLastUserTailForCache(
  messages: Anthropic.MessageParam[]
): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const content = messages[i].content;
    if (!Array.isArray(content) || content.length === 0) return;
    const last = content[content.length - 1] as unknown as Record<string, unknown>;
    last.cache_control = { type: "ephemeral" };
    return;
  }
}

export function buildAnthropicMessages(
  messages: Message[]
): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const m of messages) {
    if (m.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.thinkingBlocks) {
        for (const tb of m.thinkingBlocks) {
          blocks.push({
            type: "thinking",
            thinking: tb.thinking,
            signature: tb.signature,
          });
        }
      }
      if (m.content) {
        blocks.push({ type: "text", text: m.content });
      }
      if (m.toolUses) {
        for (const tu of m.toolUses) {
          blocks.push({
            type: "tool_use",
            id: tu.toolUseId,
            name: tu.toolName,
            input: tu.arguments,
          });
        }
      }
      if (blocks.length === 0) {
        blocks.push({ type: "text", text: "" });
      }
      result.push({ role: "assistant", content: blocks });
    } else if (m.toolResults && m.toolResults.length > 0) {
      const blocks: Anthropic.ToolResultBlockParam[] = [];
      for (const tr of m.toolResults) {
        blocks.push({
          type: "tool_result",
          tool_use_id: tr.toolUseId,
          is_error: tr.isError,
          content: tr.content,
        });
      }
      result.push({ role: "user", content: blocks });
    } else {
      // Merge consecutive user text messages to maintain alternation.
      // After compaction the summary (user) may be followed by kept user
      // messages with no intervening assistant turn. The Anthropic API
      // requires strict user/assistant alternation, so we merge them into
      // a single user entry with multiple text blocks. Only merge when the
      // previous entry is a plain-text user (not a tool_result user).
      let canMerge = false;
      if (result.length > 0) {
        const prev = result[result.length - 1];
        if (
          prev.role === "user" &&
          Array.isArray(prev.content) &&
          prev.content.length > 0 &&
          (prev.content[0] as unknown as Record<string, unknown>).type !== "tool_result"
        ) {
          canMerge = true;
        }
      }
      if (canMerge) {
        (result[result.length - 1].content as Anthropic.TextBlockParam[]).push({
          type: "text",
          text: m.content,
        });
      } else {
        result.push({
          role: "user",
          content: [{ type: "text", text: m.content }],
        });
      }
    }
  }

  return result;
}

function classifyAnthropicError(err: unknown): Error {
  if (err instanceof Anthropic.APIError) {
    if (
      err.status === 413 ||
      err.message?.includes("prompt is too long")
    ) {
      return new ContextTooLongError(`Context too long: ${err.message}`);
    }
    if (err.status === 401) {
      return new AuthenticationError(`Invalid API key: ${err.message}`);
    }
    if (err.status === 429) {
      const retryAfter = (err.headers as Record<string, string>)?.["retry-after"];
      let msg = "Rate limited.";
      if (retryAfter) {
        msg += ` Retry after ${retryAfter}s.`;
      } else {
        msg += " Please wait.";
      }
      return new RateLimitError(msg, retryAfter);
    }
    return new LLMError(`API error (${err.status}): ${err.message}`);
  }
  return new NetworkError(`Network error: ${String(err)}`);
}
