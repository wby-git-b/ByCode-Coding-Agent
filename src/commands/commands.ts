// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

export type CommandType = "local" | "local_ui" | "prompt" | "skill_fork";

export interface CommandContext {
  workDir: string;
  args: string;
  conversation?: unknown;
  registry?: unknown;
  /** 返回当前权限模式 */
  permissionMode?: () => string;
  /** 返回 token 用量 [input, output] */
  tokenCount?: () => [number, number];
  /** 返回当前启用的工具数量 */
  toolCount?: () => number;
  /** 返回记忆列表 */
  memoryList?: () => string[];
  /** 清空所有记忆 */
  memoryClear?: () => void;
  /** 返回当前模型名称 */
  model?: string;
}

export interface Command {
  name: string;
  aliases: string[];
  type: CommandType;
  description: string;
  handler: (ctx: CommandContext) => string;
}

export class CommandRegistry {
  private commands = new Map<string, Command>();
  private aliasMap = new Map<string, string>();

  /**
   * 注册命令，检查名称和别名冲突。
   * 名称不能与已有命令名或别名冲突；别名不能与已有命令名或其他别名冲突。
   */
  register(cmd: Command): void {
    // 检查命令名是否与已有命令名冲突
    if (this.commands.has(cmd.name)) {
      throw new Error(`Command '${cmd.name}' already registered`);
    }
    // 检查命令名是否与已有别名冲突
    if (this.aliasMap.has(cmd.name)) {
      throw new Error(
        `Command name '${cmd.name}' collides with alias of '${this.aliasMap.get(cmd.name)}'`
      );
    }
    // 检查每个别名是否与已有命令名或别名冲突
    for (const alias of cmd.aliases) {
      if (this.commands.has(alias)) {
        throw new Error(
          `Alias '${alias}' for '${cmd.name}' collides with existing command name`
        );
      }
      if (this.aliasMap.has(alias)) {
        throw new Error(
          `Alias '${alias}' for '${cmd.name}' already registered by '${this.aliasMap.get(alias)}'`
        );
      }
    }
    this.commands.set(cmd.name, cmd);
    for (const alias of cmd.aliases) {
      this.aliasMap.set(alias, cmd.name);
    }
  }

  /**
   * 检查命令是否会与已注册的命令产生冲突。
   * 动态加载器（如用户自定义命令）应在 register 前调用此方法过滤冲突条目，
   * 因为 register 在冲突时会抛异常。
   */
  hasConflict(cmd: Command): boolean {
    if (this.find(cmd.name)) return true;
    for (const alias of cmd.aliases) {
      if (this.find(alias)) return true;
    }
    return false;
  }

  find(name: string): Command | undefined {
    return this.commands.get(name) ?? this.commands.get(this.aliasMap.get(name) ?? "");
  }

  complete(prefix: string): Command[] {
    const lower = prefix.toLowerCase();
    return [...this.commands.values()].filter(
      (cmd) =>
        cmd.name.toLowerCase().startsWith(lower) ||
        cmd.aliases.some((a) => a.toLowerCase().startsWith(lower))
    );
  }

