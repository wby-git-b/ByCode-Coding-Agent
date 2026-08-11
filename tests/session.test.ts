import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveMessage,
  loadSession,
  listSessions,
  newSessionId,
  saveCompactBoundary,
  rebuildFromSession,
  COMPACT_BOUNDARY,
} from "../src/session/session.js";

describe("session save/load round-trip", () => {
  it("persists messages and loads them back in order", () => {
    const workDir = mkdtempSync(join(tmpdir(), "mewcode-sess-"));
    const id = newSessionId();

    saveMessage(workDir, id, { role: "user", content: "first", timestamp: "t1" });
    saveMessage(workDir, id, { role: "assistant", content: "reply", timestamp: "t2" });

    const loaded = loadSession(workDir, id);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({ role: "user", content: "first" });
    expect(loaded[1]).toMatchObject({ role: "assistant", content: "reply" });
  });

  it("skips malformed and empty-content lines instead of crashing", () => {
    const workDir = mkdtempSync(join(tmpdir(), "mewcode-sess-"));
    const id = "broken";
    const dir = join(workDir, ".mewcode", "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${id}.jsonl`),
      [
        JSON.stringify({ role: "user", content: "ok", timestamp: "t" }),
        "{ not valid json",
        JSON.stringify({ role: "assistant", content: "", timestamp: "t" }),
        JSON.stringify({ role: "assistant", content: "good", timestamp: "t" }),
      ].join("\n") + "\n"
    );

    const loaded = loadSession(workDir, id);
    expect(loaded.map((m) => m.content)).toEqual(["ok", "good"]);
  });

  it("labels a session by its first user message", () => {
    const workDir = mkdtempSync(join(tmpdir(), "mewcode-sess-"));
    const id = newSessionId();
    // First persisted line is a system message; the label should skip to user.
    saveMessage(workDir, id, { role: "system", content: "boot", timestamp: "t0" });
    saveMessage(workDir, id, { role: "user", content: "the real question", timestamp: "t1" });

    const info = listSessions(workDir).find((s) => s.id === id)!;
    expect(info.firstMessage).toBe("the real question");
    expect(info.messageCount).toBe(2);
  });
});

describe("rebuildFromSession (compacted-state resume)", () => {
  it("rebuilds the compacted state from the last compact_boundary", () => {
    const workDir = mkdtempSync(join(tmpdir(), "mewcode-sess-"));
    const id = newSessionId();

    // Original pre-boundary history that compaction summarized away. These must
    // NOT be replayed on resume — only the summary stands in for them.
    saveMessage(workDir, id, { role: "user", content: "ORIGINAL-Q-1 must-not-replay", timestamp: "t0" });
    saveMessage(workDir, id, { role: "assistant", content: "ORIGINAL-A-1 must-not-replay", timestamp: "t1" });
    saveMessage(workDir, id, { role: "user", content: "ORIGINAL-Q-2 must-not-replay", timestamp: "t2" });

    // The boundary: summary + the verbatim kept tail inlined as role+text.
    saveCompactBoundary(workDir, id, {
      summary: "SUMMARY of the old prefix",
      keep: [
        { role: "user", content: "KEPT-Q recent" },
        { role: "assistant", content: "KEPT-A recent" },
      ],
    });

    // Continuation turns appended AFTER the boundary (e.g. after a prior resume).
    saveMessage(workDir, id, { role: "user", content: "POST-BOUNDARY-Q new", timestamp: "t3" });
    saveMessage(workDir, id, { role: "assistant", content: "POST-BOUNDARY-A new", timestamp: "t4" });

    const saved = loadSession(workDir, id);
    const rebuilt = rebuildFromSession(saved);
    const joined = rebuilt.map((m) => `${m.role}:${m.content}`).join("\n");

    // Summary is present with Chinese framing, replayed as a synthetic user message.
    expect(rebuilt[0].role).toBe("user");
    expect(rebuilt[0].content).toContain("本次会话延续自之前的对话");
    expect(rebuilt[0].content).toContain("SUMMARY of the old prefix");
    expect(rebuilt[0].content).toContain("近期消息已原样保留");
    // Kept tail (original text) is replayed verbatim, in order, with roles.
    expect(rebuilt[1]).toEqual({ role: "user", content: "KEPT-Q recent" });
    expect(rebuilt[2]).toEqual({ role: "assistant", content: "KEPT-A recent" });
    // Post-boundary continuation messages are replayed.
    expect(joined).toContain("user:POST-BOUNDARY-Q new");
    expect(joined).toContain("assistant:POST-BOUNDARY-A new");
    // Pre-boundary originals are NOT replayed (the summary replaces them).
    expect(joined).not.toContain("must-not-replay");
    // Exactly: summary + 2 kept + 2 post-boundary.
    expect(rebuilt).toHaveLength(5);
  });

  it("uses only the LAST boundary when a session was compacted twice (chaining)", () => {
    const workDir = mkdtempSync(join(tmpdir(), "mewcode-sess-"));
    const id = newSessionId();

    saveMessage(workDir, id, { role: "user", content: "VERY-OLD must-not-replay", timestamp: "t0" });
    // First boundary (superseded by the second).
    saveCompactBoundary(workDir, id, {
      summary: "FIRST-SUMMARY must-not-replay",
      keep: [{ role: "user", content: "FIRST-KEEP must-not-replay" }],
    });
    saveMessage(workDir, id, { role: "assistant", content: "MID must-not-replay", timestamp: "t1" });
    // Second (latest) boundary — the one resume should use.
    saveCompactBoundary(workDir, id, {
      summary: "SECOND-SUMMARY",
      keep: [{ role: "assistant", content: "SECOND-KEEP recent" }],
    });
    saveMessage(workDir, id, { role: "user", content: "AFTER-SECOND new", timestamp: "t2" });

    const rebuilt = rebuildFromSession(loadSession(workDir, id));
    const joined = rebuilt.map((m) => `${m.role}:${m.content}`).join("\n");

    expect(joined).toContain("SECOND-SUMMARY");
    expect(joined).toContain("SECOND-KEEP recent");
    expect(joined).toContain("AFTER-SECOND new");
    // Nothing from before the last boundary leaks in.
    expect(joined).not.toContain("must-not-replay");
    expect(rebuilt).toHaveLength(3); // summary + 1 kept + 1 post-boundary
  });

  it("full-replays an old session with no boundary (backward compatible)", () => {
    const workDir = mkdtempSync(join(tmpdir(), "mewcode-sess-"));
    const id = newSessionId();

    saveMessage(workDir, id, { role: "user", content: "q1", timestamp: "t0" });
    saveMessage(workDir, id, { role: "assistant", content: "a1", timestamp: "t1" });
    saveMessage(workDir, id, { role: "user", content: "q2", timestamp: "t2" });

    const rebuilt = rebuildFromSession(loadSession(workDir, id));
    expect(rebuilt).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ]);
  });

  it("persists the boundary as a COMPACT_BOUNDARY-typed record on disk", () => {
    const workDir = mkdtempSync(join(tmpdir(), "mewcode-sess-"));
    const id = newSessionId();
    saveCompactBoundary(workDir, id, { summary: "s", keep: [] });

    const saved = loadSession(workDir, id);
    expect(saved).toHaveLength(1);
    expect(saved[0].type).toBe(COMPACT_BOUNDARY);
    expect(JSON.parse(saved[0].content)).toEqual({ summary: "s", keep: [] });
  });
});
