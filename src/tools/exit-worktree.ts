// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import type { Tool, ToolResult, ToolContext } from "./types.js";
import { strArg } from "./types.js";
import { removeAgentWorktree, hasWorktreeChanges } from "../worktree/worktree.js";

export class ExitWorktreeTool implements Tool {
  name = "ExitWorktree";
  description = "Exit and optionally clean up a git worktree.";
  category = "write" as const;
  deferred = true;

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Worktree path" },
          branch: { type: "string", description: "Worktree branch name" },
          git_root: { type: "string", description: "Git root directory" },
          head_commit: { type: "string", description: "Original HEAD commit for change detection" },
        },
        required: ["path", "branch", "git_root"],
      },
    };
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const path = strArg(args, "path");
    const branch = strArg(args, "branch");
    const gitRoot = strArg(args, "git_root");
    const headCommit = strArg(args, "head_commit");

    if (!path || !branch || !gitRoot) {
      return { output: "Error: path, branch, and git_root are required", isError: true };
    }

    const hasChanges = headCommit ? hasWorktreeChanges(path, headCommit) : false;

    if (!hasChanges) {
      try {
        removeAgentWorktree(path, branch, gitRoot);
        return { output: `Worktree cleaned up (no changes): ${path}`, isError: false };
      } catch (err) {
        return { output: `Error cleaning up worktree: ${(err as Error).message}`, isError: true };
      }
    }

    return {
      output: `Worktree has changes, kept at: ${path}\nBranch: ${branch}`,
      isError: false,
    };
  }
}
