// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { execSync } from "node:child_process";
import { platform, arch } from "node:os";
import type { Section, EnvironmentContext } from "./sections.js";
import {
  identitySection,
  systemSection,
  doingTasksSection,
  executingActionsSection,
  usingToolsSection,
  toneStyleSection,
  outputEfficiencySection,
  environmentSection,
} from "./sections.js";

export class PromptBuilder {
  private sections: Section[] = [];

  add(s: Section): this {
    this.sections.push(s);
    return this;
  }

  build(): string {
    const sorted = [...this.sections].sort((a, b) => a.priority - b.priority);
    return sorted
      .map((s) => s.content.trim())
      .filter(Boolean)
      .join("\n\n");
  }
}

export function detectEnvironment(workDir: string): EnvironmentContext {
  const env: EnvironmentContext = {
    workDir,
    os: platform(),
    arch: arch(),
    shell: process.env.SHELL ?? "bash",
    isGitRepo: false,
    gitBranch: "",
    model: "",
    date: new Date().toISOString().split("T")[0],
  };

  try {
    const result = execSync("git rev-parse --is-inside-work-tree", {
      cwd: workDir,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
    if (result === "true") {
      env.isGitRepo = true;
      env.gitBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: workDir,
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf-8",
      }).trim();
    }
  } catch {
    // not a git repo
  }

  return env;
}

export interface BuildOptions {
  skillSection?: string;
  // 用户自定义指令（CLAUDE.md 等），注入到系统提示中
  customInstructions?: string;
  // 自动记忆内容，注入到系统提示中
  memorySection?: string;
}

export function buildSystemPrompt(
  env: EnvironmentContext,
  opts: BuildOptions = {}
): string {
  const b = new PromptBuilder();
  b.add(identitySection());
  b.add(systemSection());
  b.add(doingTasksSection());
  b.add(executingActionsSection());
  b.add(usingToolsSection());
  b.add(toneStyleSection());
  b.add(outputEfficiencySection());
  b.add(environmentSection(env));

  if (opts.skillSection) {
    b.add({ name: "Skills", priority: 90, content: opts.skillSection });
  }

  // 自定义指令（CLAUDE.md 等）优先级高于 skills，低于 memory
  if (opts.customInstructions) {
    b.add({ name: "CustomInstructions", priority: 95, content: opts.customInstructions });
  }

  // 记忆区段排在最后，确保模型看到最新的持久记忆
  if (opts.memorySection) {
    b.add({ name: "Memory", priority: 100, content: opts.memorySection });
  }

  return b.build();
}
