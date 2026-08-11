// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import chalk from "chalk";

export const brand = {
  primary: chalk.hex("#a78bfa"),
  dim: chalk.dim,
  bright: chalk.bold.white,
  error: chalk.bold.red,
  success: chalk.green,
  warning: chalk.yellow,
  muted: chalk.gray,
  tool: chalk.cyan,
  thinking: chalk.hex("#8b5cf6"),
  user: chalk.bold.blue,
  assistant: chalk.bold.hex("#a78bfa"),
};

export const symbols = {
  prompt: "❯",
  thinking: "◆",
  tool: "▶",
  success: "✓",
  error: "✗",
  arrow: "→",
  dot: "·",
};

export const commandIcons: Record<string, string> = {
  local: "⚙",
  local_ui: "⚙",
  skill_fork: "★",
  prompt: "◇",
};

export const borderColors: Record<string, string> = {
  // focused 用品牌紫，idle 用灰，两者要能一眼分辨输入框当前是否可输入
  idle: "gray",
  focused: "#a78bfa",
  agent: "#a855f6",
  error: "red",
};
