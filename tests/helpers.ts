import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AuditLog, type AuditEntry } from "../src/audit.js";
import { parseConfig, type Config } from "../src/config.js";
import { GitHubClient } from "../src/github.js";
import { createServer } from "../src/server.js";

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

type Route = (url: string, method: string) => { status?: number; json: unknown } | undefined;

/** A fetch replacement that serves canned JSON and records every request. */
export function mockFetch(route: Route) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const hit = route(url, method);
    if (!hit) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return new Response(JSON.stringify(hit.json), {
      status: hit.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

export async function startServer(opts: { config?: Partial<Config>; route?: Route; token?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-guard-test-"));
  const auditPath = join(dir, "audit.jsonl");
  const config = parseConfig({ auditLogPath: auditPath, ...opts.config });
  const fetcher = mockFetch(opts.route ?? (() => undefined));
  const github = new GitHubClient({
    baseUrl: config.apiBaseUrl,
    token: opts.token,
    timeoutMs: 5000,
    fetchImpl: fetcher.impl,
  });
  const audit = new AuditLog(auditPath, opts.token ? [opts.token] : []);
  const server = createServer({ config, github, audit });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientT);
  const readAudit = (): AuditEntry[] =>
    readFileSync(auditPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { client, calls: fetcher.calls, readAudit, auditPath, config };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function text(result: any): string {
  return result.content?.[0]?.text ?? "";
}
