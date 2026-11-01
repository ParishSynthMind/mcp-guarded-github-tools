import { readFileSync } from "node:fs";
import { z } from "zod";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const ConfigSchema = z
  .object({
    // Repos (owner/name) the one write tool may touch. Empty means no writes at all.
    commentAllowlist: z.array(z.string().regex(REPO_PATTERN, "must be owner/repo")).default([]),
    maxCommentLength: z.number().int().min(1).max(65536).default(2000),
    // When true, add_issue_comment validates and logs but never calls the GitHub API.
    dryRun: z.boolean().default(true),
    auditLogPath: z.string().min(1).default("./audit.jsonl"),
    apiBaseUrl: z.string().url().default("https://api.github.com"),
    requestTimeoutMs: z.number().int().min(1000).max(120000).default(15000),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

export function parseConfig(raw: unknown): Config {
  return ConfigSchema.parse(raw ?? {});
}

/**
 * Loads config from the JSON file named in MCP_GUARD_CONFIG (if set), then
 * applies a couple of env overrides. The GitHub token is never part of the
 * config file: it is read from GITHUB_TOKEN only.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let raw: Record<string, unknown> = {};
  if (env.MCP_GUARD_CONFIG) {
    raw = JSON.parse(readFileSync(env.MCP_GUARD_CONFIG, "utf8"));
  }
  if (env.MCP_GUARD_DRY_RUN !== undefined) {
    raw.dryRun = !["0", "false", "no"].includes(env.MCP_GUARD_DRY_RUN.toLowerCase());
  }
  if (env.MCP_GUARD_AUDIT_LOG) {
    raw.auditLogPath = env.MCP_GUARD_AUDIT_LOG;
  }
  return parseConfig(raw);
}
