import { appendFileSync } from "node:fs";

export type AuditStatus = "ok" | "error" | "refused" | "dry_run";

export interface AuditEntry {
  ts: string;
  tool: string;
  args: unknown;
  status: AuditStatus;
  duration_ms: number;
  error?: string;
}

const SECRET_KEY = /(token|secret|password|passwd|authorization|api[_-]?key|cookie|credential)/i;
// GitHub token formats: classic (ghp_), OAuth (gho_), user-to-server (ghu_),
// server-to-server (ghs_), refresh (ghr_) and fine-grained (github_pat_).
const GITHUB_TOKEN_VALUE = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const BEARER_VALUE = /\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi;

export const REDACTED = "[REDACTED]";

export function redactString(value: string, knownSecrets: string[] = []): string {
  let out = value;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  return out.replace(GITHUB_TOKEN_VALUE, REDACTED).replace(BEARER_VALUE, `$1 ${REDACTED}`);
}

/** Deep-copies a value, blanking secret-looking keys and token-looking strings. */
export function redact(value: unknown, knownSecrets: string[] = [], depth = 0): unknown {
  if (depth > 10) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value, knownSecrets);
  if (Array.isArray(value)) return value.map((v) => redact(v, knownSecrets, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? REDACTED : redact(v, knownSecrets, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Append-only JSONL audit log. The file is only ever opened with the "a"
 * flag, so existing lines are never rewritten. Created with mode 0600.
 */
export class AuditLog {
  constructor(
    private readonly path: string,
    private readonly knownSecrets: string[] = [],
  ) {}

  write(entry: Omit<AuditEntry, "ts" | "args"> & { args: unknown; ts?: string }): AuditEntry {
    const record: AuditEntry = {
      ts: entry.ts ?? new Date().toISOString(),
      tool: entry.tool,
      args: redact(entry.args, this.knownSecrets),
      status: entry.status,
      duration_ms: entry.duration_ms,
      ...(entry.error ? { error: redactString(entry.error, this.knownSecrets) } : {}),
    };
    appendFileSync(this.path, JSON.stringify(record) + "\n", { flag: "a", mode: 0o600 });
    return record;
  }
}
