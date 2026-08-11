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
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

export interface Backup {
  backupPath: string;
  version: number;
  time: string;
}

export interface Snapshot {
  messageIndex: number;
  userText: string;
  backups: Record<string, Backup>;
  timestamp: string;
}

const MAX_SNAPSHOTS = 100;

function backupName(filePath: string, version: number): string {
  const hash = createHash("sha256").update(filePath).digest("hex").slice(0, 16);
  return `${hash}@v${version}`;
}

export class FileHistory {
  private sessionDir: string;
  private trackedFiles = new Map<string, number>();
  private snapshots: Snapshot[] = [];

  constructor(baseDir: string, sessionID: string) {
    this.sessionDir = join(baseDir, ".mewcode", "file-history", sessionID);
    mkdirSync(this.sessionDir, { recursive: true });
  }

  trackEdit(path: string): void {
    const absPath = resolve(path);
    const ver = this.trackedFiles.get(absPath) ?? 0;
    const newVer = ver + 1;

    if (existsSync(absPath)) {
      try {
        const content = readFileSync(absPath);
        const bkName = backupName(absPath, newVer);
        writeFileSync(join(this.sessionDir, bkName), content);
      } catch {
        // skip unreadable files
      }
    }
    // If file doesn't exist, we still bump version — signals "file didn't exist" on rewind

    this.trackedFiles.set(absPath, newVer);
  }

  makeSnapshot(msgIndex: number, userText: string): void {
    let label = userText;
    if (label.length > 60) {
      label = label.slice(0, 60) + "...";
    }

    const backups: Record<string, Backup> = {};
    for (const [filePath, version] of this.trackedFiles) {
      const bkName = backupName(filePath, version);
      const bkPath = join(this.sessionDir, bkName);

      // Safety net: if backup doesn't exist yet but file does, create it now
      if (!existsSync(bkPath) && existsSync(filePath)) {
        try {
          writeFileSync(bkPath, readFileSync(filePath));
        } catch {
          // skip
        }
      }

      backups[filePath] = {
        backupPath: bkPath,
        version,
        time: new Date().toISOString(),
      };
    }

    this.snapshots.push({
      messageIndex: msgIndex,
      userText: label,
      backups,
      timestamp: new Date().toISOString(),
    });

    if (this.snapshots.length > MAX_SNAPSHOTS) {
      this.snapshots = this.snapshots.slice(this.snapshots.length - MAX_SNAPSHOTS);
    }
  }

  rewind(snapshotIndex: number): string[] {
    if (snapshotIndex < 0 || snapshotIndex >= this.snapshots.length) {
      throw new Error(`Invalid snapshot index: ${snapshotIndex}`);
    }

    const target = this.snapshots[snapshotIndex];
    const changed: string[] = [];

    for (const [filePath, backup] of Object.entries(target.backups)) {
      let backupData: Buffer | null = null;
      try {
        backupData = readFileSync(backup.backupPath) as unknown as Buffer;
      } catch {
        // Backup missing → file didn't exist at snapshot time → delete it now
        if (existsSync(filePath)) {
          try {
            unlinkSync(filePath);
            changed.push(filePath);
          } catch {
            // skip
          }
        }
        continue;
      }

      // Compare with current file
      let currentData: Buffer | null = null;
      try {
        currentData = readFileSync(filePath) as unknown as Buffer;
      } catch {
        // File doesn't exist now but backup exists → restore
      }

      const backupStr = backupData.toString();
      const currentStr = currentData?.toString() ?? "";
      if (backupStr !== currentStr) {
        try {
          writeFileSync(filePath, backupData);
          changed.push(filePath);
        } catch {
          // skip
        }
      }
    }

    // Truncate snapshot history — can't redo forward
    this.snapshots = this.snapshots.slice(0, snapshotIndex + 1);

    // Reset version counters to snapshot state
    for (const [filePath, backup] of Object.entries(target.backups)) {
      this.trackedFiles.set(filePath, backup.version);
    }

    return changed;
  }

  getSnapshots(): Snapshot[] {
    return [...this.snapshots];
  }

  hasSnapshots(): boolean {
    return this.snapshots.length > 0;
  }

  save(): void {
    const filePath = join(this.sessionDir, "snapshots.json");
    writeFileSync(filePath, JSON.stringify(this.snapshots, null, 2), "utf-8");
  }
}
