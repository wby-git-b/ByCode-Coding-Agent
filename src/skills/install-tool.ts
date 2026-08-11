// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, isAbsolute, basename } from "node:path";
import type { Tool, ToolResult } from "../tools/types.js";
import { strArg } from "../tools/types.js";
import type { SkillCatalog } from "./catalog.js";

function nameFromFrontmatter(content: string): string {
  if (!content.startsWith("---")) return "";
  const end = content.indexOf("---", 3);
  if (end === -1) return "";
  const m = content.slice(3, end).match(/(?:^|\n)\s*name:\s*(.+)/);
  return m ? m[1].trim() : "";
}

// Installs a skill from a local file path or an https URL into
// .mewcode/skills/<name>/SKILL.md, then reloads the catalog. Mirrors Go's
// InstallSkill tool.
export class InstallSkillTool implements Tool {
  name = "InstallSkill";
  description = "Install a skill from a local file path or an https URL into .mewcode/skills.";
  category = "read" as const;
  system = true;

  constructor(
    private workDir: string,
    private catalog: SkillCatalog,
    private onInstalled?: () => void
  ) {}

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Local path or https URL to a SKILL.md" },
          name: { type: "string", description: "Optional skill name (defaults to frontmatter name)" },
        },
        required: ["source"],
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const source = strArg(args, "source");
    if (!source) return { output: "Error: source is required", isError: true };

    let content: string;
    if (/^https?:\/\//.test(source)) {
      try {
        const resp = await fetch(source);
        if (!resp.ok) return { output: `Error: fetch failed (${resp.status})`, isError: true };
        content = await resp.text();
      } catch (e) {
        return { output: `Error fetching skill: ${(e as Error).message}`, isError: true };
      }
    } else {
      const p = isAbsolute(source) ? source : join(this.workDir, source);
      if (!existsSync(p)) return { output: `Error: file not found: ${source}`, isError: true };
      content = readFileSync(p, "utf-8");
    }

    const name = strArg(args, "name") || nameFromFrontmatter(content) || basename(source).replace(/\.md$/, "");
    if (!name) return { output: "Error: could not determine skill name", isError: true };

    const dir = join(this.workDir, ".mewcode", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), content, "utf-8");

    this.catalog.load(this.workDir);
    this.onInstalled?.();

    return { output: `Skill '${name}' installed to .mewcode/skills/${name}/SKILL.md`, isError: false };
  }
}
