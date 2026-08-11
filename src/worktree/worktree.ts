// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join, dirname, isAbsolute } from "node:path";

export interface WorktreeResult {
  path: string;
  branch: string;
  headCommit: string;
  gitRoot: string;
}

// ── 纯文件系统 git HEAD 读取 ──────────────────────────────────
// 以下函数通过直接读取 .git/ 目录下的文件来获取分支和 SHA，
// 不启动 git 子进程，在大仓库（百万级对象）中可节省 ~15ms 的
// 进程启动开销。

/** 允许的 ref 名称字符集——防止路径遍历和 shell 注入 */
const SAFE_REF_RE = /^[a-zA-Z0-9/._+@-]+$/;

/** 完整 SHA-1 (40 hex) 或 SHA-256 (64 hex) */
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function isSafeRefName(name: string): boolean {
  if (!name || name.startsWith("-") || name.startsWith("/")) return false;
  if (name.includes("..")) return false;
  for (const seg of name.split("/")) {
    if (seg === "." || seg === "") return false;
  }
  return SAFE_REF_RE.test(name);
}

/**
 * 解析 .git 目录：处理 worktree/submodule 场景下 .git 是文件而非目录的情况。
 * 返回空字符串表示非 git 仓库。
 */
export function resolveGitDir(root: string): string {
  const gitPath = join(root, ".git");
  if (!existsSync(gitPath)) return "";
  const st = statSync(gitPath);
  if (st.isDirectory()) return gitPath;

  // Worktree / submodule：.git 是包含 `gitdir: <path>` 的文件
  const raw = readFileSync(gitPath, "utf-8").trim();
  if (!raw.startsWith("gitdir:")) return "";
  const rel = raw.slice("gitdir:".length).trim();
  return isAbsolute(rel) ? rel : join(root, rel);
}

/** 读取 worktree gitDir 中的 commondir 文件以定位共享 git 目录 */
function getCommonDir(gitDir: string): string {
  try {
    const raw = readFileSync(join(gitDir, "commondir"), "utf-8").trim();
    return isAbsolute(raw) ? raw : join(gitDir, raw);
  } catch {
    return "";
  }
}

interface GitHead {
  branch?: string; // 非空表示在分支上
  sha?: string;    // 非空表示 detached HEAD
}

/**
 * 解析 <gitDir>/HEAD 文件获取当前分支或 detached SHA。
 * 返回 null 表示文件不存在或格式异常。
 */
function readGitHead(gitDir: string): GitHead | null {
  let raw: string;
  try {
    raw = readFileSync(join(gitDir, "HEAD"), "utf-8").trim();
  } catch {
    return null;
  }

  if (raw.startsWith("ref:")) {
    const ref = raw.slice("ref:".length).trim();
    if (ref.startsWith("refs/heads/")) {
      const name = ref.slice("refs/heads/".length);
      if (!isSafeRefName(name)) return null;
      return { branch: name };
    }
    // 非标准 symref（如 bisect）——解析为 SHA
    if (!isSafeRefName(ref)) return null;
    const sha = resolveRef(gitDir, ref);
    return sha ? { sha } : null;
  }

  // 裸 SHA (detached HEAD)
  if (SHA_RE.test(raw)) return { sha: raw };
  return null;
}

/** 在单个 git 目录中解析 ref（先查 loose 文件，再查 packed-refs） */
function resolveRefInDir(dir: string, ref: string): string {
  // 先查 loose ref 文件
  try {
    const content = readFileSync(join(dir, ref), "utf-8").trim();
    if (content.startsWith("ref:")) {
      const target = content.slice("ref:".length).trim();
      if (!isSafeRefName(target)) return "";
      return resolveRef(dir, target);
    }
    if (SHA_RE.test(content)) return content;
    return "";
  } catch {
    // loose 文件不存在，尝试 packed-refs
  }

  // 查 packed-refs
  try {
    const packed = readFileSync(join(dir, "packed-refs"), "utf-8");
    for (const line of packed.split("\n")) {
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx === -1) continue;
      if (line.slice(spaceIdx + 1) === ref) {
        const sha = line.slice(0, spaceIdx);
        if (SHA_RE.test(sha)) return sha;
        return "";
      }
    }
  } catch {
    // packed-refs 不存在
  }

  return "";
}

