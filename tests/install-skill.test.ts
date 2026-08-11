import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstallSkillTool } from "../src/skills/install-tool.js";
import { SkillCatalog } from "../src/skills/catalog.js";

const SKILL = `---
name: commit-helper
description: Helps write commits
---
Write a conventional-commit message for the staged changes.`;

describe("InstallSkillTool", () => {
  it("installs a skill from a local path and loads it into the catalog", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "mewcode-inst-"));
    const srcPath = join(workDir, "src-skill.md");
    writeFileSync(srcPath, SKILL);

    const catalog = new SkillCatalog();
    const r = await new InstallSkillTool(workDir, catalog).execute({ source: srcPath });

    expect(r.isError).toBe(false);
    expect(r.output).toContain("commit-helper");
    const installed = join(workDir, ".mewcode", "skills", "commit-helper", "SKILL.md");
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, "utf-8")).toContain("conventional-commit");
    // catalog reloaded with the new skill
    expect(catalog.has("commit-helper")).toBe(true);
  });

  it("errors on a missing local source", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "mewcode-inst-"));
    const r = await new InstallSkillTool(workDir, new SkillCatalog()).execute({ source: "nope.md" });
    expect(r.isError).toBe(true);
  });

  it("honors an explicit name override", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "mewcode-inst-"));
    const srcPath = join(workDir, "s.md");
    writeFileSync(srcPath, SKILL);
    const catalog = new SkillCatalog();
    await new InstallSkillTool(workDir, catalog).execute({ source: srcPath, name: "renamed" });
    expect(existsSync(join(workDir, ".mewcode", "skills", "renamed", "SKILL.md"))).toBe(true);
  });
});
