// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { ProviderConfig, MCPServerConfig, HookConfig } from "../config/config.js";
import { getContextWindow, getContextWindowAsync, getMaxOutputTokens } from "../config/config.js";
import { createClient } from "../llm/client.js";
import type { LLMClient } from "../llm/client.js";
import { ConversationManager } from "../conversation/conversation.js";
import { buildSystemPrompt, detectEnvironment } from "../prompt/builder.js";
import { ToolRegistry } from "../tools/registry.js";
import { ReadFileTool } from "../tools/read-file.js";
import { BashTool } from "../tools/bash.js";
import { GlobTool } from "../tools/glob.js";
import { GrepTool } from "../tools/grep.js";
import { WriteFileTool } from "../tools/write-file.js";
import { EditFileTool } from "../tools/edit-file.js";
import { ExitPlanModeTool } from "../tools/exit-plan-mode.js";
import { ToolSearchTool } from "../tools/tool-search.js";
import { EnterWorktreeTool } from "../tools/enter-worktree.js";
import { ExitWorktreeTool } from "../tools/exit-worktree.js";
import { AskUserQuestionTool, type Question, type AskAnswers } from "../tools/ask-user.js";
import { Agent } from "../agent/agent.js";
import type { AgentEvent } from "../agent/events.js";
import { PermissionChecker, type PermissionMode } from "../permissions/checker.js";
import type { Decision } from "../permissions/checker.js";
import {
  parse as parseCommand,
  createDefaultRegistry as createCommandRegistry,
  type CommandRegistry,
  type CommandContext,
} from "../commands/commands.js";
import { loadUserCommands } from "../commands/loader.js";
import { MCPManager } from "../mcp/manager.js";
import { MCPToolWrapper } from "../mcp/tool-wrapper.js";
import { loadInstructions } from "../memory/instructions.js";
import { MemoryManager } from "../memory/manager.js";
import { MemoryExtractor } from "../memory/extractor.js";
import { SkillCatalog } from "../skills/catalog.js";
import type { SkillHost } from "../skills/skill.js";
import { LoadSkillTool } from "../skills/load-skill-tool.js";
import { runInline as runSkillInline } from "../skills/executor.js";
import { TaskList } from "../todo/todo.js";
import { TaskCreateTool, TaskGetTool, TaskListTool, TaskUpdateTool } from "../todo/tools.js";
import { TaskStore } from "../todo/store.js";
import { AgentTool } from "../agents/agent-tool.js";
import { spawnSubAgent } from "../agents/spawn.js";
import { BUILTIN_AGENTS } from "../agents/definition.js";
import { TeamCreateTool, SendMessageTool, TeamDeleteTool } from "../teams/tools.js";
import { TeamManager } from "../teams/team.js";
import type { RunAgent } from "../teams/team.js";
import { HookEngine, validate as validateHooks } from "../hooks/hooks.js";
import { forceCompact } from "../compact/compact.js";
import { RecoveryState } from "../compact/recovery.js";
import { getOrCreatePlanPath, planExists } from "../planfile/planfile.js";
import { FileHistory } from "../filehistory/filehistory.js";
import { FileStateCache } from "../tools/file-state-cache.js";
import * as sessionMod from "../session/session.js";
import { INDEX_HTML } from "./web.js";

// ── 消息类型定义 ────────────────────────────────────────────────

// 下行消息（Server → Web UI）
interface WSMessage {
  type: string;
  data: unknown;
}

// 上行消息（Web UI → Server）
interface ClientMessage {
  type: string;
  data: Record<string, unknown>;
}

interface UserMessageData {
  content: string;
}

interface PermResponseData {
  id: string;
  response: string; // "allow" | "deny" | "allowAlways"
}

interface AskUserResponseData {
  id: string;
  answers: Record<string, string>;
}

// ── RemoteServer ────────────────────────────────────────────────

/**
 * RemoteServer 是 Remote Control 的核心，桥接 Agent 事件和 WebSocket 客户端。
 * 通过 HTTP 提供前端页面，通过 WebSocket 传递双向消息。
 */
