// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import os from "node:os";

// 沙箱配置：控制文件写入和网络权限
export interface SandboxConfig {
  allowWrite: string[];   // 允许写入的路径列表
  denyWrite: string[];    // 始终只读的路径（优先级高于 allowWrite）
  networkEnabled: boolean; // 是否允许网络访问
}

// 沙箱统一接口，macOS 和 Linux 各自实现
export interface Sandbox {
  // 将原始命令包装成沙箱内执行的命令字符串
  wrap(command: string, config: SandboxConfig): string;
  // 检查当前平台的沙箱工具是否可用
  available(): boolean;
}

/**
 * 根据当前操作系统创建对应的沙箱实例。
 * macOS → seatbelt (sandbox-exec)
 * Linux → bubblewrap (bwrap)
 * 其他平台 → null（不支持沙箱）
 */
export function createSandbox(): Sandbox | null {
  const platform = os.platform();
  if (platform === "darwin") {
    const { SeatbeltSandbox } = require("./seatbelt");
    return new SeatbeltSandbox();
  }
  if (platform === "linux") {
    const { BwrapSandbox } = require("./bwrap");
    return new BwrapSandbox();
  }
  return null;
}
