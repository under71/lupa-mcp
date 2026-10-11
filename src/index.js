#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ContentUnsupportedError,
  runLupa,
  supportsContent,
  supportsFolders,
} from "./cli.js";
import { auditPath, record, tail, verify } from "./audit.js";

// `lupa-mcp audit [--verify] [-n 20]` — 서버를 띄우지 않고 감사 로그를 보여주거나 검증한다.
if (process.argv[2] === "audit") {
  const args = process.argv.slice(3);
  if (args.includes("--verify")) {
    const r = verify();
    console.log(r.ok
      ? `OK — ${r.entries} entries, hash chain intact (${auditPath()})`
      : `TAMPERED — line ${r.brokenAt}: ${r.reason} (${auditPath()})`);
    process.exit(r.ok ? 0 : 1);
  }
  const n = Number(args[args.indexOf("-n") + 1]) || 20;
  for (const e of tail(n)) {
    const what = e.tool === "lupa_read" ? e.path : JSON.stringify(e.query);
    const res = e.ok ? (e.tool === "lupa_read" ? `${e.chars} chars` : `${e.returned} results`) : `ERROR ${e.error}`;
    console.log(`${e.ts}  ${(e.client || "?").padEnd(16)} ${e.tool.padEnd(11)} ${what}  → ${res}`);
  }
  console.log(`\n${auditPath()}`);
  process.exit(0);
}

/**
 * 검색 문법 치트시트.
 *
 * Claude Code 플러그인은 이걸 스킬 파일로 가르치지만, 다른 MCP 클라이언트에는
 * 스킬이 없다. 그래서 도구 설명에 직접 넣는다 — 어느 클라이언트에서든 모델이
 * 자연어를 이 문법으로 옮길 수 있게.
 */
const QUERY_SYNTAX = `Query syntax (combine freely; more conditions = sharper results):
  word1 word2      files matching ALL words rank first (grouped by match count)
  n:word           file name only        (aliases: name:, 이름:, 파일명:, 文件名:)
  c:word           document content only (aliases: content:, 내용:, 内容:)
  f:word           folder path contains  (aliases: 폴더:, 文件夹:)
  -word            exclude
  "exact phrase"   literal match, no stemming
  .pdf  *.mp3  report*     extension / wildcard
  kind:document    kind filter — document, pdf, hwp, image, video, audio, code, archive, app
  size:>10mb  size:<1mb
  date:today  date:week  date:month  date:7d  date:2026-06
Korean and Chinese prefixes work too (종류:, 크기:, 날짜: / 种类:, 大小:, 日期:).
Korean is handled properly: partial words inside compounds and attached particles
("보호정책" finds "정보보호정책서.hwp"; "심사보고서를" finds "심사보고서").`;

const server = new McpServer({ name: "lupa", version: "0.3.0" });

/** 어떤 클라이언트(Claude Code, Cursor …)가 불렀는지 — initialize 때 받은 이름. */
function clientName() {
  const c = server.server.getClientVersion?.();
  return c ? `${c.name}${c.version ? " " + c.version : ""}` : undefined;
}

/** 도구 호출을 감사 로그에 남긴다. 기록 실패는 도구 결과에 영향을 주지 않는다. */
async function audited(tool, input, run, summarize) {
  const started = Date.now();
  try {
    const out = await run();
    record({ tool, client: clientName(), ...input, ok: true, ...summarize(out), ms: Date.now() - started });
    return out.response;
  } catch (err) {
    record({ tool, client: clientName(), ...input, ok: false, error: `${err.code ?? err.name ?? "error"}: ${String(err.message || "").slice(0, 80)}`, ms: Date.now() - started });
    throw err;
  }
}

