import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { buildSearchQuery, toolSchemas } from "../src/server.js";
import { startServer, text } from "./helpers.js";

describe("input schemas", () => {
  it("applies defaults for state and per_page", () => {
    expect(toolSchemas.list_issues.parse({ owner: "acme", repo: "app" })).toEqual({
      owner: "acme",
      repo: "app",
      state: "open",
      per_page: 20,
    });
  });

  it("rejects owner/repo values that could escape the API path", () => {
    for (const bad of ["../etc", "acme/app", "a b", "", "x".repeat(40)]) {
      expect(toolSchemas.get_issue.safeParse({ owner: bad, repo: "app", number: 1 }).success).toBe(false);
    }
    for (const bad of ["../../user", "app?x=1", "a/b", ""]) {
      expect(toolSchemas.get_issue.safeParse({ owner: "acme", repo: bad, number: 1 }).success).toBe(false);
    }
  });

  it("rejects non-positive or fractional numbers and out-of-range page sizes", () => {
    expect(toolSchemas.get_issue.safeParse({ owner: "a", repo: "b", number: 0 }).success).toBe(false);
    expect(toolSchemas.get_issue.safeParse({ owner: "a", repo: "b", number: 1.5 }).success).toBe(false);
    expect(toolSchemas.list_pull_requests.safeParse({ owner: "a", repo: "b", per_page: 101 }).success).toBe(false);
    expect(toolSchemas.list_issues.safeParse({ owner: "a", repo: "b", state: "merged" }).success).toBe(false);
  });

  it("rejects unknown extra arguments", () => {
    expect(toolSchemas.get_issue.safeParse({ owner: "a", repo: "b", number: 1, force: true }).success).toBe(false);
  });

  it("publishes JSON schemas the client can read", async () => {
    const { client } = await startServer();
    const { tools } = await client.listTools();
    const comment = tools.find((t) => t.name === "add_issue_comment")!;
    expect(comment.inputSchema.required).toEqual(expect.arrayContaining(["owner", "repo", "number", "body"]));
    expect(comment.description).toMatch(/DRY-RUN/);
  });

  it("returns a validation error through MCP for bad input, without calling GitHub", async () => {
    const { client, calls } = await startServer();
    const res = await client.callTool({ name: "get_issue", arguments: { owner: "../x", repo: "app", number: 1 } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/invalid GitHub owner/);
    expect(calls).toHaveLength(0);
  });
});

describe("search query builder", () => {
  it("adds is:issue by default and scopes to a repo", () => {
    expect(buildSearchQuery({ query: "crash", type: "issue", per_page: 5, owner: "acme", repo: "app" })).toBe(
      "crash repo:acme/app is:issue",
    );
  });
  it("uses is:pr for pull requests and keeps an explicit qualifier", () => {
    expect(buildSearchQuery({ query: "fix", type: "pr", per_page: 5 })).toBe("fix is:pr");
    expect(buildSearchQuery({ query: "fix is:pr", type: "issue", per_page: 5 })).toBe("fix is:pr");
  });
});

describe("config", () => {
  it("defaults to dry-run on and an empty allowlist", () => {
    const c = parseConfig({});
    expect(c.dryRun).toBe(true);
    expect(c.commentAllowlist).toEqual([]);
    expect(c.maxCommentLength).toBe(2000);
  });
  it("rejects malformed allowlist entries and unknown keys", () => {
    expect(() => parseConfig({ commentAllowlist: ["*"] })).toThrow();
    expect(() => parseConfig({ commentAllowlist: ["acme"] })).toThrow();
    expect(() => parseConfig({ allowMerge: true })).toThrow();
  });
});
