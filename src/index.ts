#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AuditLog } from "./audit.js";
import { loadConfig } from "./config.js";
import { GitHubClient } from "./github.js";
import { createServer, SERVER_NAME } from "./server.js";

async function main() {
  const config = loadConfig();
  const token = process.env.GITHUB_TOKEN || undefined;
  const github = new GitHubClient({ baseUrl: config.apiBaseUrl, token, timeoutMs: config.requestTimeoutMs });
  const audit = new AuditLog(config.auditLogPath, token ? [token] : []);
  const server = createServer({ config, github, audit });

  await server.connect(new StdioServerTransport());
  // stdout carries the MCP protocol, so status goes to stderr. Never print the token.
  console.error(
    `${SERVER_NAME} running on stdio | auth: ${github.authenticated ? "token set" : "none (public reads only)"} | ` +
      `dry-run: ${config.dryRun} | comment allowlist: ${config.commentAllowlist.join(", ") || "(none)"} | ` +
      `audit log: ${config.auditLogPath}`,
  );
}

main().catch((err) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