  listCommands(): Command[] {
    return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

export function parse(input: string): { name: string; args: string } | null {
  if (!input.startsWith("/")) return null;
  const trimmed = input.slice(1).trim();
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { name: trimmed, args: "" };
  }
  return {
    name: trimmed.slice(0, spaceIdx),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}

export function createDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();

  registry.register({
    name: "help",
    aliases: ["h", "?"],
    type: "local",
    description: "Show available commands",
    handler: (ctx) => {
      // 支持 /help <cmd> 查看单个命令详情
      if (ctx.args) {
        const cmd = registry.find(ctx.args);
        if (!cmd) {
          return `Unknown command: ${ctx.args}`;
        }
        let detail = `/${cmd.name} — ${cmd.description}\n`;
        if (cmd.aliases.length > 0) {
          detail += `  Aliases: ${cmd.aliases.join(", ")}\n`;
        }
        return detail;
      }
      // 列出所有命令
      const cmds = registry.listCommands();
      let output = "Available commands:\n\n";
      output += cmds
        .map((c) => {
          const aliases = c.aliases.length > 0
            ? `, /${c.aliases.join(", /")}`
            : "";
          return `  /${c.name}${aliases}\n    ${c.description}`;
        })
        .join("\n");
      output += "\n\nType /help <command> for details.";
      return output;
    },
  });

  registry.register({
    name: "clear",
    aliases: [],
    type: "local_ui",
    description: "Clear conversation history",
    handler: () => "clear",
  });

  registry.register({
    name: "compact",
    aliases: ["c"],
    type: "local_ui",
    description: "Force context compaction",
    handler: () => "compact",
  });

  registry.register({
    name: "status",
    aliases: ["s"],
    type: "local",
    description: "Show current status",
    handler: (ctx) => {
      // 显示实际运行状态而非占位文本
      const lines: string[] = [];
      lines.push("MewCode Status");
      lines.push("──────────────");

      // 权限模式
      const mode = ctx.permissionMode ? ctx.permissionMode() : "default";
      lines.push(`  Mode:      ${mode}`);

      // Token 用量
      if (ctx.tokenCount) {
        const [input, output] = ctx.tokenCount();
        lines.push(`  Tokens:    ${input} in / ${output} out`);
      }

      // 工具数量
      if (ctx.toolCount) {
        lines.push(`  Tools:     ${ctx.toolCount()} enabled`);
      }

      // 记忆数量
      if (ctx.memoryList) {
        const memories = ctx.memoryList();
        lines.push(`  Memories:  ${memories.length} entries`);
      }

      // 模型
      if (ctx.model) {
        lines.push(`  Model:     ${ctx.model}`);
      }

      // 工作目录
      lines.push(`  Directory: ${ctx.workDir}`);

      return lines.join("\n");
    },
  });

  registry.register({
    name: "session",
    aliases: [],
    type: "local",
    description: "Show session info",
    handler: () => "Session is active. Use /resume to list past sessions.",
  });

  registry.register({
    name: "plan",
    aliases: ["p"],
    type: "local_ui",
    description: "Enter plan mode",
    handler: () => "plan",
  });

  registry.register({
    name: "resume",
    aliases: ["r"],
    type: "local_ui",
    description: "Resume a previous session",
    handler: () => "resume",
  });

  registry.register({
    name: "quit",
    aliases: ["exit", "q"],
    type: "local_ui",
    description: "Exit MewCode",
    handler: () => "quit",
  });

  registry.register({
    name: "memory",
    aliases: [],
    type: "local",
    description: "Show memory status",
    handler: () => "memory",
  });

  registry.register({
    name: "permission",
    aliases: ["perm"],
    type: "local",
    description: "Show/change permission mode",
    handler: () => "permission",
  });

  registry.register({
    name: "skills",
    aliases: [],
    type: "local_ui",
    description: "List available skills",
    handler: () => "skills",
  });

  registry.register({
    name: "worktree",
    aliases: ["wt"],
    type: "local_ui",
    description: "Manage git worktrees",
    handler: () => "worktree",
  });

  registry.register({
    name: "code-review",
    aliases: ["cr"],
    type: "local",
    description: "Manage code review team (create, add, remove, list)",
    handler: (ctx) => {
      const args = ctx.args.trim();
      if (!args) {
        return "Usage: /code-review <command> [args]\nCommands: create, add <name>, remove <name>, list, status";
      }
      return `code-review:${args}`;
    },
  });

  registry.register({
    name: "review",
    aliases: [],
    type: "prompt",
    description: "Review the uncommitted code changes for bugs and improvements",
    handler: (ctx) =>
      "Review the current uncommitted changes. Run `git status` and `git diff` to see them, " +
      "then report concrete findings (file:line) for correctness bugs, security issues, and obvious " +
      "simplifications. Be specific and concise." +
      (ctx.args ? `\n\nFocus on: ${ctx.args}` : ""),
  });

  registry.register({
    name: "rewind",
    aliases: [],
    type: "local_ui",
    description: "Rewind conversation to a previous checkpoint",
    handler: () => "rewind",
  });

  registry.register({
    name: "mcp",
    aliases: [],
    type: "local",
    description: "Show MCP server connection status",
    handler: () => "mcp",
  });

  // /sandbox 命令：查看和切换沙箱模式
  registry.register({
    name: "sandbox",
    aliases: ["sb"],
    type: "local_ui",
    description: "Toggle OS sandbox mode for command execution",
    handler: () => "sandbox",
  });

  return registry;
}
