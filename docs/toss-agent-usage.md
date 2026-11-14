# Toss CLI instructions for local agents

Use these instructions in the repository root when choosing queries, interpreting results, or connecting a local agent, including Codex and OpenAI dots. Use [the CLI reference](toss-cli.md) as the authority for arguments, JSON fields, limits and errors. Discover the current command list with `node scripts/toss.ts --help`; it requires no authentication.

Actual Toss data, account access, credential setup and transmission to external models require the applicable [access conditions](toss-access-readiness.md) and task-specific authorization. Reuse existing authorization within its scope. Historical acceptance and synthetic exercises do not authorize new accounts, consumer environments or transmission/storage scope.

## Use the CLI for a user request

1. Identify the user's request and the approved scope for queries, account access and data transmission/storage. Reuse existing authorization within that scope.
2. Discover commands with `node scripts/toss.ts --help` and use the CLI reference to choose the queries and arguments needed for the request.
3. Run the selected queries and inspect stdout JSON, exit codes, omissions and next-page information together.
4. If more data is needed, request additional queries or pages within the approved scope. Report unresolved gaps when the scope or query budget prevents further retrieval.
5. Use the returned data to write the analysis and recommendations, reflecting its coverage and limits. The agent owns query order and analysis; the CLI owns retrieval, validation, timestamps and error handling. The user decides and executes actual trades.

### Choose queries for the requested task

Use the following starting points, then choose only the queries needed to answer the request. A request does not require every command in its row. Use a verified provider symbol and resolve ambiguous identity with `stock` before combining data for a security. Selecting a market/ISIN with `stock` does not pass that selection to `prices`; when multiple securities share a symbol, do not attribute a symbol-only price to the selected security without evidence linking them.

