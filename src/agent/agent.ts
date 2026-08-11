// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import type { LLMClient, MaxTokensSetter } from "../llm/client.js";
import type { ConversationManager } from "../conversation/conversation.js";
import type { ToolUseBlock, ToolResultBlock } from "../conversation/conversation.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PermissionChecker, Decision } from "../permissions/checker.js";
import type { HookEngine, EventName } from "../hooks/hooks.js";
import type { FileHistory } from "../filehistory/filehistory.js";
import type { FileStateCache } from "../tools/file-state-cache.js";
import type { AgentEvent } from "./events.js";
import { StreamingExecutor } from "./streaming-executor.js";
import { manageContext, forceCompact, AutoCompactTrackingState } from "../compact/compact.js";
import { getSessionFilePath } from "../session/session.js";
import type { UsageAnchor } from "../compact/compact.js";
import { RecoveryState } from "../compact/recovery.js";
import { ContextTooLongError, RateLimitError } from "../llm/errors.js";
import { getOrCreatePlanPath, planExists } from "../planfile/planfile.js";
import { buildPlanModeReminder } from "../prompt/plan-mode.js";
import { applyBudget } from "../toolresult/budget.js";
import { readFile } from "node:fs/promises";

// When the model stops on max_tokens, escalate its output ceiling once to this
// value, then attempt a bounded number of multi-turn recoveries. Mirrors Go.
const MAX_TOKENS_CEILING = 64000;
const MAX_OUTPUT_TOKENS_RECOVERIES = 3;
// Hard per-result cap on tool output stored back into the conversation. The
// toolresult budget handles spilling separately; this is a final safety cap.
const MAX_OUTPUT_CHARS = 10000;

export interface AgentConfig {
  client: LLMClient;
  registry: ToolRegistry;
  checker: PermissionChecker;
  conversation: ConversationManager;
  workDir: string;
  sessionId?: string;
  hookEngine?: HookEngine;
  fileHistory?: FileHistory;
  fileStateCache?: FileStateCache;
  abortSignal?: AbortSignal;
  contextWindow?: number;
  maxOutput?: number;
  recoveryState?: RecoveryState;
  maxIterations?: number;
  notificationFn?: () => string[];
  onLoopComplete?: (conversation: ConversationManager) => void;
  activeSkills?: Map<string, string>;
  toolFilter?: (name: string) => boolean;
  // 项目指令和记忆内容，压缩后需要重新注入
  instructions?: string;
  memoryContent?: string;
  // 非阻塞 memory recall：prefetch promise 与主 LLM 调用并行，工具执行后注入
  memoryRecallPromise?: Promise<string>;
  onPermissionRequest?: (
    toolName: string,
    args: Record<string, unknown>,
    decision: Decision
  ) => Promise<"allow" | "deny" | "allowAlways">;
}

export class Agent {
  private client: LLMClient;
  private registry: ToolRegistry;
  private checker: PermissionChecker;
  private conversation: ConversationManager;
  private workDir: string;
  private sessionId: string;
  private sessionFilePath: string;
  private hookEngine?: HookEngine;
  private fileHistory?: FileHistory;
  private fileStateCache?: FileStateCache;
  private abortSignal?: AbortSignal;
  private contextWindow: number;
  private maxOutput: number;
  private recoveryState: RecoveryState;
  private maxIterations: number;
  private notificationFn?: () => string[];
  private onLoopComplete?: (conversation: ConversationManager) => void;
  private compactTracking = new AutoCompactTrackingState();
  // Real-token anchor from the last stream's API usage. null until the first
  // turn completes, so the very first manageContext() call falls back to
  // whole-transcript char estimation (cold start). Mirrors python
  // conversation.last_input_tokens, extended with cache tokens + an increment.
  private usageAnchor: UsageAnchor | null = null;
  private onPermissionRequest?: AgentConfig["onPermissionRequest"];
  private toolFilter?: (name: string) => boolean;
  activeSkills: Map<string, string>;
  private instructions: string;
  private memoryContent: string;
  private memoryRecallPromise?: Promise<string>;
  private memoryRecallConsumed = false;

