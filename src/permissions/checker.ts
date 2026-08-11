// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";

export type DecisionEffect = "allow" | "deny" | "ask";
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface Decision {
  effect: DecisionEffect;
  reason: string;
}

type RuleEffect = "allow" | "deny" | "ask";

interface Rule {
  tool: string;
  pattern: string;
  effect: RuleEffect;
}

// 危险命令模式：每项携带匹配原因，用于 HITL 展示
interface DangerousPattern {
  re: RegExp;
  reason: string;
}

const DANGEROUS_PATTERNS: DangerousPattern[] = [
  { re: /rm\s+(-rf?|--recursive)\s+[\/~]/, reason: "recursive force delete root" },
  { re: /rm\s+-rf?\s+\*/, reason: "recursive force delete wildcard" },
  { re: /mkfs\./, reason: "format disk" },
  { re: /dd\s+if=/, reason: "direct write to disk device" },
  { re: />\s*\/dev\/sd/, reason: "overwrite disk device" },
  { re: /chmod\s+-R?\s*777\s+\//, reason: "recursive chmod root" },
  { re: /:\(\)\{\s*:\|\s*:\s*&\s*\}\s*;/, reason: "fork bomb" },
  { re: /curl\s+.*\|\s*(ba)?sh/, reason: "pipe remote script" },
  { re: /wget\s+.*\|\s*(ba)?sh/, reason: "pipe remote script" },
  { re: /git\s+push\s+.*--force/, reason: "force push" },
  { re: /git\s+reset\s+--hard/, reason: "hard reset" },
  { re: /git\s+clean\s+-f/, reason: "force clean untracked files" },
  { re: /git\s+checkout\s+\./, reason: "discard all changes" },
  { re: /git\s+branch\s+-D/, reason: "force delete branch" },
];

const SAFE_PREFIXES = [
  "ls", "pwd", "echo", "cat", "head", "tail", "wc", "date",
  "whoami", "uname", "hostname", "which", "type", "file",
  "git status", "git log", "git diff", "git branch",
  "git show", "git rev-parse", "git remote",
  "bun test", "bun run", "npm test", "npm run",
  "go test", "go build", "go vet",
  "python -c", "node -e",
];

// Per-tool argument field treated as the "content" for safe/dangerous checks
// and rule matching. Mirrors Go contentFields.
const CONTENT_FIELDS: Record<string, string> = {
  Bash: "command",
  ReadFile: "file_path",
  WriteFile: "file_path",
  EditFile: "file_path",
  Glob: "pattern",
  Grep: "pattern",
};

export function extractContent(toolName: string, args: Record<string, unknown>): string {
  const field = CONTENT_FIELDS[toolName];
  if (!field) return "";
  const v = args[field];
  return typeof v === "string" ? v : "";
}

// 默认拒绝写入的敏感路径（相对于项目根目录）
const DEFAULT_DENY_WRITE = [
  ".mewcode/config.yaml",
  ".mewcode/permissions.local.yaml",
  ".mewcode/skills/",
];

export class PathSandbox {
  private allowedRoots: string[];
  private denyWritePaths: string[];
  private projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = resolve(projectDir);
    this.allowedRoots = [this.projectDir, "/tmp"];
    // 将相对路径转为绝对路径
    this.denyWritePaths = DEFAULT_DENY_WRITE.map((p) => join(this.projectDir, p));
  }

  addRoot(root: string): void {
    this.allowedRoots.push(resolve(root));
  }

  // 添加自定义拒绝写入路径
  addDenyWrite(path: string): void {
    this.denyWritePaths.push(resolve(path));
  }

  /**
   * 检查路径是否在拒绝写入列表中。
   * denyWrite 优先级最高——即使路径在允许根目录内，也会被拒绝写入。
   */
  checkDenyWrite(filePath: string): Decision | null {
    const absolute = resolve(filePath);
    for (const denied of this.denyWritePaths) {
      if (absolute.startsWith(denied)) {
        return {
          effect: "deny",
          reason: `Path ${filePath} is in deny-write list`,
        };
      }
    }
    return null;
  }

  check(filePath: string): Decision | null {
    const absolute = resolve(filePath);
    for (const root of this.allowedRoots) {
      if (absolute.startsWith(root)) return null;
    }
    return {
      effect: "deny",
      reason: `Path ${filePath} is outside allowed directories`,
    };
  }
}

// Glob match mirroring Go filepath.Match: `*` matches a run of non-separator
// characters, `?` matches a single non-separator character.
function globMatch(pattern: string, content: string): boolean {
  const re =
    "^" +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      // Bash 命令中 * 应匹配包括 / 在内的任意字符（命令不是路径）
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".") +
    "$";
  try {
    return new RegExp(re).test(content);
  } catch {
    return false;
  }
}

