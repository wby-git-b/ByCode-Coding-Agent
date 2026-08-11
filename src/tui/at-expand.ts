// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const MAX_INLINE_BYTES = 100_000;

// Expand @path references in a user message by inlining the referenced files'
// contents (resolved relative to workDir). Tokens that don't resolve to a small
// readable file are left untouched. Mirrors Go expandAtRefs.
export function expandAtRefs(text: string, workDir: string): string {
  const refs = [...text.matchAll(/(?:^|\s)@([^\s]+)/g)].map((m) => m[1]);
  if (refs.length === 0) return text;

  let appendix = "";
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const p = isAbsolute(ref) ? ref : join(workDir, ref);
    try {
      const st = statSync(p);
      if (st.isFile() && st.size <= MAX_INLINE_BYTES) {
        appendix += `\n\n<file path="${ref}">\n${readFileSync(p, "utf-8")}\n</file>`;
      }
    } catch {
      // not a readable file → leave the @token as literal text
    }
  }
  return appendix ? text + appendix : text;
}
