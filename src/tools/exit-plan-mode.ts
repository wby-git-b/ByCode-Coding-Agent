// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import type { Tool, ToolResult, ToolContext } from "./types.js";

export class ExitPlanModeTool implements Tool {
  name = "ExitPlanMode";
  description =
    "Exit plan mode and present the plan for user approval. " +
    "Call this when your plan is complete and written to the plan file.";
  category = "read" as const;
  deferred = false;

  isPlanMode: (() => boolean) | null = null;
  planExists: (() => boolean) | null = null;

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {},
      },
    };
  }

  async execute(
    _args: Record<string, unknown>,
    _ctx: ToolContext
  ): Promise<ToolResult> {
    if (this.isPlanMode && !this.isPlanMode()) {
      return {
        output:
          "You are not in plan mode. This tool is only for exiting plan mode after writing a plan.",
        isError: true,
      };
    }
    if (this.planExists && !this.planExists()) {
      return {
        output:
          "No plan file found. Please write your plan to the plan file before calling ExitPlanMode.",
        isError: true,
      };
    }
    return {
      output:
        "Plan mode will be exited after this turn. " +
        "The user will be shown the plan approval dialog. " +
        "Do not call any more tools — end your turn now.",
      isError: false,
    };
  }
}
