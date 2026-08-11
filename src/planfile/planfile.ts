// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ADJECTIVES = [
  "quiet", "happy", "brave", "calm", "dark", "eager", "fair", "gentle",
  "kind", "lively", "mighty", "noble", "proud", "swift", "warm", "wise",
];

const NOUNS = [
  "falcon", "tiger", "river", "mountain", "forest", "ocean", "eagle",
  "phoenix", "dragon", "thunder", "crystal", "shadow", "flame", "frost",
];

function generateSlug(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const ts = Date.now().toString(36).slice(-4);
  return `${adj}-${noun}-${ts}`;
}

let currentPlanPath: string | null = null;

export function getOrCreatePlanPath(workDir: string): string {
  if (currentPlanPath && existsSync(currentPlanPath)) {
    return currentPlanPath;
  }

  const dir = join(workDir, ".mewcode", "plans");
  mkdirSync(dir, { recursive: true });
  const slug = generateSlug();
  currentPlanPath = join(dir, `${slug}.md`);
  writeFileSync(currentPlanPath, "", "utf-8");
  return currentPlanPath;
}

export function savePlan(workDir: string, content: string): void {
  const path = getOrCreatePlanPath(workDir);
  writeFileSync(path, content, "utf-8");
}

export function loadPlan(workDir: string): string | null {
  if (!currentPlanPath || !existsSync(currentPlanPath)) return null;
  return readFileSync(currentPlanPath, "utf-8");
}

export function planExists(workDir: string): boolean {
  return currentPlanPath !== null && existsSync(currentPlanPath);
}

export function resetPlanPath(): void {
  currentPlanPath = null;
}

export function getCurrentPlanPath(): string | null {
  return currentPlanPath;
}
