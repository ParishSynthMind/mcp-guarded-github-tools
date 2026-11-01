import { describe, expect, it } from "vitest";
import { formatEntry, tail } from "../scripts/audit-tail.js";

describe("audit-tail", () => {
  const log = [1, 2, 3]
    .map((n) => JSON.stringify({ ts: `2026-11-01T00:00:0${n}Z`, tool: "get_issue", args: { number: n }, status: "ok", duration_ms: n * 10 }))
    .join("\n");

  it("returns the last N entries", () => {
    expect(tail(log + "\n", 2).map((e) => (e.args as { number: number }).number)).toEqual([2, 3]);
  });

  it("formats a readable line", () => {
    const line = formatEntry(tail(log, 1)[0]);
    expect(line).toContain("get_issue");
    expect(line).toContain("30ms");
    expect(line).toContain('{"number":3}');
  });
});
