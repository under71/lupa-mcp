#!/usr/bin/env node
/**
 * 감사 로그 단위 테스트 — Lupa 앱 없이 돈다.
 *   node test/audit.js
 * 기록 → 검증 통과 → 한 줄 수정 시 탐지 → 한 줄 삭제 시 탐지 → 꺼짐 설정 확인.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "lupa-audit-"));
const file = join(dir, "mcp-audit.jsonl");
process.env.LUPA_MCP_AUDIT_PATH = file;
const { record, verify } = await import("../src/audit.js");

let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failed++;
};

record({ tool: "lupa_search", query: "계약서 위약금", ok: true, returned: 2, paths: ["/a.pdf", "/b.hwp"] });
record({ tool: "lupa_read", path: "/a.pdf", ok: true, chars: 1200 });
record({ tool: "lupa_search", query: "보호정책", ok: true, returned: 0, paths: [] });
check("intact chain verifies", verify(file).ok && verify(file).entries === 3);

const lines = readFileSync(file, "utf8").trimEnd().split("\n");
check("no snippet/content field is written", !lines.some((l) => /snippet|content/.test(l)));

const edited = [...lines];
edited[1] = edited[1].replace('"chars":1200', '"chars":9999');
writeFileSync(file, edited.join("\n") + "\n");
const r1 = verify(file);
check("edited line is detected at line 2", !r1.ok && r1.brokenAt === 2);

writeFileSync(file, [lines[0], lines[2]].join("\n") + "\n");
const r2 = verify(file);
check("deleted line is detected", !r2.ok && r2.reason.includes("removed"));

writeFileSync(file, lines.join("\n") + "\n");
process.env.LUPA_MCP_AUDIT = "off";
check("LUPA_MCP_AUDIT=off writes nothing", record({ tool: "lupa_search" }) === null);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