| User task | Query choices | Interpretation and stopping point |
| --- | --- | --- |
| Find securities for further research | `rankings`, `tradable`, then `stock` for selected symbols | Treat rankings as US market discovery data. Confirm security identity and type; a ranking or tradable entry alone does not establish suitability or current eligibility. |
| Review an additional purchase of a held security | Scoped `holdings`, relevant-currency `buying-power`, `stock`, `prices`, and needed market queries | Distinguish the existing position, cash buying power and market evidence. Report [price age at the report timestamp](#classify-prices-at-report-time) and unresolved trade constraints. |
| Compare daily price history for several symbols | `candles-batch`, then selected individual `candles` pages | Inspect each symbol's actual coverage. Follow only pages needed for the analysis, preserving partial and unqueried results. |
| Examine current market context | `orderbook`, `trades`, `sessions`, `constraints` as needed | Preserve provider order and timestamps. Recent trades are not a complete day; documented rules and sessions do not confirm per-symbol eligibility. |
| Review settled or pending account transactions | Period-bound `transactions` | Use settlement date/status and the provider's net amount. Keep this separate from order creation and current order state. |
| Review current general or conditional orders | `orders` or `conditional-orders` for the relevant group | Distinguish group selection from item status and order quantity from execution. Querying an order does not execute or change it. |

For account queries, use the existing approved selection and scopes. If the request needs an unapproved account or scope, report that prerequisite instead of changing selection or opening credential files. Keep arguments and response details in the approved consumer context; shared evidence should contain only the safe metadata described in [the real-data exercise](#real-data-consumer-exercise-298).

Continue with [result interpretation](#interpret-query-results), [daily coverage](#choose-daily-queries-and-follow-up-pages), and [report-time price classification](#classify-prices-at-report-time). Use [the synthetic exercise](#synthetic-connection-exercise) to verify a consumer path before approved real queries.

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
| `success` | `candles DEMO 1d date=2026-11-05 count=3` | Read two daily bars with a verified synthetic US identity. |
| `partial` | `candles DEMO 1d date=2026-11-05 count=3` | Analyze two bars while preserving the remaining-page omission and exit 2. |
| `success` | `candles-batch DEMO,EMPTY count=3` | Distinguish two returned bars with unconfirmed trade dates from a successful empty page. |
| `partial` | `candles-batch DEMO,PARTIAL,EMPTY,INVALID,DENIED,LATER date=2026-11-05 count=3` | Read success, usable partial pages, invalid-item/pagination omissions, a permission error and an unqueried symbol with the actual CLI summaries. |
| `error` | `candles DEMO 1d` or `candles-batch DEMO,LATER` | Preserve the permission failure and, for the batch, the unqueried remainder. |
| `error` | `prices DEMO` | Receive a synthetic permission failure. |
| `success` | `prices DEMO/` | Observe the actual CLI rejecting invalid input. |
| `success` | `stock DEMO` | Read one listing and its security type. |
| `success` | `orderbook DEMO` | Preserve decimal prices, quantities and provider order. |
| `success` | `trades DEMO 1` | Read one recent execution without treating it as a full-day history. |
| `success` | `sessions 2026-11-06` | Distinguish the US date from KST session timestamps. |
| `success` | `constraints DEMO 2026-11-06` | Interpret exit 2 and unknown eligibility alongside documented rules. |
| `success` | `holdings` | Read synthetic fractional holdings, costs and currency summaries. |
| `success` | `buying-power USD` | Read cash buying power, not withdrawable cash. KRW is also accepted. |
| `success` | `transactions 2026-10-11 2026-11-10 limit=1` | Preserve settlement fields and the provider's net amount. |
| `success` | `orders OPEN` or `orders CLOSED limit=1` | Read a general order group and its separate item status. |
| `success` | `conditional-orders OPEN limit=1` or `conditional-orders CLOSED limit=1` | Read conditional order state without inventing a currency. |
| `partial` | `transactions 2026-10-11 2026-11-10 limit=1` | Receive an empty page with a next cursor and context. |
| `partial` | `orders CLOSED limit=1` or `conditional-orders CLOSED limit=1` | Exercise the same account-page continuation contract. |
| `error` | `holdings` | Distinguish account permission denial from an empty portfolio. |

Start discovery with `node tests/toss-agent-cli.mjs success --help`. Choose subsequent arguments from its output and the reference. The fixture contains a `DEMO` listing and fixed synthetic market/account responses; date-selected daily batches supply matching synthetic identities for their requested symbols. Ranking requests for more than one item return a partial result. Outside the daily batch cases, other symbols and filters do not create new fixture data. Session fixtures use only `2026-11-06`; adjacent dates are synthetic closed days, not historical calendar evidence. The runner covers only the cases above; it is not a replacement provider or live execution mode.

Account exercises select a synthetic `primary` account in the invocation's isolated state, without reading or changing the live selection. For account pagination, copy both `page.nextCursor` and `page.context` into `cursor=VALUE context=VALUE`, keeping the scenario `partial` and the same command, group, period and filters. The next invocation returns one item and no next page. The fixed synthetic identity lets this context work across isolated invocations; do not reuse synthetic cursors or contexts with live state. Never use `account-select` to prepare a real account during this exercise.

### Check changed candle analysis before real queries

When creating analysis code or changing its field mapping, feed synthetic CLI stdout into the same code that will analyze the actual response, before making real queries. Repeat when that code changes, rather than before every real query. Keep independently chosen expected trade dates, `closePrice`, `volume` and calculation results; checking only extraction in a separate test implementation does not verify the analysis path. A field-mapping failure must stop the analysis. Do not fill a missing close with zero, silently use another field name or query Toss again to repair a code error.

The executable [candle consumer](../examples/candle-consumer.mjs) reads individual daily or batch stdout from stdin. For each usable nonempty result, it compares the first returned close with the last returned close and sums all returned volumes; it does not require exactly two bars. It preserves the top-level `status` and, when present, the CLI-safe `error` object, including early `INPUT_INVALID` or `AUTH_STORAGE` failures that have no daily source metadata. A failed query can therefore produce `status: "error"`, empty `data` and a machine-readable `error.code`; this is not a successful empty query. Provider messages, bodies and secrets excluded by the CLI are not reconstructed. The public regression check runs that executable with synthetic CLI stdout and isolated configuration failures: `node --test tests/toss-agent-cli.test.mjs`.

The consumer exits 0 when it successfully consumes a query error; retain and interpret the original CLI exit code together with the JSON status and error. To inspect the same calculation directly, use a shell with `pipefail` so the upstream CLI exit remains observable:

```sh
set -o pipefail
node tests/toss-agent-cli.mjs success candles DEMO 1d date=2026-11-05 count=3 | node examples/candle-consumer.mjs
node tests/toss-agent-cli.mjs partial candles-batch DEMO,PARTIAL,EMPTY,INVALID,DENIED,LATER date=2026-11-05 count=3 | node examples/candle-consumer.mjs
```

The first query exits 0. Its newest source timestamp is `2026-11-04T23:00:00-06:00`, whose confirmed New York trade date is `2026-11-05`; the older trade date is `2026-11-04`. Closes `12.50` and `10.00` give a 25% change, and volumes `200` and `100` sum to 300. The example preserves the decimal strings and uses JavaScript numbers for this illustrative calculation; choose suitable precision for actual analysis. A zero latest close is valid; a zero base makes the percentage unavailable (`null`) while volume remains calculable.

The second pipeline exits 2, with `PERMISSION_DENIED` on stderr. `DEMO` succeeds; `PARTIAL` has the same usable calculation and a next page, which does not make the analysis fail or change its partial status. `EMPTY` is a usable empty partial page with count 0 and its next boundary. `INVALID` excludes an invalid bar and retains `invalid_item` plus `pagination_unknown`; its two valid bars still give 25% and 300. `DENIED` is an attempted error and `LATER` is unqueried; their summary counts are null and their existing error/reason explains why. The consumer forwards each actual summary, status, omissions, page and error/reason rather than rebuilding a batch schema or partial-reason list. An empty result has no calculation; the consumer does not choose a universal minimum bar count or follow additional pages.

Omit `date` to exercise unconfirmed market/timezone evidence: source timestamps remain available, but trade dates are null with `market_timezone_unconfirmed`. Never derive a US trade date by slicing the timestamp's date portion. The regression check also sends a missing `closePrice` through this same executable and requires failure. When changing the extraction logic, demonstrate that the regression fails for the broken mapping under the repository's negative-control procedure; an earlier validation does not verify a later revision. Synthetic success establishes this fixture and consumer path only, not live provider-schema agreement, live integration success or other agents' continued compliance. It authorizes no real queries or data transmission.

## Interpret query results

Read stdout as one JSON object and retain the process exit code even if it is nonzero. Interpret `version=1`, `status`, `data`, `omissions`, `page`, `source` and `error` together:

- `success` / exit 0 means this request completed. It does not establish live freshness, investment suitability or future availability.
- `partial` / exit 2 preserves usable data and identifies missing coverage. Empty `data` with `page.nextBefore` is not the last page. Request another page explicitly with the same symbol, interval, count and adjustment choice; copy the boundary without subtracting time. A null boundary ends pagination; inspect other omissions before treating the request as complete. Report unresolved coverage if the boundary is absent.
- `error` / exit 1 is a failed query, not evidence of no matching securities. Report the machine-readable error code. A permission failure requires checking access conditions; do not silently change providers, use KIS or start an authentication loop.

For `prices`, read each original `timestamp` with its query-time `priceAge` using [the response contract](toss-cli.md#응답-계약). An elapsed-time warning is not a provider-delay measurement or a reason to discard a valid price. Apply [report-time classification](#classify-prices-at-report-time) when writing the analysis.

Preserve decimal strings and distinguish null from zero and omission. Treat `retrievedAt` as retrieval time, not a provider update timestamp. US market rankings are not exchange-specific rankings. Tradable lists and rankings have no cursor; do not invent a page argument.

For paginated account queries, copy both `page.nextCursor` and `page.context` from the previous response. Keep the same account, command, group, period and filters; consult [the CLI reference](toss-cli.md) for which commands support pagination and which changes require a fresh first page. An empty page with more coverage outstanding remains partial. If the response indicates a next page but supplies no usable cursor, report the missing coverage instead of guessing a cursor or treating the history as complete. Keep live cursors and context out of shared evidence.

## Choose daily queries and follow-up pages

Use [the candle reference](toss-cli.md#일봉과-분봉) to select an inclusive US trade-date upper bound or a provider page boundary. Date selection verifies the market; it does not establish candle completion or finality. Do not infer a market from ticker spelling or a US trade date by slicing a timestamp's displayed date.

For several requested symbols, use [the sequential daily batch](toss-cli.md#순차-일봉-묶음). Keep its shared execution budget; do not split it into parallel processes to bypass limits. Inspect every item's status, data, omissions, page and error/reason, including usable empty pages and unqueried symbols. The reference owns the input limits, aggregate status, summary fields and stop policy.

Use each item's summary to assess the actual returned coverage, then decide whether it is sufficient for the requested analysis. Requested count and date are not returned count and date; a summary does not establish completion or analytical sufficiency. Choose only the needed follow-up pages, using individual `candles` queries with the exact `page.nextBefore` copied to `before`, no `date`, and the same count/adjustment. Do not rebuild the batch schema or duplicate its partial reasons in a new summary.

Preserve the query exit code and completed results when a batch stops. An item's `retrievedAt` for `not_queried` does not mean its data was fetched. Forced termination and process crashes have no recovery guarantee; save stdout only within approved storage scope. Synthetic checks establish their exercised path, not live provider or consumer validation, and authorize no real queries or data transmission.

## Classify prices at report time

State one explicit report timestamp, then recalculate elapsed time from each original `timestamp` to that report timestamp. Use that row's `priceAge.thresholdSeconds`, which carries the threshold selected for the query. Do not reuse the query-time `seconds` or `exceedsThreshold` as the report-time decision: a price can cross the threshold during analysis. Classify only a strict excess as a **reference price** and separate it from prices within the threshold; equality remains within the threshold. Show the source timestamp, report timestamp, recalculated seconds and applied threshold alongside the price.

Classify a missing, null or report-future source timestamp as a **timestamp-unknown price**, separately from a reference price. Preserve missing versus null and explain the unavailable reason. Never substitute `retrievedAt` for a source timestamp. Preserve the original response, including its `retrievedAt`, `priceAge`, decimal strings, omissions and source metadata. A price within the threshold still has no guarantee of realtime freshness, provider transport delay or a simultaneous snapshot. The agent owns report wording and classification; the CLI does not enforce report compliance.

Use [the executable consumer example](../examples/price-consumer.mjs) with the same code for synthetic and approved real inputs. It reads one usable `prices` CLI JSON response from stdin and requires an explicit report timestamp with an offset. For a synthetic exercise:

```sh
node tests/toss-agent-cli.mjs success prices DEMO | node examples/price-consumer.mjs 2026-11-06T15:45:00Z
node --test tests/price-consumer.test.mjs
```

The first command uses the runner's null source timestamp, so `report.prices[0].classification` is `timestamp_unknown`. The test command runs that same consumer with the actual CLI, isolated synthetic state, mocked HTTP and a substituted clock for threshold boundaries, elapsed analysis time, custom thresholds and unavailable timestamps. Inspect both process exit codes when invoking queries; consumer success does not replace the query's exit code or make partial coverage complete.

The example retains the complete input in `query` and puts the report timestamp in `report.asOf`. Each `report.prices` row retains the price and original `timestamp`, adds `classification` (`reference_price`, `timestamp_unknown` or `within_threshold`), and recalculates `priceAge` at `report.asOf`. Read `timestamp`, `report.asOf`, `priceAge.seconds` and `priceAge.thresholdSeconds` together. This is a consumption example, not a report generator; synthetic checks establish its observed behavior, not every external agent's compliance or live Toss response validity. Real queries and data transmission still require their existing authorization.

## Verify each consumer separately

In each actual consumer, ask the agent to read this document, discover the CLI, choose arguments for the normal market queries, follow the partial page and interpret the error. Record the consumer and execution host, commands, exit codes and its interpretation. A shell command run by Codex proves only that Codex path. A Node regression test proves the runner behavior, not that dots can discover or execute it.

If dots cannot read this checkout or run a local process, record the observed limitation and ask whether to connect dots to this computer or reconsider the CLI interface. Evaluate each new consumer connection from its own evidence; use [the synthetic validation record](toss-agent-validation.md) for the accepted #295 observations. Do not add a server or drop a consumer automatically.

## Extend to later commands

Keep `node scripts/toss.ts --help` as the discovery entry point and [the reference](toss-cli.md) as the argument, JSON, limit and error-contract authority. Keep workflow, consumer validation and report-time classification in this document. Add a command-specific section there when a new query is implemented. Add a synthetic response at the existing external HTTP boundary and a public CLI regression check when extending this exercise; keep live state and fixture state separate. The accepted first-tool-set consumer observations are recorded in [the live consumer record](toss-agent-live-validation.md).

## Real-data consumer exercise (#298)

The completed first-tool-set exercise is preserved in [the #298 record](toss-agent-live-validation.md), separating direct Codex execution from user-reported dots observations. Its one-time command sweep is not a routine query checklist. Use [the transition record](toss-transition.md) for legacy-path removal and residual limits.

For a new consumer, verify its own discovery, execution and interpretation path as described above. Confirm the approved account, query budget, and transmission/storage scope before real queries; existing acceptance does not authorize a new account, consumer environment or transmission scope. Use the existing approved launcher and state. Do not open credential or selection files, copy credentials, or create a new client; report an unavailable launcher and request the authorized connection route.

Keep financial JSON in the approved consumer context. Shared evidence may record consumer/host, revision, approved scope, safe command arguments, status/exit code, interpretation and limits, but must exclude raw responses, financial amounts, credentials, account identifiers and live cursors. Distinguish direct observations from user reports.