  constructor(config: AgentConfig) {
    this.client = config.client;
    this.registry = config.registry;
    this.checker = config.checker;
    this.conversation = config.conversation;
    this.workDir = config.workDir;
    this.sessionId = config.sessionId || "";
    this.sessionFilePath = config.sessionId
      ? getSessionFilePath(config.workDir, config.sessionId)
      : "";
    this.hookEngine = config.hookEngine;
    this.fileHistory = config.fileHistory;
    this.fileStateCache = config.fileStateCache;
    this.abortSignal = config.abortSignal;
    this.contextWindow = config.contextWindow ?? 200000;
    this.maxOutput = config.maxOutput ?? 8192;
    this.recoveryState = config.recoveryState ?? new RecoveryState();
    this.maxIterations = config.maxIterations ?? 0;
    this.notificationFn = config.notificationFn;
    this.onLoopComplete = config.onLoopComplete;
    this.onPermissionRequest = config.onPermissionRequest;
    this.activeSkills = config.activeSkills ?? new Map();
    this.toolFilter = config.toolFilter;
    this.instructions = config.instructions ?? "";
    this.memoryContent = config.memoryContent ?? "";
    this.memoryRecallPromise = config.memoryRecallPromise;
  }

  async *run(): AsyncGenerator<AgentEvent> {
    // Apply an active skill's allowed-tools filter to the schemas sent to the
    // LLM. System tools always remain available. Mirrors Go currentToolSchemas.
    let toolSchemas = this.registry.getAllSchemas();
    if (this.toolFilter) {
      toolSchemas = toolSchemas.filter((s) => {
        const n = s.name as string;
        return this.registry.get(n)?.system === true || this.toolFilter!(n);
      });
    }
    const toolSchemaNames = this.registry.listTools().map((t) => t.name);

    let maxTokensEscalated = false;
    let outputRecoveries = 0;
    let consecutiveUnknown = 0;
    let iteration = 0;

    await this.fireLifecycle("session_start");
    try {
    let looping = true;
    while (looping) {
      iteration++;
      if (this.maxIterations > 0 && iteration > this.maxIterations) {
        yield {
          type: "error",
          error: new Error(`Agent reached maximum iterations (${this.maxIterations})`),
        };
        return;
      }

      let fullText = "";
      const thinkingBlocks: { thinking: string; signature: string }[] = [];
      const toolUses: ToolUseBlock[] = [];
      let stopReason = "end_turn";

      // Plan mode: sync the plan path onto the checker (so the Layer-0 plan-file
      // write exception works however plan mode was entered) and inject a
      // per-turn reminder keeping the model read-only.
      if (this.checker.mode === "plan") {
        const planPath = getOrCreatePlanPath(this.workDir);
        this.checker.planFilePath = planPath;
        this.conversation.addSystemReminder(
          buildPlanModeReminder(planPath, planExists(this.workDir), iteration)
        );
      }

      // Drain queued hook notifications and any external notifications (e.g. a
      // team mailbox) into system reminders for this turn.
      if (this.hookEngine) {
        for (const note of this.hookEngine.drainNotifications()) {
          this.conversation.addSystemReminder(note);
        }
      }
      if (this.notificationFn) {
        for (const note of this.notificationFn()) {
          this.conversation.addSystemReminder(note);
        }
      }

      await this.fireLifecycle("turn_start");
      await this.fireLifecycle("pre_send");

      // Layer 1: 就地裁剪超限的工具结果
      applyBudget(this.conversation.getMessages(), this.workDir, this.sessionId);

      // Layer 2: auto-compact when the window fills up
      const mc = await manageContext(
        this.conversation,
        this.client,
        this.contextWindow,
        this.maxOutput,
        this.compactTracking,
        this.recoveryState,
        toolSchemaNames,
        toolSchemas,
        this.usageAnchor,
        this.sessionFilePath,
      );
      if (mc.message) {
        yield { type: "compact", message: mc.message, boundary: mc.boundary };
      }
      if (mc.compacted) {
        this.usageAnchor = null;
        // 压缩后消息已变，重新应用 budget
        applyBudget(this.conversation.getMessages(), this.workDir, this.sessionId);
        this.conversation.injectLongTermMemory(this.instructions, this.memoryContent);
      }

      // Message count of the live conversation at the moment we send. The API
      // usage we receive back covers exactly these messages, so this becomes
      // the anchor index: only messages appended after it are estimated.
      const sentMessageCount = this.conversation.len();

      try {
        // 直接用 conversation 发起 API 调用，无需重建
        const stream = this.client.stream(this.conversation, toolSchemas, this.abortSignal);

        for await (const event of stream) {
          if (this.abortSignal?.aborted) {
            looping = false;
            break;
          }
          switch (event.type) {
            case "text_delta":
              fullText += event.text;
              yield { type: "stream_text", text: event.text };
              break;

            case "thinking_delta":
              yield { type: "thinking_text", text: event.text };
              break;

            case "thinking_complete":
              thinkingBlocks.push({
                thinking: event.thinking,
                signature: event.signature,
              });
              yield {
                type: "thinking_complete",
                thinking: event.thinking,
                signature: event.signature,
              };
              break;

            case "tool_call_start":
              break;

            case "tool_call_complete":
              toolUses.push({
                toolUseId: event.toolId,
                toolName: event.toolName,
                arguments: event.arguments,
              });
              yield {
                type: "tool_use",
                toolName: event.toolName,
                toolId: event.toolId,
                args: event.arguments,
              };
              break;

            case "stream_end":
              stopReason = event.stopReason;
              // Record the real-token anchor: the full context size the API
              // just reported (input + cache_read + cache_creation + output)
              // plus the message count it covered. The next manageContext()
              // trusts this baseline and only char-estimates the tail beyond it.
              this.usageAnchor = {
                baselineTokens:
                  event.usage.inputTokens +
                  event.usage.cacheReadInputTokens +
                  event.usage.cacheCreationInputTokens +
                  event.usage.outputTokens,
                anchorCount: sentMessageCount,
              };
              yield { type: "usage", usage: event.usage };
              break;
          }
        }
      } catch (err) {
        if (this.abortSignal?.aborted) {
          yield { type: "loop_complete", stopReason: "interrupted" };
          return;
        }
        const e = err as Error;

        // Self-heal: context too long → force-compact, then retry the turn.
        if (e instanceof ContextTooLongError) {
          try {
            // 对齐 Claude Code：先应用 tool-result budget，再做 auto-compact
            applyBudget(this.conversation.getMessages(), this.workDir, this.sessionId);
            const result = await forceCompact(
              this.conversation,
              this.client,
              this.recoveryState,
              toolSchemaNames,
              toolSchemas,
              this.sessionFilePath,
            );
            // Transcript was rewritten — the usage anchor is now stale (see the
            // reset after manageContext above). Drop it so the retry re-estimates
            // against the compacted transcript.
            this.usageAnchor = null;
            this.conversation.injectLongTermMemory(this.instructions, this.memoryContent);
            yield {
              type: "compact",
              message: "Auto-compacted due to context length: " + result.message,
              boundary: result.boundary,
            };
            continue;
          } catch {
            yield { type: "error", error: e };
            return;
          }
        }

        // Self-heal: rate limited → wait (Retry-After header or 5s), then retry.
        if (e instanceof RateLimitError) {
          const waitMs = parseRetryAfter(e.retryAfter);
          yield { type: "retry", reason: "rate limited", delay: waitMs };
          if (await this.interruptibleSleep(waitMs)) {
            yield { type: "loop_complete", stopReason: "interrupted" };
            return;
          }
          continue;
        }

        yield { type: "error", error: e };
        return;
      }

      if (this.abortSignal?.aborted) {
        if (fullText) {
          this.conversation.addAssistantFull(fullText, thinkingBlocks, []);
        }
        yield { type: "loop_complete", stopReason: "interrupted" };
        return;
      }

      await this.fireLifecycle("post_receive", fullText);

      // Handle the max_tokens stop reason: escalate the output ceiling once,
      // then do up to N multi-turn recoveries before giving up. Each recovery
      // re-prompts the model to resume from where it stopped. Mirrors Go.
      if (stopReason === "max_tokens") {
        if (!maxTokensEscalated) {
          const setter = this.client as Partial<MaxTokensSetter>;
          setter.setMaxOutputTokens?.(MAX_TOKENS_CEILING);
          maxTokensEscalated = true;
          if (fullText) {
            this.conversation.addAssistantFull(fullText, thinkingBlocks, []);
            this.conversation.addUserMessage(
              "Output token limit hit. Resume directly from where you stopped. Do not apologize or repeat previous content. Pick up mid-thought if needed."
            );
          }
          yield { type: "retry", reason: "max_tokens escalation", delay: 0 };
          continue;
        } else if (outputRecoveries < MAX_OUTPUT_TOKENS_RECOVERIES) {
          outputRecoveries++;
          this.conversation.addAssistantFull(fullText, thinkingBlocks, []);
          this.conversation.addUserMessage(
            "Output token limit hit. Resume directly from where you stopped. Break remaining work into smaller pieces."
          );
          yield {
            type: "retry",
            reason: `max_tokens recovery ${outputRecoveries}/${MAX_OUTPUT_TOKENS_RECOVERIES}`,
            delay: 0,
          };
          continue;
        }
        // Exhausted recoveries: fall through to normal completion.
      } else {
        outputRecoveries = 0;
      }

      this.conversation.addAssistantFull(fullText, thinkingBlocks, toolUses);

      if (toolUses.length > 0) {
        const results = await this.executeTools(toolUses);
        for (const r of results) {
          yield r;
        }

        // Safety guard: bail out if the model keeps calling tools that don't
        // exist — a sign it's stuck. Mirrors Go's consecutiveUnknown >= 3.
        for (const tu of toolUses) {
          if (this.registry.get(tu.toolName)) consecutiveUnknown = 0;
          else consecutiveUnknown++;
        }
        if (consecutiveUnknown >= 3) {
          yield { type: "error", error: new Error("Too many consecutive unknown tool calls") };
          return;
        }

        const toolResults: ToolResultBlock[] = [];
        for (const r of results) {
          if (r.type === "tool_result") {
            toolResults.push({
              toolUseId: r.toolId,
              content:
                r.output.length > MAX_OUTPUT_CHARS
                  ? r.output.slice(0, MAX_OUTPUT_CHARS) + "\n… (output truncated)"
                  : r.output,
              isError: r.isError,
            });
          }
        }
        const exitPlanCalled = toolUses.some(
          (tu) => tu.toolName === "ExitPlanMode"
        );
        this.conversation.addToolResultsMessage(toolResults);

        // 非阻塞 memory recall：工具执行完后检查 prefetch 是否就绪
        if (this.memoryRecallPromise && !this.memoryRecallConsumed) {
          try {
            // Promise.race with an immediately-resolved marker to avoid blocking
            const settled = await Promise.race([
              this.memoryRecallPromise.then((r) => ({ done: true, value: r })),
              Promise.resolve({ done: false, value: "" }),
            ]);
            if (settled.done) {
              if (settled.value) {
                this.conversation.addSystemReminder(settled.value);
              }
              this.memoryRecallConsumed = true;
            }
          } catch {
            this.memoryRecallConsumed = true;
          }
        }

        if (exitPlanCalled) {
          yield { type: "turn_complete" };
          yield { type: "loop_complete", stopReason: "end_turn" };
          return;
        }

        yield { type: "turn_complete" };
        await this.fireLifecycle("turn_end");
      } else {
        looping = false;
        if (this.fileHistory) {
          const summary = fullText.length > 60 ? fullText.slice(0, 60) + "..." : fullText;
          this.fileHistory.makeSnapshot(this.conversation.len(), summary);
        }
        yield { type: "loop_complete", stopReason };
        // Fire-and-forget post-completion hook (e.g. background memory
        // extraction). Mirrors Go's OnLoopComplete goroutine.
        if (this.onLoopComplete) {
          try {
            this.onLoopComplete(this.conversation);
          } catch {
            /* non-fatal */
          }
        }
      }
    }
    } finally {
      await this.fireLifecycle("session_end");
    }
  }

