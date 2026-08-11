// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import React from "react";
import { Box, Text } from "ink";

/** EditFile 的输出是结构化 diff 文本，其余工具仍是普通字符串 */
export function isDiffTool(toolName: string): boolean {
  return toolName === "EditFile";
}

/**
 * 把 buildDiff() 产出的带行号 diff 文本渲染成彩色行：
 * "+ " 开头绿色、"- " 开头红色，其余（上下文行/摘要行）灰色。
 */
export function DiffLines({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        if (line.startsWith("+ ")) return <Text key={i} color="green">{line}</Text>;
        if (line.startsWith("- ")) return <Text key={i} color="red">{line}</Text>;
        return <Text key={i} dimColor>{line}</Text>;
      })}
    </Box>
  );
}
