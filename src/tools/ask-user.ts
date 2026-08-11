// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import type { Tool, ToolResult } from "./types.js";

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

// Maps each question text to the user's chosen answer (labels joined for
// multi-select, or free text for "Other").
export type AskAnswers = Record<string, string>;

export type Asker = (questions: Question[]) => Promise<AskAnswers>;

// Structured multiple-choice question tool (mirrors Go AskUserQuestionTool).
// The actual prompting is delegated to an injected asker (the TUI dialog), the
// same pattern as onPermissionRequest.
export class AskUserQuestionTool implements Tool {
  name = "AskUserQuestion";
  description =
    "Ask the user one to four multiple-choice questions and wait for their answers. " +
    "Each question needs 2-4 options; an \"Other\" option for custom input is added automatically. " +
    "Set multiSelect: true when choices are not mutually exclusive.";
  category = "read" as const;
  system = true;

  constructor(private ask: Asker) {}

  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                question: { type: "string", description: "The question to ask" },
                header: { type: "string", description: "Very short label/category (≤12 chars)" },
                options: {
                  type: "array",
                  minItems: 2,
                  maxItems: 4,
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      description: { type: "string" },
                    },
                    required: ["label"],
                  },
                },
                multiSelect: { type: "boolean" },
              },
              required: ["question", "header", "options", "multiSelect"],
            },
          },
        },
        required: ["questions"],
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const questions = args.questions as Question[] | undefined;
    if (!Array.isArray(questions) || questions.length === 0 || questions.length > 4) {
      return { output: "Error: must have 1-4 questions", isError: true };
    }
    for (const q of questions) {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
        return { output: `Error: question '${q?.question}' must have 2-4 options`, isError: true };
      }
    }

    const answers = await this.ask(questions);
    const parts = Object.entries(answers).map(([q, a]) => `"${q}" = "${a}"`);
    return {
      output: `User has answered your questions: ${parts.join(", ")}. You can now continue with the user's answers in mind.`,
      isError: false,
    };
  }
}
