// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import React, { useState, useCallback, useRef, useReducer } from "react";
import { Box, Text, useInput } from "ink";
import { brand, symbols } from "./styles.js";
import type { Question, AskAnswers } from "../tools/ask-user.js";

interface Props {
  questions: Question[];
  onComplete: (answers: AskAnswers) => void;
}

const OTHER_VALUE = "__other__";

// ── 状态管理（参照 Claude Code 的 use-multiple-choice-state.ts）──

interface QuestionState {
  cursor: number;
  selectedValue?: string | string[];
  textInputValue: string;
  answer?: string;
  otherMode: boolean;
}

interface State {
  currentIndex: number;
  questionStates: QuestionState[];
  submitCursor: number; // 0=Submit, 1=Cancel
}

type Action =
  | { type: "next" }
  | { type: "prev" }
  | { type: "goto"; index: number }
  | { type: "update"; index: number; updates: Partial<QuestionState> }
  | { type: "set-submit-cursor"; cursor: number };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "next":
      return { ...state, currentIndex: Math.min(state.currentIndex + 1, state.questionStates.length) };
    case "prev":
      return { ...state, currentIndex: Math.max(state.currentIndex - 1, 0) };
    case "goto":
      return { ...state, currentIndex: action.index };
    case "update": {
      const qs = [...state.questionStates];
      qs[action.index] = { ...qs[action.index], ...action.updates };
      return { ...state, questionStates: qs };
    }
    case "set-submit-cursor":
      return { ...state, submitCursor: action.cursor };
    default:
      return state;
  }
}

// ── 导航栏（参照 Claude Code 的 QuestionNavigationBar）──

function NavigationBar({ questions, currentIndex, states, hideSubmit }: {
  questions: Question[];
  currentIndex: number;
  states: QuestionState[];
  hideSubmit: boolean;
}) {
  const total = questions.length + (hideSubmit ? 0 : 1);
  const isFirst = currentIndex === 0;
  const isLast = currentIndex >= total - 1;

  return (
    <Box flexDirection="row" marginBottom={1}>
      <Text dimColor={isFirst} color={isFirst ? undefined : "white"}>{" ← "}</Text>
      {questions.map((q, i) => {
        const active = currentIndex === i;
        const answered = states[i].answer !== undefined;
        const check = answered ? "☑" : "☐";
        if (active) {
          return (
            <Text key={i} backgroundColor="magenta" color="white" bold>
              {` ${check} ${q.header} `}
            </Text>
          );
        }
        return (
          <Text key={i} dimColor={!answered} color={answered ? "green" : undefined}>
            {` ${check} ${q.header} `}
          </Text>
        );
      })}
      {!hideSubmit && (
        currentIndex === questions.length ? (
          <Text backgroundColor="magenta" color="white" bold>{" ✓ Submit "}</Text>
        ) : (
          <Text dimColor>{" ✓ Submit "}</Text>
        )
      )}
      <Text dimColor={isLast} color={isLast ? undefined : "white"}>{" → "}</Text>
    </Box>
  );
}

// ── 问题视图（参照 Claude Code 的 QuestionView + Select compact-vertical）──

