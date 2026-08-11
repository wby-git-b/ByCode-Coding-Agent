// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import type { LLMClient } from "../llm/client.js";
import { ConversationManager } from "../conversation/conversation.js";
import type { Message } from "../conversation/conversation.js";
import type { RecoveryState } from "./recovery.js";
import type { CompactBoundaryPayload } from "../session/session.js";
import { getSessionFilePath } from "../session/session.js";

// Structured outcome of a compaction. When `compacted` is true, `boundary`
// carries the summary plus the verbatim kept tail (inlined as role+text) so the
// caller that owns the sessionId can persist a compact_boundary record. The
// kept tail is flattened to text here — the same text-only shape the session
// .jsonl already uses — which is exactly what resume needs to replay.
export interface CompactResult {
  compacted: boolean;
  message: string;
  boundary?: CompactBoundaryPayload;
}

// Legacy ratio threshold, kept for reference. The live judgment below uses the
// token-budget formula aligned with Claude Code's autoCompact.ts: reserve room
// for the summary output, then leave a safety margin before the window fills.
const AUTO_COMPACT_THRESHOLD = 0.8;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_PTL_RETRIES = 3;
const PTL_RETRY_MARKER = "[earlier conversation truncated for compaction retry]";
const CHARS_PER_TOKEN = 3.5;

// Recent-history retention for compaction, aligned with Claude Code's
// buildPostCompactMessages messagesToKeep. When we compact we keep the tail of
// the transcript verbatim instead of collapsing everything into a summary, so
// the model still sees the literal recent exchange (not just a paraphrase).
//   KEEP_RECENT_TOKENS — lower bound: walk back from the tail until the kept
//     tail reaches at least this many tokens (one of two "good enough" stops).
//   MIN_KEEP_MESSAGES — floor: keep at least this many recent messages even if
//     they are short (the other "good enough" stop).
//   KEEP_MAX_TOKENS — upper bound: never let the kept tail exceed this; stop
//     walking back once adding the next message would cross it.
const KEEP_RECENT_TOKENS = 10000;
const MIN_KEEP_MESSAGES = 5;
const KEEP_MAX_TOKENS = 40000;

// If fewer than this many messages would be summarized (everything else is in
// the kept tail), skip compaction entirely — the savings aren't worth the
// summary round-trip and the lost cache. Degenerate-case guard for step 5.
const MIN_COMPACT_PREFIX = 2;

const SUMMARY_OUTPUT_RESERVE = 20000;
const AUTO_COMPACT_SAFETY_MARGIN = 13000;
const MANUAL_COMPACT_SAFETY_MARGIN = 3000;

// effectiveWindow = contextWindow − min(model maxOutput, SUMMARY_OUTPUT_RESERVE).
// Auto-compact triggers at effectiveWindow − AUTO margin; once token usage crosses
// effectiveWindow − MANUAL margin (the hard block line) we must force a compaction.
export function computeCompactThreshold(
  contextWindow: number,
  maxOutput: number,
  manual = false
): number {
  const effective = contextWindow - Math.min(maxOutput, SUMMARY_OUTPUT_RESERVE);
  const margin = manual ? MANUAL_COMPACT_SAFETY_MARGIN : AUTO_COMPACT_SAFETY_MARGIN;
  return effective - margin;
}

export class AutoCompactTrackingState {
  consecutiveFailures = 0;
}

// Real-token anchor captured after each stream ends. Mirrors Claude Code's
// tokenCountWithEstimation: instead of re-estimating the whole transcript from
// characters every turn, we pin the last API-reported context size
// (input + cache_read + cache_creation + output) and the message count at that
// moment, then only character-estimate the messages appended afterwards.
export interface UsageAnchor {
  // input + cache_read + cache_creation + output from the last real API usage.
  baselineTokens: number;
  // conversation.len() at the moment the anchor was recorded; only messages
  // beyond this index are estimated incrementally.
  anchorCount: number;
}

