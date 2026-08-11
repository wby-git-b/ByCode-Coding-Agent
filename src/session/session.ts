// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// 持久化的会话行。普通消息的 type 留空，压缩边界记录的 type 为 COMPACT_BOUNDARY，
// 其 content 是 CompactBoundaryPayload 的 JSON 序列化（包含摘要和保留的近期尾部消息）。
// 将保留的尾部内联在边界记录中避免了"物理位置"问题：恢复时读取边界即可重建
// [摘要] + 保留消息 + 边界之后追加的消息，无需从边界之前的区域中搜索保留的消息。
export const COMPACT_BOUNDARY = "compact_boundary";

/** 会话过期天数，超过此天数的会话文件将被自动清理 */
const SESSION_EXPIRY_DAYS = 30;

export interface SessionMessage {
  role: string;
  content: string;
  timestamp: string;
  type?: string;
  /** 工具调用 ID，用于恢复时验证 tool_use/tool_result 链完整性 */
  toolUseId?: string;
}

// One inlined kept message stored inside a boundary record. We only store
// role + text — consistent with how the rest of the session is persisted
// (the .jsonl only ever holds text, never tool_use/tool_result blocks).
export interface KeptMessage {
  role: string;
  content: string;
}

// Structured payload serialized into a compact_boundary record's `content`.
export interface CompactBoundaryPayload {
  summary: string;
  keep: KeptMessage[];
}

export interface SessionInfo {
  id: string;
  firstMessage: string;
  messageCount: number;
  size: number;
  modTime: Date;
}

function sessionsDir(workDir: string): string {
  return join(workDir, ".mewcode", "sessions");
}

export function getSessionFilePath(workDir: string, sessionId: string): string {
  return join(sessionsDir(workDir), sessionId + ".jsonl");
}

export function newSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `${ts}-${rand}`;
}

