// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import type { Tool, ToolResult, ToolContext } from "./types.js";
import { strArg, intArg } from "./types.js";
import type { ToolRegistry } from "./registry.js";

export class ToolSearchTool implements Tool {
  name = "ToolSearch";
  description = "Search for and load deferred tools by name or keyword.";
  category = "read" as const;
  system = true;
  private registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'Search query. Use "select:name1,name2" to load specific tools by name, or keywords to search.',
          },
          max_results: { type: "integer", description: "Max results to return", default: 5 },
        },
        required: ["query"],
      },
    };
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const query = strArg(args, "query");
    const maxResults = intArg(args, "max_results", 5);

    if (!query) {
      return { output: "Error: query is required", isError: true };
    }

    // Handle "select:name1,name2" syntax
    if (query.startsWith("select:")) {
      const names = query.slice(7).split(",").map((n) => n.trim());
      const tools = this.registry.findDeferredByNames(names);
      for (const t of tools) {
        this.registry.markDiscovered(t.name);
      }
      if (tools.length === 0) {
        return { output: `No deferred tools found matching: ${names.join(", ")}`, isError: false };
      }
      const schemas = tools.map((t) => JSON.stringify(t.schema(), null, 2));
      return { output: schemas.join("\n\n"), isError: false };
    }

    // Keyword search
    const tools = this.registry.searchDeferred(query, maxResults);
    if (tools.length === 0) {
      return { output: "No deferred tools matched the query.", isError: false };
    }

    const lines = tools.map(
      (t) => `- ${t.name}: ${t.description.slice(0, 100)}`
    );
    return { output: lines.join("\n"), isError: false };
  }
}
