// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import React from "react";
import { Text } from "ink";

interface Props {
  count: number; // number of active teammates
}

export function TeamStatus({ count }: Props) {
  if (count === 0) return null;

  const label = count === 1 ? "teammate" : "teammates";

  return (
    <Text dimColor>
      <Text color="magenta">●</Text> {count} {label}
    </Text>
  );
}
