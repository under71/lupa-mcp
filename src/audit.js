/**
 * 감사 로그 — 에이전트가 이 서버로 무엇을 검색하고 무엇을 읽었는지 사용자 Mac에 남긴다.
 *
 * 원칙 (CLAUDE.md 설계 규칙과 같다)
 * - 로컬 전용: ~/Library/Logs/Lupa/mcp-audit.jsonl. 네트워크로 보내지 않는다.
 * - 내용은 남기지 않는다: 검색어·경로·건수·결과만. 스니펫과 문서 본문은 기록하지 않는다.
 * - 변조 탐지(tamper-evident): 줄마다 이전 줄의 해시를 이어 붙인 해시 체인.
 *   줄을 고치거나 지우면 `lupa-mcp audit --verify` 가 그 지점을 찾아낸다.
 *   파일 전체를 지우고 새로 시작하는 것까지 막지는 못한다 — "변경 불가"가 아니라 "변조 시 탐지".
 * - 기록 실패가 도구 동작을 막지 않는다.
 * - 끄기: LUPA_MCP_AUDIT=off. 경로 바꾸기: LUPA_MCP_AUDIT_PATH=/path/file.jsonl
 */
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const GENESIS = "0".repeat(64);
const ROTATE_BYTES = 20 * 1024 * 1024;
export const SESSION = randomUUID().slice(0, 8);

export function auditPath() {
  return process.env.LUPA_MCP_AUDIT_PATH || join(homedir(), "Library", "Logs", "Lupa", "mcp-audit.jsonl");
}

export function auditEnabled() {
  return !["off", "0", "false", "no"].includes(String(process.env.LUPA_MCP_AUDIT || "").toLowerCase());
}

/** 같은 키 순서로 직렬화해야 해시가 재현된다. */
function canonical(entry) {
  return JSON.stringify(entry, Object.keys(entry).sort());
}

export function hashEntry(entryWithoutHash) {
  return createHash("sha256").update(canonical(entryWithoutHash)).digest("hex");
}

function lastHash(file) {
  if (!existsSync(file)) return GENESIS;
  const text = readFileSync(file, "utf8").trimEnd();
  if (!text) return GENESIS;
  const last = text.slice(text.lastIndexOf("\n") + 1);
  try {
    return JSON.parse(last).hash || GENESIS;
  } catch {
    return GENESIS;
  }
}

/** 여러 클라이언트가 동시에 서버를 띄워도 체인이 엇갈리지 않게 mkdir 잠금. */
function withLock(file, fn) {
  const lock = file + ".lock";
  const until = Date.now() + 2000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5000) rmdirSync(lock); // 죽은 프로세스가 남긴 잠금
      } catch {}
      if (Date.now() > until) throw new Error("audit lock timeout");
      const t = Date.now() + 15;
      while (Date.now() < t) {} // 아주 짧은 대기 (stdio 서버라 동기로 충분)
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {}
  }
}

/**
 * 한 줄 기록. 회전 시 새 파일의 첫 줄 prev 는 이전 파일의 마지막 해시 → 파일을 넘어서도 체인이 이어진다.
 * @returns 기록한 항목, 또는 꺼져 있거나 실패하면 null
 */
export function record(fields) {
  if (!auditEnabled()) return null;
  try {
    const file = auditPath();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    return withLock(file, () => {
      let prev = lastHash(file);
      if (existsSync(file) && statSync(file).size > ROTATE_BYTES) {
        renameSync(file, file.replace(/\.jsonl$/, "") + "-" + new Date().toISOString().slice(0, 10) + ".jsonl");
      }
      const entry = { ts: new Date().toISOString(), session: SESSION, ...fields, prev };
      entry.hash = hashEntry(entry);
      appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
      return entry;
    });
  } catch (err) {
    process.stderr.write(`lupa-mcp: audit log not written (${err.message})\n`);
    return null;
  }
}

/** 체인 검증. { ok, entries, brokenAt?, reason? } */
export function verify(file = auditPath()) {
  if (!existsSync(file)) return { ok: true, entries: 0 };
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  let prev = null;
  for (let i = 0; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      return { ok: false, entries: lines.length, brokenAt: i + 1, reason: "not valid JSON" };
    }
    const { hash, ...rest } = entry;
    if (hashEntry(rest) !== hash) {
      return { ok: false, entries: lines.length, brokenAt: i + 1, reason: "entry was modified" };
    }
    if (prev !== null && entry.prev !== prev) {
      return { ok: false, entries: lines.length, brokenAt: i + 1, reason: "a previous entry was removed or reordered" };
    }
    prev = hash;
  }
  return { ok: true, entries: lines.length };
}

export function tail(n = 20, file = auditPath()) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-n).map((l) => JSON.parse(l));
}