export class RemoteServer {
  private providers: ProviderConfig[];
  private mcpConfigs: MCPServerConfig[];
  private hookCfgs: HookConfig[];
  private addr: string;

  // WebSocket 连接集合，支持多客户端广播
  private conns = new Set<WebSocket>();

  // Agent 相关组件
  private client: LLMClient | null = null;
  private conv: ConversationManager = new ConversationManager();
  private registry: ToolRegistry = new ToolRegistry();
  private sessionId: string = sessionMod.newSessionId();
  private fileHistory: FileHistory | null = null;
  private fileStateCache = new FileStateCache();

  // 流式状态控制
  private streaming = false;
  private abortController: AbortController | null = null;

  // 命令和 Skill 注册表
  private cmdRegistry: CommandRegistry;
  private skillCatalog: SkillCatalog | null = null;
  private activeSkills = new Map<string, string>();
  private toolFilter: ((name: string) => boolean) | null = null;

  // MCP 管理器
  private mcpManager: MCPManager | null = null;
  private mcpInstructions = "";

  // 状态组件
  private hookEngine: HookEngine | null = null;
  private recoveryState = new RecoveryState();
  private teamManager: TeamManager;
  private memoryManager: MemoryManager;
  private ltmInstructions = "";
  private ltmMemoryContent = "";

  // 权限请求：id → resolve 回调，等待前端回复
  private pendingPerms = new Map<string, (response: "allow" | "deny" | "allowAlways") => void>();
  // AskUser 请求：id → resolve 回调
  private pendingAsks = new Map<string, (answers: AskAnswers) => void>();

  // 上下文窗口
  private contextWindow: number;

  constructor(
    providers: ProviderConfig[],
    mcpConfigs: MCPServerConfig[],
    hookCfgs: HookConfig[],
    addr: string
  ) {
    this.providers = providers;
    this.mcpConfigs = mcpConfigs;
    this.hookCfgs = hookCfgs;
    this.addr = addr;

    this.cmdRegistry = createCommandRegistry();
    this.teamManager = new TeamManager(process.cwd());
    this.memoryManager = new MemoryManager(process.cwd());
    this.contextWindow = getContextWindow(providers[0]);
  }

