// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export type PlanChoice = "yolo" | "manual" | "feedback";

interface Props {
  onSelect: (choice: PlanChoice, feedback?: string) => void;
}

const OPTIONS = [
  "Yes, enter YOLO mode (auto-approve all)",
  "Yes, manually approve edits",
  "Tell MewCode what to change",
];

export function PlanApprovalDialog({ onSelect }: Props) {
  const [cursor, setCursor] = useState(0);
  const [feedbackText, setFeedbackText] = useState("");

  useInput((input, key) => {
    if (key.upArrow && cursor > 0) {
      setCursor(cursor - 1);
      return;
    }
    if (key.downArrow && cursor < 2) {
      setCursor(cursor + 1);
      return;
    }
    if (key.return) {
      if (cursor === 0) onSelect("yolo");
      else if (cursor === 1) onSelect("manual");
      else if (cursor === 2 && feedbackText) onSelect("feedback", feedbackText);
      return;
    }
    if (key.escape) {
      onSelect("manual");
      return;
    }
    if (key.tab && key.shift && cursor === 2 && feedbackText) {
      onSelect("feedback", feedbackText);
      return;
    }
    if (cursor === 2) {
      if (key.backspace) {
        setFeedbackText((prev) => prev.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setFeedbackText((prev) => prev + input);
      }
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="magenta">
        MewCode has written up a plan and is ready to execute. Would you like to proceed?
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((label, i) => (
          <Text key={i}>
            {i === cursor ? (
              <Text bold color="cyan">{"❯ "}</Text>
            ) : (
              <Text>{"  "}</Text>
            )}
            <Text dimColor={i !== cursor}>
              {i + 1}. {label}
            </Text>
          </Text>
        ))}
        {cursor === 2 && (
          <Box marginLeft={4} flexDirection="column">
            <Text>{feedbackText || <Text dimColor>Type feedback here...</Text>}█</Text>
            <Text dimColor>shift+tab to approve with this feedback</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