  // Fire a lifecycle hook event and queue any non-empty hook output as a
  // notification to be surfaced on the next turn. No-op without a HookEngine.
  private async fireLifecycle(event: EventName, message?: string): Promise<void> {
    if (!this.hookEngine) return;
    const results = await this.hookEngine.fire(event, { event, message });
    for (const r of results) {
      if (r.output) this.hookEngine.recordNotification(r.output);
    }
  }

  // Sleep for ms, resolving early with `true` if the abort signal fires during
  // the wait (mirrors Go's select on ctx.Done()). Resolves `false` on timeout.
  private interruptibleSleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.abortSignal?.aborted) return resolve(true);
      const onAbort = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.abortSignal?.removeEventListener("abort", onAbort);
        resolve(false);
      }, ms);
      this.abortSignal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async executeTools(
    toolUses: ToolUseBlock[]
  ): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];

    // 按相邻性分批：连续的只读工具合成一个并行批次，写/命令工具各自独占一批
    const batches = this.partitionToolCalls(toolUses);

    for (const batch of batches) {
      const batchEvents = await this.executeBatch(
        batch.blocks,
        batch.concurrent && batch.blocks.length > 1,
      );
      events.push(...batchEvents);
    }

    return events;
  }

  private partitionToolCalls(
    toolUses: ToolUseBlock[]
  ): Array<{ concurrent: boolean; blocks: ToolUseBlock[] }> {
    const batches: Array<{ concurrent: boolean; blocks: ToolUseBlock[] }> = [];
    for (const tu of toolUses) {
      const tool = this.registry.get(tu.toolName);
      const safe = (tool?.category ?? "command") === "read";

      if (safe && batches.length > 0 && batches[batches.length - 1].concurrent) {
        batches[batches.length - 1].blocks.push(tu);
      } else {
        batches.push({ concurrent: safe, blocks: [tu] });
      }
    }
    return batches;
  }

  // executeBatch runs a set of tool calls through permission checks, hooks,
  // and the streaming executor. When parallel is true all calls run
  // concurrently; otherwise they run one at a time.
  private async executeBatch(
    toolUses: ToolUseBlock[],
    parallel: boolean,
  ): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    const executor = new StreamingExecutor(this.registry, {
      workDir: this.workDir,
      fileHistory: this.fileHistory,
      fileStateCache: this.fileStateCache,
    });

    for (const tu of toolUses) {
      // Fire pre-tool hooks
      if (this.hookEngine) {
        const hookResult = await this.hookEngine.firePreToolHooks(tu.toolName, tu.arguments);
        if (hookResult.rejected) {
          events.push({
            type: "tool_result",
            toolName: tu.toolName,
            toolId: tu.toolUseId,
            output: `Rejected by hook: ${hookResult.reason}`,
            isError: true,
            elapsed: 0,
          });
          continue;
        }
      }

      const tool = this.registry.get(tu.toolName);
      const category = tool?.category ?? "command";

      const decision = this.checker.check(tu.toolName, category, tu.arguments);

      if (decision.effect === "deny") {
        events.push({
          type: "tool_result",
          toolName: tu.toolName,
          toolId: tu.toolUseId,
          output: `Permission denied: ${decision.reason}. 此操作已被安全策略拦截和阻止，请告知用户该命令被拒绝，不要描述该命令会做什么。`,
          isError: true,
          elapsed: 0,
        });
        continue;
      }

      if (decision.effect === "ask" && this.onPermissionRequest) {
        const response = await this.onPermissionRequest(
          tu.toolName,
          tu.arguments,
          decision
        );
        if (response === "deny") {
          events.push({
            type: "tool_result",
            toolName: tu.toolName,
            toolId: tu.toolUseId,
            output: "Permission denied by user",
            isError: true,
            elapsed: 0,
          });
          continue;
        }
        if (response === "allowAlways") {
          this.checker.allowAlways(tu.toolName, tu.arguments);
        }
      }

      executor.submit(tu.toolUseId, tu.toolName, tu.arguments);

      // Sequential mode: collect after every single call.
      if (!parallel) {
        const batchResults = await executor.collectResults();
        for (const r of batchResults) {
          await this.processToolResult(r, toolUses, events);
        }
      }
    }

    // Parallel mode: collect all results at once.
    if (parallel) {
      const batchResults = await executor.collectResults();
      for (const r of batchResults) {
        await this.processToolResult(r, toolUses, events);
      }
    }

    return events;
  }

  // processToolResult handles a single executor result: records file-read
  // snapshots, emits the tool_result event, and fires post-tool hooks.
  private async processToolResult(
    r: { toolId: string; toolName: string; result: { output: string; isError: boolean }; elapsed: number },
    toolUses: ToolUseBlock[],
    events: AgentEvent[],
  ): Promise<void> {
    // Snapshot ReadFile content into recovery state so a later auto-compact
    // can replay it after the transcript collapses into a summary. Mirrors
    // Go agent.go executeSingleTool's RecordFileRead.
    if (!r.result.isError && r.toolName === "ReadFile") {
      const tu = toolUses.find((t) => t.toolUseId === r.toolId);
      const p = tu?.arguments.file_path as string | undefined;
      if (p) {
        try {
          this.recoveryState.recordFileRead(p, await readFile(p, "utf-8"));
        } catch {
          /* best-effort; recovery snapshots are optional */
        }
      }
    }

    events.push({
      type: "tool_result",
      toolName: r.toolName,
      toolId: r.toolId,
      output: r.result.output,
      isError: r.result.isError,
      elapsed: r.elapsed,
    });

    // Fire post-tool hooks; queue any output as a notification.
    if (this.hookEngine) {
      const hookResults = await this.hookEngine.fire("post_tool_use", {
        event: "post_tool_use",
        toolName: r.toolName,
        message: r.result.output,
      });
      for (const hr of hookResults) {
        if (hr.output) this.hookEngine.recordNotification(hr.output);
      }
    }
  }
}


// parseRetryAfter converts a Retry-After header (seconds) into milliseconds,
// defaulting to 5s when absent or unparseable. Mirrors Go parseRetryAfter.
function parseRetryAfter(header?: string): number {
  if (!header) return 5000;
  const secs = parseInt(header, 10);
  if (!Number.isNaN(secs)) return secs * 1000;
  return 5000;
}
