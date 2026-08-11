// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  statSync,
  openSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";

export interface FileMailMessage {
  from: string;
  text: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// File-based lock: mirrors the Go implementation in filemailbox.go.
//
// Uses exclusive-create (wx flag) on a .lock file.  Retries up to maxAttempts
// times with a small random back-off.  Stale locks (older than staleLockMs)
// are automatically removed so a crashed process cannot block others forever.
// ---------------------------------------------------------------------------

const LOCK_MAX_ATTEMPTS = 10;
const LOCK_STALE_MS = 10_000; // 10 seconds — matches Go/Java threshold
const LOCK_RETRY_MIN_MS = 5;
const LOCK_RETRY_MAX_MS = 100;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(lockFile: string): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      // O_CREAT | O_EXCL | O_WRONLY — fails if the file already exists.
      const fd = openSync(lockFile, "wx");
      closeSync(fd);
      return; // lock acquired
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw err; // unexpected filesystem error
      }
      lastErr = err;

      // Lock file exists — check if it is stale.
      try {
        const info = statSync(lockFile);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          try {
            unlinkSync(lockFile);
          } catch {
            // another process may have removed it already
          }
        }
      } catch {
        // stat failed — file may have been removed between our open and stat
      }

      // Random back-off before retrying (5–100 ms, matching Go implementation).
      const delayMs =
        LOCK_RETRY_MIN_MS +
        Math.floor(Math.random() * (LOCK_RETRY_MAX_MS - LOCK_RETRY_MIN_MS + 1));
      sleepSync(delayMs);
    }
  }
  throw lastErr; // could not acquire lock after all attempts
}

function releaseLock(lockFile: string): void {
  try {
    unlinkSync(lockFile);
  } catch {
    // best-effort — file may already be gone
  }
}

/** Execute `fn` while holding an exclusive .lock file for `filePath`. */
function withLock<T>(filePath: string, fn: () => T): T {
  const lockFile = filePath + ".lock";
  acquireLock(lockFile);
  try {
    return fn();
  } finally {
    releaseLock(lockFile);
  }
}

// ---------------------------------------------------------------------------

export class FileMailbox {
  private filePath: string;
  private readStatePath: string;
  private lastReadLines: number;

  constructor(dir: string, memberName: string) {
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, `${memberName}.jsonl`);
    this.readStatePath = join(dir, `${memberName}.read`);
    // Persist the read cursor so a restarted / different process resumes from
    // where it left off instead of re-reading the whole mailbox from line 0.
    this.lastReadLines = this.loadReadState();
  }

  private loadReadState(): number {
    try {
      return parseInt(readFileSync(this.readStatePath, "utf-8").trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  private saveReadState(): void {
    try {
      writeFileSync(this.readStatePath, String(this.lastReadLines), "utf-8");
    } catch {
      // best-effort
    }
  }

  private allLines(): string[] {
    if (!existsSync(this.filePath)) return [];
    return readFileSync(this.filePath, "utf-8").trim().split("\n").filter(Boolean);
  }

  async send(from: string, text: string): Promise<void> {
    const msg: FileMailMessage = {
      from,
      text,
      timestamp: new Date().toISOString(),
    };
    withLock(this.filePath, () => {
      writeFileSync(this.filePath, JSON.stringify(msg) + "\n", {
        flag: "a",
        encoding: "utf-8",
      });
    });
  }

  // Consume and return unread messages, advancing (and persisting) the cursor.
  receiveSync(): FileMailMessage[] {
    return withLock(this.filePath, () => {
      const lines = this.allLines();
      const newLines = lines.slice(this.lastReadLines);
      this.lastReadLines = lines.length;
      this.saveReadState();

      const out: FileMailMessage[] = [];
      for (const line of newLines) {
        try {
          out.push(JSON.parse(line) as FileMailMessage);
        } catch {
          // skip malformed line
        }
      }
      return out;
    });
  }

  async receive(): Promise<FileMailMessage[]> {
    return this.receiveSync();
  }

  // Number of unread messages without consuming them.
  unreadCount(): number {
    return Math.max(0, this.allLines().length - this.lastReadLines);
  }

  // Mark everything currently in the mailbox as read without returning it.
  markAllRead(): void {
    withLock(this.filePath, () => {
      this.lastReadLines = this.allLines().length;
      this.saveReadState();
    });
  }

  async *poll(intervalMs = 1000): AsyncGenerator<FileMailMessage> {
    while (true) {
      const messages = await this.receive();
      for (const msg of messages) {
        yield msg;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
