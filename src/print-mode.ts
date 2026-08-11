// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { loadConfig } from "./config/config.js";
import { getContextWindow, getMaxOutputTokens } from "./config/config.js";
import { createClient } from "./llm/client.js";
import { ConversationManager } from "./conversation/conversation.js";
import { buildSystemPrompt, detectEnvironment } from "./prompt/builder.js";
import { ToolRegistry } from "./tools/registry.js";
import { ReadFileTool } from "./tools/read-file.js";
import { BashTool } from "./tools/bash.js";
import { GlobTool } from "./tools/glob.js";
import { GrepTool } from "./tools/grep.js";
import { WriteFileTool } from "./tools/write-file.js";
import { EditFileTool } from "./tools/edit-file.js";
import { ToolSearchTool } from "./tools/tool-search.js";
import { PermissionChecker } from "./permissions/checker.js";
import { Agent } from "./agent/agent.js";
import type { AgentEvent } from "./agent/events.js";
import { FileStateCache } from "./tools/file-state-cache.js";

// -p 模式支持的输出格式
type OutputFormat = "text" | "stream-json";

// -p 模式的解析结果
export interface PrintArgs {
  prompt: string;
  outputFormat: OutputFormat;
}

/**
 * 解析 -p 相关的命令行参数。
 * 返回 null 表示未使用 -p 模式。
 */
export function parsePrintFlags(args: string[]): PrintArgs | null {
  const idx = args.indexOf("-p");
  if (idx === -1) return null;

  const prompt = args[idx + 1];
  if (!prompt) {
    console.error("Error: -p requires a prompt argument");
    process.exit(1);
  }

  // 解析 --output-format（默认 text）
  let outputFormat: OutputFormat = "text";
  const fmtIdx = args.indexOf("--output-format");
  if (fmtIdx !== -1 && args[fmtIdx + 1]) {
    const fmt = args[fmtIdx + 1];
    if (fmt === "stream-json") {
      outputFormat = "stream-json";
    } else if (fmt !== "text") {
      console.error(`Error: unknown output format '${fmt}', expected 'text' or 'stream-json'`);
      process.exit(1);
    }
  }

  return { prompt, outputFormat };
}

/**
 * 以非交互方式运行 Agent 并将结果输出到 stdout。
 * - text 模式：只输出模型的文本回复
 * - stream-json 模式：每个事件输出一行 JSON
 */
export async function runPrintMode(args: PrintArgs): Promise<void> {
  const startTime = Date.now();
  const workDir = process.cwd();

  // 加载配置
  const cfg = loadConfig();
  const provider = cfg.providers[0];

  // 构建系统提示词
  const env = detectEnvironment(workDir);
  env.model = provider.model;
  const systemPrompt = buildSystemPrompt(env);

  // 创建 LLM 客户端
  const client = await createClient(provider, systemPrompt);

  // 创建工具注册表，注册核心工具
  const registry = new ToolRegistry();
  registry.register(new ReadFileTool());
  registry.register(new BashTool());
  registry.register(new GlobTool());
  registry.register(new GrepTool());
  registry.register(new WriteFileTool());
  registry.register(new EditFileTool());
  registry.register(new ToolSearchTool(registry));

  // 创建会话管理器，添加用户消息
  const conv = new ConversationManager();
  conv.addUserMessage(args.prompt);

  // bypassPermissions 模式：自动批准所有权限
  const checker = new PermissionChecker(workDir, "bypassPermissions");

  // 创建 Agent
  const agent = new Agent({
    client,
    registry,
    checker,
    conversation: conv,
    workDir,
    fileStateCache: new FileStateCache(),
    contextWindow: getContextWindow(provider),
    maxOutput: getMaxOutputTokens(provider),
  });

  // 统计信息
  let resultText = "";
  let numTurns = 0;
  const toolCalls: Array<{ tool: string; elapsed: number }> = [];
  let totalUsage = { inputTokens: 0, outputTokens: 0 };

  // 遍历 Agent 事件流
  for await (const event of agent.run()) {
    if (args.outputFormat === "stream-json") {
      emitStreamJson(event);
    } else {
      // text 模式：只输出流式文本
      if (event.type === "stream_text") {
        process.stdout.write(event.text);
      }
    }

    // 收集统计信息
    switch (event.type) {
      case "stream_text":
        resultText += event.text;
        break;
      case "tool_use":
        toolCalls.push({ tool: event.toolName, elapsed: 0 });
        break;
      case "tool_result":
        // 更新最后一个同名工具调用的耗时
        for (let i = toolCalls.length - 1; i >= 0; i--) {
          if (toolCalls[i].tool === event.toolName && toolCalls[i].elapsed === 0) {
            toolCalls[i].elapsed = event.elapsed;
            break;
          }
        }
        break;
      case "turn_complete":
        numTurns++;
        break;
      case "usage":
        totalUsage.inputTokens += event.usage.inputTokens;
        totalUsage.outputTokens += event.usage.outputTokens;
        break;
      case "error":
        if (args.outputFormat === "text") {
          console.error(`\nError: ${event.error.message}`);
        }
        break;
    }
  }

  const durationMs = Date.now() - startTime;

  // text 模式：确保最后有换行
  if (args.outputFormat === "text" && resultText && !resultText.endsWith("\n")) {
    process.stdout.write("\n");
  }

  // stream-json 模式：输出最终汇总
  if (args.outputFormat === "stream-json") {
    const resultLine = {
      type: "result",
      result: resultText,
      duration_ms: durationMs,
      num_turns: numTurns,
      tool_calls: toolCalls,
      usage: totalUsage,
    };
    console.log(JSON.stringify(resultLine));
  }
}

/**
 * 将 Agent 事件转为 stream-json 格式输出到 stdout。
 * 每个事件一行 JSON。
 */
function emitStreamJson(event: AgentEvent): void {
  switch (event.type) {
    case "tool_use":
      console.log(
        JSON.stringify({
          type: "tool_use",
          tool_name: event.toolName,
          tool_id: event.toolId,
          args: event.args,
        })
      );
      break;

    case "tool_result":
      console.log(
        JSON.stringify({
          type: "tool_result",
          tool_name: event.toolName,
          output: event.output,
          is_error: event.isError,
          elapsed: event.elapsed,
        })
      );
      break;

    case "usage":
      console.log(
        JSON.stringify({
          type: "usage",
          input_tokens: event.usage.inputTokens,
          output_tokens: event.usage.outputTokens,
        })
      );
      break;

    case "error":
      console.log(
        JSON.stringify({
          type: "error",
          message: event.error.message,
        })
      );
      break;

    // stream_text, thinking_text 等不输出到 stream-json（文本内容在最终 result 中汇总）
    default:
      break;
  }
}
