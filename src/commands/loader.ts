// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import type { Command } from "./commands.js";

// Loads user-defined slash commands from .mewcode/commands/*.md (user then
// project, so project wins on a name collision). Subdirectories namespace the
// command name: sub/dir/foo.md → "sub:dir:foo". Mirrors Go LoadUserCommands.
export function loadUserCommands(workDir: string): Command[] {
  const byName = new Map<string, Command>();
  const bases = [
    join(homedir(), ".mewcode", "commands"),
    join(workDir, ".mewcode", "commands"),
  ];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    for (const cmd of walkDir(base, base)) byName.set(cmd.name, cmd);
  }
  return [...byName.values()];
}

function walkDir(base: string, dir: string): Command[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Command[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walkDir(base, full));
    } else if (entry.endsWith(".md")) {
      const cmd = parseCommandFile(base, full);
      if (cmd) out.push(cmd);
    }
  }
  return out;
}

function commandName(base: string, full: string): string {
  const rel = full.slice(base.length + 1).replace(/\.md$/, "");
  return rel
    .split(/[/\\]/)
    .map((p) => p.toLowerCase().replace(/ /g, "-"))
    .join(":");
}

function parseCommandFile(base: string, full: string): Command | null {
  let raw: string;
  try {
    raw = readFileSync(full, "utf-8");
  } catch {
    return null;
  }

  let description = "";
  let argumentHint = "";
  let aliases: string[] = [];
  let body = raw;

  if (raw.startsWith("---")) {
    const end = raw.indexOf("---", 3);
    if (end !== -1) {
      const frontmatter = raw.slice(3, end).trim();
      body = raw.slice(end + 3).trim();
      try {
        const p = yaml.load(frontmatter) as Record<string, unknown> | null;
        description = (p?.description as string) ?? "";
        argumentHint = (p?.["argument-hint"] as string) ?? "";
        aliases = (p?.aliases as string[]) ?? [];
      } catch {
        // ignore frontmatter parse errors; treat whole file as body
      }
    }
  }

  const name = commandName(base, full);
  if (!name) return null;

  return {
    name,
    aliases: Array.isArray(aliases) ? aliases : [],
    type: "prompt",
    description: description || (argumentHint ? `custom command (args: ${argumentHint})` : "custom command"),
    handler: (ctx) => renderBody(body, ctx.args),
  };
}

// Render a command body, substituting $ARGUMENTS; if there is no placeholder and
// args were given, append them. Mirrors Go promptHandler.
export function renderBody(body: string, args: string): string {
  if (body.includes("$ARGUMENTS")) return body.replaceAll("$ARGUMENTS", args);
  if (args) return `${body}\n\n${args}`;
  return body;
}
