// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { readFileSync, readdirSync, unlinkSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import type { LLMClient } from "../llm/client.js";
import { ConversationManager } from "../conversation/conversation.js";

/** Caps for MEMORY.md index content: 200 lines or 25KB, whichever is hit first. */
const MAX_ENTRYPOINT_LINES = 200;
const MAX_ENTRYPOINT_BYTES = 25_000;
const MEMORY_INDEX_NAME = "MEMORY.md";

export interface MemoryFile {
  path: string;
  name: string;
  description: string;
  type: string;
  content: string;
}

/** Header metadata from a scanned memory file, used by findRelevantMemories. */
export interface MemoryHeader {
  filename: string;   // path relative to the memory dir
  filePath: string;   // absolute path
  scope: string;      // "user" or "project"
  mtimeMs: number;    // modification time, ms since epoch
  description: string;
  type: string;
}

/** One memory selected for surfacing into the main conversation. */
export interface RelevantMemory {
  path: string;
  mtimeMs: number;
}

/** The system prompt for the selector agent. Mirrors the Go SelectMemoriesSystemPrompt. */
const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to MewCode as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to MewCode as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (MewCode is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.

Respond with valid JSON only, no markdown, in this exact shape: {"selected_memories": ["filename1.md", "filename2.md"]}`;

export class MemoryManager {
  private userDir: string;
  private projectDir: string;

  constructor(workDir: string) {
    this.userDir = join(homedir(), ".mewcode", "memory");
    this.projectDir = join(workDir, ".mewcode", "memory");
  }

  loadAll(): MemoryFile[] {
    const memories: MemoryFile[] = [];
    for (const dir of [this.userDir, this.projectDir]) {
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir).filter(
        (f) => f.endsWith(".md") && f !== MEMORY_INDEX_NAME
      );
      for (const file of files) {
        const fullPath = join(dir, file);
        try {
          const raw = readFileSync(fullPath, "utf-8");
          const parsed = parseFrontmatter(raw);
          if (parsed) {
            memories.push({
              path: fullPath,
              name: parsed.name ?? file.replace(".md", ""),
              description: parsed.description ?? "",
              type: parsed.type ?? "reference",
              content: parsed.body,
            });
          }
        } catch {
          continue;
        }
      }
    }
    this.rebuildIndex();
    return memories;
  }

  getMemories(): MemoryFile[] {
    return this.loadAll();
  }

  buildSystemReminder(): string {
    const memories = this.loadAll();
    if (memories.length === 0) return "";

    const lines = memories.map(
      (m) => `- [${m.name}] (${m.type}): ${m.description}`
    );
    return `Active memories:\n${lines.join("\n")}`;
  }

  clear(): void {
    for (const dir of [this.userDir, this.projectDir]) {
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        try {
          unlinkSync(join(dir, file));
        } catch {
          continue;
        }
      }
    }
  }

  // ── Feature 1: MEMORY.md index generation ──────────────────────────

  /**
   * Scans both userDir and projectDir for .md files (excluding MEMORY.md),
   * parses each file's frontmatter for name + description, and writes a
   * MEMORY.md index in the projectDir. One line per memory, sorted
   * alphabetically by name, truncated at MAX_ENTRYPOINT_LINES / MAX_ENTRYPOINT_BYTES.
   */
  rebuildIndex(): void {
    const entries: { name: string; relPath: string; description: string }[] = [];

    for (const dir of [this.userDir, this.projectDir]) {
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir).filter(
        (f) => f.endsWith(".md") && f !== MEMORY_INDEX_NAME
      );
      for (const file of files) {
        const fullPath = join(dir, file);
        try {
          const raw = readFileSync(fullPath, "utf-8");
          const parsed = parseFrontmatter(raw);
          if (!parsed) continue;
          const name = parsed.name ?? file.replace(".md", "");
          const description = parsed.description ?? "";
          // Relative path from projectDir so the link works from MEMORY.md
          const relPath = relative(this.projectDir, fullPath) || file;
          entries.push({ name, relPath, description });
        } catch {
          continue;
        }
      }
    }

    // Sort alphabetically by name (case-insensitive)
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    // Build index lines
    const lines: string[] = [];
    for (const e of entries) {
      if (e.description) {
        lines.push(`- [${e.name}](${e.relPath}) — ${e.description}`);
      } else {
        lines.push(`- [${e.name}](${e.relPath})`);
      }
    }

    // Truncate to MAX_ENTRYPOINT_LINES
    let content = lines.slice(0, MAX_ENTRYPOINT_LINES).join("\n");

    // Truncate to MAX_ENTRYPOINT_BYTES at a newline boundary
    if (Buffer.byteLength(content, "utf-8") > MAX_ENTRYPOINT_BYTES) {
      // Find the last newline before the byte cap
      const buf = Buffer.from(content, "utf-8");
      const truncBuf = buf.subarray(0, MAX_ENTRYPOINT_BYTES);
      const truncStr = truncBuf.toString("utf-8");
      const lastNL = truncStr.lastIndexOf("\n");
      content = lastNL > 0 ? truncStr.slice(0, lastNL) : truncStr;
    }

    // Write MEMORY.md into projectDir, ensuring the dir exists
    mkdirSync(this.projectDir, { recursive: true });
    writeFileSync(join(this.projectDir, MEMORY_INDEX_NAME), content + "\n", "utf-8");
  }

  // ── Feature 2: findRelevantMemories ────────────────────────────────

  /**
   * Scans all memory headers from both dirs, asks the LLM to select the
   * top 5 most relevant ones for the query, and returns the full content
   * of those files. Best-effort: selector failures return an empty array.
   */
  async findRelevantMemories(
    query: string,
    client: LLMClient,
    recentTools: string[] = [],
    alreadySurfaced: Set<string> = new Set()
  ): Promise<RelevantMemory[]> {
    // 1. Scan both dirs for memory headers
    const allHeaders: MemoryHeader[] = [];
    for (const [dir, scope] of [[this.userDir, "user"], [this.projectDir, "project"]] as const) {
      const headers = scanMemoryHeaders(dir, scope);
      allHeaders.push(...headers);
    }

    // Filter out already-surfaced files
    const candidates = allHeaders.filter((h) => !alreadySurfaced.has(h.filePath));
    if (candidates.length === 0) return [];

    // 2. Build the manifest and ask the LLM to select
    const manifest = formatMemoryManifest(candidates);
    let toolsSection = "";
    if (recentTools.length > 0) {
      toolsSection = "\n\nRecently used tools: " + recentTools.join(", ");
    }
    const userMessage = `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}`;

    let rawResponse = "";
    try {
      const conv = new ConversationManager();
      // The TS LLMClient binds system prompts at construction time, so we
      // inline the selector instructions as a user message (same pattern as
      // the MemoryExtractor).
      conv.addUserMessage(SELECT_MEMORIES_SYSTEM_PROMPT + "\n\n" + userMessage);

      const stream = client.stream(conv, []);
      for await (const event of stream) {
        if (event.type === "text_delta") {
          rawResponse += event.text;
        }
      }
    } catch {
      return [];
    }

    // 3. Parse the selector response
    const jsonStr = extractJSONObject(rawResponse);
    if (!jsonStr) return [];

    let parsed: { selected_memories?: string[] };
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return [];
    }

    if (!Array.isArray(parsed.selected_memories)) return [];

    // Build lookup maps: by filePath and by filename (relative)
    const byKey = new Map<string, MemoryHeader>();
    for (const h of candidates) {
      byKey.set(h.filePath, h);
      if (!byKey.has(h.filename)) {
        byKey.set(h.filename, h);
      }
    }

    // 4. Resolve selected filenames to RelevantMemory objects
    const selected: RelevantMemory[] = [];
    for (const fn of parsed.selected_memories) {
      const h = byKey.get(fn);
      if (!h) continue;
      selected.push({ path: h.filePath, mtimeMs: h.mtimeMs });
    }

    return selected;
  }
}

// ── Scanning / manifest helpers (parallel to Go ScanMemoryFiles / FormatMemoryManifest) ──

/**
 * Scans a memory directory for .md files (excluding MEMORY.md), reads
 * their frontmatter, and returns headers sorted newest-first (capped at
 * MAX_ENTRYPOINT_LINES files).
 */
function scanMemoryHeaders(dir: string, scope: string): MemoryHeader[] {
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = readdirSync(dir).filter(
      (f) => f.endsWith(".md") && f !== MEMORY_INDEX_NAME
    );
  } catch {
    return [];
  }

  const headers: MemoryHeader[] = [];
  for (const file of files) {
    const fullPath = join(dir, file);
    try {
      const stat = statSync(fullPath);
      if (!stat.isFile()) continue;

      const raw = readFileSync(fullPath, "utf-8");
      const parsed = parseFrontmatter(raw);
      if (!parsed) continue;

      headers.push({
        filename: file,
        filePath: fullPath,
        scope,
        mtimeMs: stat.mtimeMs,
        description: parsed.description ?? "",
        type: parsed.type ?? "",
      });
    } catch {
      continue;
    }
  }

  // Sort newest-first
  headers.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (headers.length > MAX_ENTRYPOINT_LINES) {
    headers.length = MAX_ENTRYPOINT_LINES;
  }
  return headers;
}

/**
 * Formats memory headers as a text manifest for the selector prompt.
 * One line per file: - [scope] [type] filepath (timestamp): description
 */
function formatMemoryManifest(memories: MemoryHeader[]): string {
  if (memories.length === 0) return "";

  const lines: string[] = [];
  for (const m of memories) {
    const scope = m.scope ? `[${m.scope}-scope] ` : "";
    const tag = m.type ? `[${m.type}] ` : "";
    const ts = new Date(m.mtimeMs).toISOString();
    const path = m.filePath || m.filename;
    if (m.description) {
      lines.push(`- ${scope}${tag}${path} (${ts}): ${m.description}`);
    } else {
      lines.push(`- ${scope}${tag}${path} (${ts})`);
    }
  }
  return lines.join("\n");
}

/**
 * Extracts the first {...} JSON object from raw text, tolerating markdown
 * fences or prose around it.
 */
function extractJSONObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const start = trimmed.indexOf("{");
  if (start < 0) return "";
  const end = trimmed.lastIndexOf("}");
  if (end < start) return "";
  return trimmed.slice(start, end + 1);
}

/**
 * 解析 frontmatter，提取 name/description/type。
 * type 字段从顶层读取（跨语言兼容），同时兼容旧的 metadata.type 嵌套格式。
 */
function parseFrontmatter(
  content: string
): { name?: string; description?: string; type?: string; body: string } | null {
  if (!content.startsWith("---")) {
    return { body: content };
  }

  const endIdx = content.indexOf("---", 3);
  if (endIdx === -1) return { body: content };

  const frontmatter = content.slice(3, endIdx).trim();
  const body = content.slice(endIdx + 3).trim();

  try {
    const parsed = yaml.load(frontmatter) as Record<string, unknown> | null;
    // 优先读取顶层 type（Go 兼容格式），回退到 metadata.type（旧 TS 格式）
    const topType = parsed?.type as string | undefined;
    const nestedType = (parsed?.metadata as Record<string, unknown>)?.type as string | undefined;
    return {
      name: parsed?.name as string | undefined,
      description: parsed?.description as string | undefined,
      type: topType ?? nestedType,
      body,
    };
  } catch {
    return { body: content };
  }
}
