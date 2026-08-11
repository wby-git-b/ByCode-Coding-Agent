// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import type { ProviderConfig } from "../config/config.js";
import type { LLMClient } from "./client.js";
import { createClient } from "./client.js";

// Short aliases the model field of an agent definition may use. Unknown names
// pass through unchanged so a full model id still works. Mirrors Go modelAliases.
const MODEL_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6-20250514",
  opus: "claude-opus-4-6-20250514",
};

export function resolveModelId(shortName: string): string {
  return MODEL_ALIASES[shortName] ?? shortName;
}

// Returns a function that builds a client for a given short model name, reusing
// the base provider config (api key, base url, protocol) but swapping the model.
// Mirrors Go NewModelResolver.
export function createModelResolver(
  baseCfg: ProviderConfig,
  systemPrompt: string
): (shortName: string) => Promise<LLMClient> {
  return (shortName: string) =>
    createClient({ ...baseCfg, model: resolveModelId(shortName) }, systemPrompt);
}
