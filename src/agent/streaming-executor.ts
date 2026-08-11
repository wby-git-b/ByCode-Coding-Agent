// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import type { ToolRegistry } from "../tools/registry.js";
import type { ToolResult, ToolContext } from "../tools/types.js";

interface PendingCall {
  toolId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

interface ExecutionResult {
  toolId: string;
  toolName: string;
  result: ToolResult;
  elapsed: number;
}

export class StreamingExecutor {
  private pending: PendingCall[] = [];
  private registry: ToolRegistry;
  private ctx: ToolContext;

  constructor(registry: ToolRegistry, ctx: ToolContext) {
    this.registry = registry;
    this.ctx = ctx;
  }

  submit(toolId: string, toolName: string, args: Record<string, unknown>): void {
    this.pending.push({ toolId, toolName, arguments: args });
  }

  async collectResults(): Promise<ExecutionResult[]> {
    const calls = [...this.pending];
    this.pending = [];

    const promises = calls.map(async (call) => {
      const tool = this.registry.get(call.toolName);
      const start = Date.now();

      if (!tool) {
        return {
          toolId: call.toolId,
          toolName: call.toolName,
          result: {
            output: `Error: unknown tool '${call.toolName}'`,
            isError: true,
          },
          elapsed: 0,
        };
      }

      try {
        const result = await tool.execute(call.arguments, this.ctx);
        return {
          toolId: call.toolId,
          toolName: call.toolName,
          result,
          elapsed: (Date.now() - start) / 1000,
        };
      } catch (err) {
        return {
          toolId: call.toolId,
          toolName: call.toolName,
          result: {
            output: `Error executing ${call.toolName}: ${(err as Error).message}`,
            isError: true,
          },
          elapsed: (Date.now() - start) / 1000,
        };
      }
    });

    return Promise.all(promises);
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }
}
