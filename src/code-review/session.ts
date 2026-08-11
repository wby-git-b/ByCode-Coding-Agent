// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import type { CodeReviewManager, CodeReviewTeam, CodeReviewMember } from "./manager.js";

export interface ReviewRequest {
  id: string;
  title: string;
  description: string;
  author: string;
  branch: string;
  files: string[];
  status: "pending" | "in-review" | "approved" | "rejected" | "changes-requested";
  createdAt: string;
  updatedAt: string;
  reviewers: string[];
  comments: ReviewComment[];
}

export type CommentResolution = "accepted" | "rejected" | "pending" | "resolved";
export type CriticEvaluation = "reasonable" | "unreasonable" | "partially-reasonable";

export interface CriticAssessment {
  commentId: string;
  critic: string;
  evaluation: CriticEvaluation;
  reasoning: string;
  timestamp: string;
}

export interface ReviewComment {
  id: string;
  reviewer: string;
  file?: string;
  line?: number;
  content: string;
  timestamp: string;
  resolved: boolean;
  resolution?: CommentResolution;
  authorResponse?: string;
  resolutionTimestamp?: string;
  criticAssessments: CriticAssessment[];
}

export interface ReviewSummary {
  requestId: string;
  title: string;
  author: string;
  reviewers: string[];
  totalComments: number;
  acceptedSuggestions: number;
  rejectedSuggestions: number;
  pendingSuggestions: number;
  resolvedIssues: number;
  overallConclusion: "approved" | "rejected" | "changes-requested";
  keyFindings: string[];
  fileSpecificFeedback: Map<string, FileFeedback>;
  generatedAt: string;
}

export interface FileFeedback {
  fileName: string;
  totalComments: number;
  acceptedCount: number;
  rejectedCount: number;
  pendingCount: number;
  issues: CommentIssue[];
}

export interface CommentIssue {
  commentId: string;
  reviewer: string;
  line?: number;
  content: string;
  resolution: CommentResolution;
  authorResponse?: string;
}

export class ReviewSession {
  private requests = new Map<string, ReviewRequest>();
  private manager: CodeReviewManager;
  private workDir: string;
  private commentCounter = 0;

  constructor(workDir: string, manager: CodeReviewManager) {
    this.workDir = workDir;
    this.manager = manager;
    this.loadRequests();
  }

  private getCritics(teamName: string): CodeReviewMember[] {
    const team = this.manager.getTeam(teamName);
    if (!team) {
      throw new Error(`Team '${teamName}' not found`);
    }
    return team.members.filter(m => m.active && m.role === "critic");
  }

  private loadRequests(): void {
    // Load from disk if needed
  }

  createReviewRequest(
    teamName: string,
    title: string,
    description: string,
    author: string,
    branch: string,
    files: string[]
  ): ReviewRequest {
    const team = this.manager.getTeam(teamName);
    if (!team) {
      throw new Error(`Team '${teamName}' not found`);
    }

    const reviewers = this.manager.getActiveReviewers(teamName).map(r => r.name);
    if (reviewers.length === 0) {
      throw new Error(`No active reviewers in team '${teamName}'`);
    }

    const request: ReviewRequest = {
      id: `review-${Date.now()}`,
      title,
      description,
      author,
      branch,
      files,
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      reviewers,
      comments: []
    };

    this.requests.set(request.id, request);
    return request;
  }

  getRequest(id: string): ReviewRequest | undefined {
    return this.requests.get(id);
  }

  updateRequestStatus(id: string, status: ReviewRequest["status"]): void {
    const request = this.requests.get(id);
    if (!request) {
      throw new Error(`Request '${id}' not found`);
    }
    request.status = status;
    request.updatedAt = new Date().toISOString();
  }

