// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import type { Team, TeamManager } from "../teams/team.js";
import { detectBackend } from "../teams/backend.js";

export interface CodeReviewMember {
  name: string;
  email: string;
  role: "reviewer" | "lead" | "junior" | "critic";
  expertise: string[];
  active: boolean;
}

export interface CodeReviewTeam {
  name: string;
  members: CodeReviewMember[];
  createdAt: string;
  lastActive: string;
}

export class CodeReviewManager {
  private teams = new Map<string, CodeReviewTeam>();
  private configPath: string;
  private teamManager: TeamManager;
  private workDir: string;

  constructor(workDir: string, teamManager: TeamManager) {
    this.workDir = workDir;
    this.configPath = join(workDir, ".mewcode", "code-review-teams.json");
    this.teamManager = teamManager;
    this.loadTeams();
  }

  private loadTeams(): void {
    if (existsSync(this.configPath)) {
      try {
        const data = readFileSync(this.configPath, "utf-8");
        const teams: CodeReviewTeam[] = JSON.parse(data);
        for (const team of teams) {
          this.teams.set(team.name, team);
        }
      } catch {
        // Start fresh if file is corrupted
      }
    }
  }

  private saveTeams(): void {
    const dir = join(this.workDir, ".mewcode");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const teams = [...this.teams.values()];
    writeFileSync(this.configPath, JSON.stringify(teams, null, 2));
  }

  createTeam(name: string, members: Omit<CodeReviewMember, "active">[]): CodeReviewTeam {
    const team: CodeReviewTeam = {
      name,
      members: members.map(m => ({ ...m, active: true })),
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
    };
    this.teams.set(name, team);
    this.saveTeams();
    
    // Also create in TeamManager for messaging
    const teamInstance = this.teamManager.create(name, detectBackend());
    for (const member of members) {
      teamInstance.addMember(member.name);
    }
    
    return team;
  }

  getTeam(name: string): CodeReviewTeam | undefined {
    return this.teams.get(name);
  }

  listTeams(): CodeReviewTeam[] {
    return [...this.teams.values()];
  }

  addMember(teamName: string, member: Omit<CodeReviewMember, "active">): void {
    const team = this.teams.get(teamName);
    if (!team) {
      throw new Error(`Team '${teamName}' not found`);
    }
    team.members.push({ ...member, active: true });
    team.lastActive = new Date().toISOString();
    this.saveTeams();
    
    const teamInstance = this.teamManager.get(teamName);
    if (teamInstance) {
      teamInstance.addMember(member.name);
    }
  }

  removeMember(teamName: string, memberName: string): void {
    const team = this.teams.get(teamName);
    if (!team) {
      throw new Error(`Team '${teamName}' not found`);
    }
    team.members = team.members.filter(m => m.name !== memberName);
    team.lastActive = new Date().toISOString();
    this.saveTeams();
  }

  activateMember(teamName: string, memberName: string): void {
    const team = this.teams.get(teamName);
    if (!team) {
      throw new Error(`Team '${teamName}' not found`);
    }
    const member = team.members.find(m => m.name === memberName);
    if (!member) {
      throw new Error(`Member '${memberName}' not found in team '${teamName}'`);
    }
    member.active = true;
    team.lastActive = new Date().toISOString();
    this.saveTeams();
  }

  deactivateMember(teamName: string, memberName: string): void {
    const team = this.teams.get(teamName);
    if (!team) {
      throw new Error(`Team '${teamName}' not found`);
    }
    const member = team.members.find(m => m.name === memberName);
    if (!member) {
      throw new Error(`Member '${memberName}' not found in team '${teamName}'`);
    }
    member.active = false;
    team.lastActive = new Date().toISOString();
    this.saveTeams();
  }

  deleteTeam(name: string): void {
    this.teams.delete(name);
    this.saveTeams();
    this.teamManager.delete(name).catch(() => {});
  }

  getActiveReviewers(teamName: string): CodeReviewMember[] {
    const team = this.teams.get(teamName);
    if (!team) {
      throw new Error(`Team '${teamName}' not found`);
    }
    return team.members.filter(m => m.active && m.role === "reviewer");
  }

  getTeamSummary(teamName: string): string {
    const team = this.teams.get(teamName);
    if (!team) {
      throw new Error(`Team '${teamName}' not found`);
    }
    const activeCount = team.members.filter(m => m.active).length;
    const reviewers = team.members.filter(m => m.role === "reviewer").length;
    const leads = team.members.filter(m => m.role === "lead").length;
    
    return `Team: ${team.name}\n` +
           `Members: ${activeCount}/${team.members.length} active\n` +
           `Reviewers: ${reviewers}, Leads: ${leads}\n` +
           `Created: ${new Date(team.createdAt).toLocaleString()}\n` +
           `Last active: ${new Date(team.lastActive).toLocaleString()}`;
  }
}

export function createDefaultCodeReviewTeam(): CodeReviewTeam {
  return {
    name: "default-review",
    members: [
      {
        name: "alice",
        email: "alice@company.com",
        role: "lead",
        expertise: ["architecture", "security", "performance"],
        active: true
      },
      {
        name: "bob",
        email: "bob@company.com",
        role: "reviewer",
        expertise: ["testing", "code-quality", "documentation"],
        active: true
      },
      {
        name: "charlie",
        email: "charlie@company.com",
        role: "reviewer",
        expertise: ["typescript", "frontend", "ux"],
        active: true
      }
    ],
    createdAt: new Date().toISOString(),
    lastActive: new Date().toISOString()
  };
}