  /**
   * 启动 HTTP + WebSocket 服务器，初始化 Agent 后开始监听。
   */
  async run(): Promise<void> {
    await this.initAgent();
    await this.initMCPServers();

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      this.handleHTTP(req, res);
    });

    // 创建 WebSocket 服务端，挂载到 HTTP server
    const wss = new WebSocketServer({ server });
    wss.on("connection", (ws: WebSocket) => {
      this.handleWSConnection(ws);
    });

    // 解析监听地址和端口
    const [host, portStr] = this.addr.includes(":")
      ? [this.addr.split(":").slice(0, -1).join(":") || "0.0.0.0", this.addr.split(":").pop()!]
      : ["0.0.0.0", this.addr];
    const port = parseInt(portStr, 10);

    return new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(port, host, () => {
        console.log(`\n  🌐 Remote UI: http://localhost:${port}\n`);
        resolve();
      });
    });
  }

  // ── HTTP 处理 ──────────────────────────────────────────────

  private handleHTTP(req: IncomingMessage, res: ServerResponse): void {
    // 所有 HTTP 请求均返回前端页面
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(INDEX_HTML);
  }

  // ── WebSocket 连接管理 ─────────────────────────────────────

  private handleWSConnection(ws: WebSocket): void {
    this.conns.add(ws);

    ws.on("close", () => {
      this.conns.delete(ws);
    });

    ws.on("error", () => {
      this.conns.delete(ws);
    });

    // 连接成功后推送会话信息和命令列表
    this.send({
      type: "connected",
      data: { session: this.sessionId, cwd: process.cwd() },
    });
    this.send({ type: "commands", data: this.buildCommandList() });

    // 监听客户端消息
    ws.on("message", (raw: Buffer) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }

      switch (msg.type) {
        case "user_message": {
          const data = msg.data as unknown as UserMessageData;
          // 异步处理用户消息，不阻塞 WS 消息循环
          this.handleUserMessage(data.content);
          break;
        }
        case "permission_response": {
          const data = msg.data as unknown as PermResponseData;
          this.handlePermissionResponse(data);
          break;
        }
        case "ask_user_response": {
          const data = msg.data as unknown as AskUserResponseData;
          this.handleAskUserResponse(data);
          break;
        }
        case "cancel":
          if (this.abortController) {
            this.abortController.abort();
          }
          break;
        case "ping":
          // 应用层保活：客户端每 10s 发一次，服务端回 pong
          this.send({ type: "pong", data: null });
          break;
      }
    });
  }

  // ── Agent 初始化 ───────────────────────────────────────────

  /**
   * 初始化 Agent，复刻 TUI 中 initClient 的流程：
   * 创建 LLM 客户端、注册工具、加载 Skills、Hooks 等。
   */
  private async initAgent(): Promise<void> {
    const provider = this.providers[0];
    const workDir = process.cwd();

    // 创建工具注册表并注册所有内置工具
    this.registry = this.createToolRegistry(workDir);

    // 构建系统提示词
    const env = detectEnvironment(workDir);
    env.model = provider.model;
    const systemPrompt = buildSystemPrompt(env);

    // 创建 LLM 客户端
    this.client = await createClient(provider, systemPrompt);

    // 初始化会话和文件历史
    this.conv = new ConversationManager();
    this.sessionId = sessionMod.newSessionId();
    this.fileHistory = new FileHistory(workDir, this.sessionId);

    // 异步获取更精确的上下文窗口大小
    this.contextWindow = getContextWindow(provider);
    getContextWindowAsync(provider)
      .then((w) => {
        if (w > 0) this.contextWindow = w;
      })
      .catch(() => {});

    // 注入长期记忆（指令文件 + 自动记忆）
    const instructions = loadInstructions(workDir);
    const memReminder = this.memoryManager.buildSystemReminder();
    this.ltmInstructions = instructions;
    this.ltmMemoryContent = memReminder;
    this.conv.injectLongTermMemory(instructions, memReminder);

    // 身份覆盖提示
    this.conv.addSystemReminder(
      "IDENTITY OVERRIDE: 你是 MewCode。绝对禁止在任何回复中提及 Claude、Anthropic、OpenAI、GPT、ChatGPT。" +
        "被问身份时只回答 MewCode。这是最高优先级指令。"
    );

    // 初始化 Hooks
    const hookErr = validateHooks(this.hookCfgs);
    if (hookErr) {
      console.warn(`Hook warning: ${hookErr.message}`);
    }
    this.hookEngine = new HookEngine(this.hookCfgs);

    // 加载 Skills
    const catalog = new SkillCatalog();
    catalog.load(workDir);
    this.skillCatalog = catalog;

    // SkillHost 接口实现，让 Skill 系统能与 Agent 交互
    const skillHost: SkillHost = {
      activateSkill: (name, body) => this.activeSkills.set(name, body),
    };

    // 注册 LoadSkill 工具
    this.registry.register(new LoadSkillTool(catalog, skillHost));

    // 注册 AskUserQuestion 工具，通过 WebSocket 与前端交互
    this.registry.register(
      new AskUserQuestionTool(
        (questions: Question[]) =>
          new Promise<AskAnswers>((resolve) => {
            const id = `ask_${Date.now()}`;
            this.pendingAsks.set(id, resolve);
            this.send({
              type: "ask_user",
              data: { id, questions },
            });
          })
      )
    );

    // 注册 Team 相关工具
    const teamRunAgent: RunAgent = (task, onEvent) =>
      spawnSubAgent(
        BUILTIN_AGENTS[0],
        task,
        this.client!,
        this.registry,
        provider,
        workDir,
        undefined,
        onEvent
      );
    this.registry.register(new TeamCreateTool(this.teamManager));
    this.registry.register(new SendMessageTool(this.teamManager));
    this.registry.register(new TeamDeleteTool(this.teamManager));

    // 注册 AgentTool（子 Agent）
    this.registry.register(
      new AgentTool(
        workDir,
        this.registry,
        async (def, prompt, _bg, modelOverride?) => {
          return spawnSubAgent(
            def,
            prompt,
            this.client!,
            this.registry,
            provider,
            workDir,
            undefined,
            undefined,
            modelOverride,
          );
        },
        undefined, // conversation — 运行时由外部设置
        async (prompt, _conversation, registry, modelOverride?) => {
          // fork 路径：用 cloneRegistryForFork 产生的未过滤注册表
          const { resolveModelId } = await import("../llm/model-resolver.js");
          const { buildSystemPrompt: buildSP, detectEnvironment: detectEnv } = await import("../prompt/builder.js");
          const { ConversationManager: CM } = await import("../conversation/conversation.js");
          const { PermissionChecker: PC } = await import("../permissions/checker.js");
          const { Agent: AgentClass } = await import("../agent/agent.js");

          const resolvedModel = modelOverride
            ? resolveModelId(modelOverride)
            : provider.model;
          const env = detectEnv(workDir);
          env.model = resolvedModel;
          const systemPrompt = buildSP(env);
          const client = modelOverride
            ? await createClient({ ...provider, model: resolvedModel }, systemPrompt)
            : this.client!;

          const checker = new PC(workDir, "acceptEdits");
          // _conversation 是父对话的引用；fork 子 Agent 在其基础上追加 prompt
          _conversation.addUserMessage(prompt);

          const agent = new AgentClass({
            client,
            registry,
            checker,
            conversation: _conversation,
            workDir,
            maxIterations: 200,
          });

          let output = "";
          for await (const event of agent.run()) {
            switch (event.type) {
              case "stream_text":
                output += event.text;
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
        },
      )
    );

    // 加载用户自定义斜杠命令
    for (const cmd of loadUserCommands(workDir)) {
      try {
        this.cmdRegistry.register(cmd);
      } catch {
        // 名称冲突，保留内置命令
      }
    }

    // 将 Skills 注册为斜杠命令
    this.wireSkillsToCommands(catalog, skillHost);
  }

  /**
   * 创建工具注册表并注册所有内置工具。
   */
  private createToolRegistry(workDir: string): ToolRegistry {
    const store = new TaskStore(workDir, this.sessionId);
    const taskList = new TaskList(store);

    const registry = new ToolRegistry();
    registry.register(new ReadFileTool());
    registry.register(new BashTool());
    registry.register(new GlobTool());
    registry.register(new GrepTool());
    registry.register(new WriteFileTool());
    registry.register(new EditFileTool());
    registry.register(new ToolSearchTool(registry));
    registry.register(new EnterWorktreeTool());
    registry.register(new ExitWorktreeTool());
    registry.register(new ExitPlanModeTool());
    registry.register(new TaskCreateTool(taskList));
    registry.register(new TaskGetTool(taskList));
    registry.register(new TaskListTool(taskList));
    registry.register(new TaskUpdateTool(taskList));
    return registry;
  }

  /**
   * 将加载的 Skills 注册为斜杠命令（inline 模式为 prompt 类型）。
   */
  private wireSkillsToCommands(catalog: SkillCatalog, skillHost: SkillHost): void {
    for (const meta of catalog.list()) {
      if (this.cmdRegistry.find(meta.name)) continue;
      const skill = catalog.get(meta.name);
      if (!skill) continue;

      const isFork = skill.meta.mode === "fork";
      try {
        this.cmdRegistry.register({
          name: meta.name,
          aliases: [],
          type: isFork ? "skill_fork" : "prompt",
          description: `${meta.description} [skill]`,
          handler: isFork
            ? () => ""
            : (ctx) => runSkillInline(skill, ctx.args, skillHost),
        });
      } catch {
        // 名称冲突，跳过
      }
    }
  }

  /**
   * 连接 MCP 服务器，注册 MCP 工具并收集服务器指令。
   */
  private async initMCPServers(): Promise<void> {
    if (this.mcpConfigs.length === 0) return;

    const mgr = new MCPManager();
    this.mcpManager = mgr;

    const result = await mgr.connectAll(this.mcpConfigs);

    // 注册所有 MCP 工具
    for (const { serverName, tool } of result.tools) {
      const client = mgr.getClient(serverName);
      if (client) {
        this.registry.register(new MCPToolWrapper(client, serverName, tool));
      }
    }

    // 打印错误
    for (const { serverName, error } of result.errors) {
      console.error(`MCP error [${serverName}]: ${error}`);
    }

    // 收集各 MCP 服务器的指令，构建注入到会话的指令文本
    if (result.instructions.length > 0) {
      const parts = result.instructions.map(
        ({ serverName, text }) => `## ${serverName}\n${text}`
      );
      this.mcpInstructions =
        "# MCP Server Instructions\n\nThe following MCP servers are connected. Use their tools when the user asks.\n\n" +
        parts.join("\n\n");
    }
  }

  // ── 用户消息处理 ──────────────────────────────────────────

  /**
   * 处理来自前端的用户消息：分发到斜杠命令或 Agent 循环。
   */
  private async handleUserMessage(content: string): Promise<void> {
    if (this.streaming) return;

    content = content.trim();
    if (!content) return;

    // 斜杠命令处理
    if (content.startsWith("/")) {
      await this.handleSlashCommand(content);
      return;
    }

    this.streaming = true;
    const workDir = process.cwd();

    // 持久化用户消息
    sessionMod.saveMessage(workDir, this.sessionId, {
      role: "user",
      content,
      timestamp: new Date().toISOString(),
    });

    this.conv.addUserMessage(content);

    // 首次注入 MCP 指令
    if (this.mcpInstructions) {
      this.conv.addSystemReminder(this.mcpInstructions);
      this.mcpInstructions = "";
    }

    await this.runAgentLoop();
  }

  /**
   * 执行 Agent 主循环：创建 Agent 实例，遍历事件流，广播到所有 WS 客户端。
   */
  private async runAgentLoop(): Promise<void> {
    const provider = this.providers[0];
    const workDir = process.cwd();
    const startTime = Date.now();

    const controller = new AbortController();
    this.abortController = controller;

    const checker = new PermissionChecker(workDir, "default");

    const agent = new Agent({
      client: this.client!,
      registry: this.registry,
      checker,
      conversation: this.conv,
      workDir,
      sessionId: this.sessionId,
      hookEngine: this.hookEngine ?? undefined,
      fileHistory: this.fileHistory ?? undefined,
      fileStateCache: this.fileStateCache,
      abortSignal: controller.signal,
      contextWindow: this.contextWindow,
      maxOutput: getMaxOutputTokens(provider),
      recoveryState: this.recoveryState,
      activeSkills: this.activeSkills,
      toolFilter: this.toolFilter ?? undefined,
      instructions: this.ltmInstructions,
      memoryContent: this.ltmMemoryContent,
      notificationFn: () => this.teamManager.drainLeads(),
      onLoopComplete: (conv) => {
        // 异步提取记忆（最佳努力，不阻塞）
        if (!this.client) return;
        const summary = conv
          .getMessages()
          .slice(-40)
          .map((m) => `[${m.role}]: ${m.content}`)
          .filter((s) => s.length > 12)
          .join("\n");
        new MemoryExtractor(this.client, workDir)
          .extract(summary)
          .catch(() => {});
      },
      // 权限请求：构造 Promise，通过 WS 发送到前端，等待前端回复后 resolve
      onPermissionRequest: async (
        toolName: string,
        args: Record<string, unknown>,
        decision: Decision
      ): Promise<"allow" | "deny" | "allowAlways"> => {
        const id = `perm_${Date.now()}`;
        return new Promise<"allow" | "deny" | "allowAlways">((resolve) => {
          this.pendingPerms.set(id, resolve);
          // 构建描述文本
          const desc = this.formatPermissionDesc(toolName, args, decision);
          this.send({
            type: "permission_request",
            data: { id, toolName, description: desc },
          });
        });
      },
    });

    // 消费 Agent 事件流并广播
    let streamBuf = "";

    for await (const event of agent.run()) {
      switch (event.type) {
        case "stream_text":
          streamBuf += event.text;
          this.send({
            type: "stream_text",
            data: { text: event.text },
          });
          break;

        case "thinking_text":
          this.send({
            type: "thinking_text",
            data: { text: event.text },
          });
          break;

        case "tool_use":
          this.send({
            type: "tool_use",
            data: {
              toolId: event.toolId,
              toolName: event.toolName,
              args: event.args,
            },
          });
          break;

        case "tool_result":
          // 工具结果前先结束当前流式文本
          if (streamBuf) {
            this.send({ type: "stream_end", data: { text: streamBuf } });
            streamBuf = "";
          }
          this.send({
            type: "tool_result",
            data: {
              toolId: event.toolId,
              toolName: event.toolName,
              output: event.output,
              isError: event.isError,
              elapsed: event.elapsed,
            },
          });
          break;

        case "turn_complete":
          if (streamBuf) {
            this.send({ type: "stream_end", data: { text: streamBuf } });
            streamBuf = "";
          }
          this.send({ type: "turn_complete", data: {} });
          break;

        case "loop_complete": {
          // 持久化助手回复
          if (streamBuf) {
            sessionMod.saveMessage(workDir, this.sessionId, {
              role: "assistant",
              content: streamBuf,
              timestamp: new Date().toISOString(),
            });
            this.send({ type: "stream_end", data: { text: streamBuf } });
            streamBuf = "";
          }
          const elapsed = (Date.now() - startTime) / 1000;
          this.send({
            type: "loop_complete",
            data: { stopReason: event.stopReason, elapsed },
          });
          break;
        }

        case "usage":
          this.send({
            type: "usage",
            data: {
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
            },
          });
          break;

        case "error":
          this.send({
            type: "error",
            data: { message: event.error.message },
          });
          break;

        case "compact":
          this.send({
            type: "compact",
            data: { message: event.message },
          });
          // 持久化压缩边界
          if (event.boundary) {
            sessionMod.saveCompactBoundary(
              workDir,
              this.sessionId,
              event.boundary
            );
          }
          break;

        case "retry":
          this.send({
            type: "retry",
            data: { reason: event.reason, waitMs: event.delay },
          });
          break;

        case "permission_request":
          // Agent 内部的 permission_request 事件由 onPermissionRequest 回调处理，
          // 不需要在这里额外处理
          break;
      }
    }

    this.streaming = false;
    this.abortController = null;
  }

  // ── 斜杠命令处理 ──────────────────────────────────────────

  /**
   * 处理斜杠命令：解析命令名和参数，分发到对应类型的处理器。
   */
  private async handleSlashCommand(input: string): Promise<void> {
    const parsed = parseCommand(input);
    if (!parsed) return;

    const { name, args } = parsed;
    const cmd = this.cmdRegistry.find(name);

    if (!cmd) {
      this.send({
        type: "error",
        data: { message: `Unknown command: /${name} — type /help to see available commands` },
      });
      this.send({ type: "command_done", data: null });
      return;
    }

    const ctx = this.buildCommandContext(args);

    switch (cmd.type) {
      case "local": {
        // 本地命令直接执行并返回结果
        const result = cmd.handler(ctx);
        this.send({ type: "system", data: { message: result } });
        this.send({ type: "command_done", data: null });
        break;
      }

      case "local_ui":
        // UI 相关命令需要特殊处理
        await this.handleLocalUICommand(name, args);
        break;

      case "prompt": {
        // Prompt 命令生成提示词注入给 Agent
        const prompt = cmd.handler(ctx);
        const displayText = args ? `/${name} ${args}` : `/${name}`;

        this.streaming = true;
        const workDir = process.cwd();
        sessionMod.saveMessage(workDir, this.sessionId, {
          role: "user",
          content: displayText,
          timestamp: new Date().toISOString(),
        });
        this.conv.addUserMessage(prompt);

        if (this.mcpInstructions) {
          this.conv.addSystemReminder(this.mcpInstructions);
          this.mcpInstructions = "";
        }

        await this.runAgentLoop();
        break;
      }

      case "skill_fork":
        // fork 模式的 Skill 在 Remote 模式下暂不支持
        this.send({
          type: "system",
          data: { message: "Fork-mode skills are not yet supported in remote mode." },
        });
        this.send({ type: "command_done", data: null });
        break;
    }
  }

  /**
   * 处理 local_ui 类型的命令（clear/compact/plan/resume 等）。
   */
  private async handleLocalUICommand(name: string, args: string): Promise<void> {
    switch (name) {
      case "clear":
        this.conv = new ConversationManager();
        this.activeSkills.clear();
        this.toolFilter = null;
        this.send({ type: "clear", data: null });
        this.send({ type: "command_done", data: null });
        break;

      case "compact":
        await this.handleCompact();
        break;

      case "plan":
        await this.handlePlan(args);
        break;

      case "resume":
        this.handleResume(args);
        break;

      case "rewind":
        this.send({
          type: "system",
          data: { message: "Rewind is not yet supported in remote mode." },
        });
        this.send({ type: "command_done", data: null });
        break;

      case "quit":
        this.send({
          type: "system",
          data: { message: "Quit is not supported in remote mode. Close the browser tab." },
        });
        this.send({ type: "command_done", data: null });
        break;

      default:
        this.send({ type: "command_done", data: null });
        break;
    }
  }

  /**
   * 构建命令执行上下文。
   */
  private buildCommandContext(args: string): CommandContext {
    const workDir = process.cwd();
    return {
      workDir,
      args,
      permissionMode: () => "default",
      tokenCount: () => [0, 0],
      toolCount: () => this.registry.listTools().length,
      memoryList: () => this.memoryManager.getMemories().map((m) => m.name),
      model: this.providers[0].model,
    };
  }

  /**
   * 处理 /compact 命令：强制压缩对话上下文。
   */
  private async handleCompact(): Promise<void> {
    if (!this.client || !this.conv) {
      this.send({
        type: "error",
        data: { message: "Compact requires an active provider." },
      });
      this.send({ type: "command_done", data: null });
      return;
    }

    this.send({ type: "system", data: { message: "Compacting conversation..." } });

    try {
      const toolNames = this.registry.listTools().map((t) => t.name);
      const toolSchemas = this.registry.getAllSchemas();
      const result = await forceCompact(
        this.conv,
        this.client,
        this.recoveryState,
        toolNames,
        toolSchemas,
        sessionMod.getSessionFilePath(process.cwd(), this.sessionId)
      );
      this.send({
        type: "system",
        data: { message: `⟳ ${result.message}` },
      });
      if (result.boundary) {
        sessionMod.saveCompactBoundary(process.cwd(), this.sessionId, result.boundary);
      }
    } catch (err) {
      this.send({
        type: "error",
        data: { message: (err as Error).message },
      });
    }

    this.send({ type: "command_done", data: null });
  }

  /**
   * 处理 /plan 命令：进入 Plan 模式。
   */
  private async handlePlan(args: string): Promise<void> {
    const workDir = process.cwd();
    const planPath = getOrCreatePlanPath(workDir);

    this.send({
      type: "system",
      data: {
        message: `Entered Plan mode. Plan file: ${planPath}\nExplore the codebase and design your approach.`,
      },
    });

    if (args) {
      // 带参数直接发给 Agent
      this.streaming = true;
      sessionMod.saveMessage(workDir, this.sessionId, {
        role: "user",
        content: `/plan ${args}`,
        timestamp: new Date().toISOString(),
      });
      this.conv.addUserMessage(args);
      await this.runAgentLoop();
    } else {
      this.send({ type: "command_done", data: null });
    }
  }

  /**
   * 处理 /resume 命令：恢复之前的会话。
   */
  private handleResume(args: string): void {
    const workDir = process.cwd();
    const sessions = sessionMod.listSessions(workDir);

    if (!args) {
      // 无参数时列出可选会话
      if (sessions.length === 0) {
        this.send({ type: "system", data: { message: "No previous sessions found." } });
        this.send({ type: "command_done", data: null });
        return;
      }

      const lines: string[] = [`Available sessions (${sessions.length}):\n`];
      for (let i = 0; i < Math.min(sessions.length, 20); i++) {
        const sess = sessions[i];
        let first = sess.firstMessage;
        if (first.length > 60) first = first.slice(0, 60) + "...";
        lines.push(`  ${i + 1}. [${sess.id}] ${first} (${sess.messageCount} msgs)`);
      }
      if (sessions.length > 20) {
        lines.push(`  ... and ${sessions.length - 20} more`);
      }
      lines.push("\nUsage: /resume <number> or /resume <session-id>");
      this.send({ type: "system", data: { message: lines.join("\n") } });
      this.send({ type: "command_done", data: null });
      return;
    }

    // 解析目标会话 ID（支持序号或完整 ID）
    let targetId = args.trim();
    const idx = parseInt(targetId, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= sessions.length) {
      targetId = sessions[idx - 1].id;
    }

    const saved = sessionMod.loadSession(workDir, targetId);
    if (saved.length === 0) {
      this.send({
        type: "error",
        data: { message: `Session '${targetId}' not found or empty.` },
      });
      this.send({ type: "command_done", data: null });
      return;
    }

    // 重建会话
    this.conv = new ConversationManager();
    this.sessionId = targetId;

    const replay = sessionMod.rebuildFromSession(saved);

    // 清除旧 UI，重放消息
    this.send({ type: "clear", data: null });
    for (const msg of replay) {
      if (msg.role === "user") {
        this.conv.addUserMessage(msg.content);
        this.send({ type: "replay_user", data: { content: msg.content } });
      } else if (msg.role === "assistant") {
        this.conv.addAssistantMessage(msg.content);
        this.send({ type: "replay_assistant", data: { content: msg.content } });
      }
    }

    this.send({
      type: "system",
      data: { message: `Session ${targetId} restored (${replay.length} messages).` },
    });
    this.send({ type: "command_done", data: null });
  }

  // ── 权限和 AskUser 响应处理 ───────────────────────────────

  /**
   * 处理前端的权限授权响应。
   */
  private handlePermissionResponse(data: PermResponseData): void {
    const resolve = this.pendingPerms.get(data.id);
    if (!resolve) return;
    this.pendingPerms.delete(data.id);

    switch (data.response) {
      case "allow":
        resolve("allow");
        break;
      case "allowAlways":
        resolve("allowAlways");
        break;
      case "deny":
      default:
        resolve("deny");
        break;
    }
  }

  /**
   * 处理前端的 AskUser 回答响应。
   */
  private handleAskUserResponse(data: AskUserResponseData): void {
    const resolve = this.pendingAsks.get(data.id);
    if (!resolve) return;
    this.pendingAsks.delete(data.id);
    resolve(data.answers);
  }

  // ── 广播和辅助方法 ────────────────────────────────────────

  /**
   * 向所有连接的 WebSocket 客户端广播消息。
   */
  private send(msg: WSMessage): void {
    if (this.conns.size === 0) return;
    const data = JSON.stringify(msg);
    for (const conn of this.conns) {
      if (conn.readyState === WebSocket.OPEN) {
        try {
          conn.send(data);
        } catch {
          // 写入失败时忽略，连接会在 close 事件中清理
        }
      }
    }
  }

  /**
   * 构建命令列表，推送到前端用于斜杠命令菜单。
   */
  private buildCommandList(): Array<{ name: string; description: string }> {
    return this.cmdRegistry.listCommands().map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
    }));
  }

  /**
   * 格式化权限请求描述文本，供前端弹窗展示。
   */
  private formatPermissionDesc(
    toolName: string,
    args: Record<string, unknown>,
    decision: Decision
  ): string {
    const parts: string[] = [];
    if (decision.reason) {
      parts.push(decision.reason);
    }
    // 附加关键参数摘要
    if (args.command) {
      parts.push(`Command: ${String(args.command)}`);
    } else if (args.file_path) {
      parts.push(`File: ${String(args.file_path)}`);
    }
    return parts.join("\n");
  }
}
