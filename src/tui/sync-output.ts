// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

// DEC 2026 同步输出：将每帧的 stdout 写入包裹在 BSU/ESU 标记中，
// 终端收到 ESU 之前不刷新画面，实现原子化渲染、消除闪屏。

const BSU = "\x1b[?2026h"; // Begin Synchronized Update
const ESU = "\x1b[?2026l"; // End Synchronized Update

/**
 * 检测当前终端是否支持 DEC 2026 同步输出。
 * 移植自 Claude Code 的终端能力检测逻辑。
 */
function isSyncOutputSupported(): boolean {
  if (process.env.TMUX) return false;

  const termProgram = process.env.TERM_PROGRAM;
  const term = process.env.TERM;

  if (
    termProgram === "iTerm.app" ||
    termProgram === "WezTerm" ||
    termProgram === "WarpTerminal" ||
    termProgram === "ghostty" ||
    termProgram === "contour" ||
    termProgram === "vscode" ||
    termProgram === "alacritty"
  ) {
    return true;
  }

  if (term?.includes("kitty") || process.env.KITTY_WINDOW_ID) return true;
  if (term === "xterm-ghostty") return true;
  if (term?.startsWith("foot")) return true;
  if (term?.includes("alacritty")) return true;
  if (process.env.ZED_TERM) return true;
  if (process.env.WT_SESSION) return true;

  const vteVersion = process.env.VTE_VERSION;
  if (vteVersion) {
    const version = parseInt(vteVersion, 10);
    if (version >= 6800) return true;
  }

  return false;
}

/**
 * 安装同步输出：monkey-patch process.stdout.write，
 * 用 queueMicrotask 将同一同步帧内的所有 write 合并为一次 BSU/ESU 包裹的写入。
 *
 * Ink 的 onRender 是同步的，其中的多次 stdout.write 发生在同一微任务内，
 * 会被自然合并到同一个 BSU...ESU 信封中。
 */
export function installSyncOutput(): void {
  if (!isSyncOutputSupported()) return;

  const originalWrite: typeof process.stdout.write =
    process.stdout.write.bind(process.stdout);
  let frameBuffer = "";
  let scheduled = false;

  process.stdout.write = function (
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((err?: Error) => void),
    callback?: (err?: Error) => void,
  ): boolean {
    const str =
      typeof chunk === "string"
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString()
          : String(chunk);
    frameBuffer += str;

    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => {
        const data = BSU + frameBuffer + ESU;
        frameBuffer = "";
        scheduled = false;
        originalWrite(data);
      });
    }

    if (typeof encodingOrCallback === "function") {
      encodingOrCallback();
    } else if (typeof callback === "function") {
      callback();
    }

    return true;
  } as typeof process.stdout.write;
}
