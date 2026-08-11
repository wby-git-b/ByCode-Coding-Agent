// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import type { AgentDefinition } from "./definition.js";
import { BUILTIN_AGENTS } from "./definition.js";

/**
 * 加载 Agent 定义：内置 → 用户级 (~/.mewcode/agents/) → 项目级 (.mewcode/agents/)。
 * 后加载的同名定义覆盖先前的，优先级：项目 > 用户 > 内置。
 */
export function loadAgentDefinitions(workDir: string): AgentDefinition[] {
  const definitions = [...BUILTIN_AGENTS];

  // 用户级目录：~/.mewcode/agents/
  const home = homedir();
  if (home) {
    loadDir(join(home, ".mewcode", "agents"), definitions);
  }

  // 项目级目录：<workDir>/.mewcode/agents/
  const dirs = [join(workDir, ".mewcode", "agents")];
  for (const dir of dirs) {
    loadDir(dir, definitions);
  }

  return definitions;
}

/** 扫描目录下所有 .md 文件并解析为 Agent 定义，同名覆盖 */
function loadDir(dir: string, definitions: AgentDefinition[]): void {
  if (!existsSync(dir)) return;

  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), "utf-8");
      const def = parseAgentDefinition(content);
      if (def) {
        const existing = definitions.findIndex((d) => d.name === def.name);
        if (existing >= 0) {
          definitions[existing] = def;
        } else {
          definitions.push(def);
        }
      }
    } catch {
      continue;
    }
  }
}

function parseAgentDefinition(content: string): AgentDefinition | null {
  if (!content.startsWith("---")) return null;
  const endIdx = content.indexOf("---", 3);
  if (endIdx === -1) return null;

  const frontmatter = content.slice(3, endIdx).trim();
  const body = content.slice(endIdx + 3).trim();

  try {
    const raw = yaml.load(frontmatter) as Record<string, unknown> | null;
    if (!raw?.name) return null;

    return {
      name: raw.name as string,
      description: (raw.description as string) ?? body.slice(0, 200),
      tools: raw.tools as string[] | undefined,
      disallowedTools: raw.disallowed_tools as string[] | undefined,
      systemPromptOverride: raw.system_prompt as string | undefined,
      maxTurns: raw.max_turns as number | undefined,
      model: raw.model as string | undefined,
      background: raw.background as boolean | undefined,
      isolation: raw.isolation as "worktree" | undefined,
      initialPrompt: body || undefined,
    };
  } catch {
    return null;
  }
}
