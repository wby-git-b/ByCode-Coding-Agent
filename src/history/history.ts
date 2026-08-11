// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const MAX_ENTRIES = 200;
const FILENAME = "prompt_history.jsonl";

export function load(dir: string): string[] {
  const filePath = join(dir, FILENAME);
  if (!existsSync(filePath)) return [];

  try {
    const content = readFileSync(filePath, "utf-8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          const entry = JSON.parse(line) as { text: string };
          return entry.text;
        } catch {
          return "";
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function append(dir: string, text: string): void {
  const filePath = join(dir, FILENAME);
  mkdirSync(dir, { recursive: true });

  const entries = load(dir);

  if (entries.length > 0 && entries[entries.length - 1] === text) {
    return;
  }

  entries.push(text);
  while (entries.length > MAX_ENTRIES) {
    entries.shift();
  }

  const lines = entries.map((t) => JSON.stringify({ text: t })).join("\n") + "\n";
  writeFileSync(filePath, lines, "utf-8");
}
