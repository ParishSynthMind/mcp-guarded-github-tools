import { describe, expect, it } from "vitest";
import { EXPOSED_TOOLS } from "../src/server.js";
import { startServer, text } from "./helpers.js";

const FORBIDDEN = [
  "merge_pull_request",
  "close_issue",
  "update_issue",
  "delete_repository",
  "delete_branch",
  "push",
  "force_push",
  "update_ref",
  "add_labels",
  "remove_label",
  "set_labels",
  "create_issue",
];

describe("tool surface", () => {
  it("exposes exactly five read tools and one write tool", async () => {
    const { client } = await startServer();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "add_issue_comment",
        "get_issue",
        "get_pull_request",
        "list_issues",
        "list_pull_requests",
        "search_issues",
      ].sort(),
    );
    expect(names).toEqual([...EXPOSED_TOOLS].sort());
    const writes = tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name);
    expect(writes).toEqual(["add_issue_comment"]);
  });

  it("does not expose merge, close, delete, push or label tools at all", async () => {
    const { client } = await startServer();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const f of FORBIDDEN) expect(names).not.toContain(f);
    for (const n of names) expect(n).not.toMatch(/merge|close|delete|push|label|ref/);
  });

  it("rejects calls to tools that do not exist", async () => {
    const { client, calls } = await startServer();
    const res = await client.callTool({
      name: "merge_pull_request",
      arguments: { owner: "acme", repo: "app", number: 1 },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not found/i);
    expect(calls).toHaveLength(0);
  });
});

describe("add_issue_comment allowlist", () => {
  const live = { commentAllowlist: ["acme/sandbox"], dryRun: false, maxCommentLength: 50 };
  const route = (url: string, method: string) =>
    method === "POST" && url.toLowerCase().endsWith("/repos/acme/sandbox/issues/7/comments")
      ? { status: 201, json: { id: 99, html_url: "https://github.com/acme/sandbox/issues/7#issuecomment-99", created_at: "2026-11-01T00:00:00Z" } }
      : undefined;

  it("refuses a write to a repo outside the allowlist and never calls the API", async () => {
    const { client, calls, readAudit } = await startServer({ config: live, route });
    const res = await client.callTool({
      name: "add_issue_comment",
      arguments: { owner: "acme", repo: "production", number: 7, body: "hello" },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not in the comment allowlist/);
    expect(calls).toHaveLength(0);
    const [entry] = readAudit();
    expect(entry.status).toBe("refused");
    expect(entry.tool).toBe("add_issue_comment");
  });

  it("refuses everything when the allowlist is empty, even with dry-run off", async () => {
    const { client, calls } = await startServer({ config: { dryRun: false }, route });
    const res = await client.callTool({
      name: "add_issue_comment",
      arguments: { owner: "acme", repo: "sandbox", number: 7, body: "hello" },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/\(none\)/);
    expect(calls).toHaveLength(0);
  });

  it("does not let a look-alike name slip through", async () => {
    const { client, calls } = await startServer({ config: live, route });
    for (const [owner, repo] of [["acme", "sandbox2"], ["acme-evil", "sandbox"], ["acm", "esandbox"]]) {
      const res = await client.callTool({ name: "add_issue_comment", arguments: { owner, repo, number: 7, body: "x" } });
      expect(res.isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses comments over the length limit and empty comments", async () => {
    const { client, calls } = await startServer({ config: live, route });
    const long = await client.callTool({
      name: "add_issue_comment",
      arguments: { owner: "acme", repo: "sandbox", number: 7, body: "x".repeat(51) },
    });
    expect(long.isError).toBe(true);
    expect(text(long)).toMatch(/51 characters, the limit is 50/);
    const empty = await client.callTool({
      name: "add_issue_comment",
      arguments: { owner: "acme", repo: "sandbox", number: 7, body: "   " },
    });
    expect(empty.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("posts to an allowlisted repo (case-insensitive) when dry-run is off", async () => {
    const { client, calls, readAudit } = await startServer({ config: live, route });
    const res = await client.callTool({
      name: "add_issue_comment",
      arguments: { owner: "Acme", repo: "Sandbox", number: 7, body: "Looks good to me." },
    });
    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ body: "Looks good to me." });
    expect(readAudit()[0].status).toBe("ok");
  });

  it("returns a preview and makes no API call in dry-run mode", async () => {
    const { client, calls, readAudit } = await startServer({
      config: { ...live, dryRun: true },
      route,
    });
    const res = await client.callTool({
      name: "add_issue_comment",
      arguments: { owner: "acme", repo: "sandbox", number: 7, body: "Draft note" },
    });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(text(res));
    expect(data).toMatchObject({ dry_run: true, would_post_to: "acme/sandbox#7", characters: 10 });
    expect(calls).toHaveLength(0);
    expect(readAudit()[0].status).toBe("dry_run");
  });

  it("posts and returns the comment URL when the repo matches exactly", async () => {
    const { client, calls, readAudit } = await startServer({ config: live, route });
    const res = await client.callTool({
      name: "add_issue_comment",
      arguments: { owner: "acme", repo: "sandbox", number: 7, body: "Ack" },
    });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res))).toMatchObject({ id: 99 });
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/sandbox/issues/7/comments");
    expect(readAudit()[0].status).toBe("ok");
  });
});
