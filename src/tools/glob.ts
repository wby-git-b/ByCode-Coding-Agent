// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Tool, ToolResult, ToolContext } from "./types.js";
import { strArg, SKIP_DIRS } from "./types.js";
import { GlobDescription } from "./descriptions.js";

export class GlobTool implements Tool {
  name = "Glob";
  description = GlobDescription;
  category = "read" as const;

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern (e.g., '**/*.ts')" },
          path: { type: "string", description: "Base directory to search from", default: "." },
        },
        required: ["pattern"],
      },
    };
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = strArg(args, "pattern");
    if (!pattern) {
      return { output: "Error: pattern is required", isError: true };
    }

    const basePath = strArg(args, "path", ctx.workDir);

    try {
      const glob = new Bun.Glob(pattern);
      const matches: string[] = [];

      for (const entry of glob.scanSync({
        cwd: basePath,
        dot: false,
      })) {
        const parts = entry.split("/");
        if (parts.some((p) => SKIP_DIRS.has(p))) continue;
        matches.push(entry);
        if (matches.length >= 1000) break;
      }

      // 按修改时间倒序，最近修改的排前面
      matches.sort((a, b) => {
        try {
          const ma = statSync(join(basePath, a)).mtimeMs;
          const mb = statSync(join(basePath, b)).mtimeMs;
          return mb - ma;
        } catch {
          return a.localeCompare(b);
        }
      });

      if (matches.length === 0) {
        return { output: "No files matched the pattern.", isError: false };
      }

      return { output: matches.join("\n"), isError: false };
    } catch (err) {
      return { output: `Error: ${(err as Error).message}`, isError: true };
    }
  }
}
