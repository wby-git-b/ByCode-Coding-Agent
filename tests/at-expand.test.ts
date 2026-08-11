import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandAtRefs } from "../src/tui/at-expand.js";

describe("@file mention expansion", () => {
  it("inlines a referenced file's contents", () => {
    const workDir = mkdtempSync(join(tmpdir(), "mewcode-at-"));
    writeFileSync(join(workDir, "notes.md"), "hello from notes");

    const out = expandAtRefs("please read @notes.md and summarize", workDir);
    expect(out).toContain("please read @notes.md and summarize");
    expect(out).toContain('<file path="notes.md">');
    expect(out).toContain("hello from notes");
  });

  it("leaves non-file @tokens untouched", () => {
    const workDir = mkdtempSync(join(tmpdir(), "mewcode-at-"));
    const text = "ping @alice about @nonexistent.txt";
    expect(expandAtRefs(text, workDir)).toBe(text);
  });

  it("returns the text unchanged when there are no @refs", () => {
    const workDir = mkdtempSync(join(tmpdir(), "mewcode-at-"));
    expect(expandAtRefs("just a plain message", workDir)).toBe("just a plain message");
  });

  it("de-duplicates repeated references", () => {
    const workDir = mkdtempSync(join(tmpdir(), "mewcode-at-"));
    writeFileSync(join(workDir, "a.txt"), "AAA");
    const out = expandAtRefs("@a.txt and again @a.txt", workDir);
    expect(out.match(/<file path="a.txt">/g)?.length).toBe(1);
  });
});
