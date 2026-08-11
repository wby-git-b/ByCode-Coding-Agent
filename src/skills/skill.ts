// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

export interface SkillMeta {
  name: string;
  description: string;
  mode?: "inline" | "fork";
  model?: string;
  forkContext?: "full" | "recent" | "none";
}

export interface Skill {
  meta: SkillMeta;
  body: string;
  sourceDir: string;
  isDirectory: boolean;
}

export interface SkillHost {
  activateSkill(name: string, body: string): void;
}

export interface SkillForkHost extends SkillHost {
  runSubAgent(prompt: string): Promise<string>;
  snapshotParentMessages(count: number): string;
}
