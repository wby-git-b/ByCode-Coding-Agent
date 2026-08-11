// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { LLMClient } from "../llm/client.js";
import { ConversationManager, type ToolUseBlock } from "../conversation/conversation.js";
import { MemoryManager } from "./manager.js";
import { ToolRegistry } from "../tools/registry.js";
import { ReadFileTool } from "../tools/read-file.js";
import { WriteFileTool } from "../tools/write-file.js";
import { EditFileTool } from "../tools/edit-file.js";
import { GlobTool } from "../tools/glob.js";
import { GrepTool } from "../tools/grep.js";
import { Agent } from "../agent/agent.js";
import { PermissionChecker } from "../permissions/checker.js";

/**
 * MemoryExtractor 实现后台记忆提取子代理。
 * 参照 Go 版 extractor.go 和 Claude Code 的 extractMemories.ts：
 * - 用子 agent + 工具（ReadFile/WriteFile/EditFile）替代裸 LLM 调用
 * - 提取前发送已有记忆 manifest 给 LLM 做去重
 * - turnsSinceLastExtraction 节流
 * - inProgress + pendingContext 合并策略
 */
export class MemoryExtractor {
  private client: LLMClient;
  private workDir: string;
  private inProgress = false;
  private pendingContext: string | null = null;
  private turnsSinceLastExtraction = 0;
  private lastMemoryMessageIdx = 0;

  constructor(client: LLMClient, workDir: string) {
    this.client = client;
    this.workDir = workDir;
  }

  async extract(conversationSummary: string): Promise<string[]> {
    if (this.inProgress) {
      this.pendingContext = conversationSummary;
      return [];
    }
    return this.runExtraction(conversationSummary, false);
  }

  private async runExtraction(conversationSummary: string, isTrailingRun: boolean): Promise<string[]> {
    // 节流：至少间隔 1 轮（trailing run 跳过节流）
    if (!isTrailingRun) {
      this.turnsSinceLastExtraction++;
      if (this.turnsSinceLastExtraction < 1) {
        return [];
      }
    }
    this.turnsSinceLastExtraction = 0;

    this.inProgress = true;
    let result: string[] = [];

    try {
      result = await this.doExtract(conversationSummary);
    } finally {
      this.inProgress = false;
      const pending = this.pendingContext;
      this.pendingContext = null;
      if (pending !== null) {
        const trailingResult = await this.runExtraction(pending, true);
        result = [...result, ...trailingResult];
      }
    }

    return result;
  }

