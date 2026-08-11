// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import type { Tool } from "./types.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private discovered = new Set<string>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  listTools(): Tool[] {
    return [...this.tools.values()];
  }

  getAllSchemas(protocol: "anthropic" | "openai" | "openai-compat" = "anthropic"): Record<string, unknown>[] {
    const schemas: Record<string, unknown>[] = [];
    for (const tool of this.tools.values()) {
      if (tool.deferred && !this.discovered.has(tool.name)) continue;
      const base = tool.schema();
      if (protocol === "openai" || protocol === "openai-compat") {
        schemas.push({
          type: "function",
          function: {
            name: base.name,
            description: base.description,
            parameters: base.input_schema,
          },
        });
      } else {
        schemas.push(base);
      }
    }
    return schemas;
  }

  getDeferredToolNames(): string[] {
    const names: string[] = [];
    for (const tool of this.tools.values()) {
      if (tool.deferred && !this.discovered.has(tool.name)) {
        names.push(tool.name);
      }
    }
    return names;
  }

  getDeferredTools(): Tool[] {
    return [...this.tools.values()].filter(
      (t) => t.deferred && !this.discovered.has(t.name)
    );
  }

  searchDeferred(query: string, maxResults = 5): Tool[] {
    const lower = query.toLowerCase();
    const matches: Tool[] = [];
    for (const tool of this.tools.values()) {
      if (!tool.deferred || this.discovered.has(tool.name)) continue;
      if (
        tool.name.toLowerCase().includes(lower) ||
        tool.description.toLowerCase().includes(lower)
      ) {
        matches.push(tool);
        if (matches.length >= maxResults) break;
      }
    }
    return matches;
  }

  findDeferredByNames(names: string[]): Tool[] {
    return names
      .map((n) => this.tools.get(n))
      .filter((t): t is Tool => t !== undefined && t.deferred === true);
  }

  markDiscovered(name: string): void {
    this.discovered.add(name);
  }

  isDiscovered(name: string): boolean {
    return this.discovered.has(name);
  }
}