/** 解析 git ref——先查 worktree gitDir，再回退到 commonDir */
function resolveRef(gitDir: string, ref: string): string {
  const sha = resolveRefInDir(gitDir, ref);
  if (sha) return sha;

  const commonDir = getCommonDir(gitDir);
  if (commonDir && commonDir !== gitDir) {
    return resolveRefInDir(commonDir, ref);
  }
  return "";
}

/**
 * 纯文件系统读取 worktree 的 HEAD SHA。直接读 <worktreePath>/.git
 * 指针文件，不走 ResolveGitDir 的上溯逻辑。
 * 返回空字符串表示非合法 worktree。
 *
 * 性能目标：≤10ms（纯文件 IO，无子进程）。
 */
export function readWorktreeHeadSha(worktreePath: string): string {
  let raw: string;
  try {
    raw = readFileSync(join(worktreePath, ".git"), "utf-8").trim();
  } catch {
    return "";
  }
  if (!raw.startsWith("gitdir:")) return "";

  const rel = raw.slice("gitdir:".length).trim();
  const gitDir = isAbsolute(rel) ? rel : join(worktreePath, rel);

  const head = readGitHead(gitDir);
  if (!head) return "";

  if (head.branch) {
    return resolveRef(gitDir, "refs/heads/" + head.branch);
  }
  return head.sha ?? "";
}

/**
 * 获取当前分支名（纯文件系统读取）。
 * 返回空字符串表示 detached HEAD 或非 git 仓库。
 */
export function getCurrentBranch(repoRoot: string): string {
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) return "";
  const head = readGitHead(gitDir);
  if (!head) return "";
  return head.branch ?? "";
}

// ── Worktree 管理 ──────────────────────────────────────────────

