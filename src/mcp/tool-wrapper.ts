// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import type { Tool, ToolResult, ToolContext } from "../tools/types.js";
import type { MCPClient, MCPTool } from "./client.js";

function sanitizeName(serverName: string, toolName: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `mcp__${clean(serverName)}__${clean(toolName)}`;
}

export class MCPToolWrapper implements Tool {
  name: string;
  description: string;
  category = "command" as const;
  // MCP 工具默认延迟加载，避免把所有 schema 塞进 prompt
  deferred = true;

  private client: MCPClient;
  private originalName: string;
  private inputSchema: Record<string, unknown>;

  constructor(client: MCPClient, serverName: string, tool: MCPTool) {
    this.name = sanitizeName(serverName, tool.name);
    this.description = tool.description;
    this.originalName = tool.name;
    this.client = client;
    this.inputSchema = tool.inputSchema;
  }

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.inputSchema,
    };
  }

  async execute(
    args: Record<string, unknown>,
    _ctx: ToolContext
  ): Promise<ToolResult> {
    try {
      const output = await this.client.callTool(this.originalName, args);
      return { output, isError: false };
    } catch (err) {
      return {
        output: `MCP tool error: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}
