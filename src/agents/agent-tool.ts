// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import type { Tool, ToolResult, ToolContext } from "../tools/types.js";
import { strArg, boolArg } from "../tools/types.js";
import type { AgentDefinition } from "./definition.js";
import { BUILTIN_AGENTS } from "./definition.js";
import { loadAgentDefinitions } from "./loader.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ConversationManager, ToolUseBlock, ToolResultBlock } from "../conversation/conversation.js";
import type { TeamManager, RunAgent } from "../teams/team.js";

// Fork 子 Agent 的前导标记——用于嵌套 fork 检测
const FORK_BOILERPLATE_TAG = "<fork_boilerplate>";
const FORK_QUERY_SOURCE = "agent:builtin:fork";

// Fork 子 Agent 注入的系统指令
const FORK_BOILERPLATE = `${FORK_BOILERPLATE_TAG}
You are a forked worker process. You are NOT the main agent.
Rules (non-negotiable):
1. Do NOT fork again.
2. Do NOT converse, ask questions, or request confirmation.
3. Use tools directly: read files, search code, make changes.
4. Stay strictly within your assigned task scope.
5. Final report must be under 500 characters, starting with "Scope:".
</fork_boilerplate>`;

export class AgentTool implements Tool {
  name = "Agent";
  description = "Launch a sub-agent to handle complex, multi-step tasks.";
  category = "read" as const;
  system = true;

  private definitions: AgentDefinition[];
  private registry: ToolRegistry;
  private conversation?: ConversationManager;

  // 标识当前 AgentTool 实例所处的派生上下文；
  // 非空且等于 FORK_QUERY_SOURCE 时禁止再次 fork
  querySource = "";

  /** 可选：团队管理器，启用 team_name 参数。 */
  private teamManager?: TeamManager;
  /** 可选：用于生成队友的 RunAgent 回调。 */
  private teamRunAgent?: RunAgent;

  private spawnHandler: (
    definition: AgentDefinition,
    prompt: string,
    background: boolean,
    modelOverride?: string,
  ) => Promise<string>;

  private forkHandler?: (
    prompt: string,
    conversation: ConversationManager,
    registry: ToolRegistry,
    modelOverride?: string,
  ) => Promise<string>;

  constructor(
    workDir: string,
    registry: ToolRegistry,
    spawnHandler: (def: AgentDefinition, prompt: string, bg: boolean, modelOverride?: string) => Promise<string>,
    conversation?: ConversationManager,
    forkHandler?: (prompt: string, conversation: ConversationManager, registry: ToolRegistry, modelOverride?: string) => Promise<string>,
  ) {
    this.definitions = loadAgentDefinitions(workDir);
    this.registry = registry;
    this.spawnHandler = spawnHandler;
    this.conversation = conversation;
    this.forkHandler = forkHandler;
  }

  /**
   * 设置团队管理器和队友运行回调，启用 team_name 参数。
   * 设置后 Agent 工具可以直接生成队友，无需单独的 SpawnTeammate 工具。
   */
  setTeamManager(mgr: TeamManager, runAgent: RunAgent): void {
    this.teamManager = mgr;
    this.teamRunAgent = runAgent;
  }

