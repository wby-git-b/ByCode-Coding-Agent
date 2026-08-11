// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import type { Skill, SkillMeta } from "./skill.js";
import { loadBuiltins } from "./builtins.js";

/** 内部存储的 skill 附带源文件路径和加载时间戳，用于热重载 */
interface CatalogEntry {
  skill: Skill;
  /** SKILL.md 的绝对路径，用于热重载时重新读取 */
  filePath: string;
  /** 上次加载时文件的修改时间（ms），0 表示内嵌 skill 无需重载 */
  loadedMtimeMs: number;
}

export class SkillCatalog {
  private entries = new Map<string, CatalogEntry>();
  private workDir = "";
  private dirModTimes = new Map<string, number>();

  load(workDir: string): void {
    this.workDir = workDir;
    // 三层加载，后面的覆盖前面的同名 skill：
    // Tier 1: 内置 skill（当前为空）
    for (const skill of loadBuiltins()) {
      this.entries.set(skill.meta.name, {
        skill,
        filePath: "",
        loadedMtimeMs: 0,
      });
    }

    // Tier 2: 用户全局 ~/.mewcode/skills/
    // Tier 3: 项目级 $workDir/.mewcode/skills/（最高优先级）
    const dirs = [
      join(homedir(), ".mewcode", "skills"),
      join(workDir, ".mewcode", "skills"),
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      this.scanDirectory(dir);
    }

    this.snapshotDirModTimes();
  }

  /**
   * 检查 skill 目录的 modtime 是否变化（新增或删除了 skill）。
   * 已有 skill 的文件编辑由 get() 的按需重读处理。
   */
  needsReload(): boolean {
    for (const [dir, recorded] of this.dirModTimes) {
      try {
        const current = statSync(dir).mtimeMs;
        if (current !== recorded) return true;
      } catch {
        if (recorded !== 0) return true;
      }
    }
    const dirs = this.skillDirPaths();
    for (const dir of dirs) {
      if (!this.dirModTimes.has(dir)) {
        try {
          statSync(dir);
          return true;
        } catch {
          // 目录仍不存在
        }
      }
    }
    return false;
  }

  reload(): void {
    this.entries.clear();
    this.load(this.workDir);
  }

  private snapshotDirModTimes(): void {
    this.dirModTimes.clear();
    for (const dir of this.skillDirPaths()) {
      try {
        this.dirModTimes.set(dir, statSync(dir).mtimeMs);
      } catch {
        this.dirModTimes.set(dir, 0);
      }
    }
  }

  private skillDirPaths(): string[] {
    return [
      join(homedir(), ".mewcode", "skills"),
      ...(this.workDir ? [join(this.workDir, ".mewcode", "skills")] : []),
    ];
  }

  private scanDirectory(dir: string): void {
    let dirEntries: string[];
    try {
      dirEntries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of dirEntries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        const skillFile = join(fullPath, "SKILL.md");
        if (existsSync(skillFile)) {
          this.loadSkill(skillFile, fullPath, true);
        }
      } else if (entry.endsWith(".md") && entry !== "SKILL.md") {
        this.loadSkill(fullPath, dir, false);
      }
    }
  }

  private loadSkill(filePath: string, sourceDir: string, isDirectory: boolean): void {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = parseSkillFile(raw);
      if (!parsed) return;

      const skill: Skill = {
        meta: parsed.meta,
        body: parsed.body,
        sourceDir,
        isDirectory,
      };

      // 记录文件修改时间，用于后续热重载检测
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch {
        // 无法获取时间戳时不影响加载
      }

      this.entries.set(skill.meta.name, {
        skill,
        filePath,
        loadedMtimeMs: mtimeMs,
      });
    } catch {
      // 跳过无效 skill
    }
  }

  list(): SkillMeta[] {
    return [...this.entries.values()].map((e) => e.skill.meta);
  }

  /**
   * 获取 skill，支持热重载：如果磁盘文件已被修改，自动重新读取。
   * 对齐 Go 版 GetFull：每次调用时重新读取 body（热重载），
   * 读取失败时保留已缓存的 body。
   */
  get(name: string): Skill | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;

    // 尝试热重载：检查文件是否已修改
    if (entry.filePath && entry.loadedMtimeMs > 0) {
      try {
        const currentMtime = statSync(entry.filePath).mtimeMs;
        if (currentMtime > entry.loadedMtimeMs) {
          // 文件已修改，重新读取
          const raw = readFileSync(entry.filePath, "utf-8");
          const parsed = parseSkillFile(raw);
          if (parsed) {
            entry.skill = {
              meta: parsed.meta,
              body: parsed.body,
              sourceDir: entry.skill.sourceDir,
              isDirectory: entry.skill.isDirectory,
            };
            entry.loadedMtimeMs = currentMtime;
          }
          // 解析失败时保留已缓存版本（与 Go 行为一致）
        }
      } catch {
        // 读取失败时保留已缓存版本
      }
    }

    return entry.skill;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }
}

function parseSkillFile(
  content: string
): { meta: SkillMeta; body: string } | null {
  if (!content.startsWith("---")) return null;

  const endIdx = content.indexOf("---", 3);
  if (endIdx === -1) return null;

  const frontmatter = content.slice(3, endIdx).trim();
  const body = content.slice(endIdx + 3).trim();

  try {
    const raw = yaml.load(frontmatter) as Record<string, unknown> | null;
    if (!raw?.name) return null;

    return {
      meta: {
        name: raw.name as string,
        description: (raw.description as string) ?? "",
        mode: (raw.mode as "inline" | "fork") ?? "inline",
        model: raw.model as string | undefined,
        forkContext: raw.fork_context as "full" | "recent" | "none" | undefined,
      },
      body,
    };
  } catch {
    return null;
  }
}
