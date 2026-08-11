import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SPILL_DIR = ".mewcode";
const REPLACEMENTS_FILE = "replacements.json";

interface ReplacementRecord {
  toolUseId: string;
  spillPath: string;
  originalSize: number;
  timestamp: string;
}

export class ContentReplacementState {
  private replacements: Map<string, ReplacementRecord> = new Map();
  private workDir: string = "";
  private sessionId: string = "";

  init(workDir: string, sessionId: string): void {
    this.workDir = workDir;
    this.sessionId = sessionId;
    this.load();
  }

  private getSpillDir(): string {
    return join(this.workDir, SPILL_DIR, "sessions", this.sessionId || "default", "tool_results");
  }

  private getReplacementsPath(): string {
    return join(this.workDir, SPILL_DIR, "sessions", this.sessionId || "default", REPLACEMENTS_FILE);
  }

  private load(): void {
    const path = this.getReplacementsPath();
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, "utf-8")) as ReplacementRecord[];
        this.replacements.clear();
        for (const r of data) {
          this.replacements.set(r.toolUseId, r);
        }
      } catch {
        // ignore corrupt file
      }
    }
  }

  private save(): void {
    const dir = join(this.workDir, SPILL_DIR, "sessions", this.sessionId || "default");
    mkdirSync(dir, { recursive: true });
    const data = Array.from(this.replacements.values());
    writeFileSync(this.getReplacementsPath(), JSON.stringify(data, null, 2), "utf-8");
  }

  isReplaced(toolUseId: string): boolean {
    return this.replacements.has(toolUseId);
  }

  getReplacement(toolUseId: string): ReplacementRecord | undefined {
    return this.replacements.get(toolUseId);
  }

  addReplacement(toolUseId: string, spillPath: string, originalSize: number): void {
    this.replacements.set(toolUseId, {
      toolUseId,
      spillPath,
      originalSize,
      timestamp: new Date().toISOString(),
    });
    this.save();
  }

  getAllReplacements(): ReplacementRecord[] {
    return Array.from(this.replacements.values());
  }

  clear(): void {
    this.replacements.clear();
    this.save();
  }
}
