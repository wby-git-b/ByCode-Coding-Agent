// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ProviderConfig } from "../config/config.js";
import { brand, symbols } from "./styles.js";

interface Props {
  providers: ProviderConfig[];
  onSelect: (provider: ProviderConfig) => void;
}

export function ProviderSelect({ providers, onSelect }: Props) {
  const [cursor, setCursor] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setCursor((c) => (c > 0 ? c - 1 : providers.length - 1));
    } else if (key.downArrow) {
      setCursor((c) => (c < providers.length - 1 ? c + 1 : 0));
    } else if (key.return) {
      onSelect(providers[cursor]);
    }
  });

  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text bold>{brand.primary("Select a provider:")}</Text>
      <Text dimColor> </Text>
      {providers.map((p, i) => (
        <Box key={p.name}>
          <Text>
            {i === cursor ? brand.primary(`${symbols.prompt} `) : "  "}
            {i === cursor ? brand.bright(p.name) : p.name}
            <Text dimColor>
              {" "}({p.protocol} {symbols.arrow} {p.model})
            </Text>
          </Text>
        </Box>
      ))}
      <Text dimColor>{"\n  ↑/↓ to navigate, Enter to select"}</Text>
    </Box>
  );
}