// Rough character-based token estimate over an explicit message slice. Used both
// for the cold-start whole-transcript fallback and the post-anchor increment.
export function estimateMessages(messages: Message[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    totalChars += msg.content.length;
    if (msg.toolUses) {
      totalChars += JSON.stringify(msg.toolUses).length;
    }
    if (msg.toolResults) {
      for (const tr of msg.toolResults) {
        totalChars += tr.content.length;
      }
    }
    if (msg.thinkingBlocks) {
      for (const tb of msg.thinkingBlocks) {
        totalChars += tb.thinking.length;
      }
    }
  }
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

export function estimateTokens(conv: ConversationManager): number {
  return estimateMessages(conv.getMessages());
}

// Single-message token estimate, reusing the same char/3.5 heuristic as the
// slice estimator so the keep-walk and the context judgment agree.
function estimateOne(msg: Message): number {
  return estimateMessages([msg]);
}

// A user message carrying tool_result blocks is the second half of a
// tool_use↔tool_result pair; its partner tool_use lives on a preceding
// assistant message. We must never keep such a message without its tool_use.
function hasToolResult(msg: Message): boolean {
  return msg.role === "user" && !!msg.toolResults && msg.toolResults.length > 0;
}

// Choose where the kept (verbatim) tail begins. Walk backward from the end
// accumulating per-message tokens until we hit a "good enough" stop — either
// the kept tail reached KEEP_RECENT_TOKENS or we've kept MIN_KEEP_MESSAGES
// messages (whichever comes first is fine, each is a floor) — but never let the
// tail exceed KEEP_MAX_TOKENS (stop before crossing it). Returns the index of
// the first kept message. Mirrors Claude Code's messagesToKeep selection.
export function computeKeepStartIndex(messages: Message[]): number {
  let keepTokens = 0;
  let keepCount = 0;
  let keepStart = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateOne(messages[i]);
    // Upper bound: adding this message would overflow the kept tail. Stop and
    // leave it out (it belongs to the summarized prefix instead).
    if (keepCount > 0 && keepTokens + t > KEEP_MAX_TOKENS) {
      break;
    }
    keepStart = i;
    keepTokens += t;
    keepCount++;
    // Lower bounds: either floor satisfied → we've kept enough recent context.
    if (keepTokens >= KEEP_RECENT_TOKENS || keepCount >= MIN_KEEP_MESSAGES) {
      break;
    }
  }

  // Don't split a tool_use↔tool_result pair: if the boundary lands on a
  // tool_result user message, move it back past the matching tool_use assistant
  // message so the pair stays whole (better to keep one extra pair than to
  // leave an orphaned tool_result with no originating tool_use).
  keepStart = backUpPastToolUse(messages, keepStart);
  return keepStart;
}

// If messages[keepStart] is a tool_result user message, walk back to include
// the assistant tool_use message that produced its tool_use_id(s). Keeps the
// pair intact; idempotent when the boundary is already clean.
function backUpPastToolUse(messages: Message[], keepStart: number): number {
  if (keepStart <= 0 || keepStart >= messages.length) return keepStart;
  if (!hasToolResult(messages[keepStart])) return keepStart;

  const ids = new Set(
    (messages[keepStart].toolResults ?? []).map((tr) => tr.toolUseId)
  );
  for (let i = keepStart - 1; i >= 0; i--) {
    const m = messages[i];
    if (
      m.role === "assistant" &&
      m.toolUses &&
      m.toolUses.some((tu) => ids.has(tu.toolUseId))
    ) {
      return i;
    }
  }
  // No matching tool_use found (shouldn't happen for well-formed transcripts);
  // leave keepStart unchanged rather than dropping the whole prefix.
  return keepStart;
}

// Current context size used for the compact judgment. With a real usage anchor
// we trust the last API-reported token count and only character-estimate the
// messages appended after it (baseline + increment). On a cold start (no anchor
// yet) we fall back to estimating the entire transcript so the very first turn
// still works. Mirrors CC tokenCountWithEstimation and the python last_input
// simplification, extended with cache tokens for a more accurate baseline.
export function currentContextTokens(
  conv: ConversationManager,
  anchor: UsageAnchor | null,
  budgetMessages?: Message[]
): number {
  // 对齐 Claude Code：当调用方提供了 budget-applied 消息列表时，用它来估算
  // token 数，这样 auto-compact 的判断基于缩减后的实际大小而非原始大小。
  if (budgetMessages && budgetMessages.length > 0) {
    if (!anchor) {
      return estimateMessages(budgetMessages);
    }
    const start = Math.min(anchor.anchorCount, budgetMessages.length);
    return anchor.baselineTokens + estimateMessages(budgetMessages.slice(start));
  }
  if (!anchor) {
    return estimateTokens(conv);
  }
  const messages = conv.getMessages();
  // Clamp in case the transcript was truncated (e.g. by a compaction) below the
  // anchor index — then nothing new to add on top of the baseline.
  const start = Math.min(anchor.anchorCount, messages.length);
  return anchor.baselineTokens + estimateMessages(messages.slice(start));
}