/** 토큰을 아끼려고 필요한 필드만 남긴다. 에이전트는 경로·이름·근거만 있으면 된다. */
function trimResult(row, snippetChars) {
  const out = {
    path: row.path,
    name: row.name,
    kind: row.kind,
    modified: (row.modified || "").slice(0, 10),
    size_kb: Math.round((row.size_bytes || 0) / 1024),
  };
  if (row.matched_keywords > 1) out.matched_keywords = row.matched_keywords;
  const snippet = (row.snippet || "").trim();
  if (snippet) {
    out.snippet =
      snippet.length > snippetChars ? snippet.slice(0, snippetChars) + "…" : snippet;
  }
  return out;
}

server.registerTool(
  "lupa_search",
  {
    title: "Search files on this Mac",
    description:
      "Find files on this Mac by file name AND by what is written inside documents " +
      "(PDF, Word, Excel, PowerPoint, Hangul HWP/HWPX, plain text, and scanned PDFs " +
      "read with OCR). Searches Lupa's local index, so it answers in ~30ms and never " +
      "touches the network. Prefer this over find/grep/mdfind for locating files.\n\n" +
      "Returns ranked paths with a matching snippet. To read a file's text afterwards, " +
      "use lupa_read — it returns the indexed text without opening the file.\n\n" +
      QUERY_SYNTAX,
    inputSchema: {
      query: z.string().min(1).describe("Search query. Use the syntax above."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("How many results to return (default 10, max 50)."),
      names_only: z
        .boolean()
        .default(false)
        .describe("Search file names only, ignoring document contents. Faster."),
      snippet_chars: z
        .number()
        .int()
        .min(0)
        .max(500)
        .default(160)
        .describe("Truncate each snippet to this many characters (0 = no snippets)."),
    },
  },
  async ({ query, limit, names_only, snippet_chars }) =>
    audited("lupa_search", { query, limit, names_only }, async () => {
    const args = [query, "--limit", String(limit)];
    if (names_only) args.push("--names-only");

    const data = await runLupa(args);
    const results = (data.results || []).map((row) => trimResult(row, snippet_chars));

    const summary = {
      query: data.query,
      total_matches: data.total_matches,
      returned: results.length,
      elapsed_ms: data.elapsed_ms,
      results,
    };
    if (data.total_matches_capped) summary.total_matches_capped = true;
    if (results.length === 0) {
      summary.hint =
        "No matches. Try fewer or shorter words, drop filters, or check that the " +
        "folder containing the file is registered in the Lupa app.";
    }
    return { results, response: { content: [{ type: "text", text: JSON.stringify(summary, null, 1) }] } };
    }, (out) => ({ returned: out.results.length, paths: out.results.map((r) => r.path) }))
);

server.registerTool(
  "lupa_read",
  {
    title: "Read a file's indexed text",
    description:
      "Return the text Lupa already extracted from a file, without opening the file " +
      "itself. Works for PDF, Word, Excel, PowerPoint, Hangul HWP/HWPX and scanned " +
      "documents that were OCR'd. Use this after lupa_search when you need the actual " +
      "content — it is far cheaper than reading the original file, and it works even " +
      "for formats you cannot parse.\n\n" +
      "Note: only the beginning of each document is indexed, so very long files are " +
      "truncated. If the file has no indexed text (image-only, password-protected, or " +
      "not yet content-indexed), this reports that instead.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .describe("Absolute file path, exactly as returned by lupa_search."),
      max_chars: z
        .number()
        .int()
        .min(0)
        .max(100_000)
        .default(8_000)
        .describe("Maximum characters to return (default 8000, 0 = no limit)."),
    },
  },
  async ({ path, max_chars }) =>
    audited("lupa_read", { path, max_chars }, async () => {
    if (!(await supportsContent())) throw new ContentUnsupportedError();
    const data = await runLupa(["--content", path, "--max-chars", String(max_chars)]);
    const truncated = data.total_chars > data.chars;
    const header =
      `${path}\n${data.chars} of ${data.total_chars} indexed characters` +
      (truncated ? " (truncated — raise max_chars for more)" : "") +
      "\n\n";
    return { chars: data.chars, response: { content: [{ type: "text", text: header + (data.content || "") }] } };
    }, (out) => ({ chars: out.chars }))
);

await server.connect(new StdioServerTransport());