const RULE_RE = /^(\w+)\((.+)\)$/;

// Loads a rules file in Go's format: a top-level YAML list of
// `{ rule: "Tool(pattern)", effect: "allow"|"deny" }`.
function loadRulesFile(path: string): Rule[] {
  let data: string;
  try {
    data = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(data);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const rules: Rule[] = [];
  for (const entry of parsed as { rule?: string; effect?: string }[]) {
    if (entry.effect !== "allow" && entry.effect !== "deny" && entry.effect !== "ask") continue;
    const m = (entry.rule ?? "").trim().match(RULE_RE);
    if (!m) continue;
    rules.push({ tool: m[1], pattern: m[2], effect: entry.effect });
  }
  return rules;
}

export class RuleEngine {
  private userPath: string;
  private projectPath: string;
  private localPath: string;

  constructor(workDir: string) {
    this.userPath = join(homedir(), ".mewcode", "permissions.yaml");
    this.projectPath = join(workDir, ".mewcode", "permissions.yaml");
    this.localPath = join(workDir, ".mewcode", "permissions.local.yaml");
  }

  // Loads the three rule files fresh on every call (so a just-written
  // "allow always" rule takes effect immediately) and returns the first match
  // scanning user → project → local, last-rule-wins within each file.
  evaluate(toolName: string, content: string): RuleEffect | null {
    for (const path of [this.userPath, this.projectPath, this.localPath]) {
      const rules = loadRulesFile(path);
      for (let i = rules.length - 1; i >= 0; i--) {
        const r = rules[i];
        if (r.tool !== toolName && r.tool !== "*") continue;
        if (globMatch(r.pattern, content)) return r.effect;
      }
    }
    return null;
  }

  // Persists a rule to the project-local YAML file in Go's `Tool(pattern)`
  // format so "allow always" survives a restart.
  appendLocalRule(rule: Rule): void {
    mkdirSync(dirname(this.localPath), { recursive: true });
    const rules = loadRulesFile(this.localPath);
    rules.push(rule);
    const entries = rules.map((r) => ({ rule: `${r.tool}(${r.pattern})`, effect: r.effect }));
    writeFileSync(this.localPath, yaml.dump(entries), "utf-8");
  }
}

// 检测危险命令，返回匹配的原因（空字符串表示安全）
function detectDangerous(command: string): string {
  for (const p of DANGEROUS_PATTERNS) {
    if (p.re.test(command)) return p.reason;
  }
  return "";
}

function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  // Reject anything with shell metacharacters: a "safe" prefix like `cat` must
  // not become a gateway to piping/chaining/redirection/substitution.
  if (
    trimmed.includes(">") ||
    trimmed.includes("|") ||
    trimmed.includes(";") ||
    trimmed.includes("&&") ||
    trimmed.includes("$(") ||
    trimmed.includes("`")
  ) {
    return false;
  }
  return SAFE_PREFIXES.some(
    (prefix) =>
      trimmed === prefix ||
      trimmed.startsWith(prefix + " ") ||
      trimmed.startsWith(prefix + "\t")
  );
}

function modeDecide(
  mode: PermissionMode,
  category: "read" | "write" | "command"
): DecisionEffect {
  switch (mode) {
    case "bypassPermissions":
      return "allow";
    case "plan":
      return category === "read" ? "allow" : "ask";
    case "acceptEdits":
      return category === "command" ? "ask" : "allow";
    case "default":
    default:
      return category === "read" ? "allow" : "ask";
  }
}

export class PermissionChecker {
  mode: PermissionMode;
  planFilePath = "";
  // 沙箱模式：开启后 command 类工具走 OS 沙箱隔离，可选自动放行
  sandboxEnabled = false;
  sandboxAutoAllow = false;
  private sandbox: PathSandbox;
  private ruleEngine: RuleEngine;
  // Layer 4b: 会话级临时放行集合（内存中，进程退出即失效）
  // key 格式 "ToolName:pattern"，匹配后直接放行，不写入磁盘
  private sessionAllowed = new Set<string>();

  constructor(workDir: string, mode: PermissionMode = "default") {
    this.mode = mode;
    this.sandbox = new PathSandbox(workDir);
    this.ruleEngine = new RuleEngine(workDir);
  }