export async function manageContext(
  conv: ConversationManager,
  client: LLMClient,
  contextWindow: number,
  maxOutput: number,
  trackingState: AutoCompactTrackingState,
  recoveryState: RecoveryState | null,
  toolSchemaNames: string[],
  toolSchemas: Record<string, unknown>[],
  anchor: UsageAnchor | null = null,
  sessionFilePath: string = "",
  budgetMessages?: Message[]
): Promise<CompactResult> {
  // 对齐 Claude Code：先应用 tool-result budget，再做 auto-compact
  // 当调用方提供了 budget-applied 消息列表时，用它来估算 token 数，
  // 这样 compact 判断基于缩减后的实际大小。
  const tokens = currentContextTokens(conv, anchor, budgetMessages);
  const autoThreshold = computeCompactThreshold(contextWindow, maxOutput);
  const hardBlock = computeCompactThreshold(contextWindow, maxOutput, true);

  if (tokens < autoThreshold) {
    return { compacted: false, message: "" };
  }

  // Past the hard-block line we must compact even if the circuit breaker tripped.
  const forced = tokens >= hardBlock;
  if (!forced && trackingState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return {
      compacted: false,
      message: `Auto-compact circuit breaker: ${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
    };
  }

  try {
    const result = await doCompact(conv, client, recoveryState, toolSchemaNames, toolSchemas, sessionFilePath, budgetMessages);
    trackingState.consecutiveFailures = 0;
    return result;
  } catch (err) {
    trackingState.consecutiveFailures++;
    return {
      compacted: false,
      message: `Auto-compact failed: ${(err as Error).message}`,
    };
  }
}

export async function forceCompact(
  conv: ConversationManager,
  client: LLMClient,
  recoveryState: RecoveryState | null,
  toolSchemaNames: string[],
  toolSchemas: Record<string, unknown>[],
  sessionFilePath: string = "",
  budgetMessages?: Message[]
): Promise<CompactResult> {
  return doCompact(conv, client, recoveryState, toolSchemaNames, toolSchemas, sessionFilePath, budgetMessages);
}

// 压缩摘要的系统提示词，对齐 Claude Code 的完整 9 段式结构。
// 采用 analysis/summary 两阶段：<analysis> 是草稿区，帮助模型整理思路；
// <summary> 是最终输出，只有这部分会被保留到上下文中。
const SUMMARY_SYSTEM_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

After your analysis, output your final summary wrapped in <summary> tags. Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.`;

// 拼装完整的摘要请求消息：系统提示 + 对话原文
function buildSummaryPrompt(conversationText: string): string {
  return SUMMARY_SYSTEM_PROMPT + "\n\n" + conversationText;
}

/** 按 API 轮次分组：每个助手新回复开始一个新组 */
function groupMessagesByAPIRound(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  let current: Message[] = [];
  let prevHadToolResult = false;

  for (const m of messages) {
    if (m.role === "assistant" && prevHadToolResult && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(m);
    prevHadToolResult = !!(m.toolResults && m.toolResults.length > 0);
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

/** 从最老的 API 轮次组开始丢弃，直到腾出足够 token */
function truncateHeadForPTL(prefix: Message[], tokenGap: number): Message[] | null {
  const groups = groupMessagesByAPIRound(prefix);
  if (groups.length < 2) return null;

  let dropCount: number;
  if (tokenGap > 0) {
    let acc = 0;
    dropCount = 0;
    for (const g of groups) {
      acc += g.reduce((sum, m) => sum + estimateOne(m), 0);
      dropCount++;
      if (acc >= tokenGap) break;
    }
  } else {
    dropCount = Math.max(1, Math.floor(groups.length / 5));
  }

  dropCount = Math.min(dropCount, groups.length - 1);
  if (dropCount < 1) return null;

  const result = groups.slice(dropCount).flat();
  if (result.length > 0 && result[0].role !== "user") {
    result.unshift({ role: "user", content: PTL_RETRY_MARKER } as Message);
  }
  return result;
}

/** 序列化前缀消息为文本 */
function serializePrefixText(messages: Message[]): string {
  return messages
    .map((m) => {
      let text = `[${m.role}]: ${m.content}`;
      if (m.toolUses) {
        text += `\n[tools: ${m.toolUses.map((t) => t.toolName).join(", ")}]`;
      }
      return text;
    })
    .join("\n\n");
}

/** 带 PTL 重试的摘要生成 */
async function requestSummaryWithPTLRetry(
  client: LLMClient,
  prefix: Message[],
  toolSchemas: Record<string, unknown>[]
): Promise<string> {
  let currentPrefix = prefix;
  for (let attempt = 0; ; attempt++) {
    const text = serializePrefixText(currentPrefix);
    const summaryConv = new ConversationManager();
    summaryConv.addUserMessage(buildSummaryPrompt(text));

    try {
      let summaryText = "";
      const stream = client.stream(summaryConv, toolSchemas);
      for await (const event of stream) {
        if (event.type === "text_delta") {
          summaryText += event.text;
        }
      }
      const match = summaryText.match(/<summary>([\s\S]*?)<\/summary>/);
      return match ? match[1].trim() : summaryText;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message.toLowerCase() : "";
      const isPTL =
        (msg.includes("prompt") && msg.includes("long")) ||
        msg.includes("too many") ||
        msg.includes("context_length");
      if (!isPTL || attempt >= MAX_PTL_RETRIES) {
        throw e;
      }
      const tokenGap = currentPrefix.reduce((sum, m) => sum + estimateOne(m), 0) / 5;
      const truncated = truncateHeadForPTL(currentPrefix, tokenGap);
      if (!truncated) {
        throw e;
      }
      currentPrefix = truncated;
    }
  }
}

async function doCompact(
  conv: ConversationManager,
  client: LLMClient,
  recoveryState: RecoveryState | null,
  toolSchemaNames: string[],
  toolSchemas: Record<string, unknown>[],
  sessionFilePath: string = "",
  budgetMessages?: Message[]
): Promise<CompactResult> {
  // 对齐 Claude Code：先应用 tool-result budget，再做 auto-compact
  // 当调用方提供了 budget-applied 消息列表时，用它来估算 token 和决定保留边界，
  // 这样 compact 的 keepStart 判断基于缩减后的实际 token 大小。
  const estimationMessages = (budgetMessages && budgetMessages.length > 0) ? budgetMessages : conv.getMessages();

  // Decide how much recent history to keep verbatim. Only messages[:keepStart]
  // get summarized; messages[keepStart:] are carried over untouched so the
  // model still sees the literal recent exchange.
  const keepStart = computeKeepStartIndex(estimationMessages);

  // Degenerate cases: if (almost) everything is already inside the kept tail,
  // compacting would only summarize a tiny prefix — "压了个寂寞". Skip it and
  // keep the conversation as-is rather than churn for no real token savings.
  if (keepStart <= 0 || keepStart < MIN_COMPACT_PREFIX) {
    return {
      compacted: false,
      message: `Compaction skipped: only ${keepStart} message(s) to summarize, kept verbatim`,
    };
  }

  const toSummarize = estimationMessages.slice(0, keepStart);
  const toKeep = estimationMessages.slice(keepStart);

  // 带 PTL 重试的摘要生成：摘要请求本身超出上下文窗口时，
  // 按 API 轮次从最老的开始丢弃，最多重试 MAX_PTL_RETRIES 次。
  const summary = await requestSummaryWithPTLRetry(client, toSummarize, toolSchemas);

  const recoveryAttachment = recoveryState
    ? recoveryState.buildRecoveryAttachment(toolSchemaNames)
    : "";

  // Rebuild: summary user message (Chinese framing, no assistant ack), then
  // the verbatim recent tail. The summary only covers messages[:keepStart].
  let summaryContent = "本次会话延续自之前的对话，因上下文空间不足进行了压缩。以下是早期对话的摘要：\n\n" + summary;
  if (toKeep.length > 0) {
    summaryContent += "\n\n近期消息已原样保留。";
  }
  if (sessionFilePath) {
    summaryContent += `\n\n如果你需要压缩前的具体细节（代码片段、报错信息等），请用 ReadFile 读取完整会话记录：${sessionFilePath}`;
  }
  if (recoveryAttachment) {
    summaryContent += `\n\n---\n\n${recoveryAttachment}`;
  }
  conv.replaceWithCompacted(summaryContent, toKeep);

  // Build the boundary payload the session owner will persist. We inline the
  // kept tail as role+text only (the session .jsonl never stores tool blocks),
  // dropping messages whose flattened text is empty (e.g. pure tool_result
  // user messages) — those carry no replayable text, matching how resume
  // already skips empty-content lines. The summary here is the bare summary
  // (no recovery attachment): recovery context is rebuilt fresh per process, so
  // baking it into the persisted boundary would be stale on the next resume.
  const keep = toKeep
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
    .map((m) => ({ role: m.role, content: m.content }));

  return {
    compacted: true,
    message: `Compacted ${toSummarize.length} messages into summary (${summary.length} chars), kept ${toKeep.length} recent messages verbatim`,
    boundary: { summary, keep },
  };
}
