// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";

interface UsageEntry {
  usageCount: number;
  lastUsedAt: number;
}

export class CommandUsageTracker {
  private usage = new Map<string, UsageEntry>();
  private filePath: string;

  constructor(workDir: string) {
    const dir = join(workDir, ".mewcode");
    this.filePath = join(dir, "command_usage.json");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.load();
  }

  record(name: string): void {
    const existing = this.usage.get(name);
    this.usage.set(name, {
      usageCount: (existing?.usageCount ?? 0) + 1,
      lastUsedAt: Date.now(),
    });
    this.save();
  }

  getScore(name: string): number {
    const entry = this.usage.get(name);
    if (!entry) return 0;
    const daysSince = (Date.now() - entry.lastUsedAt) / (1000 * 60 * 60 * 24);
    const recency = Math.pow(0.5, daysSince / 7);
    return entry.usageCount * Math.max(recency, 0.1);
  }

  getRecentlyUsed(limit = 5): string[] {
    return [...this.usage.entries()]
      .map(([name, entry]) => ({ name, score: this.getScore(name) }))
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((e) => e.name);
  }

  private load(): void {
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf-8"));
      for (const [name, entry] of Object.entries(data)) {
        this.usage.set(name, entry as UsageEntry);
      }
    } catch {
      // file doesn't exist yet
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(
        this.filePath,
        JSON.stringify(Object.fromEntries(this.usage), null, 2),
      );
    } catch {
      // ignore write errors
    }
  }
}
