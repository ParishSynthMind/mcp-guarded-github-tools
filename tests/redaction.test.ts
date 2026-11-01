import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, REDACTED, redact } from "../src/audit.js";
import { startServer } from "./helpers.js";

// Built at runtime so no token-shaped literal sits in the source file.
const FAKE_TOKEN = ["github", "pat", "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"].join("_");
const FAKE_CLASSIC = "ghp" + "_" + "a".repeat(36);

describe("redaction", () => {
  it("blanks secret-looking keys at any depth", () => {
    const out = redact({ owner: "acme", headers: { Authorization: "Bearer xyz" }, nested: [{ api_key: "k", password: "p" }] });
    expect(out).toEqual({ owner: "acme", headers: { Authorization: REDACTED }, nested: [{ api_key: REDACTED, password: REDACTED }] });
  });

  it("blanks GitHub token values even under innocent keys", () => {
    const out = redact({ body: `here is my token ${FAKE_TOKEN} and ${FAKE_CLASSIC}` }) as { body: string };
    expect(out.body).not.toContain(FAKE_TOKEN);
    expect(out.body).not.toContain(FAKE_CLASSIC);
    expect(out.body).toContain(REDACTED);
  });

  it("blanks a known secret value wherever it appears", () => {
    const out = redact({ query: "abc-SECRETVALUE-123" }, ["SECRETVALUE"]);
    expect(out).toEqual({ query: `abc-${REDACTED}-123` });
  });

  it("writes one JSON line per call, append-only, owner-only permissions", () => {
    const path = join(mkdtempSync(join(tmpdir(), "audit-")), "a.jsonl");
    const log = new AuditLog(path);
    log.write({ tool: "t1", args: {}, status: "ok", duration_ms: 1 });
    log.write({ tool: "t2", args: {}, status: "error", duration_ms: 2, error: "boom" });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).tool).toBe("t1");
    expect(JSON.parse(lines[1])).toMatchObject({ tool: "t2", status: "error", error: "boom" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("token handling end to end", () => {
  it("sends the token to GitHub but never writes it to the audit log or the tool result", async () => {
    const { client, calls, auditPath } = await startServer({
      token: FAKE_TOKEN,
      config: { commentAllowlist: ["acme/sandbox"], dryRun: true },
      route: () => ({ status: 401, json: { message: `Bad credentials for ${FAKE_TOKEN}` } }),
    });
    const read = await client.callTool({ name: "get_issue", arguments: { owner: "acme", repo: "app", number: 1 } });
    await client.callTool({
      name: "add_issue_comment",
      arguments: { owner: "acme", repo: "sandbox", number: 1, body: `oops pasted ${FAKE_TOKEN}` },
    });
    expect(calls[0].headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    const raw = readFileSync(auditPath, "utf8");
    expect(raw).not.toContain(FAKE_TOKEN);
    expect(raw).toContain(REDACTED);
    expect(JSON.stringify(read)).not.toContain(FAKE_TOKEN);
    const entries = raw.trim().split("\n").map((l) => JSON.parse(l));
    expect(entries.map((e) => e.status)).toEqual(["error", "dry_run"]);
    for (const e of entries) {
      expect(Object.keys(e).sort()).toEqual(
        e.error ? ["args", "duration_ms", "error", "status", "tool", "ts"] : ["args", "duration_ms", "status", "tool", "ts"],
      );
      expect(typeof e.duration_ms).toBe("number");
      expect(new Date(e.ts).toString()).not.toBe("Invalid Date");
    }
  });
});
