# Toss CLI instructions for local agents

Use these instructions in the repository root. Use [the CLI reference](toss-cli.md) for command arguments and data meanings. Discover the current command list with `node scripts/toss.ts --help`; it requires no authentication. This document is intended for agents, including Codex and OpenAI dots.

## Synthetic connection exercise

Invoke `node tests/toss-agent-cli.mjs SCENARIO` followed by the CLI arguments for `node scripts/toss.ts`. The runner starts that actual CLI with the existing HTTP mock and a new temporary state directory for each invocation. It supplies only synthetic credentials and responses, ignores the caller's `TOSS_STATE_DIR` for the child, and deletes its temporary state after the invocation. No HTTP server or MCP server is needed. The `SYNTHETIC` stderr notice labels the entire exercise; the CLI's stdout JSON and exit code are forwarded unchanged. Even `source.provider=tossinvest` refers to mocked responses here.

| Scenario | CLI arguments | Purpose |
| --- | --- | --- |
| `success` | `--help` | Discover commands and usage without authentication. |
| `success` | `prices DEMO` | Read a decimal price and an unknown data timestamp. |
| `success` | `rankings TOP_GAINERS 1d 1` | Read one original US market rank and its aggregation time. |
| `success` | `tradable NASDAQ` | Read a complete synthetic list for the requested market. |
| `partial` | `candles DEMO 1m count=1` | Receive an empty page with a next boundary. |
| `partial` | `candles DEMO 1m count=1 before=VALUE` | Copy the previous `page.nextBefore` exactly to obtain the last page. |
| `error` | `prices DEMO` | Receive a synthetic permission failure. |
| `success` | `prices DEMO/` | Observe the actual CLI rejecting invalid input. |

Start discovery with `node tests/toss-agent-cli.mjs success --help`. Choose subsequent arguments from its output and the reference. The fixture contains one `DEMO` price, rank and listed security. Ranking requests for more than one item return a partial result. Other symbols and filters do not create new fixture data. The runner covers only the cases above; it is not a replacement provider or live execution mode.

Read stdout as one JSON object and retain the process exit code even if it is nonzero. Interpret `version=1`, `status`, `data`, `omissions`, `page`, `source` and `error` together:

- `success` / exit 0 means this request completed. It does not establish live freshness, investment suitability or future availability.
- `partial` / exit 2 preserves usable data and identifies missing coverage. Empty `data` with `page.nextBefore` is not the last page. Request another page explicitly with the same symbol, interval, count and adjustment choice; copy the boundary without subtracting time. A null boundary ends pagination; inspect other omissions before treating the request as complete. Report unresolved coverage if the boundary is absent.
- `error` / exit 1 is a failed query, not evidence of no matching securities. Report the machine-readable error code. A permission failure requires checking access conditions; do not silently change providers, use KIS or start an authentication loop.

Preserve decimal strings and distinguish null from zero and omission. Treat `retrievedAt` as retrieval time, not a provider update timestamp. US market rankings are not exchange-specific rankings. Tradable lists and rankings have no cursor; do not invent a page argument. Read the candle page contract in the reference before choosing follow-up arguments.

## Verify each consumer separately

In each actual consumer, ask the agent to read this document, discover the CLI, choose arguments for the normal market queries, follow the partial page and interpret the error. Record the consumer and execution host, commands, exit codes and its interpretation. A shell command run by Codex proves only that Codex path. A Node regression test proves the runner behavior, not that dots can discover or execute it.

If dots cannot read this checkout or run a local process, record the observed limitation and ask whether to connect dots to this computer or reconsider the CLI interface. Keep #295 pending until the required consumer path is observed or the user changes the requirement. Do not add a server or drop a consumer automatically.

## Extend to later commands

Keep `node scripts/toss.ts --help` as the discovery entry point and [the reference](toss-cli.md) as the argument and interpretation authority. Add a command-specific section there when a new query is implemented. Add a synthetic response at the existing external HTTP boundary and a public CLI regression check when extending this exercise; keep live state and fixture state separate. The remaining first-tool-set consumer acceptance belongs to later integration work.

Actual Toss data, account access, credential setup and transmission to external models require the applicable [access conditions](toss-access-readiness.md) and task-specific authorization. Synthetic connection success does not establish any of them.
