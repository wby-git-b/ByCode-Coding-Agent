// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

export type ToolCategory = "read" | "write" | "command";

export interface ToolResult {
  output: string;
  isError: boolean;
}

export interface ToolContext {
  workDir: string;
  abortSignal?: AbortSignal;
  fileHistory?: import("../filehistory/filehistory.js").FileHistory;
  fileStateCache?: import("./file-state-cache.js").FileStateCache;
}

export interface Tool {
  name: string;
  description: string;
  category: ToolCategory;
  deferred?: boolean;
  system?: boolean;

  schema(): Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".next",
  ".nuxt",
  "dist",
  "build",
  ".mewcode",
  ".claude",
  "vendor",
  ".venv",
  "venv",
]);

export function intArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number
): number {
  const v = args[key];
  if (typeof v === "number") return Math.floor(v);
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return isNaN(n) ? fallback : n;
  }
  return fallback;
}

export function strArg(
  args: Record<string, unknown>,
  key: string,
  fallback = ""
): string {
  const v = args[key];
  if (typeof v === "string") return v;
  return fallback;
}

export function boolArg(
  args: Record<string, unknown>,
  key: string,
  fallback = false
): boolean {
  const v = args[key];
  if (typeof v === "boolean") return v;
  return fallback;
}
