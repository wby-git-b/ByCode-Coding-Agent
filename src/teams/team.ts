// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { FileMailbox } from "./file-mailbox.js";
import { detectBackend } from "./backend.js";
import type { TeammateUIState } from "./progress.js";
import { createProgress, recordToolUse, recordTokens } from "./progress.js";
import { randomVerb } from "../tui/verbs.js";
import type { ConversationManager } from "../conversation/conversation.js";
import { saveTranscript } from "./transcript.js";

export type TeamMode = "in-process" | "tmux" | "iterm";

// Callback that receives agent events during execution. The team layer uses
// this to update TeammateUIState without depending on the agent/LLM layer.
export type AgentEventCallback = (event: {
  type: string;
  toolName?: string;
  args?: Record<string, unknown>;
  usage?: { inputTokens: number; outputTokens: number };
  text?: string;
}) => void;

export interface Member {
  name: string;
  active: boolean;
  cancel?: () => void;
  mailbox: FileMailbox;
  uiState?: TeammateUIState;
  /** 可选：队友的对话管理器，设置后退出时会持久化 transcript。 */
  conversation?: ConversationManager;
}

// Runs a teammate's task and returns its final output. Injected so the team
// layer stays decoupled from the LLM/agent layer (and is unit-testable).
// The optional onEvent callback lets the team layer observe agent events
// (tool_use, usage) without coupling to the Agent/LLM types directly.
export type RunAgent = (task: string, onEvent?: AgentEventCallback) => Promise<string>;

export class Team {
  name: string;
  mode: TeamMode;
  members = new Map<string, Member>();
  leadMailbox: FileMailbox;
  private mailboxDir: string;
  private workDir: string;

  constructor(name: string, mode: TeamMode, workDir: string) {
    this.name = name;
    this.mode = mode;
    this.workDir = workDir;
    this.mailboxDir = join(workDir, ".mewcode", "teams", name);
    mkdirSync(this.mailboxDir, { recursive: true });
    this.leadMailbox = new FileMailbox(this.mailboxDir, "lead");
  }

  addMember(name: string): Member {
    const mailbox = new FileMailbox(this.mailboxDir, name);
    const member: Member = { name, active: false, mailbox };
    this.members.set(name, member);
    return member;
  }

  // 空闲轮询间隔（毫秒），队友完成一轮后轮询信箱等待新消息
  static readonly IDLE_POLL_INTERVAL_MS = 500;
  // 关机前缀：lead 写入此前缀的消息通知队友退出
  static readonly SHUTDOWN_PREFIX = "[shutdown]";

  /**
   * 启动 in-process 队友：在后台运行 agent 主循环，完成后发送 idle 通知，
   * 然后轮询信箱等待新任务。收到 shutdown 消息或被 cancel 时退出循环。
   * 对齐 Go RunInProcessTeammate 的 idle-poll-continue 模式。
   */
  spawnTeammate(name: string, task: string, runAgent: RunAgent): void {
    const member = this.addMember(name);
    member.active = true;

    // 为进度追踪创建 UI 状态
    const uiState: TeammateUIState = {
      name,
      teamName: this.name,
      status: "running",
      progress: createProgress(),
      startTime: Date.now(),
      spinnerVerb: randomVerb(),
    };
    member.uiState = uiState;

    // agent 事件回调：更新进度
    const onEvent: AgentEventCallback = (event) => {
      switch (event.type) {
        case "tool_use":
          if (event.toolName && event.args) {
            recordToolUse(uiState.progress, event.toolName, event.args);
          }
          break;
        case "usage":
          if (event.usage) {
            recordTokens(
              uiState.progress,
              event.usage.inputTokens,
              event.usage.outputTokens,
            );
          }
          break;
        case "stream_text":
          if (event.text) {
            uiState.lastMessage = event.text;
          }
          break;
      }
    };

    // 主循环：执行任务 → idle 通知 → 轮询信箱 → 收到新消息继续执行
    void (async () => {
      let nextPrompt = task;
      let idleReason = "available";
      try {
        while (member.active) {
          // 执行一轮 agent
          uiState.status = "running";
          const result = await runAgent(nextPrompt, onEvent);
          uiState.lastMessage = result.length > 200 ? result.slice(0, 200) + "..." : result;

          // 向 lead 发送 idle 通知
          uiState.status = "idle";
          await this.leadMailbox.send(
            name,
            `[idle] ${name} (reason: ${idleReason})`
          );
          idleReason = "available";

          // 轮询信箱等待新消息或 shutdown
          const pollResult = await this.waitForNextPromptOrShutdown(member);
          if (pollResult.shutdown || !member.active) break;
          nextPrompt = pollResult.prompt;
        }

        uiState.status = "completed";
      } catch (e) {
        uiState.status = "failed";
        uiState.lastMessage = (e as Error).message;
        await this.leadMailbox.send(name, `[idle] ${name} (reason: failed)`);
      } finally {
        member.active = false;
        if (uiState.status === "running") {
          uiState.status = "idle";
        }
        // 队友退出时持久化对话记录，用于调试
        if (member.conversation) {
          try {
            saveTranscript(this.workDir, this.name, name, member.conversation);
          } catch {
            // best-effort：持久化失败不影响正常退出
          }
        }
      }
    })();
  }

