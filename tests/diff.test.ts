import { describe, it, expect } from "bun:test";
import { buildDiff } from "../src/tools/diff.js";

describe("buildDiff", () => {
  it("reports a single-line change with correct counts and markers", () => {
    const oldContent = "a\nb\nc\nd\ne\n";
    const newContent = "a\nb\nX\nd\ne\n";
    const { text, additions, removals } = buildDiff(oldContent, newContent);
    expect(additions).toBe(1);
    expect(removals).toBe(1);
    expect(text).toContain("-    3  c");
    expect(text).toContain("+    3  X");
    // 上下文行应带正确原始行号
    expect(text).toContain("   2  b");
    expect(text).toContain("   4  d");
  });

  it("handles a pure insertion (no removals)", () => {
    const { text, additions, removals } = buildDiff("a\nb\n", "a\nX\nY\nb\n");
    expect(removals).toBe(0);
    expect(additions).toBe(2);
    expect(text).toContain("+    2  X");
    expect(text).toContain("+    3  Y");
  });

  it("handles a pure deletion (no additions)", () => {
    const { text, additions, removals } = buildDiff("a\nb\nc\n", "a\nc\n");
    expect(additions).toBe(0);
    expect(removals).toBe(1);
    expect(text).toContain("-    2  b");
  });

  it("trims unchanged prefix/suffix so unrelated lines don't show up as changed", () => {
    const oldLines = Array.from({ length: 20 }, (_, i) => `line${i}`);
    const newLines = [...oldLines];
    newLines[10] = "CHANGED";
    const { text } = buildDiff(oldLines.join("\n"), newLines.join("\n"));
    expect(text).not.toContain("line0\n");
    expect(text).toContain("-   11  line10");
    expect(text).toContain("+   11  CHANGED");
  });

  it("caps output for very large diffs instead of dumping everything", () => {
    const oldLines = Array.from({ length: 500 }, (_, i) => `old${i}`);
    const newLines = Array.from({ length: 500 }, (_, i) => `new${i}`);
    const { text } = buildDiff(oldLines.join("\n"), newLines.join("\n"));
    expect(text).toContain("truncated");
    expect(text.split("\n").length).toBeLessThan(500);
  });
});
