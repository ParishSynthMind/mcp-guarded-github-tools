import type { Config } from "./config.js";

export class GuardRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardRefusal";
  }
}

export function isAllowlisted(config: Config, owner: string, repo: string): boolean {
  const target = `${owner}/${repo}`.toLowerCase();
  return config.commentAllowlist.some((entry) => entry.toLowerCase() === target);
}

/** Throws GuardRefusal unless a comment on owner/repo is permitted by config. */
export function checkCommentAllowed(config: Config, owner: string, repo: string, body: string): void {
  if (!isAllowlisted(config, owner, repo)) {
    throw new GuardRefusal(
      `Refused: ${owner}/${repo} is not in the comment allowlist. ` +
        `Allowed repos: ${config.commentAllowlist.length ? config.commentAllowlist.join(", ") : "(none)"}.`,
    );
  }
  if (body.trim().length === 0) {
    throw new GuardRefusal("Refused: comment body is empty.");
  }
  if (body.length > config.maxCommentLength) {
    throw new GuardRefusal(
      `Refused: comment is ${body.length} characters, the limit is ${config.maxCommentLength}.`,
    );
  }
}
