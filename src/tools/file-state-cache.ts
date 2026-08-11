// 来源：公众号@小林coding
// FileStateCache — tracks file content and mtime after ReadFile,
// enforcing "read before edit/write" and stale-file detection.

import { statSync } from "node:fs";

interface CacheEntry {
  content: string;
  mtimeMs: number;
}

export class FileStateCache {
  private cache = new Map<string, CacheEntry>();

  /** Called after a successful ReadFile to register the file as "seen". */
  record(filePath: string, content: string, mtimeMs: number): void {
    this.cache.set(filePath, { content, mtimeMs });
  }

  /**
   * Gate check before EditFile / WriteFile.
   * Returns { ok: true } if the edit may proceed, or { ok: false, error }
   * with a human-readable reason to reject.
   */
  check(filePath: string): { ok: true } | { ok: false; error: string } {
    const entry = this.cache.get(filePath);
    if (!entry) {
      return {
        ok: false,
        error:
          "Error: file has not been read yet. Read it first before editing.",
      };
    }

    let currentMtime: number;
    try {
      currentMtime = statSync(filePath).mtimeMs;
    } catch {
      // File may have been deleted between read and edit — let the
      // calling tool surface a more specific error later.
      return { ok: true };
    }

    if (currentMtime > entry.mtimeMs) {
      return {
        ok: false,
        error:
          "Error: file has been modified since last read. Read it again before editing.",
      };
    }

    return { ok: true };
  }

  /**
   * Called after a successful edit / write to keep the cache in sync
   * with the new on-disk state.
   */
  update(filePath: string, newContent: string): void {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      // If we can't stat (shouldn't happen right after a write), just
      // remove the entry so next edit requires a fresh read.
      this.cache.delete(filePath);
      return;
    }
    this.cache.set(filePath, { content: newContent, mtimeMs });
  }
}
