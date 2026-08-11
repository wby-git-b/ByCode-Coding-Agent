import { describe, it, expect } from "bun:test";
import { AskUserQuestionTool, type Question } from "../src/tools/ask-user.js";

function q(overrides: Partial<Question> = {}): Question {
  return {
    question: "Pick one",
    header: "Choice",
    options: [{ label: "A" }, { label: "B" }],
    multiSelect: false,
    ...overrides,
  };
}

describe("AskUserQuestionTool", () => {
  it("rejects 0 or more than 4 questions", async () => {
    const tool = new AskUserQuestionTool(async () => ({}));
    expect((await tool.execute({ questions: [] })).isError).toBe(true);
    expect((await tool.execute({ questions: [q(), q(), q(), q(), q()] })).isError).toBe(true);
  });

  it("rejects a question with fewer than 2 or more than 4 options", async () => {
    const tool = new AskUserQuestionTool(async () => ({}));
    const tooFew = await tool.execute({ questions: [q({ options: [{ label: "only" }] })] });
    expect(tooFew.isError).toBe(true);
    const tooMany = await tool.execute({
      questions: [q({ options: [{ label: "1" }, { label: "2" }, { label: "3" }, { label: "4" }, { label: "5" }] })],
    });
    expect(tooMany.isError).toBe(true);
  });

  it("delegates to the asker and formats the answers", async () => {
    const tool = new AskUserQuestionTool(async (qs) => ({ [qs[0].question]: "A" }));
    const r = await tool.execute({ questions: [q()] });
    expect(r.isError).toBe(false);
    expect(r.output).toContain('"Pick one" = "A"');
    expect(r.output).toContain("continue");
  });
});
