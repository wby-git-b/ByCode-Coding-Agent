// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve, isAbsolute, relative } from "node:path";
import { homedir } from "node:os";

/** @include 最大递归深度，防止无限嵌套 */
const MAX_INCLUDE_DEPTH = 5;

/** 已加载的指令文件 */
export interface InstructionSource {
  path: string;
  content: string;
}

/**
 * 发现并拼接所有项目和用户级指令文件。
 *
 * 发现顺序（越靠后优先级越高，模型注意力优先关注后面的内容）：
 *  1. 用户全局: ~/.mewcode/MEWCODE.md, ~/.mewcode/AGENTS.md
 *  2. 项目: 从 git root 到 workDir 路径上每个目录的 MEWCODE.md 和 AGENTS.md
 *  3. workDir/.mewcode/INSTRUCTIONS.md（兼容旧格式）
 *  4. workDir/MEWCODE.local.md（本地私有覆盖）
 *
 * 支持 @include 指令：
 *  - @./relative/path, @~/home/path, @/absolute/path
 *  - 相对于包含文件所在目录解析
 *  - 在 fenced code block 内忽略
 *  - 循环检测（同一绝对路径不会被包含两次）
 */
export function loadInstructions(workDir: string): string {
  const sources = discoverInstructions(workDir);
  if (sources.length === 0) return "";

  const parts: string[] = [];
  for (const s of sources) {
    // 尽量用相对路径作为标签，更易读
    let label = s.path;
    try {
      const rel = relative(workDir, s.path);
      if (!rel.startsWith("..")) label = rel;
    } catch {
      // 保持绝对路径
    }
    parts.push(`Contents of ${label}:\n\n${s.content.replace(/\n+$/, "")}`);
  }
  return parts.join("\n\n---\n\n");
}

/**
 * 按优先级顺序返回所有已加载的指令源文件。
 * 最低优先级在前（用户全局），最高在后（本地覆盖）。
 */
export function discoverInstructions(workDir: string): InstructionSource[] {
  const sources: InstructionSource[] = [];
  const seen = new Set<string>();

  // 1. 用户全局指令
  try {
    const home = homedir();
    addSource(sources, seen, join(home, ".mewcode", "MEWCODE.md"));
    addSource(sources, seen, join(home, ".mewcode", "AGENTS.md"));
  } catch {
    // $HOME 不可用时跳过
  }

  // 2. 从 git root 到 workDir 的每个目录
  const dirs = projectInstructionDirs(workDir);
  for (const dir of dirs) {
    addSource(sources, seen, join(dir, "MEWCODE.md"));
    addSource(sources, seen, join(dir, "AGENTS.md"));
  }

  // 3. 兼容旧格式
  addSource(sources, seen, join(workDir, ".mewcode", "INSTRUCTIONS.md"));

  // 4. 本地私有覆盖
  addSource(sources, seen, join(workDir, "MEWCODE.local.md"));

  return sources;
}

/** 尝试读取一个指令文件并添加到列表，支持 @include 展开 */
function addSource(
  out: InstructionSource[],
  seen: Set<string>,
  filePath: string
): void {
  let abs: string;
  try {
    abs = resolve(filePath);
  } catch {
    return;
  }
  if (seen.has(abs)) return;
  if (!existsSync(abs)) return;

  let data: string;
  try {
    data = readFileSync(abs, "utf-8");
  } catch {
    return;
  }
  seen.add(abs);
  const content = expandIncludes(data, dirname(abs), seen, 0);
  out.push({ path: abs, content });
}

/**
 * 递归展开 @include 指令。
 * 在 fenced code block 内的 @ 行不做处理。
 * 同一绝对路径不会被包含两次（cycle-safe）。
 */
function expandIncludes(
  content: string,
  baseDir: string,
  seen: Set<string>,
  depth: number
): string {
  if (depth > MAX_INCLUDE_DEPTH) return content;

  const lines = content.split("\n");
  const out: string[] = [];
  let inCode = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // 检测 fenced code block 边界
    if (trimmed.startsWith("```")) {
      inCode = !inCode;
      out.push(line);
      continue;
    }

    if (!inCode) {
      const includePath = parseInclude(trimmed);
      if (includePath) {
        const resolved = resolveInclude(includePath, baseDir);
        if (resolved) {
          let abs: string;
          try {
            abs = resolve(resolved);
          } catch {
            out.push(line);
            continue;
          }
          if (!seen.has(abs)) {
            try {
              const data = readFileSync(abs, "utf-8");
              seen.add(abs);
              out.push(`<!-- included from ${includePath} -->`);
              out.push(expandIncludes(data, dirname(abs), seen, depth + 1));
              continue;
            } catch {
              // 读取失败，保留原始行让用户看到
            }
          }
        }
        // 无法解析或已包含，保留原始行
      }
    }

    out.push(line);
  }

  return out.join("\n");
}

/**
 * 解析 @include 行：@./path, @~/path, @/abs/path。
 * 其他 @-token（如 @username）会被忽略以避免误识别。
 */
function parseInclude(trimmed: string): string {
  // 必须以 @ 开头，但 @@ 是转义不处理
  if (!trimmed.startsWith("@") || trimmed.startsWith("@@")) return "";

  const rest = trimmed.slice(1);
  if (!rest) return "";
  // 不能包含空格或制表符（排除 @username 等情况）
  if (/[\s\t]/.test(rest)) return "";

  // 只接受相对路径、~/路径、绝对路径
  if (
    rest.startsWith("./") ||
    rest.startsWith("../") ||
    rest.startsWith("~/") ||
    rest.startsWith("/")
  ) {
    return rest;
  }
  return "";
}

/** 将 include 路径解析为绝对路径 */
function resolveInclude(p: string, baseDir: string): string {
  if (p.startsWith("~/")) {
    try {
      return join(homedir(), p.slice(2));
    } catch {
      return "";
    }
  }
  if (isAbsolute(p)) return p;
  return join(baseDir, p);
}

/**
 * 返回从 git root 到 workDir 的目录列表。
 * 如果 workDir 不在 git 仓库内，只返回 [workDir]。
 */
function projectInstructionDirs(workDir: string): string[] {
  let abs: string;
  try {
    abs = resolve(workDir);
  } catch {
    return [workDir];
  }

  const root = findGitRoot(abs);
  if (!root) return [abs];

  // 从 abs 向上收集到 root
  const dirs: string[] = [];
  let cur = abs;
  while (true) {
    dirs.unshift(cur);
    if (cur === root) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

/** 向上查找 .git 目录以确定 git 仓库根 */
function findGitRoot(start: string): string {
  let cur = start;
  while (true) {
    try {
      const gitPath = join(cur, ".git");
      if (existsSync(gitPath)) return cur;
    } catch {
      // ignore
    }
    const parent = dirname(cur);
    if (parent === cur) return "";
    cur = parent;
  }
}
