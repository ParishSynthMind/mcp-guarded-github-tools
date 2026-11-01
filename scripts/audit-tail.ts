#!/usr/bin/env node
// Prints the last N audit log entries as a readable table.
// Usage: audit-tail [path] [-n 20] [--json]
import { existsSync, readFileSync } from "node:fs";
import type { AuditEntry } from "../src/audit.js";

export function formatEntry(e: AuditEntry): string {
  const args = JSON.stringify(e.args);
  const shortArgs = args.length > 70 ? `${args.slice(0, 67)}...` : args;
  const err = e.error ? `  ${e.error.slice(0, 90)}` : "";
  return `${e.ts}  ${e.status.padEnd(8)} ${String(e.duration_ms).padStart(6)}ms  ${e.tool.padEnd(19)} ${shortArgs}${err}`;
}

export function tail(text: string, n: number): AuditEntry[] {
  const lines = text.split("\n").filter((l) => l.trim());
  return lines.slice(-n).map((l) => JSON.parse(l) as AuditEntry);
}

function main(argv: string[]) {
  let path = process.env.MCP_GUARD_AUDIT_LOG || "./audit.jsonl";
  let n = 20;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-n") n = Number(argv[++i]);
    else if (argv[i] === "--json") json = true;
    else path = argv[i];
  }
  if (!existsSync(path)) {
    console.error(`No audit log at ${path}`);
    process.exit(1);
  }
  const entries = tail(readFileSync(path, "utf8"), n);
  if (json) {
    for (const e of entries) console.log(JSON.stringify(e));
    return;
  }
  console.log(`${"timestamp".padEnd(24)}  ${"status".padEnd(8)} ${"time".padStart(8)}  ${"tool".padEnd(19)} args`);
  for (const e of entries) console.log(formatEntry(e));
}

if (process.argv[1] && /audit-tail\.(js|ts)$/.test(process.argv[1])) main(process.argv.slice(2));
