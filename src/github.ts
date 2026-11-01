export type FetchLike = typeof fetch;

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export interface GitHubClientOptions {
  baseUrl: string;
  token?: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

const MAX_BODY_CHARS = 4000;
const MAX_ISSUE_PAGES = 3;

function clip(text: string | null | undefined, max = MAX_BODY_CHARS): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}\n[... clipped ${text.length - max} chars]` : text;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function summariseIssue(i: any) {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    author: i.user?.login ?? null,
    labels: (i.labels ?? []).map((l: any) => (typeof l === "string" ? l : l.name)),
    comments: i.comments,
    created_at: i.created_at,
    updated_at: i.updated_at,
    url: i.html_url,
  };
}

function summarisePull(p: any) {
  return {
    number: p.number,
    title: p.title,
    state: p.state,
    draft: p.draft ?? false,
    author: p.user?.login ?? null,
    head: p.head?.ref ?? null,
    base: p.base?.ref ?? null,
    created_at: p.created_at,
    updated_at: p.updated_at,
    merged_at: p.merged_at ?? null,
    url: p.html_url,
  };
}

/**
 * Thin GitHub REST client. Only the endpoints the server exposes exist here:
 * there is deliberately no method for merge, close, delete, labels or refs,
 * so those actions can't be reached even by a bug in the tool layer.
 */
export class GitHubClient {
  private readonly token?: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: GitHubClientOptions) {
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get authenticated(): boolean {
    return Boolean(this.token);
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mcp-guarded-github-tools",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = ((await res.json()) as any)?.message ?? "";
      } catch {
        /* non-JSON error body */
      }
      const hint =
        res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0"
          ? " (rate limit reached; set GITHUB_TOKEN for a higher limit)"
          : "";
      throw new GitHubApiError(res.status, `GitHub API ${res.status} on ${method} ${path}: ${detail}${hint}`);
    }
    return res.json();
  }

  private repoPath(owner: string, repo: string): string {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  async listIssues(owner: string, repo: string, state: string, perPage: number) {
    // The issues endpoint also returns pull requests and counts them in
    // per_page, so on a busy repo one page can hold no issues at all. Read
    // full pages (up to MAX_ISSUE_PAGES) until there are enough real issues.
    const issues: any[] = [];
    for (let page = 1; page <= MAX_ISSUE_PAGES && issues.length < perPage; page++) {
      const items = (await this.request(
        "GET",
        `${this.repoPath(owner, repo)}/issues?state=${state}&per_page=100&page=${page}`,
      )) as any[];
      issues.push(...items.filter((i) => !i.pull_request));
      if (items.length < 100) break;
    }
    return issues.slice(0, perPage).map(summariseIssue);
  }

  async getIssue(owner: string, repo: string, number: number) {
    const i = await this.request("GET", `${this.repoPath(owner, repo)}/issues/${number}`);
    return { ...summariseIssue(i), is_pull_request: Boolean(i.pull_request), body: clip(i.body) };
  }

  async listPullRequests(owner: string, repo: string, state: string, perPage: number) {
    const items = await this.request(
      "GET",
      `${this.repoPath(owner, repo)}/pulls?state=${state}&per_page=${perPage}`,
    );
    return (items as any[]).map(summarisePull);
  }

  async getPullRequest(owner: string, repo: string, number: number) {
    const base = this.repoPath(owner, repo);
    const p = await this.request("GET", `${base}/pulls/${number}`);
    const files = (await this.request("GET", `${base}/pulls/${number}/files?per_page=50`)) as any[];
    return {
      ...summarisePull(p),
      body: clip(p.body),
      mergeable_state: p.mergeable_state ?? null,
      diff_stats: {
        commits: p.commits,
        changed_files: p.changed_files,
        additions: p.additions,
        deletions: p.deletions,
        files: files.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
        })),
        files_listed: files.length,
      },
    };
  }

  async searchIssues(query: string, perPage: number) {
    const res = await this.request(
      "GET",
      `/search/issues?q=${encodeURIComponent(query)}&per_page=${perPage}`,
    );
    return {
      total_count: res.total_count,
      items: (res.items as any[]).map((i) => ({
        ...summariseIssue(i),
        repository: String(i.repository_url ?? "").replace(/^.*\/repos\//, ""),
        is_pull_request: Boolean(i.pull_request),
      })),
    };
  }

  async addIssueComment(owner: string, repo: string, number: number, body: string) {
    const c = await this.request("POST", `${this.repoPath(owner, repo)}/issues/${number}/comments`, { body });
    return { id: c.id, url: c.html_url, created_at: c.created_at };
  }
}
