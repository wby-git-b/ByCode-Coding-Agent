// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

const CONTEXT_LINES = 3;
// 防止超大文件/批量替换产出天量 diff 文本拖垮 TUI 渲染和上下文占用
const MAX_DIFF_LINES = 200;

export interface DiffResult {
  /** 统一格式的 diff 文本："  行号  内容" 表示未变，"- 行号  内容" 表示删除，"+ 行号  内容" 表示新增 */
  text: string;
  additions: number;
  removals: number;
}

/**
 * 对比编辑前后的文件内容，生成一段带行号的 diff。
 * 利用"编辑只改动中间一小段"的特点，从两端找公共前缀/后缀行，
 * 避免跑通用的 LCS/Myers diff 算法（对大文件更快，实现也更简单）。
 */
export function buildDiff(oldContent: string, newContent: string): DiffResult {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  let prefixLen = 0;
  const maxPrefix = Math.min(oldLines.length, newLines.length);
  while (prefixLen < maxPrefix && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  const maxSuffix = maxPrefix - prefixLen;
  while (
    suffixLen < maxSuffix &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const removedLines = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const addedLines = newLines.slice(prefixLen, newLines.length - suffixLen);

  const contextStart = Math.max(0, prefixLen - CONTEXT_LINES);
  const contextBefore = oldLines.slice(contextStart, prefixLen);
  const contextEnd = Math.min(oldLines.length, oldLines.length - suffixLen + CONTEXT_LINES);
  const contextAfter = oldLines.slice(oldLines.length - suffixLen, contextEnd);

  const out: string[] = [];
  let oldLineNo = contextStart + 1;
  let newLineNo = contextStart + 1;
  let truncated = false;

  const push = (prefix: string, lineNo: number, content: string) => {
    if (out.length >= MAX_DIFF_LINES) {
      truncated = true;
      return;
    }
    out.push(`${prefix} ${String(lineNo).padStart(4)}  ${content}`);
  };

  for (const l of contextBefore) {
    push(" ", oldLineNo, l);
    oldLineNo++;
    newLineNo++;
  }
  for (const l of removedLines) {
    push("-", oldLineNo, l);
    oldLineNo++;
  }
  for (const l of addedLines) {
    push("+", newLineNo, l);
    newLineNo++;
  }
  for (const l of contextAfter) {
    push(" ", oldLineNo, l);
    oldLineNo++;
    newLineNo++;
  }

  if (truncated) out.push(`  … (diff truncated at ${MAX_DIFF_LINES} lines)`);

  return { text: out.join("\n"), additions: addedLines.length, removals: removedLines.length };
}
