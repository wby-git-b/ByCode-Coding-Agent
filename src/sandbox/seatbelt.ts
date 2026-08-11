// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { existsSync } from "node:fs";
import type { Sandbox, SandboxConfig } from "./index.js";

// 硬编码路径，防止 PATH 注入攻击
const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/**
 * macOS seatbelt 沙箱实现。
 * 通过动态生成 seatbelt profile 控制文件写入和网络访问权限。
 */
export class SeatbeltSandbox implements Sandbox {
  available(): boolean {
    return existsSync(SANDBOX_EXEC_PATH);
  }

  wrap(command: string, config: SandboxConfig): string {
    const profile = buildProfile(config);
    // 用 -p 参数传入 profile 内容，用 %q 格式化命令避免 shell 二次解析
    const escaped = command.replace(/'/g, "'\\''");
    return `${SANDBOX_EXEC_PATH} -p '${profile}' bash -c '${escaped}'`;
  }
}

/**
 * 动态生成 seatbelt profile 字符串。
 * 策略：默认拒绝 → 放行执行/读取 → 按路径放行写入 → 按路径拒绝写入 → 网络控制。
 */
function buildProfile(config: SandboxConfig): string {
  const lines: string[] = [];

  lines.push("(version 1)");
  lines.push("(deny default)");

  // 允许进程执行和 fork
  lines.push("(allow process-exec)");
  lines.push("(allow process-fork)");
  // 允许读取系统信息
  lines.push("(allow sysctl-read)");
  // 全盘可读
  lines.push('(allow file-read* (subpath "/"))');

  // 按路径放行写入
  for (const path of config.allowWrite) {
    lines.push(`(allow file-write* (subpath "${path}"))`);
  }

  // 拒绝写入的路径放在 allow 之后，seatbelt 后出现的规则优先
  // 单文件用 literal 精确匹配，目录用 subpath 前缀匹配
  for (const path of config.denyWrite) {
    const fs = require("fs");
    const matcher = fs.existsSync(path) && fs.statSync(path).isDirectory() ? "subpath" : "literal";
    lines.push(`(deny file-write* (${matcher} "${path}"))`);
  }

  // 网络控制
  if (config.networkEnabled) {
    lines.push("(allow network*)");
  } else {
    lines.push("(deny network*)");
  }

  return lines.join("\n");
}
