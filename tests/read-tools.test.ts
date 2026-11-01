import { describe, expect, it } from "vitest";
import { startServer, text } from "./helpers.js";

const user = { login: "octo" };
const issue = (n: number, extra: object = {}) => ({
  number: n,
  title: `Issue ${n}`,
  state: "open",
  user,
  labels: [{ name: "bug" }],
  comments: 2,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-02T00:00:00Z",
  html_url: `https://github.com/acme/app/issues/${n}`,
  body: "Steps to reproduce...",
  ...extra,
});
const pull = (n: number) => ({
  number: n,
  title: `PR ${n}`,
  state: "open",
  draft: false,
  user,
  head: { ref: "feature" },
  base: { ref: "main" },
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-02T00:00:00Z",
  merged_at: null,
  html_url: `https://github.com/acme/app/pull/${n}`,
  body: "x".repeat(5000),
  commits: 3,
  changed_files: 2,
  additions: 40,
  deletions: 7,
  mergeable_state: "clean",
});

const routes = (url: string, method: string) => {
  if (method !== "GET") return undefined;
  const u = new URL(url);
  const p = u.pathname;
  if (p === "/repos/acme/app/issues") return { json: [issue(1), issue(2, { pull_request: {} }), issue(3)] };
  if (p === "/repos/acme/busy/issues") {
    // Page 1 is 100 pull requests, page 2 holds the issues.
    const page = Number(u.searchParams.get("page"));
    if (page === 1) return { json: Array.from({ length: 100 }, (_, k) => issue(1000 + k, { pull_request: {} })) };
    return { json: [issue(7), issue(8)] };
  }
  if (p === "/repos/acme/app/issues/1") return { json: issue(1) };
  if (p === "/repos/acme/app/pulls") return { json: [pull(5)] };
  if (p === "/repos/acme/app/pulls/5") return { json: pull(5) };
  if (p === "/repos/acme/app/pulls/5/files")
    return {
      json: [
        { filename: "src/a.ts", status: "modified", additions: 30, deletions: 7, patch: "@@ huge patch @@" },
        { filename: "README.md", status: "added", additions: 10, deletions: 0 },
      ],
    };
  if (p === "/search/issues")
    return {
      json: {
        total_count: 1,
        items: [{ ...issue(9), repository_url: "https://api.github.com/repos/acme/app" }],
      },
    };
  if (p === "/repos/acme/missing/issues") return { status: 404, json: { message: "Not Found" } };
  if (p === "/repos/acme/limited/issues") return { status: 403, json: { message: "API rate limit exceeded" } };
  return undefined;
};

const call = async (name: string, args: object) => {
  const s = await startServer({ route: routes });
  const res = await s.client.callTool({ name, arguments: args as Record<string, unknown> });
  return { ...s, res };
};

describe("read tools against mocked GitHub", () => {
  it("list_issues drops pull requests and passes state and per_page", async () => {
    const { res, calls, readAudit } = await call("list_issues", { owner: "acme", repo: "app", state: "all", per_page: 5 });
    const data = JSON.parse(text(res));
    expect(data.map((i: { number: number }) => i.number)).toEqual([1, 3]);
    expect(data[0]).toMatchObject({ author: "octo", labels: ["bug"], comments: 2 });
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/app/issues?state=all&per_page=100&page=1");
    expect(calls).toHaveLength(1);
    expect(readAudit()[0]).toMatchObject({ tool: "list_issues", status: "ok" });
  });

  it("list_issues keeps paging when the first page is all pull requests", async () => {
    const { res, calls } = await call("list_issues", { owner: "acme", repo: "busy", per_page: 2 });
    expect(JSON.parse(text(res)).map((i: { number: number }) => i.number)).toEqual([7, 8]);
    expect(calls).toHaveLength(2);
  });

  it("get_issue returns the body", async () => {
    const { res } = await call("get_issue", { owner: "acme", repo: "app", number: 1 });
    expect(JSON.parse(text(res))).toMatchObject({ number: 1, body: "Steps to reproduce...", is_pull_request: false });
  });

  it("list_pull_requests summarises head and base branches", async () => {
    const { res } = await call("list_pull_requests", { owner: "acme", repo: "app" });
    expect(JSON.parse(text(res))[0]).toMatchObject({ number: 5, head: "feature", base: "main", draft: false });
  });

  it("get_pull_request includes diff stats and a per-file breakdown without patches", async () => {
    const { res, calls } = await call("get_pull_request", { owner: "acme", repo: "app", number: 5 });
    const data = JSON.parse(text(res));
    expect(data.diff_stats).toMatchObject({ commits: 3, changed_files: 2, additions: 40, deletions: 7, files_listed: 2 });
    expect(data.diff_stats.files[0]).toEqual({ filename: "src/a.ts", status: "modified", additions: 30, deletions: 7 });
    expect(text(res)).not.toContain("huge patch");
    expect(data.body.length).toBeLessThan(4100);
    expect(data.body).toMatch(/clipped 1000 chars/);
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });

  it("search_issues builds the query and reports the repository", async () => {
    const { res, calls } = await call("search_issues", { query: "crash", owner: "acme", repo: "app", per_page: 3 });
    const data = JSON.parse(text(res));
    expect(data.total_count).toBe(1);
    expect(data.items[0]).toMatchObject({ number: 9, repository: "acme/app" });
    const q = new URL(calls[0].url).searchParams.get("q");
    expect(q).toBe("crash repo:acme/app is:issue");
  });

  it("turns a GitHub 404 into a tool error and logs it as an error", async () => {
    const { res, readAudit } = await call("list_issues", { owner: "acme", repo: "missing" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/GitHub API 404/);
    expect(readAudit()[0]).toMatchObject({ status: "error" });
  });

  it("read tools never send anything but GET", async () => {
    const s = await startServer({ route: routes });
    await s.client.callTool({ name: "list_issues", arguments: { owner: "acme", repo: "app" } });
    await s.client.callTool({ name: "get_issue", arguments: { owner: "acme", repo: "app", number: 1 } });
    await s.client.callTool({ name: "list_pull_requests", arguments: { owner: "acme", repo: "app" } });
    await s.client.callTool({ name: "get_pull_request", arguments: { owner: "acme", repo: "app", number: 5 } });
    await s.client.callTool({ name: "search_issues", arguments: { query: "x" } });
    expect(s.calls.length).toBe(6);
    expect(new Set(s.calls.map((c) => c.method))).toEqual(new Set(["GET"]));
    expect(s.readAudit()).toHaveLength(5);
  });
});
