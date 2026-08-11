// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { execSync } from "node:child_process";
import type { Sandbox, SandboxConfig } from "./index.js";

/**
 * Linux bubblewrap (bwrap) 沙箱实现。
 * bwrap 利用 Linux user namespace 创建轻量级隔离环境。
 */
export class BwrapSandbox implements Sandbox {
  available(): boolean {
    try {
      execSync("which bwrap", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  wrap(command: string, config: SandboxConfig): string {
    const args: string[] = [];

    // 隔离 user 和 pid namespace
    args.push("bwrap", "--unshare-user", "--unshare-pid");

    // 根文件系统只读挂载
    args.push("--ro-bind", "/", "/");

    // 按路径放行写入（可写绑定）
    for (const path of config.allowWrite) {
      args.push("--bind", path, path);
    }

    // 强制只读（覆盖上面可写根路径下的子路径）
    for (const path of config.denyWrite) {
      args.push("--ro-bind", path, path);
    }

    // 网络隔离
    if (!config.networkEnabled) {
      args.push("--unshare-net");
    }

    // 挂载 /proc，很多命令依赖它
    args.push("--proc", "/proc");

    // 追加要执行的命令
    args.push("--", "bash", "-c", command);

    // 拼接成完整命令字符串，含空格或特殊字符的参数用单引号包裹
    return args
      .map((arg) => {
        if (/[ \t\n"'\\$`!]/.test(arg)) {
          return `'${arg.replace(/'/g, "'\\''")}'`;
        }
        return arg;
      })
      .join(" ");
  }
}
