// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { MCPServerConfig } from "../config/config.js";

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type AnyTransport =
  | StdioClientTransport
  | StreamableHTTPClientTransport
  | SSEClientTransport;

// Expand ${VAR} / $VAR references in config values from the environment so
// secrets (API keys etc.) can live in env vars rather than the config file.
function expandEnv(value: string): string {
  return value.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, a, b) => process.env[a ?? b] ?? "");
}

export class MCPClient {
  name: string;
  private config: MCPServerConfig;
  private client: Client | null = null;
  private transport: AnyTransport | null = null;

  constructor(config: MCPServerConfig) {
    this.name = config.name;
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.config.command) {
      // stdio transport
      const env: Record<string, string> = { ...(process.env as Record<string, string>) };
      if (this.config.env) {
        for (const [k, v] of Object.entries(this.config.env)) env[k] = expandEnv(v);
      }
      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        env,
        stderr: "ignore",
      });
    } else if (this.config.url) {
      // http / sse transport
      const url = new URL(this.config.url);
      const headers: Record<string, string> = {};
      if (this.config.headers) {
        for (const [k, v] of Object.entries(this.config.headers)) headers[k] = expandEnv(v);
      }
      const opts = { requestInit: { headers } };
      this.transport =
        this.config.transport === "sse"
          ? new SSEClientTransport(url, opts)
          : new StreamableHTTPClientTransport(url, opts);
    } else {
      throw new Error(
        `MCP server '${this.name}': needs either 'command' (stdio) or 'url' (http/sse)`
      );
    }

    this.client = new Client({ name: "mewcode", version: "0.1.0" }, {});
    await this.client.connect(this.transport);
  }

  // The server's instructions from the initialize result, if any.
  getInstructions(): string {
    return this.client?.getInstructions() ?? "";
  }

  async listTools(): Promise<MCPTool[]> {
    if (!this.client) throw new Error("Not connected");
    const result = await this.client.listTools();
    return (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<string> {
    if (!this.client) throw new Error("Not connected");
    const result = await this.client.callTool({ name, arguments: args });
    if (result.content && Array.isArray(result.content)) {
      return result.content
        .map((c: { type: string; text?: string }) =>
          c.type === "text" ? c.text ?? "" : JSON.stringify(c)
        )
        .join("\n");
    }
    return JSON.stringify(result);
  }

  async disconnect(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // ignore
    }
    this.client = null;
    this.transport = null;
  }
}