export function createAgentWorktree(
  slug: string,
  gitRoot?: string
): WorktreeResult {
  const root =
    gitRoot ??
    execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();

  const wtDir = join(root, ".mewcode", "worktrees", slug);
  const branch = `worktree-${slug}`;

  // 快速恢复路径：已存在的 worktree，用纯文件系统读取 HEAD
  if (existsSync(wtDir)) {
    const head = readWorktreeHeadSha(wtDir);
    if (head) {
      return { path: wtDir, branch, headCommit: head, gitRoot: root };
    }
    // 文件系统读取失败则回退到 git 子进程
    const headFallback = execSync("git rev-parse HEAD", {
      cwd: wtDir,
      encoding: "utf-8",
    }).trim();
    return { path: wtDir, branch, headCommit: headFallback, gitRoot: root };
  }

  // `-B`（大写）：如果残留分支已存在也能成功创建，不会报错；
  // 小写 `-b` 在分支已存在时会失败
  execSync(`git worktree add -B "${branch}" "${wtDir}"`, {
    cwd: root,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  performPostCreationSetup(root, wtDir);

  // 新建 worktree 优先用文件系统读取 HEAD
  const head = readWorktreeHeadSha(wtDir);
  if (head) {
    return { path: wtDir, branch, headCommit: head, gitRoot: root };
  }
  // 回退到子进程
  const headFallback = execSync("git rev-parse HEAD", {
    cwd: wtDir,
    encoding: "utf-8",
  }).trim();

  return { path: wtDir, branch, headCommit: headFallback, gitRoot: root };
}

export function removeAgentWorktree(
  path: string,
  branch: string,
  gitRoot: string
): void {
  try {
    execSync(`git worktree remove "${path}" --force`, {
      cwd: gitRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // worktree 可能已被移除
  }

  try {
    execSync(`git branch -D "${branch}"`, {
      cwd: gitRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // 分支可能已被删除
  }
}

export function hasWorktreeChanges(path: string, headCommit: string): boolean {
  try {
    const status = execSync("git status --porcelain", {
      cwd: path,
      encoding: "utf-8",
    }).trim();

    if (status) return true;

    // 比较 HEAD SHA：优先纯文件系统读取
    const currentHead =
      readWorktreeHeadSha(path) ||
      execSync("git rev-parse HEAD", { cwd: path, encoding: "utf-8" }).trim();

    return currentHead !== headCommit;
  } catch {
    return true; // 失败时保守处理：假设有变更
  }
}

export function buildWorktreeNotice(parentCwd: string, wtPath: string): string {
  return (
    `You are working in a git worktree at: ${wtPath}\n` +
    `The parent project is at: ${parentCwd}\n` +
    `Changes made here are isolated from the parent working tree.`
  );
}

/**
 * Propagates settings, hooks, symlinks, and .worktreeinclude files from the
 * main repo into a newly created worktree. Failures are logged but never
 * propagated — they must not break worktree creation.
 */
function performPostCreationSetup(repoRoot: string, wtPath: string): void {
  copyMewcodeSettings(repoRoot, wtPath);
  configureHooksPath(repoRoot, wtPath);
  symlinkNodeModules(repoRoot, wtPath);
  copyWorktreeIncludeFiles(repoRoot, wtPath);
}

/** Copy .mewcode/ settings directory from the main repo to the worktree. */
function copyMewcodeSettings(repoRoot: string, wtPath: string): void {
  try {
    const src = join(repoRoot, ".mewcode");
    if (!existsSync(src)) return;
    const dst = join(wtPath, ".mewcode");
    cpSync(src, dst, { recursive: true });
  } catch (err) {
    console.error(
      `Warning: failed to copy .mewcode/ to worktree: ${(err as Error).message}`
    );
  }
}

/**
 * Set core.hooksPath in the worktree so git hooks from the main repo are
 * shared. Prioritizes .husky/ over .git/hooks/.
 */
function configureHooksPath(repoRoot: string, wtPath: string): void {
  try {
    const candidates = [
      join(repoRoot, ".husky"),
      join(repoRoot, ".git", "hooks"),
    ];
    let hooksPath: string | undefined;
    for (const c of candidates) {
      try {
        const info = statSync(c);
        if (info.isDirectory()) {
          hooksPath = c;
          break;
        }
      } catch {
        // candidate doesn't exist, try next
      }
    }
    if (!hooksPath) return;

    execSync(`git config core.hooksPath "${hooksPath}"`, {
      cwd: wtPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    console.error(
      `Warning: failed to configure hooks path in worktree: ${(err as Error).message}`
    );
  }
}

/**
 * If node_modules exists in the source repo, create a symlink in the worktree
 * pointing to it so dependencies don't need to be re-installed.
 */
function symlinkNodeModules(repoRoot: string, wtPath: string): void {
  try {
    const src = join(repoRoot, "node_modules");
    if (!existsSync(src)) return;
    const dst = join(wtPath, "node_modules");
    if (existsSync(dst)) return; // already present
    symlinkSync(src, dst);
  } catch (err) {
    console.error(
      `Warning: failed to symlink node_modules in worktree: ${(err as Error).message}`
    );
  }
}

/**
 * If .worktreeinclude exists in the source root, read it (one path per line,
 * blank lines and #-comments skipped) and copy each listed file/directory into
 * the worktree.
 */
function copyWorktreeIncludeFiles(repoRoot: string, wtPath: string): void {
  try {
    const includeFile = join(repoRoot, ".worktreeinclude");
    if (!existsSync(includeFile)) return;

    const content = readFileSync(includeFile, "utf-8");
    const paths = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

    for (const relPath of paths) {
      // Guard against path traversal.
      if (relPath.includes("..")) continue;

      try {
        const src = join(repoRoot, relPath);
        if (!existsSync(src)) continue;

        const dst = join(wtPath, relPath);
        mkdirSync(dirname(dst), { recursive: true });

        const info = statSync(src);
        if (info.isDirectory()) {
          cpSync(src, dst, { recursive: true });
        } else {
          cpSync(src, dst);
        }
      } catch {
        // best-effort per file — skip failures
      }
    }
  } catch (err) {
    console.error(
      `Warning: failed to process .worktreeinclude: ${(err as Error).message}`
    );
  }
}
