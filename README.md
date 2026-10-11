# lupa-mcp

**Let your AI agent search the documents on your Mac — by what's written inside them.**

An MCP server for [Lupa](https://lupa.kr), a macOS file search app with its own index.
Your agent asks Lupa; Lupa answers from a local index in ~30 ms. Nothing touches the network.

```
"find the contract that mentions the penalty clause"
        ↓
   lupa_search  →  ranked paths + matching snippets
   lupa_read    →  the document's text, without opening the file
```

Searches **file names and document contents**: PDF, Word, Excel, PowerPoint, plain text,
Hangul **HWP/HWPX**, and **scanned PDFs read with OCR**.

## Why this instead of find/grep

| | `find` / `grep` / `mdfind` | lupa-mcp |
|---|---|---|
| Searches inside PDF, DOCX, HWP | no | **yes** |
| Scanned documents (OCR) | no | **yes** |
| Korean partial words and particles | poorly | **yes** — `보호정책` finds `정보보호정책서.hwp` |
| Speed on a large disk | seconds | **~30 ms** (indexed) |
| Agent needs file system access | **yes** | **no** — Lupa reads the files, not your agent |

That last row is the point. Your agent gets document contents **without you granting it
access to your disk**.

## Requirements

**The Lupa app must be installed** — this server reads the index that Lupa builds; it does
not index anything itself.

1. Install Lupa (free) from the Mac App Store: <https://lupa.kr>
2. Open it, add the folders you want searchable, and let indexing finish.

macOS only.

## Install

**Claude Code**

```bash
claude mcp add lupa -- npx -y lupa-mcp
```

**Claude Desktop / Cursor / any MCP client** — add to the client's MCP config:

```json
{
  "mcpServers": {
    "lupa": { "command": "/bin/zsh", "args": ["-lc", "npx -y lupa-mcp"] }
  }
}
```

That's it. No API key, no account, no configuration.

> **Why `/bin/zsh -lc`?** GUI apps don't inherit your shell's PATH, so a bare
> `"command": "npx"` fails to start with `env: npx: No such file or directory`
> (measured on Claude Desktop and Aside). A login shell finds `npx` wherever it lives —
> Homebrew, nvm, or a system install. In a terminal-based client (Claude Code, Codex)
> plain `npx -y lupa-mcp` is fine.

> **Agents: don't run `lupa-search` through your shell.** Sandboxed agent shells
> (Aside, Codex) kill the App Store-signed CLI at launch — exit code 133 or 134.
> Register this MCP server instead; it starts outside that sandbox.
> Full guide: https://lupa.kr/agents.html

## Tools

### `lupa_search`

| argument | default | meaning |
|---|---|---|
| `query` | — | see syntax below |
| `limit` | 10 | results to return (max 50) |
| `names_only` | false | file names only, ignore contents (faster) |
| `snippet_chars` | 160 | truncate each snippet (0 = none) |

### `lupa_read`

Returns the text Lupa already extracted from a file — cheaper than reading the original,
and it works for formats your agent cannot parse. Requires **Lupa 2.0 or later**.

| argument | default | meaning |
|---|---|---|
| `path` | — | absolute path, as returned by `lupa_search` |
| `max_chars` | 8000 | cap the returned text (0 = no limit) |

## Query syntax

```
word1 word2      files matching ALL words rank first
n:word           file name only          (name:, 이름:, 文件名:)
c:word           document content only   (content:, 내용:, 内容:)
f:word           folder path contains    (폴더:, 文件夹:)
-word            exclude
"exact phrase"   literal match
.pdf  *.mp3  report*      extension / wildcard
kind:document    document · pdf · hwp · image · video · audio · code · archive · app
size:>10mb       size:<1mb
date:today       date:week · date:month · date:7d · date:2026-06
```

Korean and Chinese prefixes work too (`종류:` `크기:` `날짜:` / `种类:` `大小:` `日期:`).

Korean is handled properly — partial words inside compounds and attached particles both
match, which is what Spotlight gets wrong.

## Audit log

Every tool call is recorded on your Mac so you can see what an agent searched for and which files it was shown:

```
~/Library/Logs/Lupa/mcp-audit.jsonl
```

Each line has the time, the calling client (e.g. Claude Code, Cursor), the tool, the query or path, the paths
returned, and whether it succeeded. **Snippets and document text are not logged.** The file is readable only by you
(0600) and never leaves the Mac.

Lines are hash-chained: each entry includes the hash of the previous one, so editing or removing a line is
detected. This makes the log *tamper-evident*, not tamper-proof — deleting the whole file and starting over is
still possible.

```bash
npx lupa-mcp audit            # last 20 calls
npx lupa-mcp audit -n 100
npx lupa-mcp audit --verify   # exit 0 if the chain is intact, 1 if a line was changed or removed
```

Turn it off with `LUPA_MCP_AUDIT=off`, or move it with `LUPA_MCP_AUDIT_PATH=/path/to/file.jsonl`.

## Privacy

Everything runs on your Mac. Lupa has no network code at all, and this server only
launches Lupa's bundled command-line tool and passes the results to your agent. Nothing is
uploaded, and there is no telemetry.

## Notes

- Lupa's free index covers up to 50,000 files. This server inherits whatever the app
  indexed — there is no separate limit or paywall here.
- Only the beginning of each document is indexed, so `lupa_read` truncates long files.
- If Lupa is installed somewhere unusual, set `LUPA_SEARCH_PATH` to the `lupa-search`
  binary inside the app bundle.

## Troubleshooting

| message | fix |
|---|---|
| "Lupa를 찾을 수 없습니다" / not found | Install Lupa from the Mac App Store |
| "검색 인덱스가 없습니다" | Open Lupa, add folders, wait for indexing |
| "본문 읽기를 지원하지 않습니다" | Update Lupa to 2.0 or later |
| No results for a file you know exists | Its folder may not be registered in Lupa |

## License

MIT
