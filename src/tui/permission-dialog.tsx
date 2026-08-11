// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { brand, symbols } from "./styles.js";

export type PermissionAction = "allow" | "deny" | "allowAlways";

const options: { label: string; action: PermissionAction }[] = [
  { label: "Yes", action: "allow" },
  { label: "Yes, and don't ask again for this pattern", action: "allowAlways" },
  { label: "No", action: "deny" },
];

interface Props {
  toolName: string;
  argsSummary: string;
  reason: string;
  onComplete: (action: PermissionAction) => void;
}

export function PermissionDialog({ toolName, argsSummary, reason, onComplete }: Props) {
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((c) => (c > 0 ? c - 1 : options.length - 1));
    } else if (key.downArrow) {
      setCursor((c) => (c < options.length - 1 ? c + 1 : 0));
    } else if (key.return) {
      onComplete(options[cursor].action);
    } else if (key.escape) {
      onComplete("deny");
    }
  });

  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text bold>{brand.warning(`  ${toolName} command`)}</Text>
      <Text> </Text>
      {argsSummary && (
        <Text>    <Text dimColor>{argsSummary.length > 120 ? argsSummary.slice(0, 120) + "…" : argsSummary}</Text></Text>
      )}
      <Text> </Text>
      <Text dimColor>  This command requires approval</Text>
      <Text> </Text>
      <Text>  Do you want to proceed?</Text>
      {options.map((opt, i) => (
        <Text key={opt.label}>
          {i === cursor ? brand.tool(` ${symbols.prompt} `) : "   "}
          {i === cursor ? (
            <Text color="cyan">{`${i + 1}. ${opt.label}`}</Text>
          ) : (
            <Text dimColor>{`${i + 1}. ${opt.label}`}</Text>
          )}
        </Text>
      ))}
      <Text> </Text>
    </Box>
  );
}