  check(
    toolName: string,
    category: "read" | "write" | "command",
    args: Record<string, unknown>
  ): Decision {
    const content = extractContent(toolName, args);

    // Layer 0: plan-mode plan-file write exception.
    // Both WriteFile and EditFile targeting the plan file are allowed so the
    // model can create and update its plan. Mirrors Go's category-level check
    // against CategoryWrite (which covers both tools).
    if (this.mode === "plan" && (toolName === "WriteFile" || toolName === "EditFile")) {
      const path = String(args.file_path ?? "");
      if (path.includes(".mewcode/plans/")) {
        return { effect: "allow", reason: "Plan file write allowed in plan mode" };
      }
    }

    // Layer 2: safe read-only command auto-allow (metachar-guarded).
    if (category === "command" && isSafeCommand(content)) {
      return { effect: "allow", reason: "Safe read-only command" };
    }

    // Layer 3: dangerous command block — reason 记录具体匹配的模式
    const dangerReason = category === "command" ? detectDangerous(content) : "";
    if (dangerReason) {
      return { effect: "deny", reason: `Dangerous command blocked: ${dangerReason}` };
    }

    // Layer 3.5: 沙箱自动放行——OS 沙箱已隔离写入，非危险命令可跳过人工确认。
    // 对齐 Claude Code checkSandboxAutoAllow：拆分复合命令逐条检查 deny/ask 规则。
    if (this.sandboxEnabled && this.sandboxAutoAllow && category === "command") {
      const subcommands = String(args.command ?? "")
        .split(/\s*(?:&&|\|\||[;|])\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
      let hasAsk = false;
      for (const sub of subcommands) {
        const ruleResult = this.ruleEngine.evaluate(toolName, sub);
        if (ruleResult === "deny") {
          return { effect: "deny", reason: "Permission rule: deny" };
        }
        if (ruleResult === "ask") {
          hasAsk = true;
        }
      }
      if (hasAsk) {
        return { effect: "ask", reason: "Permission rule: ask (sandbox does not override)" };
      }
      return { effect: "allow", reason: "Sandbox auto-allow: OS sandbox active" };
    }

    // Layer 4: path sandbox (file tools only).
    const filePath = String(args.file_path ?? args.path ?? "");
    if ((category === "read" || category === "write") && filePath) {
      // denyWrite 检查优先：敏感路径始终拒绝写入
      if (category === "write") {
        const denyDecision = this.sandbox.checkDenyWrite(filePath);
        if (denyDecision) {
          return denyDecision;
        }
      }
      const sandboxDecision = this.sandbox.check(filePath);
      if (sandboxDecision && this.mode !== "bypassPermissions") {
        return { effect: "ask", reason: sandboxDecision.reason };
      }
    }

    // Layer 4b: 会话级临时放行——检查内存中的 sessionAllowed 集合
    const sessionKey = `${toolName}:${content}`;
    if (this.sessionAllowed.has(sessionKey)) {
      return { effect: "allow", reason: "Session allow: previously approved" };
    }

    // Layer 5: rule engine — per-tool content + glob match.
    const ruleEffect = this.ruleEngine.evaluate(toolName, content);
    if (ruleEffect) {
      return { effect: ruleEffect, reason: `Permission rule: ${ruleEffect}` };
    }

    // Layer 6: mode matrix.
    return {
      effect: modeDecide(this.mode, category),
      reason: `Mode: ${this.mode}`,
    };
  }

  // 会话级放行：仅在当前进程生命周期内生效，不写入磁盘
  allowForSession(toolName: string, args: Record<string, unknown>): void {
    const content = extractContent(toolName, args);
    this.sessionAllowed.add(`${toolName}:${content}`);
  }

  // Persist a scoped "allow always" rule. The pattern is derived from the
  // tool's content field (capped at 60 chars) so it allows that specific
  // command/path family rather than the whole tool. Mirrors Go.
  allowAlways(toolName: string, args: Record<string, unknown>): void {
    const content = extractContent(toolName, args);
    const pattern = content.length > 60 ? content.slice(0, 60) + "*" : content + "*";
    this.ruleEngine.appendLocalRule({ tool: toolName, pattern, effect: "allow" });
  }

  /**
   * 生成可读的工具操作描述，用于 HITL 确认对话框展示。
   * 优先提取 contentFields 定义的字段（如 command、file_path），
   * 无匹配时回退到 key:value 格式的参数摘要。
   */
  describeToolAction(toolName: string, args: Record<string, unknown>): string {
    const content = extractContent(toolName, args);
    if (content) return content;
    // 回退：拼接所有参数的 key: value，截断过长值
    const parts: string[] = [];
    for (const [k, v] of Object.entries(args)) {
      let s = String(v);
      if (s.length > 80) s = s.slice(0, 80) + "...";
      parts.push(`${k}: ${s}`);
    }
    return parts.join(", ");
  }
}