function QuestionContent({ question, state, questionIndex, totalQuestions }: {
  question: Question;
  state: QuestionState;
  questionIndex: number;
  totalQuestions: number;
}) {
  const options = question.options;
  const otherIndex = options.length;
  const maxIdxWidth = String(otherIndex + 1).length;

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>{question.question}</Text>
      {question.multiSelect && <Text dimColor>{"  (space to toggle, enter to confirm)"}</Text>}
      <Text> </Text>
      {options.map((opt, i) => {
        const isFocused = state.cursor === i;
        const isSelected = state.answer === opt.label;
        const idx = String(i + 1).padStart(maxIdxWidth, " ");
        const pointer = isFocused ? "❯" : " ";
        const checked = question.multiSelect && (
          Array.isArray(state.selectedValue) ? state.selectedValue.includes(opt.label) : false
        );
        const checkMark = question.multiSelect ? (checked ? "☑ " : "☐ ") : "";
        const color = isFocused ? "cyan" : isSelected ? "green" : undefined;
        return (
          <Box key={opt.label} flexDirection="column">
            <Text>
              <Text color={isFocused ? "cyan" : undefined}>{pointer}</Text>
              <Text dimColor> {idx}. </Text>
              <Text color={color} dimColor={!isFocused && !isSelected}>
                {checkMark}{opt.label}
              </Text>
            </Text>
            {opt.description && (
              <Box paddingLeft={maxIdxWidth + 5}>
                <Text dimColor>{opt.description}</Text>
              </Box>
            )}
          </Box>
        );
      })}
      {/* Other 选项 */}
      <Box flexDirection="column">
        <Text>
          <Text color={state.cursor === otherIndex ? "cyan" : undefined}>
            {state.cursor === otherIndex ? "❯" : " "}
          </Text>
          <Text dimColor> {String(otherIndex + 1).padStart(maxIdxWidth, " ")}. </Text>
          <Text color={state.cursor === otherIndex ? "cyan" : undefined} dimColor={state.cursor !== otherIndex}>
            Other (type your own)
          </Text>
        </Text>
      </Box>
      {state.otherMode && (
        <Box paddingLeft={maxIdxWidth + 5}>
          <Text>
            <Text dimColor>{"› "}</Text>
            <Text color="cyan">{state.textInputValue}</Text>
            <Text inverse> </Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ── 提交视图（参照 Claude Code 的 SubmitQuestionsView）──

function SubmitContent({ questions, states, allAnswered, submitCursor }: {
  questions: Question[];
  states: QuestionState[];
  allAnswered: boolean;
  submitCursor: number;
}) {
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>Review your answers</Text>
      <Text> </Text>
      {!allAnswered && (
        <Text color="yellow">{"  ⚠ You have not answered all questions"}</Text>
      )}
      {questions.map((q, i) => (
        <Box key={q.question} flexDirection="column" marginBottom={0}>
          <Text>
            <Text dimColor>{"  • "}</Text>
            <Text>{q.question}</Text>
          </Text>
          {states[i].answer !== undefined ? (
            <Text>
              <Text color="green">{"    → "}</Text>
              <Text color="green">{states[i].answer}</Text>
            </Text>
          ) : (
            <Text dimColor>{"    → (not answered)"}</Text>
          )}
        </Box>
      ))}
      <Text> </Text>
      {allAnswered && (
        <Box flexDirection="column">
          <Text dimColor>Ready to submit your answers?</Text>
          <Text> </Text>
          <Text>
            <Text color={submitCursor === 0 ? "cyan" : undefined}>
              {submitCursor === 0 ? "❯" : " "}
            </Text>
            <Text color={submitCursor === 0 ? "cyan" : undefined} dimColor={submitCursor !== 0} bold={submitCursor === 0}>
              {" Submit answers"}
            </Text>
          </Text>
          <Text>
            <Text color={submitCursor === 1 ? "cyan" : undefined}>
              {submitCursor === 1 ? "❯" : " "}
            </Text>
            <Text color={submitCursor === 1 ? "cyan" : undefined} dimColor={submitCursor !== 1}>
              {" Cancel"}
            </Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ── 主组件 ──

export function AskUserDialog({ questions, onComplete }: Props) {
  const hideSubmit = questions.length === 1 && !questions[0].multiSelect;
  const totalTabs = questions.length + (hideSubmit ? 0 : 1);

  const [state, dispatch] = useReducer(reducer, {
    currentIndex: 0,
    questionStates: questions.map(() => ({
      cursor: 0,
      textInputValue: "",
      otherMode: false,
    })),
    submitCursor: 0,
  });

  const { currentIndex, questionStates, submitCursor } = state;
  const isSubmitTab = !hideSubmit && currentIndex === questions.length;
  const q = isSubmitTab ? undefined : questions[currentIndex];
  const qs = isSubmitTab ? undefined : questionStates[currentIndex];
  const allAnswered = questionStates.every((s) => s.answer !== undefined);

  const commitAnswer = (answer: string, advance = true) => {
    dispatch({ type: "update", index: currentIndex, updates: { answer, otherMode: false } });
    if (advance) {
      if (hideSubmit) {
        // 单问题：直接提交
        const answers: AskAnswers = {};
        answers[questions[0].question] = answer;
        onComplete(answers);
        return;
      }
      dispatch({ type: "next" });
    }
  };

  useInput((input, key) => {
    // 过滤 SGR 鼠标事件
    if (input.includes("[<") && /\[\<\d+;\d+;\d+[Mm]/.test(input)) return;

    // Other 文本输入模式
    if (!isSubmitTab && qs?.otherMode) {
      if (key.return) {
        commitAnswer(qs.textInputValue.trim() || "(no answer)");
      } else if (key.backspace || key.delete) {
        dispatch({ type: "update", index: currentIndex, updates: {
          textInputValue: qs.textInputValue.slice(0, -1)
        }});
      } else if (key.escape) {
        dispatch({ type: "update", index: currentIndex, updates: { otherMode: false } });
      } else if (input && !key.ctrl && !key.meta) {
        dispatch({ type: "update", index: currentIndex, updates: {
          textInputValue: qs.textInputValue + input
        }});
      }
      return;
    }

    if (key.escape) {
      onComplete({});
      return;
    }

    // Tab 导航
    if (key.leftArrow && !isSubmitTab) { dispatch({ type: "prev" }); return; }
    if (key.rightArrow && !isSubmitTab) { dispatch({ type: "next" }); return; }
    if (key.tab) { dispatch({ type: key.shift ? "prev" : "next" }); return; }

    // 提交视图
    if (isSubmitTab) {
      if (key.upArrow) { dispatch({ type: "set-submit-cursor", cursor: 0 }); return; }
      if (key.downArrow) { dispatch({ type: "set-submit-cursor", cursor: 1 }); return; }
      if (key.leftArrow) { dispatch({ type: "prev" }); return; }
      if (key.return) {
        if (submitCursor === 0 && allAnswered) {
          const answers: AskAnswers = {};
          for (let i = 0; i < questions.length; i++) {
            answers[questions[i].question] = questionStates[i].answer!;
          }
          onComplete(answers);
        } else if (submitCursor === 1) {
          onComplete({});
        }
      }
      return;
    }

    if (!q || !qs) return;
    const optCount = q.options.length + 1; // +1 for Other

    // 数字快捷键
    const num = parseInt(input, 10);
    if (num >= 1 && num <= optCount) {
      dispatch({ type: "update", index: currentIndex, updates: { cursor: num - 1 } });
      return;
    }

    if (key.upArrow) {
      dispatch({ type: "update", index: currentIndex, updates: {
        cursor: qs.cursor > 0 ? qs.cursor - 1 : optCount - 1
      }});
    } else if (key.downArrow) {
      dispatch({ type: "update", index: currentIndex, updates: {
        cursor: qs.cursor < optCount - 1 ? qs.cursor + 1 : 0
      }});
    } else if (input === " " && q.multiSelect && qs.cursor < q.options.length) {
      const current = Array.isArray(qs.selectedValue) ? [...qs.selectedValue] : [];
      const label = q.options[qs.cursor].label;
      const idx = current.indexOf(label);
      if (idx >= 0) current.splice(idx, 1); else current.push(label);
      dispatch({ type: "update", index: currentIndex, updates: { selectedValue: current } });
    } else if (key.return) {
      if (qs.cursor === q.options.length) {
        // Other
        dispatch({ type: "update", index: currentIndex, updates: { otherMode: true } });
      } else if (q.multiSelect) {
        const selected = Array.isArray(qs.selectedValue) ? qs.selectedValue : [];
        if (selected.length > 0) {
          commitAnswer(selected.join(", "));
        } else {
          commitAnswer(q.options[qs.cursor]?.label ?? "(unknown)");
        }
      } else {
        commitAnswer(q.options[qs.cursor]?.label ?? "(unknown)");
      }
    }
  });

  // 动态帮助文本
  const helpParts: string[] = [];
  if (!isSubmitTab) {
    helpParts.push("Enter to select");
    helpParts.push("↑/↓ to navigate");
    if (questions.length > 1) helpParts.push("Tab/Arrow keys to switch questions");
  }
  helpParts.push("Esc to cancel");
  const helpText = helpParts.join(" · ");

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text dimColor>{"─".repeat(60)}</Text>
      <NavigationBar
        questions={questions}
        currentIndex={currentIndex}
        states={questionStates}
        hideSubmit={hideSubmit}
      />
      {isSubmitTab ? (
        <SubmitContent
          questions={questions}
          states={questionStates}
          allAnswered={allAnswered}
          submitCursor={submitCursor}
        />
      ) : q && qs ? (
        <QuestionContent
          question={q}
          state={qs}
          questionIndex={currentIndex}
          totalQuestions={questions.length}
        />
      ) : null}
      <Text> </Text>
      <Text dimColor>{"  "}{helpText}</Text>
    </Box>
  );
}
