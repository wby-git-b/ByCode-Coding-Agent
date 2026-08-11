// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import type { Tool, ToolResult, ToolContext } from "./types.js";
import { strArg } from "./types.js";
import { createAgentWorktree } from "../worktree/worktree.js";

export class EnterWorktreeTool implements Tool {
  name = "EnterWorktree";
  description = "Create and enter a git worktree for isolated work.";
  category = "write" as const;
  deferred = true;

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Short identifier for the worktree" },
        },
        required: ["slug"],
      },
    };
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const slug = strArg(args, "slug");
    if (!slug) {
      return { output: "Error: slug is required", isError: true };
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
      return { output: "Error: slug must contain only alphanumeric, hyphen, underscore", isError: true };
    }

    try {
      const result = createAgentWorktree(slug);
      return {
        output: `Worktree created at: ${result.path}\nBranch: ${result.branch}\nHead: ${result.headCommit}`,
        isError: false,
      };
    } catch (err) {
      return { output: `Error creating worktree: ${(err as Error).message}`, isError: true };
    }
  }
}
