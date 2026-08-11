// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Tool, ToolResult, ToolContext } from "./types.js";
import { strArg } from "./types.js";
import { WriteFileDescription } from "./descriptions.js";

export class WriteFileTool implements Tool {
  name = "WriteFile";
  description = WriteFileDescription;
  category = "write" as const;

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to write" },
          content: { type: "string", description: "Content to write" },
        },
        required: ["file_path", "content"],
      },
    };
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const filePath = strArg(args, "file_path");
    const content = strArg(args, "content");
    if (!filePath) {
      return { output: "Error: file_path is required", isError: true };
    }

    // Gate: read-before-write enforcement (skip for new files)
    if (ctx.fileStateCache && existsSync(filePath)) {
      const gate = ctx.fileStateCache.check(filePath);
      if (!gate.ok) {
        return { output: gate.error, isError: true };
      }
    }

    try {
      ctx.fileHistory?.trackEdit(filePath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, "utf-8");
      ctx.fileStateCache?.update(filePath, content);
      const lineCount = content.split("\n").length;
      return { output: `File written: ${filePath} (${lineCount} lines)`, isError: false };
    } catch (err) {
      return { output: `Error writing file: ${(err as Error).message}`, isError: true };
    }
  }
}
