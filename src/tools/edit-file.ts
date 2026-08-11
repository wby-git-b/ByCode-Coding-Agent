// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { readFileSync, writeFileSync } from "node:fs";
import type { Tool, ToolResult, ToolContext } from "./types.js";
import { strArg, boolArg } from "./types.js";
import { EditFileDescription } from "./descriptions.js";
import { buildDiff } from "./diff.js";

export class EditFileTool implements Tool {
  name = "EditFile";
  description = EditFileDescription;
  category = "write" as const;

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the file" },
          old_string: { type: "string", description: "Exact string to find and replace" },
          new_string: { type: "string", description: "Replacement string" },
          replace_all: { type: "boolean", description: "Replace all occurrences of old_string (default false)", default: false },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    };
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const filePath = strArg(args, "file_path");
    const oldString = strArg(args, "old_string");
    const newString = strArg(args, "new_string");
    const replaceAll = boolArg(args, "replace_all");

    if (!filePath) return { output: "Error: file_path is required", isError: true };
    if (!oldString) return { output: "Error: old_string is required", isError: true };
    if (oldString === newString) return { output: "Error: old_string and new_string must be different", isError: true };

    // Gate: read-before-edit enforcement
    if (ctx.fileStateCache) {
      const gate = ctx.fileStateCache.check(filePath);
      if (!gate.ok) {
        return { output: gate.error, isError: true };
      }
    }

    ctx.fileHistory?.trackEdit(filePath);

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch (err) {
      return { output: `Error reading file: ${(err as Error).message}`, isError: true };
    }

    const count = content.split(oldString).length - 1;
    if (count === 0) {
      return { output: "Error: old_string not found in file", isError: true };
    }
    if (!replaceAll && count > 1) {
      return {
        output: `Error: old_string found ${count} times in file. It must be unique. Add more surrounding context, or set replace_all to true.`,
        isError: true,
      };
    }

    const newContent = replaceAll
      ? content.replaceAll(oldString, newString)
      : content.replace(oldString, newString);
    try {
      writeFileSync(filePath, newContent, "utf-8");
      ctx.fileStateCache?.update(filePath, newContent);
      // 带上具体 diff 而不是只报一句"改好了"：模型和 TUI 都需要知道具体改了哪几行
      const { text: diffText, additions, removals } = buildDiff(content, newContent);
      const summary = replaceAll && count > 1
        ? `Updated ${filePath} with ${additions} addition${additions === 1 ? "" : "s"} and ${removals} removal${removals === 1 ? "" : "s"} (${count} replacements)`
        : `Updated ${filePath} with ${additions} addition${additions === 1 ? "" : "s"} and ${removals} removal${removals === 1 ? "" : "s"}`;
      return { output: `${summary}\n${diffText}`, isError: false };
    } catch (err) {
      return { output: `Error writing file: ${(err as Error).message}`, isError: true };
    }
  }
}