  /** 扫描已有记忆文件，生成 manifest 给 LLM 做去重 */
  private scanExistingMemories(): string {
    const dirs = [
      join(this.workDir, ".mewcode", "memory"),
      join(homedir(), ".mewcode", "memory"),
    ];
    const entries: string[] = [];

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        const files = readdirSync(dir).filter(f => f.endsWith(".md") && f !== "MEMORY.md");
        for (const file of files) {
          try {
            const content = readFileSync(join(dir, file), "utf-8");
            const nameMatch = content.match(/name:\s*(.+)/);
            const typeMatch = content.match(/type:\s*(.+)/);
            const descMatch = content.match(/description:\s*(.+)/);
            const name = nameMatch?.[1]?.trim() ?? file;
            const type = typeMatch?.[1]?.trim() ?? "reference";
            const desc = descMatch?.[1]?.trim() ?? "";
            entries.push(`- [${type}] ${file}: ${desc}`);
          } catch {}
        }
      } catch {}
    }

    return entries.length > 0 ? entries.join("\n") : "";
  }

  /** 构建提取 prompt（参照 Go 版 prompts.go） */
  private buildExtractionPrompt(conversationSummary: string): string {
    const manifest = this.scanExistingMemories();
    const projectMemDir = join(this.workDir, ".mewcode", "memory");
    const userMemDir = join(homedir(), ".mewcode", "memory");

    let manifestSection = "";
    if (manifest) {
      manifestSection = `\n\n## Existing memory files\n\n${manifest}\n\nCheck this list before writing — update an existing file rather than creating a duplicate.`;
    }

    return [
      `You are now acting as the memory extraction subagent. Analyze the conversation below and use the tools to update persistent memory files.`,
      ``,
      `Available tools: ReadFile, WriteFile, EditFile, Glob, Grep. EditFile requires a prior ReadFile of the same file.`,
      ``,
      `You have a limited turn budget. The efficient strategy is: turn 1 — issue all ReadFile calls in parallel for every file you might update; turn 2 — issue all WriteFile/EditFile calls in parallel.`,
      ``,
      `You MUST only use content from the conversation to update memories. Do not investigate source code.${manifestSection}`,
      ``,
      `## Memory storage paths`,
      ``,
      `- \`user\` and \`feedback\` type → write to \`${userMemDir}/\` (user-level; follows the human across projects)`,
      `- \`project\` and \`reference\` type → write to \`${projectMemDir}/\` (project-level; lives with this repo)`,
      ``,
      `Pick the type first, then write the memory file (and its MEMORY.md pointer) into the matching directory.`,
      ``,
      `## Memory types`,
      ``,
      `- **user**: Information about the user's role, goals, preferences, knowledge`,
      `- **feedback**: Guidance the user gave about how to approach work (corrections AND confirmations)`,
      `- **project**: Ongoing work, goals, decisions, deadlines within the project`,
      `- **reference**: Pointers to external resources (URLs, docs, tools)`,
      ``,
      `## What NOT to save`,
      ``,
      `- Code patterns, architecture, file paths — derivable from reading the project`,
      `- Git history — use git log/blame`,
      `- Debugging solutions — the fix is in the code`,
      `- Anything in CLAUDE.md / MEWCODE.md files`,
      `- Ephemeral task details, current conversation context`,
      ``,
      `## How to save memories`,
      ``,
      `**Step 1** — write the memory to its own file using this frontmatter format:`,
      ``,
      "```markdown",
      `---`,
      `name: {{short-kebab-case-slug}}`,
      `description: {{one-line summary}}`,
      `metadata:`,
      `  type: {{user, feedback, project, reference}}`,
      `---`,
      ``,
      `{{memory content}}`,
      "```",
      ``,
      `**Step 2** — add a pointer to MEMORY.md in the SAME directory. Each entry one line: \`- [Title](file.md) — one-line hook\``,
      ``,
      `- Do not write duplicate memories. Check existing files first.`,
      `- If no memories are worth saving, do nothing.`,
      ``,
      `## Conversation to analyze`,
      ``,
      conversationSummary,
    ].join("\n");
  }

  /** 核心提取逻辑：用子 agent + 工具 */
  private async doExtract(conversationSummary: string): Promise<string[]> {
    const extractionPrompt = this.buildExtractionPrompt(conversationSummary);

    // 构建子 agent 的工具注册表（只包含文件操作工具）
    const subRegistry = new ToolRegistry();
    subRegistry.register(new ReadFileTool());
    subRegistry.register(new WriteFileTool());
    subRegistry.register(new EditFileTool());
    subRegistry.register(new GlobTool());
    subRegistry.register(new GrepTool());

    // bypass 权限（后台 agent 不需要用户确认）
    const subChecker = new PermissionChecker(this.workDir, "bypassPermissions");

    const forkedConv = new ConversationManager();
    forkedConv.addUserMessage(extractionPrompt);

    const subAgent = new Agent({
      client: this.client,
      registry: subRegistry,
      checker: subChecker,
      conversation: forkedConv,
      workDir: this.workDir,
      maxIterations: 5,
    });

    // 驱动子 agent 到完成，不传播事件到 UI
    for await (const _event of subAgent.run()) {
      // drain
    }

    // 从子 agent 的对话中提取写入的文件路径
    const writtenPaths = this.extractWrittenPaths(forkedConv.getMessages());

    // 过滤掉 MEMORY.md 索引文件
    const memoryPaths = writtenPaths.filter(p => basename(p) !== "MEMORY.md");

    // 写入后重建索引
    if (memoryPaths.length > 0) {
      const mgr = new MemoryManager(this.workDir);
      mgr.rebuildIndex();
    }

    return memoryPaths.map(p => basename(p).replace(/\.md$/i, ""));
  }

  /** 从对话消息中提取 WriteFile/EditFile 工具调用的文件路径 */
  private extractWrittenPaths(
    messages: Array<{ role: string; content: string; toolUses?: ToolUseBlock[] }>
  ): string[] {
    const paths: string[] = [];
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      // Structured tool calls: read file_path from WriteFile/EditFile arguments.
      for (const tu of msg.toolUses ?? []) {
        const filePath = tu.arguments?.file_path;
        if (
          typeof filePath === "string" &&
          (filePath.includes("memory") || filePath.endsWith(".md"))
        ) {
          paths.push(filePath);
        }
      }
      // Fallback: tool_use JSON embedded in plain text.
      // 匹配 tool_use 中的 file_path 参数
      const filePathMatches = msg.content.matchAll(/"file_path"\s*:\s*"([^"]+)"/g);
      for (const m of filePathMatches) {
        if (m[1] && (m[1].includes("memory") || m[1].endsWith(".md"))) {
          paths.push(m[1]);
        }
      }
    }
    return [...new Set(paths)];
  }
}
