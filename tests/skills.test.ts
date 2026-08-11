import { describe, it, expect } from "bun:test";
import { runInline } from "../src/skills/executor.js";
import type { Skill, SkillHost } from "../src/skills/skill.js";

function makeHost() {
  const activated: [string, string][] = [];
  const host: SkillHost = {
    activateSkill: (n, b) => activated.push([n, b]),
  };
  return { host, activated };
}

function skill(body: string): Skill {
  return {
    meta: { name: "demo", description: "d" },
    body,
    sourceDir: "",
    isDirectory: false,
  };
}

describe("skills runInline", () => {
  it("substitutes $ARGUMENTS and activates the skill", () => {
    const { host, activated } = makeHost();
    const body = runInline(skill("Do $ARGUMENTS now."), "the thing", host);

    expect(body).toBe("Do the thing now.");
    expect(activated[0][0]).toBe("demo");
    expect(activated[0][1]).toBe("Do the thing now.");
  });

  it("appends a User Request fallback when there is no placeholder", () => {
    const { host } = makeHost();
    const body = runInline(skill("SOP body"), "extra context", host);
    expect(body).toContain("SOP body");
    expect(body).toContain("User Request: extra context");
  });
});
