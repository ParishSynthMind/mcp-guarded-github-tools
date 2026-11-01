import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuditLog, type AuditStatus } from "./audit.js";
import type { Config } from "./config.js";
import { GitHubClient } from "./github.js";
import { checkCommentAllowed, GuardRefusal } from "./guard.js";

export const SERVER_NAME = "guarded-github-tools";
export const SERVER_VERSION = "1.0.0";

// Shared input pieces. GitHub owner/repo names are restricted to this set,
// which also keeps path traversal and query injection out of API paths.
const owner = z.string().regex(/^[A-Za-z0-9-]{1,39}$/, "invalid GitHub owner").describe("Repository owner, e.g. octocat");
const repo = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/, "invalid repository name").describe("Repository name");
const number = z.number().int().positive().describe("Issue or pull request number");
const state = z.enum(["open", "closed", "all"]).default("open");
const perPage = z.number().int().min(1).max(100).default(20);

export const toolSchemas = {
  list_issues: z.object({ owner, repo, state, per_page: perPage }).strict(),
  get_issue: z.object({ owner, repo, number }).strict(),
  list_pull_requests: z.object({ owner, repo, state, per_page: perPage }).strict(),
  get_pull_request: z.object({ owner, repo, number }).strict(),
  search_issues: z
    .object({
      query: z.string().min(1).max(256).describe("GitHub search syntax, e.g. 'bug in:title'"),
      type: z.enum(["issue", "pr"]).default("issue"),
      owner: owner.optional(),
      repo: repo.optional(),
      per_page: perPage,
    })
    .strict(),
  add_issue_comment: z
    .object({
      owner,
      repo,
      number,
      body: z.string().describe("Markdown comment text"),
    })
    .strict(),
} as const;

export type ToolName = keyof typeof toolSchemas;
export const EXPOSED_TOOLS = Object.keys(toolSchemas) as ToolName[];

interface Outcome {
  status: AuditStatus;
  data: unknown;
}

export interface ServerDeps {
  config: Config;
  github: GitHubClient;
  audit: AuditLog;
}

export function buildSearchQuery(args: z.infer<typeof toolSchemas.search_issues>): string {
  let q = args.query.trim();
  if (args.owner && args.repo) q += ` repo:${args.owner}/${args.repo}`;
  if (!/\bis:(issue|pr|pull-request)\b/i.test(q)) q += args.type === "pr" ? " is:pr" : " is:issue";
  return q;
}

export function createServer({ config, github, audit }: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // Every tool goes through this wrapper: timing, audit line, and a uniform
  // error shape so the model sees a refusal as a tool result, not a crash.
  function register<N extends ToolName>(
    name: N,
    description: string,
    readOnly: boolean,
    handler: (args: z.infer<(typeof toolSchemas)[N]>) => Promise<Outcome>,
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: toolSchemas[name].shape,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: false,
          idempotentHint: readOnly,
          openWorldHint: true,
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (args: any) => {
        const started = Date.now();
        try {
          const { status, data } = await handler(args);
          audit.write({ tool: name, args, status, duration_ms: Date.now() - started });
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
        } catch (err) {
          const refused = err instanceof GuardRefusal;
          const message = err instanceof Error ? err.message : String(err);
          const entry = audit.write({
            tool: name,
            args,
            status: refused ? "refused" : "error",
            duration_ms: Date.now() - started,
            error: message,
          });
          return { isError: true, content: [{ type: "text" as const, text: entry.error ?? message }] };
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    );
  }

  register("list_issues", "List issues (not pull requests) in a repository.", true, async (a) => ({
    status: "ok",
    data: await github.listIssues(a.owner, a.repo, a.state, a.per_page),
  }));

  register("get_issue", "Get one issue with its body (clipped to 4000 characters).", true, async (a) => ({
    status: "ok",
    data: await github.getIssue(a.owner, a.repo, a.number),
  }));

  register("list_pull_requests", "List pull requests in a repository.", true, async (a) => ({
    status: "ok",
    data: await github.listPullRequests(a.owner, a.repo, a.state, a.per_page),
  }));

  register(
    "get_pull_request",
    "Get one pull request with diff stats: commits, changed files, additions, deletions and a per-file breakdown (first 50 files).",
    true,
    async (a) => ({ status: "ok", data: await github.getPullRequest(a.owner, a.repo, a.number) }),
  );

  register(
    "search_issues",
    "Search issues or pull requests across GitHub with GitHub search syntax. Pass owner and repo to scope it to one repository.",
    true,
    async (a) => ({ status: "ok", data: await github.searchIssues(buildSearchQuery(a), a.per_page) }),
  );

  register(
    "add_issue_comment",
    `Add a comment to an issue or pull request. Only works on allowlisted repositories ` +
      `(${config.commentAllowlist.join(", ") || "none configured"}), max ${config.maxCommentLength} characters.` +
      (config.dryRun ? " The server is in DRY-RUN mode: nothing is posted, you get back what would have been sent." : ""),
    false,
    async (a) => {
      checkCommentAllowed(config, a.owner, a.repo, a.body);
      if (config.dryRun) {
        return {
          status: "dry_run",
          data: {
            dry_run: true,
            would_post_to: `${a.owner}/${a.repo}#${a.number}`,
            characters: a.body.length,
            body: a.body,
          },
        };
      }
      return { status: "ok", data: await github.addIssueComment(a.owner, a.repo, a.number, a.body) };
    },
  );

  return server;
}
