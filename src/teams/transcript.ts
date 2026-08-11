// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ConversationManager,
  Message,
  ToolUseBlock,
  ToolResultBlock,
} from "../conversation/conversation.js";

// ── 序列化数据结构 ──────────────────────────────────────────────

interface TranscriptToolUse {
  tool_use_id: string;
  tool_name: string;
  arguments?: Record<string, unknown>;
}

interface TranscriptToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

interface TranscriptEntry {
  role: string;
  content?: string;
  tool_uses?: TranscriptToolUse[];
  tool_results?: TranscriptToolResult[];
}

// ── 序列化/反序列化 ────────────────────────────────────────────

/**
 * 将对话历史序列化为可持久化的条目列表。
 */
function serializeConversation(conv: ConversationManager): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const msg of conv.getMessages()) {
    const entry: TranscriptEntry = { role: msg.role, content: msg.content };
    if (msg.toolUses && msg.toolUses.length > 0) {
      entry.tool_uses = msg.toolUses.map((tu) => ({
        tool_use_id: tu.toolUseId,
        tool_name: tu.toolName,
        arguments: tu.arguments,
      }));
    }
    if (msg.toolResults && msg.toolResults.length > 0) {
      entry.tool_results = msg.toolResults.map((tr) => ({
        tool_use_id: tr.toolUseId,
        content: tr.content,
        is_error: tr.isError || undefined,
      }));
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * 返回团队的 transcript 存储目录。
 */
function transcriptDir(workDir: string, teamName: string): string {
  return join(workDir, ".mewcode", "teams", teamName, "transcripts");
}

/**
 * 将队友的对话历史持久化到磁盘，用于调试和问题排查。
 * 文件路径为 .mewcode/teams/{team}/transcripts/{agentId}.json。
 */
export function saveTranscript(
  workDir: string,
  teamName: string,
  agentId: string,
  conv: ConversationManager,
): string {
  const dir = transcriptDir(workDir, teamName);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${agentId}.json`);
  const data = serializeConversation(conv);
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  return path;
}

/**
 * 从磁盘加载队友的对话历史。
 * 文件不存在或解析失败时返回 null。
 */
export function loadTranscript(
  workDir: string,
  teamName: string,
  agentId: string,
): TranscriptEntry[] | null {
  const path = join(transcriptDir(workDir, teamName), `${agentId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as TranscriptEntry[];
  } catch {
    return null;
  }
}
