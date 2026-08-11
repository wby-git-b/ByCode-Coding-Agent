// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { PermissionChecker } from "../src/permissions/checker.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mewcode-test-"));
}

function makeChecker(tmpDir: string, rules: Array<{rule: string; effect: string}>) {
  const rulesDir = join(tmpDir, ".mewcode");
  mkdirSync(rulesDir, { recursive: true });
  const rulesFile = join(rulesDir, "permissions.yaml");
  const yaml = rules.map(r => `- rule: "${r.rule}"\n  effect: ${r.effect}`).join("\n");
  writeFileSync(rulesFile, yaml);

  const checker = new PermissionChecker(tmpDir, "default");
  checker.sandboxEnabled = true;
  checker.sandboxAutoAllow = true;
  return checker;
}

describe("sandbox auto-allow respects deny/ask rules", () => {
  it("denies compound command with denied subcommand", () => {
    const dir = makeTmpDir();
    const checker = makeChecker(dir, [{ rule: 'Bash(rm -rf /)', effect: "deny" }]);
    const result = checker.check("Bash", "command", { command: "echo ok && rm -rf /" });
    expect(result.effect).toBe("deny");
  });

  it("allows safe command with sandbox", () => {
    const dir = makeTmpDir();
    const checker = makeChecker(dir, [{ rule: 'Bash(rm -rf /)', effect: "deny" }]);
    const result = checker.check("Bash", "command", { command: "go test ./..." });
    expect(result.effect).toBe("allow");
  });

  it("respects ask rule even with sandbox", () => {
    const dir = makeTmpDir();
    const checker = makeChecker(dir, [{ rule: 'Bash(git push origin main)', effect: "ask" }]);
    const result = checker.check("Bash", "command", { command: "git push origin main" });
    expect(result.effect).toBe("ask");
  });
});
