// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  // Cache token counts from the API usage block. Anthropic reports these
  // directly; OpenAI/compat usually report 0 (or only cache_read via
  // prompt_tokens_details.cached_tokens). They anchor the compact judgment's
  // real-token baseline (input + cache_read + cache_creation + output).
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_complete"; thinking: string; signature: string }
  | { type: "tool_call_start"; toolName: string; toolId: string }
  | { type: "tool_call_delta"; text: string }
  | {
      type: "tool_call_complete";
      toolId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    }
  | { type: "stream_end"; stopReason: string; usage: UsageInfo };
