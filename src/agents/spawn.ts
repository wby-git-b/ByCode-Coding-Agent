// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import type { LLMClient } from "../llm/client.js";
import { createClient } from "../llm/client.js";
import { resolveModelId } from "../llm/model-resolver.js";
import { ConversationManager } from "../conversation/conversation.js";
import { buildSystemPrompt, detectEnvironment } from "../prompt/builder.js";
import { ToolRegistry } from "../tools/registry.js";
import { PermissionChecker } from "../permissions/checker.js";
import { Agent } from "../agent/agent.js";
import type { AgentDefinition } from "./definition.js";
import type { ProviderConfig } from "../config/config.js";
import { filterToolsForAgent } from "./tool-filter.js";

export type AgentEventSink = (event: {
  type: string;
  toolName?: string;
  args?: Record<string, unknown>;
  usage?: { inputTokens: number; outputTokens: number };
  text?: string;
}) => void;

export async function spawnSubAgent(
  definition: AgentDefinition,
  prompt: string,
  parentClient: LLMClient,
  parentRegistry: ToolRegistry,
  parentProvider: ProviderConfig,
  workDir: string,
  onProgress?: (p: { turn?: number; lastTool?: string }) => void,
  onEvent?: AgentEventSink,
  modelOverride?: string,
): Promise<string> {
  // 确定模型：调用级 override > 定义级 model > 父 Agent 的模型
  const effectiveModel = modelOverride || definition.model;
  const resolvedModel = effectiveModel ? resolveModelId(effectiveModel) : parentProvider.model;
  const env = detectEnvironment(workDir);
  env.model = resolvedModel;
  const systemPrompt = definition.systemPromptOverride ?? buildSystemPrompt(env);
  const client: LLMClient = effectiveModel
    ? await createClient({ ...parentProvider, model: resolvedModel }, systemPrompt)
    : parentClient;

  // 通过多层过滤构建子 Agent 工具注册表（对齐 Go 的 FilterToolsForAgent）
  const registry = filterToolsForAgent(
    parentRegistry,
    definition.tools,
    definition.disallowedTools,
    false, // isAsync — spawnSubAgent 目前是同步路径
  );

  const permMode = definition.permissionMode ?? "acceptEdits";
  const checker = new PermissionChecker(workDir, permMode);
  const conv = new ConversationManager();
  conv.addUserMessage(prompt);

  const agent = new Agent({
    client,
    registry,
    checker,
    conversation: conv,
    workDir,
    maxIterations: definition.maxTurns ?? 200,
  });

  let output = "";
  let turn = 0;
  for await (const event of agent.run()) {
    switch (event.type) {
      case "stream_text":
        output += event.text;
        break;
      case "tool_use":
        onProgress?.({ lastTool: event.toolName });
        onEvent?.({ type: "tool_use", toolName: event.toolName, args: event.args });
        break;
      case "usage":
        onEvent?.({ type: "usage", usage: { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens } });
        break;
      case "turn_complete":
        onProgress?.({ turn: ++turn });
        break;
      case "loop_complete":
        return output || "[No output]";
      case "error":
        return output
          ? `${output}\n\n[Error: ${event.error.message}]`
          : `Error: ${event.error.message}`;
    }
  }

  return output || "[No output]";
}
