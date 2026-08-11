// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Message, ToolUseBlock } from "../conversation/conversation.js";

const SINGLE_RESULT_LIMIT = 50000;
const MESSAGE_AGGREGATE_LIMIT = 200000;

// 已替换结果的前缀标记，用于跳过已处理的结果
const PERSISTED_TAG_PREFIX = "[Result of ";

function spillDir(workDir: string, sessionId: string): string {
  const id = sessionId || "default";
  return join(workDir, ".mewcode", "sessions", id, "tool_results");
}

function writeSpill(workDir: string, sessionId: string, toolUseId: string, content: string): string {
  const dir = spillDir(workDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, toolUseId);
  try {
    writeFileSync(path, content, { encoding: "utf-8", flag: "wx" });
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
  }
  return path;
}

const PREVIEW_CHARS = 2000;

function buildSpillPreview(content: string, spillPath: string): string {
  const sizeKB = Math.floor(content.length / 1024);
  const preview = content.slice(0, PREVIEW_CHARS);
  const hasMore = content.length > PREVIEW_CHARS;
  let msg = `${PERSISTED_TAG_PREFIX}tool call]\n<persisted-output>\n`;
  msg += `输出太大（${sizeKB}KB），完整内容已保存到：\n${spillPath}\n\n`;
  msg += `预览（前 2KB）：\n${preview}`;
  if (hasMore) msg += '\n...';
  msg += '\n</persisted-output>';
  return msg;
}

// 检查工具结果是否已被替换过（通过前缀标记判断）
function isAlreadyReplaced(content: string): boolean {
  return content.startsWith(PERSISTED_TAG_PREFIX);
}

function isSpillReadback(
  toolUseId: string,
  toolUseIndex: Map<string, ToolUseBlock>,
  absSpillDir: string
): boolean {
  const tu = toolUseIndex.get(toolUseId);
  if (!tu || tu.toolName !== "ReadFile" || !absSpillDir) return false;
  const raw = tu.arguments?.file_path;
  if (typeof raw !== "string" || !raw) return false;
  return resolve(raw).startsWith(absSpillDir);
}

function buildToolUseIndex(messages: Message[]): Map<string, ToolUseBlock> {
  const idx = new Map<string, ToolUseBlock>();
  for (const m of messages) {
    if (m.toolUses) {
      for (const tu of m.toolUses) idx.set(tu.toolUseId, tu);
    }
  }
  return idx;
}

/**
 * applyBudget 就地修改 messages 中超限的 toolResult.content：
 * - Pass 1: 单条结果超过 SINGLE_RESULT_LIMIT → 溢出到磁盘
 * - Pass 2: 单消息聚合超过 MESSAGE_AGGREGATE_LIMIT → 溢出最大的结果
 * 已替换的结果（带 persistedTagPrefix 前缀）会被跳过，保证幂等。
 */
export function applyBudget(
  messages: Message[],
  workDir: string,
  sessionId: string
): void {
  // 从尾部往前找需要处理的消息。旧消息的 tool_result 已经在之前的轮次
  // 被替换过了，碰到一条全部是 preview 的消息就可以停下来。
  const toProcess: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const trs = messages[i].toolResults;
    if (!trs || trs.length === 0) continue;
    const hasFresh = trs.some((tr) => !isAlreadyReplaced(tr.content));
    if (!hasFresh) break;
    toProcess.push(i);
  }
  if (toProcess.length === 0) return;

  const absSpillDir = resolve(spillDir(workDir, sessionId));
  const toolUseIndex = buildToolUseIndex(messages);

  for (const idx of toProcess) {
    const msg = messages[idx];
    if (!msg.toolResults || msg.toolResults.length === 0) continue;

    // Pass 1: 单条结果超限 → 溢出到磁盘
    for (const tr of msg.toolResults) {
      // 已替换过的结果跳过，保持幂等
      if (isAlreadyReplaced(tr.content)) continue;

      if (tr.content.length > SINGLE_RESULT_LIMIT) {
        if (isSpillReadback(tr.toolUseId, toolUseIndex, absSpillDir)) continue;
        const spillPath = writeSpill(workDir, sessionId, tr.toolUseId, tr.content);
        tr.content = buildSpillPreview(tr.content, spillPath);
      }
    }

    // Pass 2: 单消息聚合超限 → 溢出最大的结果
    let totalLen = msg.toolResults.reduce((sum, r) => sum + r.content.length, 0);
    if (totalLen > MESSAGE_AGGREGATE_LIMIT) {
      // 按内容长度降序排列，优先溢出最大的
      const sorted = [...msg.toolResults].sort(
        (a, b) => b.content.length - a.content.length
      );
      for (const r of sorted) {
        if (totalLen <= MESSAGE_AGGREGATE_LIMIT) break;
        if (isAlreadyReplaced(r.content)) continue;
        if (isSpillReadback(r.toolUseId, toolUseIndex, absSpillDir)) continue;
        if (r.content.length > PREVIEW_CHARS) {
          const before = r.content;
          const spillPath = writeSpill(workDir, sessionId, r.toolUseId, before);
          const replacement = buildSpillPreview(before, spillPath);
          totalLen = totalLen - before.length + replacement.length;
          r.content = replacement;
        }
      }
    }
  }
}