export function saveMessage(
  workDir: string,
  sessionId: string,
  msg: SessionMessage
): void {
  const dir = sessionsDir(workDir);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${sessionId}.jsonl`);
  const line = JSON.stringify(msg) + "\n";
  writeFileSync(filePath, line, { flag: "a", encoding: "utf-8" });
}

// Append a compaction boundary to the session. The summary and the verbatim
// kept tail are inlined into one COMPACT_BOUNDARY record. This is append-only:
// the pre-boundary original messages stay in the file (they just won't be
// replayed on resume — see rebuildFromSession). Mirrors the Go/Java boundary
// record and the Python COMPACT_BOUNDARY RecordType.
export function saveCompactBoundary(
  workDir: string,
  sessionId: string,
  payload: CompactBoundaryPayload
): void {
  saveMessage(workDir, sessionId, {
    role: "system",
    content: JSON.stringify(payload),
    timestamp: new Date().toISOString(),
    type: COMPACT_BOUNDARY,
  });
}

export function loadSession(
  workDir: string,
  sessionId: string
): SessionMessage[] {
  const filePath = join(sessionsDir(workDir), `${sessionId}.jsonl`);
  if (!existsSync(filePath)) return [];

  const out: SessionMessage[] = [];
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line) as SessionMessage;
      // Boundary records carry their text payload in `content`, so keep them
      // (they pass the non-empty content check). Skip malformed or
      // empty-content ordinary messages rather than crashing the load.
      if (m && typeof m.content === "string" && m.content) out.push(m);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

// A message ready to replay on resume. Boundary records expand into the summary
// (as a synthetic user message) followed by their inlined kept tail; ordinary
// records map 1:1. This is the compacted-state reconstruction.
export interface RestoredMessage {
  role: "user" | "assistant";
  content: string;
}

// Rebuild the conversation to replay on resume, honoring compaction boundaries.
//
//   - If the session contains at least one compact_boundary, take the LAST one
//     and rebuild: [summary as a user message] + its inlined keep tail +
//     every ordinary message appended AFTER that boundary. The original
//     messages before the boundary stay in the file but are NOT replayed —
//     that's the whole point of compaction surviving a resume.
//   - If there is no boundary (old sessions, or never compacted), replay every
//     ordinary message verbatim. Fully backward-compatible.
export function rebuildFromSession(saved: SessionMessage[]): RestoredMessage[] {
  // Find the last boundary record.
  let lastBoundary = -1;
  for (let i = saved.length - 1; i >= 0; i--) {
    if (saved[i].type === COMPACT_BOUNDARY) {
      lastBoundary = i;
      break;
    }
  }

  const out: RestoredMessage[] = [];

  if (lastBoundary >= 0) {
    // Compacted state: summary + inlined keep, then post-boundary appends.
    let payload: CompactBoundaryPayload | null = null;
    try {
      payload = JSON.parse(saved[lastBoundary].content) as CompactBoundaryPayload;
    } catch {
      payload = null;
    }
    if (payload) {
      // The summary stands in for everything before the boundary, replayed as a
      // single user message (mirrors how doCompact rebuilds the live transcript).
      let resumeSummary = "本次会话延续自之前的对话，因上下文空间不足进行了压缩。以下是早期对话的摘要：\n\n" + payload.summary;
      if ((payload.keep ?? []).length > 0) {
        resumeSummary += "\n\n近期消息已原样保留。";
      }
      out.push({ role: "user", content: resumeSummary });
      for (const k of payload.keep ?? []) {
        if (k.role === "user" || k.role === "assistant") {
          if (k.content) out.push({ role: k.role, content: k.content });
        }
      }
    }
    // Replay ordinary messages appended after the boundary (continuation turns).
    for (let i = lastBoundary + 1; i < saved.length; i++) {
      const m = saved[i];
      if (m.type === COMPACT_BOUNDARY) continue; // defensive; last() already found
      if (m.role === "user" && m.content) out.push({ role: "user", content: m.content });
      else if (m.role === "assistant" && m.content) out.push({ role: "assistant", content: m.content });
    }
    return out;
  }

  // No boundary → full replay (backward compatible).
  for (const m of saved) {
    if (m.role === "user" && m.content) out.push({ role: "user", content: m.content });
    else if (m.role === "assistant" && m.content) out.push({ role: "assistant", content: m.content });
  }
  return out;
}

export function listSessions(workDir: string): SessionInfo[] {
  const dir = sessionsDir(workDir);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const sessions: SessionInfo[] = [];

  for (const file of files) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);
    const id = file.replace(".jsonl", "");

    let firstMessage = "";
    let messageCount = 0;
    try {
      for (const line of readFileSync(filePath, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        let m: SessionMessage;
        try {
          m = JSON.parse(line) as SessionMessage;
        } catch {
          continue;
        }
        messageCount++;
        // Label the session by its first user message (untruncated role match).
        if (!firstMessage && m.role === "user" && m.content) {
          firstMessage = m.content.slice(0, 100);
        }
      }
    } catch {
      continue;
    }

    sessions.push({
      id,
      firstMessage,
      messageCount,
      size: stat.size,
      modTime: stat.mtime,
    });
  }

  sessions.sort((a, b) => b.modTime.getTime() - a.modTime.getTime());
  return sessions;
}

/**
 * 清理过期会话：删除最后修改时间超过 SESSION_EXPIRY_DAYS 天的 .jsonl 文件。
 * 在 listSessions 或启动时调用，避免会话目录无限膨胀。
 * 删除失败时静默跳过（best-effort）。
 */
export function cleanExpiredSessions(workDir: string): number {
  const dir = sessionsDir(workDir);
  if (!existsSync(dir)) return 0;

  const now = Date.now();
  const expiryMs = SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return 0;
  }

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const stat = statSync(filePath);
      if (now - stat.mtimeMs > expiryMs) {
        unlinkSync(filePath);
        // 清理对应的 tool_results 目录
        const id = file.replace(".jsonl", "");
        const toolResultsDir = join(workDir, ".mewcode", "sessions", id, "tool_results");
        try { rmSync(toolResultsDir, { recursive: true, force: true }); } catch {}
        const sessionSubdir = join(workDir, ".mewcode", "sessions", id);
        try { rmSync(sessionSubdir, { recursive: false }); } catch {}
        removed++;
      }
    } catch {
      // 删除失败时静默跳过
    }
  }
  return removed;
}