  schema(): Record<string, unknown> {
    const agentTypes = this.definitions.map((d) => d.name);
    return {
      name: this.name,
      description: this.buildDescription(),
      input_schema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Short description of what the agent will do" },
          prompt: { type: "string", description: "The task for the agent to perform" },
          subagent_type: {
            type: "string",
            enum: agentTypes,
            description: "Agent type. Omit to fork current conversation context.",
          },
          model: {
            type: "string",
            enum: ["sonnet", "opus", "haiku"],
            description: "Override the model for this agent.",
          },
          run_in_background: { type: "boolean", description: "Run in background", default: false },
          team_name: {
            type: "string",
            description:
              "REQUIRED when creating team members. Spawns the agent as a long-running " +
              "teammate under this team (created via TeamCreate). Unlike regular sub-agents, " +
              "team members persist after the lead returns and communicate via SendMessage. " +
              "Without team_name the agent runs as a one-shot sub-agent that blocks and returns inline.",
          },
        },
        required: ["description", "prompt"],
      },
    };
  }

  private buildDescription(): string {
    let desc = `Launch a sub-agent to handle a complex task. Each sub-agent runs independently with its own context. The sub-agent cannot see the current conversation.

This is ONE tool with multiple roles. Roles are NOT separate tools — you pick one by passing its name in the "subagent_type" parameter. Do not search for a tool named after a role; call THIS tool ("Agent") and set "subagent_type".

Available roles for the "subagent_type" parameter:`;

    for (const def of this.definitions) {
      desc += `\n- ${def.name}: ${def.description}`;
    }

    desc += `

Example call shape:
{
  "name": "Agent",
  "input": {
    "subagent_type": "<role from the list above>",
    "description": "Short task label",
    "prompt": "Detailed instructions — the sub-agent has zero prior context"
  }
}

Write a detailed prompt explaining what the sub-agent should do and why — it has no prior context.
When tasks are independent, launch multiple sub-agents in parallel by making multiple Agent tool calls in a single response.`;
    return desc;
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const description = strArg(args, "description");
    const prompt = strArg(args, "prompt");
    if (!description || !prompt) {
      return { output: "Error: description and prompt are required", isError: true };
    }

    const subagentType = strArg(args, "subagent_type");
    const modelOverride = strArg(args, "model");
    const background = boolArg(args, "run_in_background");
    const teamName = strArg(args, "team_name");

    // Team-member 路径：team_name 优先于 fork/subagent，将 agent 作为
    // 长驻队友运行，完成后通过 SendMessage / mailbox 通知 lead。
    if (teamName && this.teamManager && this.teamRunAgent) {
      return this.runAsTeammate(teamName, description, prompt);
    }

    // Fork 路径：没有指定 subagent_type 时继承父对话上下文
    if (!subagentType) {
      return this.runFork(prompt, description, modelOverride);
    }

    // 定义路径：按 subagent_type 查找 Agent 定义
    const definition = this.definitions.find((d) => d.name === subagentType);
    if (!definition) {
      return {
        output: `Error: unknown agent type '${subagentType}'. Available: ${this.definitions.map((d) => d.name).join(", ")}`,
        isError: true,
      };
    }

    try {
      const output = await this.spawnHandler(definition, prompt, background || !!definition.background, modelOverride);
      return { output, isError: false };
    } catch (err) {
      return {
        output: `Agent error: ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  /**
   * Team-member 模式：在指定团队中生成一个长驻队友。
   * 对齐 Go/Java 的 Agent 工具 team_name 代码路径，
   * 委托给 Team.spawnTeammate() 启动 idle-poll 主循环。
   */
  private runAsTeammate(
    teamName: string,
    description: string,
    prompt: string,
  ): ToolResult {
    const team = this.teamManager!.get(teamName);
    if (!team) {
      return {
        output: `Error: team '${teamName}' not found. Create it first with TeamCreate.`,
        isError: true,
      };
    }

    // 从 description 派生队友名称，去重
    let memberName = description
      .replace(/\s+/g, "-")
      .toLowerCase()
      .slice(0, 30);
    let suffix = 2;
    const base = memberName;
    while (team.getMember(memberName)) {
      memberName = `${base}-${suffix++}`;
    }

    team.spawnTeammate(memberName, prompt, this.teamRunAgent!);
    return {
      output: `Teammate '${memberName}' spawned in team '${teamName}' (mode: ${team.mode}). ` +
        `The teammate is now working on the assigned task.`,
      isError: false,
    };
  }

  /**
   * Fork 模式：继承父对话上下文，在后台运行。
   * 与定义模式不同，fork 子 Agent 能看到父对话的全部历史，
   * 实现 prompt-cache prefix 的字节对齐以提高缓存命中率。
   */
  private async runFork(
    prompt: string,
    description: string,
    modelOverride: string,
  ): Promise<ToolResult> {
    if (!this.conversation || !this.forkHandler) {
      return { output: "Error: fork requires parent conversation context", isError: true };
    }

    // 嵌套 fork 检测——两层防护：
    // (1) 主检测：querySource 标记（即使对话被压缩也能检测）
    // (2) 回退：扫描对话历史中的 fork 标记
    if (this.querySource === FORK_QUERY_SOURCE) {
      return {
        output: "Error: cannot fork from a forked agent. Use subagent_type to spawn a definition-based agent instead.",
        isError: true,
      };
    }
    for (const msg of this.conversation.getMessages()) {
      if (msg.content.includes(FORK_BOILERPLATE_TAG)) {
        return {
          output: "Error: cannot fork from a forked agent. Use subagent_type to spawn a definition-based agent instead.",
          isError: true,
        };
      }
    }

    try {
      const { cloneRegistryForFork } = await import("./tool-filter.js");
      const forkedRegistry = cloneRegistryForFork(this.registry);
      const output = await this.forkHandler(
        `${FORK_BOILERPLATE}\n\nYour task:\n${prompt}`,
        this.conversation,
        forkedRegistry,
        modelOverride,
      );
      return {
        output: `Forked agent "${description}" launched in background. Results will arrive via task-notification.`,
        isError: false,
      };
    } catch (err) {
      return {
        output: `Fork error: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}
