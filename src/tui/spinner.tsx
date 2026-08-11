// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import React, { useState, useEffect, useRef } from "react";
import { Text } from "ink";
import InkSpinner from "ink-spinner";
import { brand } from "./styles.js";
import { randomVerb } from "./verbs.js";

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

interface Props {
  label?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export const Spinner = React.memo(function Spinner({ label, inputTokens = 0, outputTokens = 0 }: Props) {
  const [elapsed, setElapsed] = useState(0);
  const verbRef = useRef(label ?? randomVerb());

  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const parts: string[] = [];
  if (inputTokens > 0) parts.push(`${formatTokens(inputTokens)}↓ ${formatTokens(outputTokens)}↑`);
  if (elapsed > 0) parts.push(`${elapsed}s`);
  const detail = parts.length > 0 ? ` (${parts.join(" · ")})` : "";

  return (
    <Text>
      <Text color="magenta">
        <InkSpinner type="dots" />
      </Text>
      {" "}
      <Text dimColor>
        {verbRef.current}{detail}
      </Text>
    </Text>
  );
});
