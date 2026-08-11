import { describe, it, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getOrCreatePlanPath,
  savePlan,
  loadPlan,
  planExists,
  resetPlanPath,
} from "../src/planfile/planfile.js";
import { buildPlanModeReminder } from "../src/prompt/plan-mode.js";

describe("planfile", () => {
  it("creates, saves, loads, and resets a plan", () => {
    resetPlanPath();
    const workDir = mkdtempSync(join(tmpdir(), "mewcode-plan-"));

    const path = getOrCreatePlanPath(workDir);
    expect(path).toContain(join(".mewcode", "plans"));
    expect(existsSync(path)).toBe(true);
    expect(planExists(workDir)).toBe(true);
    // Stable within a process.
    expect(getOrCreatePlanPath(workDir)).toBe(path);

    savePlan(workDir, "# Plan\n- step 1\n- step 2");
    expect(loadPlan(workDir)).toContain("step 2");

    resetPlanPath();
    expect(planExists(workDir)).toBe(false);
    expect(loadPlan(workDir)).toBeNull();
  });

  it("reminder reflects whether a plan file exists", () => {
    const withPlan = buildPlanModeReminder("/x/plan.md", true, 1);
    expect(withPlan).toContain("plan file already exists");
    const noPlan = buildPlanModeReminder("/x/plan.md", false, 1);
    expect(noPlan).toContain("No plan file exists");
    expect(noPlan).toContain("MUST NOT make any edits");
  });
});
