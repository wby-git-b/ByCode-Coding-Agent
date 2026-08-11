import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserCommands, renderBody } from "../src/commands/loader.js";

function cmdDir(): string {
  const workDir = mkdtempSync(join(tmpdir(), "mewcode-cmd-"));
  mkdirSync(join(workDir, ".mewcode", "commands"), { recursive: true });
  return workDir;
}

describe("user command loader", () => {
  it("loads a command with frontmatter and substitutes $ARGUMENTS", () => {
    const workDir = cmdDir();
    writeFileSync(
      join(workDir, ".mewcode", "commands", "deploy.md"),
      "---\ndescription: Deploy it\naliases: [d, ship]\n---\nDeploy $ARGUMENTS to production."
    );

    const deploy = loadUserCommands(workDir).find((c) => c.name === "deploy");
    expect(deploy).toBeDefined();
    expect(deploy!.description).toBe("Deploy it");
    expect(deploy!.aliases).toEqual(["d", "ship"]);
    expect(deploy!.type).toBe("prompt");
    expect(deploy!.handler({ workDir, args: "staging" })).toBe("Deploy staging to production.");
  });

  it("namespaces subdirectory commands with ':'", () => {
    const workDir = cmdDir();
    const sub = join(workDir, ".mewcode", "commands", "git");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "sync.md"), "Sync the repo.");

    const cmd = loadUserCommands(workDir).find((c) => c.name === "git:sync");
    expect(cmd).toBeDefined();
    expect(cmd!.handler({ workDir, args: "" })).toBe("Sync the repo.");
  });

  it("renderBody appends args when there is no placeholder", () => {
    expect(renderBody("Do the thing.", "extra")).toBe("Do the thing.\n\nextra");
    expect(renderBody("Echo $ARGUMENTS!", "hi")).toBe("Echo hi!");
    expect(renderBody("No args needed.", "")).toBe("No args needed.");
  });
});