  addComment(
    requestId: string,
    reviewer: string,
    content: string,
    file?: string,
    line?: number
  ): ReviewComment {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Request '${requestId}' not found`);
    }

    const comment: ReviewComment = {
      id: `comment-${Date.now()}-${++this.commentCounter}`,
      reviewer,
      file,
      line,
      content,
      timestamp: new Date().toISOString(),
      resolved: false,
      criticAssessments: []
    };

    request.comments.push(comment);
    request.updatedAt = new Date().toISOString();
    return comment;
  }

  resolveComment(requestId: string, commentId: string): void {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Request '${requestId}' not found`);
    }
    const comment = request.comments.find(c => c.id === commentId);
    if (!comment) {
      throw new Error(`Comment '${commentId}' not found`);
    }
    comment.resolved = true;
    comment.resolution = "resolved";
    comment.resolutionTimestamp = new Date().toISOString();
    request.updatedAt = new Date().toISOString();
  }

  acceptComment(requestId: string, commentId: string, authorResponse?: string): void {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Request '${requestId}' not found`);
    }
    const comment = request.comments.find(c => c.id === commentId);
    if (!comment) {
      throw new Error(`Comment '${commentId}' not found`);
    }
    comment.resolved = true;
    comment.resolution = "accepted";
    comment.authorResponse = authorResponse;
    comment.resolutionTimestamp = new Date().toISOString();
    request.updatedAt = new Date().toISOString();
  }

  rejectComment(requestId: string, commentId: string, authorResponse?: string): void {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Request '${requestId}' not found`);
    }
    const comment = request.comments.find(c => c.id === commentId);
    if (!comment) {
      throw new Error(`Comment '${commentId}' not found`);
    }
    comment.resolved = true;
    comment.resolution = "rejected";
    comment.authorResponse = authorResponse;
    comment.resolutionTimestamp = new Date().toISOString();
    request.updatedAt = new Date().toISOString();
  }

  addCriticAssessment(
    requestId: string,
    commentId: string,
    critic: string,
    evaluation: CriticEvaluation,
    reasoning: string
  ): CriticAssessment {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Request '${requestId}' not found`);
    }
    const comment = request.comments.find(c => c.id === commentId);
    if (!comment) {
      throw new Error(`Comment '${commentId}' not found`);
    }

    const assessment: CriticAssessment = {
      commentId,
      critic,
      evaluation,
      reasoning,
      timestamp: new Date().toISOString()
    };

    comment.criticAssessments.push(assessment);
    request.updatedAt = new Date().toISOString();
    return assessment;
  }

  evaluateCommentByCritic(
    requestId: string,
    commentId: string,
    criticName: string,
    isReasonable: boolean,
    reasoning: string
  ): CriticAssessment {
    const evaluation: CriticEvaluation = isReasonable ? "reasonable" : "unreasonable";
    return this.addCriticAssessment(requestId, commentId, criticName, evaluation, reasoning);
  }

  getCriticSummary(requestId: string): string {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Request '${requestId}' not found`);
    }

    let summary = `📊 CRITIC EVALUATION SUMMARY\n`;
    summary += `═════════════════════════════════════════════════════════════════\n\n`;
    summary += `Request: ${request.title}\n`;
    summary += `Total Comments: ${request.comments.length}\n\n`;

    let reasonableCount = 0;
    let unreasonableCount = 0;
    let partiallyReasonableCount = 0;
    let notEvaluatedCount = 0;

    for (const comment of request.comments) {
      if (comment.criticAssessments.length === 0) {
        notEvaluatedCount++;
        continue;
      }

      summary += `💬 Comment by ${comment.reviewer}\n`;
      if (comment.file) {
        summary += `   File: ${comment.file}${comment.line ? `:${comment.line}` : ""}\n`;
      }
      summary += `   "${comment.content.substring(0, 80)}${comment.content.length > 80 ? "..." : ""}"\n\n`;

      for (const assessment of comment.criticAssessments) {
        const icon = assessment.evaluation === "reasonable" ? "✅" : 
                     assessment.evaluation === "unreasonable" ? "❌" : "⚠️";
        summary += `   ${icon} Critic: ${assessment.critic}\n`;
        summary += `   Verdict: ${assessment.evaluation.toUpperCase()}\n`;
        summary += `   Reasoning: ${assessment.reasoning}\n`;
        summary += `   Time: ${new Date(assessment.timestamp).toLocaleString()}\n\n`;

        if (assessment.evaluation === "reasonable") reasonableCount++;
        else if (assessment.evaluation === "unreasonable") unreasonableCount++;
        else partiallyReasonableCount++;
      }
      summary += `─────────────────────────────────────────────────────────────────\n\n`;
    }

    summary += `📈 EVALUATION STATISTICS\n`;
    summary += `═════════════════════════════════════════════════════════════════\n`;
    summary += `✅ Reasonable: ${reasonableCount}\n`;
    summary += `❌ Unreasonable: ${unreasonableCount}\n`;
    summary += `⚠️  Partially Reasonable: ${partiallyReasonableCount}\n`;
    summary += `⏳ Not Evaluated: ${notEvaluatedCount}\n`;

    const totalEvaluated = reasonableCount + unreasonableCount + partiallyReasonableCount;
    if (totalEvaluated > 0) {
      const reasonablePercentage = ((reasonableCount / totalEvaluated) * 100).toFixed(1);
      summary += `📊 Reasonable Rate: ${reasonablePercentage}%\n`;
    }

    return summary;
  }

  generateFinalReport(requestId: string): ReviewSummary {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Request '${requestId}' not found`);
    }

    const acceptedCount = request.comments.filter(c => c.resolution === "accepted").length;
    const rejectedCount = request.comments.filter(c => c.resolution === "rejected").length;
    const pendingCount = request.comments.filter(c => !c.resolution || c.resolution === "pending").length;
    const resolvedCount = request.comments.filter(c => c.resolved).length;

    // Determine overall conclusion
    let overallConclusion: "approved" | "rejected" | "changes-requested";
    if (rejectedCount > acceptedCount && rejectedCount >= 3) {
      overallConclusion = "rejected";
    } else if (pendingCount > 0 || (acceptedCount > 0 && rejectedCount > 0)) {
      overallConclusion = "changes-requested";
    } else {
      overallConclusion = "approved";
    }

    // Extract key findings from comments
    const keyFindings = request.comments
      .filter(c => c.resolution === "accepted" || c.resolution === "pending")
      .map(c => `[${c.reviewer}] ${c.content.substring(0, 100)}${c.content.length > 100 ? "..." : ""}`);

    // Group feedback by file
    const fileFeedback = new Map<string, FileFeedback>();
    for (const comment of request.comments) {
      if (!comment.file) continue;
      
      const fileName = comment.file;
      if (!fileFeedback.has(fileName)) {
        fileFeedback.set(fileName, {
          fileName,
          totalComments: 0,
          acceptedCount: 0,
          rejectedCount: 0,
          pendingCount: 0,
          issues: []
        });
      }
      
      const feedback = fileFeedback.get(fileName)!;
      feedback.totalComments++;
      
      if (comment.resolution === "accepted") feedback.acceptedCount++;
      else if (comment.resolution === "rejected") feedback.rejectedCount++;
      else feedback.pendingCount++;
      
      feedback.issues.push({
        commentId: comment.id,
        reviewer: comment.reviewer,
        line: comment.line,
        content: comment.content,
        resolution: comment.resolution || "pending",
        authorResponse: comment.authorResponse
      });
    }

    return {
      requestId: request.id,
      title: request.title,
      author: request.author,
      reviewers: request.reviewers,
      totalComments: request.comments.length,
      acceptedSuggestions: acceptedCount,
      rejectedSuggestions: rejectedCount,
      pendingSuggestions: pendingCount,
      resolvedIssues: resolvedCount,
      overallConclusion,
      keyFindings,
      fileSpecificFeedback: fileFeedback,
      generatedAt: new Date().toISOString()
    };
  }

  formatFinalReport(summary: ReviewSummary): string {
    const conclusionColors = {
      approved: "✅",
      rejected: "❌", 
      "changes-requested": "⚠️"
    };

    let report = `
╔════════════════════════════════════════════════════════════════╗
║                    CODE REVIEW FINAL REPORT                    ║
╚════════════════════════════════════════════════════════════════╝

📋 REVIEW INFORMATION
─────────────────────────────────────────────────────────────────
Request ID:     ${summary.requestId}
Title:          ${summary.title}
Author:         ${summary.author}
Reviewers:      ${summary.reviewers.join(", ")}
Generated:      ${new Date(summary.generatedAt).toLocaleString()}

📊 SUMMARY STATISTICS
─────────────────────────────────────────────────────────────────
Total Comments:           ${summary.totalComments}
✅ Accepted Suggestions:  ${summary.acceptedSuggestions}
❌ Rejected Suggestions:  ${summary.rejectedSuggestions}
⏳ Pending Suggestions:   ${summary.pendingSuggestions}
🔧 Resolved Issues:       ${summary.resolvedIssues}

🎯 OVERALL CONCLUSION: ${conclusionColors[summary.overallConclusion]} ${summary.overallConclusion.toUpperCase()}
─────────────────────────────────────────────────────────────────

💡 KEY FINDINGS
─────────────────────────────────────────────────────────────────
`;
    
    if (summary.keyFindings.length === 0) {
      report += "No key findings identified.\n";
    } else {
      summary.keyFindings.forEach((finding, index) => {
        report += `${index + 1}. ${finding}\n`;
      });
    }

    report += `
📁 FILE-SPECIFIC FEEDBACK
─────────────────────────────────────────────────────────────────
`;
    
    if (summary.fileSpecificFeedback.size === 0) {
      report += "No file-specific feedback available.\n";
    } else {
      for (const [fileName, feedback] of summary.fileSpecificFeedback) {
        report += `
File: ${fileName}
${"─".repeat(60)}
Total Comments: ${feedback.totalComments}
  ✅ Accepted: ${feedback.acceptedCount}
  ❌ Rejected: ${feedback.rejectedCount}
  ⏳ Pending:  ${feedback.pendingCount}

`;
        if (feedback.issues.length > 0) {
          feedback.issues.forEach((issue, idx) => {
            const resolutionIcon = {
              accepted: "✅",
              rejected: "❌",
              pending: "⏳",
              resolved: "🔧"
            }[issue.resolution];
            
            report += `  ${idx + 1}. ${resolutionIcon} [${issue.reviewer}]`;
            if (issue.line) report += ` (Line ${issue.line})`;
            report += `\n     "${issue.content}"\n`;
            
            if (issue.authorResponse) {
              report += `     → Author response: "${issue.authorResponse}"\n`;
            }
            report += `\n`;
          });
        }
      }
    }

    report += `
═════════════════════════════════════════════════════════════════
                    END OF REPORT
═════════════════════════════════════════════════════════════════
`;

    return report;
  }

  getPendingRequests(): ReviewRequest[] {
    return [...this.requests.values()].filter(r => 
      r.status === "pending" || r.status === "in-review"
    );
  }

  getRequestSummary(id: string): string {
    const request = this.requests.get(id);
    if (!request) {
      throw new Error(`Request '${id}' not found`);
    }

    const resolvedComments = request.comments.filter(c => c.resolved).length;
    return `Review: ${request.title} (${request.id})\n` +
           `Author: ${request.author}\n` +
           `Branch: ${request.branch}\n` +
           `Status: ${request.status}\n` +
           `Reviewers: ${request.reviewers.join(", ")}\n` +
           `Files: ${request.files.length}\n` +
           `Comments: ${request.comments.length} (${resolvedComments} resolved)\n` +
           `Created: ${new Date(request.createdAt).toLocaleString()}`;
  }
}