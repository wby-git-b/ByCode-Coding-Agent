// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import type { ProviderConfig } from "../config/config.js";
import type { ConversationManager } from "../conversation/conversation.js";
import type { StreamEvent } from "./events.js";

export interface LLMClient {
  stream(
    conv: ConversationManager,
    tools: Record<string, unknown>[],
    abortSignal?: AbortSignal
  ): AsyncGenerator<StreamEvent>;

  setSystemPrompt(prompt: string): void;
}

export interface MaxTokensSetter {
  setMaxOutputTokens(tokens: number): void;
}

export async function createClient(
  cfg: ProviderConfig,
  systemPrompt: string
): Promise<LLMClient> {
  switch (cfg.protocol) {
    case "anthropic": {
      const { AnthropicClient } = await import("./anthropic.js");
      return new AnthropicClient(cfg, systemPrompt);
    }
    case "openai": {
      const { OpenAIClient } = await import("./openai.js");
      return new OpenAIClient(cfg, systemPrompt);
    }
    case "openai-compat": {
      const { OpenAICompatClient } = await import("./openai.js");
      return new OpenAICompatClient(cfg, systemPrompt);
    }
    default:
      throw new Error(`Unknown protocol: ${cfg.protocol}`);
  }
}
