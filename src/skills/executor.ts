// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import type { Skill, SkillHost, SkillForkHost } from "./skill.js";

/**
 * 以 inline 模式运行 skill：将 skill body 注入当前对话上下文。
 */
export function runInline(
  skill: Skill,
  args: string,
  host: SkillHost
): string {
  // 替换 body 中的 $ARGUMENTS 占位符；没有占位符时追加用户请求
  let body = skill.body;
  if (body.includes("$ARGUMENTS")) {
    body = body.replaceAll("$ARGUMENTS", args);
  } else if (args) {
    body += `\n\nUser Request: ${args}`;
  }

  host.activateSkill(skill.meta.name, body);

  return body;
}

/**
 * 以 fork 模式运行 skill：在隔离的子代理中执行。
 */
export async function runFork(
  skill: Skill,
  args: string,
  host: SkillForkHost
): Promise<string> {
  let prompt = skill.body;
  if (args) {
    prompt += `\n\nARGUMENTS: ${args}`;
  }

  // 根据 forkContext 配置决定携带多少父对话上下文
  const contextMode = skill.meta.forkContext ?? "none";
  if (contextMode === "recent") {
    const context = host.snapshotParentMessages(5);
    prompt = `Context from parent conversation:\n${context}\n\n${prompt}`;
  } else if (contextMode === "full") {
    const context = host.snapshotParentMessages(100);
    prompt = `Context from parent conversation:\n${context}\n\n${prompt}`;
  }

  return host.runSubAgent(prompt);
}
