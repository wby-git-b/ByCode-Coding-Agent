// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import type { MCPServerConfig } from "../config/config.js";
import { MCPClient } from "./client.js";
import type { MCPTool } from "./client.js";

export interface ConnectResult {
  tools: { serverName: string; tool: MCPTool }[];
  servers: string[];
  errors: { serverName: string; error: string }[];
  instructions: { serverName: string; text: string }[];
}

export class MCPManager {
  private clients = new Map<string, MCPClient>();

  async connectAll(configs: MCPServerConfig[]): Promise<ConnectResult> {
    const result: ConnectResult = { tools: [], servers: [], errors: [], instructions: [] };

    for (const cfg of configs) {
      const client = new MCPClient(cfg);
      try {
        await client.connect();
        this.clients.set(cfg.name, client);
        result.servers.push(cfg.name);

        const tools = await client.listTools();
        for (const tool of tools) {
          result.tools.push({ serverName: cfg.name, tool });
        }

        const instructions = client.getInstructions();
        if (instructions) {
          result.instructions.push({ serverName: cfg.name, text: instructions });
        }
      } catch (err) {
        result.errors.push({
          serverName: cfg.name,
          error: (err as Error).message,
        });
      }
    }

    return result;
  }

  getClient(name: string): MCPClient | undefined {
    return this.clients.get(name);
  }

  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.disconnect();
    }
    this.clients.clear();
  }
}
