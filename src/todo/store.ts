// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Task } from "./todo.js";

export class TaskStore {
  private filePath: string;

  // Session-scoped store: .mewcode/tasks/<listId>.json (mirrors Go NewStore).
  constructor(workDir: string, listId: string) {
    this.filePath = join(workDir, ".mewcode", "tasks", `${listId}.json`);
  }

  load(): Task[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const data = readFileSync(this.filePath, "utf-8");
      return JSON.parse(data) as Task[];
    } catch {
      return [];
    }
  }

  save(tasks: Task[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(tasks, null, 2), "utf-8");
  }
}