  /**
   * 阻塞等待直到队友信箱有新消息。返回拼接后的 prompt 或 shutdown 标志。
   */
  private async waitForNextPromptOrShutdown(
    member: Member
  ): Promise<{ prompt: string; shutdown: boolean }> {
    while (member.active) {
      await new Promise((r) => setTimeout(r, Team.IDLE_POLL_INTERVAL_MS));
      const msgs = member.mailbox.receiveSync();
      if (msgs.length === 0) continue;

      // 检查是否有 shutdown 请求
      const hasShutdown = msgs.some((m) =>
        m.text.trimStart().startsWith(Team.SHUTDOWN_PREFIX)
      );
      if (hasShutdown) return { prompt: "", shutdown: true };

      // 拼接所有消息作为下一轮的 user prompt
      const prompt = msgs
        .map((m) => `From ${m.from}: ${m.text}`)
        .join("\n\n");
      return { prompt: `You have new messages from your team:\n\n${prompt}`, shutdown: false };
    }
    return { prompt: "", shutdown: true };
  }

  getMember(name: string): Member | undefined {
    return this.members.get(name);
  }

  async sendMessage(from: string, to: string, content: string): Promise<void> {
    const member = this.members.get(to);
    if (!member) {
      throw new Error(`Member '${to}' not found in team '${this.name}'`);
    }
    await member.mailbox.send(from, content);
  }

  async stopMember(name: string): Promise<void> {
    const member = this.members.get(name);
    if (member) {
      member.active = false;
      if (member.uiState && member.uiState.status === "running") {
        member.uiState.status = "stopped";
      }
      member.cancel?.();
    }
  }

  async stopAll(): Promise<void> {
    for (const member of this.members.values()) {
      member.active = false;
      if (member.uiState && member.uiState.status === "running") {
        member.uiState.status = "stopped";
      }
      member.cancel?.();
    }
  }

  listMembers(): Member[] {
    return [...this.members.values()];
  }

  getTeammateStates(): TeammateUIState[] {
    return this.listMembers()
      .filter((m) => m.uiState)
      .map((m) => m.uiState!);
  }
}

export class TeamManager {
  private teams = new Map<string, Team>();
  private workDir: string;

  constructor(workDir: string) {
    this.workDir = workDir;
  }

  create(name: string, mode: TeamMode = detectBackend()): Team {
    const team = new Team(name, mode, this.workDir);
    this.teams.set(name, team);
    return team;
  }

  get(name: string): Team | undefined {
    return this.teams.get(name);
  }

  list(): Team[] {
    return [...this.teams.values()];
  }

  async delete(name: string): Promise<void> {
    const team = this.teams.get(name);
    if (team) {
      await team.stopAll();
      this.teams.delete(name);
    }
  }

  getAllTeammateStates(): TeammateUIState[] {
    return this.list().flatMap((t) => t.getTeammateStates());
  }

  /**
   * 读取所有团队 lead 信箱中的未读消息，以 XML 标签格式返回。
   * 对齐 Go DrainLeadMailbox 的 <team-notification> 格式，
   * 让模型能结构化解析团队通知。
   */
  drainLeads(): string[] {
    const out: string[] = [];
    for (const team of this.teams.values()) {
      const msgs = team.leadMailbox.receiveSync();
      if (msgs.length === 0) continue;
      const lines: string[] = [];
      lines.push(`<team-notification team="${team.name}">`);
      for (const msg of msgs) {
        lines.push(`from=${msg.from}: ${msg.text}`);
      }
      lines.push("</team-notification>");
      out.push(lines.join("\n"));
    }
    return out;
  }
}
