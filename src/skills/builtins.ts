// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import type { Skill } from "./skill.js";

/**
 * 加载内置 skill。
 * 当前版本不包含任何内置 skill，所有 skill 通过用户目录或项目目录加载。
 */
export function loadBuiltins(): Skill[] {
  return [];
}
