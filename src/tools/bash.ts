// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { spawnSync } from "node:child_process";
import type { Tool, ToolResult, ToolContext } from "./types.js";
import { intArg, strArg } from "./types.js";
import { BashDescription } from "./descriptions.js";
import type { Sandbox, SandboxConfig } from "../sandbox/index.js";

const MAX_TIMEOUT = 600;

// 命令退出码语义映射表：某些命令用非零退出码表示正常结果（如 grep 返回 1 表示未匹配到内容）
// 值为判定"真正出错"的最小退出码阈值
const commandErrorThresholds: Map<string, number> = new Map([
  ["grep", 2],   // exit 1 = 未匹配到内容，不算错误
  ["egrep", 2],
  ["fgrep", 2],
  ["rg", 2],     // ripgrep 同 grep 语义
  ["diff", 2],   // exit 1 = 文件有差异，不算错误
  ["test", 2],   // exit 1 = 条件为假，不算错误
  ["[", 2],      // test 的另一种写法
  ["find", 2],   // exit 1 = 部分成功，不算错误
]);

/**
 * 从命令字符串中提取基础命令名。
 * 管道命令取最后一段（bash 默认返回管道最后一个命令的退出码）。
 */
function extractBaseCmd(command: string): string {
  // 按管道符拆分，取最后一段命令
  const lastSegment = command.split("|").pop()?.trim() ?? command;
  // 提取基础命令名：跳过 env 变量赋值和路径前缀
  const tokens = lastSegment.split(/\s+/);
  for (const token of tokens) {
    // 跳过形如 VAR=value 的环境变量设置
    if (token.includes("=") && !token.startsWith("-")) continue;
    // 去掉路径前缀，只保留命令名
    return token.split("/").pop() ?? token;
  }
  return "";
}

/**
 * 根据命令语义判断退出码是否表示错误。
 */
function interpretExitCode(command: string, exitCode: number): boolean {
  const baseCmd = extractBaseCmd(command);
  const threshold = commandErrorThresholds.get(baseCmd);
  if (threshold !== undefined) {
    return exitCode >= threshold;
  }
  // 默认规则：非零即错误
  return exitCode !== 0;
}

// 特殊命令的退出码语义提示，帮助 LLM 理解非零退出码的含义
const exitCodeHints: Map<string, Map<number, string>> = new Map([
  ["grep", new Map([[1, "no matches found"]])],
  ["egrep", new Map([[1, "no matches found"]])],
  ["fgrep", new Map([[1, "no matches found"]])],
  ["rg", new Map([[1, "no matches found"]])],
  ["diff", new Map([[1, "files differ"]])],
  ["test", new Map([[1, "condition is false"]])],
  ["[", new Map([[1, "condition is false"]])],
  ["find", new Map([[1, "partial success"]])],
]);

/**
 * 为特殊命令的非零退出码返回语义提示，帮助 LLM 理解退出码含义。
 * 如果不是已知的特殊命令或退出码，返回空字符串。
 */
function exitCodeHint(command: string, exitCode: number): string {
  const baseCmd = extractBaseCmd(command);
  const hints = exitCodeHints.get(baseCmd);
  return hints?.get(exitCode) ?? "";
}

export class BashTool implements Tool {
  name = "Bash";
  description = BashDescription;
  category = "command" as const;

  // OS 级沙箱实例及配置，由外部注入
  sandbox: Sandbox | null = null;
  sandboxConfig: SandboxConfig = { allowWrite: [], denyWrite: [], networkEnabled: true };

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          timeout: { type: "integer", description: "Timeout in seconds (max 600)", default: 120 },
        },
        required: ["command"],
      },
    };
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = strArg(args, "command");
    if (!command) {
      return { output: "Error: command is required", isError: true };
    }

    let timeout = intArg(args, "timeout", 120);
    if (timeout > MAX_TIMEOUT) timeout = MAX_TIMEOUT;

    // 沙箱包装：如果沙箱可用，将命令包装在沙箱环境中执行
    let actualCommand = command;
    if (this.sandbox?.available()) {
      actualCommand = this.sandbox.wrap(command, this.sandboxConfig);
    }

    // stdout 和 stderr 合并到同一个 fd，与 Claude Code 的 merged fd 对齐
    const result = spawnSync("bash", ["-c", actualCommand], {
      cwd: ctx.workDir,
      timeout: timeout * 1000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.error && result.signal === "SIGTERM") {
      return {
        output: `Error: command timed out after ${timeout}s`,
        isError: true,
      };
    }

    if (result.error && !result.stdout && !result.stderr) {
      return {
        output: `Error executing command: ${result.error.message}`,
        isError: true,
      };
    }

    const exitCode = result.status ?? 0;
    let output = `$ ${command}\n`;
    // 合并 stdout 和 stderr，不加前缀
    if (result.stdout) output += result.stdout;
    if (result.stderr) output += result.stderr;

    if (exitCode !== 0) {
      const hint = exitCodeHint(command, exitCode);
      output += hint
        ? `\nExit code ${exitCode} (${hint})`
        : `\nExit code ${exitCode}`;
    }

    return { output, isError: false };
  }
}
