# Toss CLI instructions for local agents

Use these instructions in the repository root. Use [the CLI reference](toss-cli.md) for command arguments and data meanings. Discover the current command list with `node scripts/toss.ts --help`; it requires no authentication. This document is intended for agents, including Codex and OpenAI dots.

## Use the CLI for a user request

1. Identify the user's request and the approved scope for queries, account access and data transmission/storage. Reuse existing authorization within that scope.
2. Discover commands with `node scripts/toss.ts --help` and use the CLI reference to choose the queries and arguments needed for the request.
3. Run the selected queries and inspect stdout JSON, exit codes, omissions and next-page information together.
4. If more data is needed, request additional queries or pages within the approved scope. Report unresolved gaps when the scope or query budget prevents further retrieval.
5. Use the returned data to write the analysis and recommendations, reflecting its coverage and limits. The agent owns query order and analysis; the CLI owns retrieval, validation, timestamps and error handling. The user decides and executes actual trades.

For example, when asked to review an additional purchase of a held security, choose the relevant holdings, buying-power and market queries for that request. Do not run every command automatically.

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

The executable [candle consumer](../examples/candle-consumer.mjs) reads either individual daily or batch stdout from stdin and performs a minimal two-point close return and volume sum. The public regression check runs that executable with synthetic CLI stdout: `node --test tests/toss-agent-cli.test.mjs`. To inspect the same calculation directly, use a shell with `pipefail` so the upstream CLI exit remains observable:

```sh
set -o pipefail
node tests/toss-agent-cli.mjs success candles DEMO 1d date=2026-11-05 count=3 | node examples/candle-consumer.mjs
node tests/toss-agent-cli.mjs partial candles-batch DEMO,PARTIAL,EMPTY,INVALID,DENIED,LATER date=2026-11-05 count=3 | node examples/candle-consumer.mjs
```

The first query exits 0. Its newest source timestamp is `2026-11-04T23:00:00-06:00`, whose confirmed New York trade date is `2026-11-05`; the older trade date is `2026-11-04`. Closes `12.50` and `10.00` give a 25% change, and volumes `200` and `100` sum to 300. The example preserves the decimal strings and uses JavaScript numbers for this illustrative calculation; choose suitable precision for actual analysis. A zero latest close is valid; a zero base makes the percentage unavailable (`null`) while volume remains calculable.

The second pipeline exits 2, with `PERMISSION_DENIED` on stderr. `DEMO` succeeds; `PARTIAL` has the same usable calculation and a next page, which does not make the analysis fail or change its partial status. `EMPTY` is a usable empty partial page with count 0 and its next boundary. `INVALID` excludes an invalid bar and retains `invalid_item` plus `pagination_unknown`; its two valid bars still give 25% and 300. `DENIED` is an attempted error and `LATER` is unqueried; their summary counts are null and their existing error/reason explains why. The consumer forwards each actual summary, status, omissions, page and error/reason rather than rebuilding a batch schema or partial-reason list. An empty result has no calculation; the consumer does not choose a universal minimum bar count or follow additional pages.

Omit `date` to exercise unconfirmed market/timezone evidence: source timestamps remain available, but trade dates are null with `market_timezone_unconfirmed`. Never derive a US trade date by slicing the timestamp's date portion. The regression check also sends a missing `closePrice` through this same executable and requires failure; the implementation's extraction mutation from `closePrice` to `close` is checked as a negative control before delivery. Synthetic success establishes this fixture and consumer path only, not live provider-schema agreement, live integration success or other agents' continued compliance. It authorizes no real queries or data transmission.

Read stdout as one JSON object and retain the process exit code even if it is nonzero. Interpret `version=1`, `status`, `data`, `omissions`, `page`, `source` and `error` together:

- `success` / exit 0 means this request completed. It does not establish live freshness, investment suitability or future availability.
- `partial` / exit 2 preserves usable data and identifies missing coverage. Empty `data` with `page.nextBefore` is not the last page. Request another page explicitly with the same symbol, interval, count and adjustment choice; copy the boundary without subtracting time. A null boundary ends pagination; inspect other omissions before treating the request as complete. Report unresolved coverage if the boundary is absent.
- `error` / exit 1 is a failed query, not evidence of no matching securities. Report the machine-readable error code. A permission failure requires checking access conditions; do not silently change providers, use KIS or start an authentication loop.

For `prices`, inspect each row's `priceAge` together with its original `timestamp`. `seconds` measures elapsed time to that response's `retrievedAt`, not provider transport delay. The default `thresholdSeconds` is 900; use `staleAfterSeconds=SECONDS` to choose a nonnegative safe integer threshold for this invocation. `exceedsThreshold` is true only above the threshold, false at equality or below, and null when age is unavailable. `unavailableReason` distinguishes `timestamp_missing`, `timestamp_null` and `timestamp_future`; missing and null source timestamps remain distinct. Warnings and unavailable ages retain valid prices and do not themselves make a result partial. A false warning does not establish realtime freshness, provider delay or a simultaneous snapshot.

Preserve decimal strings and distinguish null from zero and omission. Treat `retrievedAt` as retrieval time, not a provider update timestamp. US market rankings are not exchange-specific rankings. Tradable lists and rankings have no cursor; do not invent a page argument. Read the candle page contract in the reference before choosing follow-up arguments.

For a chosen US daily trade-date upper bound, use `candles SYMBOL 1d date=YYYY-MM-DD`. The selected New York date is inclusive; the CLI converts its local midnight with the applicable offset and verifies the provider stock identity and US market before fetching one candle page. Do not infer the market from ticker spelling. Ambiguous, malformed or unconfirmed identities stop the candle query. A holiday selects available bars on or before that date. Omitting `date` retains the existing latest-page flow without a stock lookup. Do not combine `date` with `before` or use it for minute bars; these inputs fail before HTTP. For continuation, omit `date` and copy `page.nextBefore` exactly into `before`, preserving count and adjustment choice. Date selection does not establish completion or finality: `completion` and `inProgress` stay `unknown`, and the daily OHLC versus consolidated-volume session distinction remains. Market verification, authentication, retries and waits share the existing single-query 60-second / 10-HTTP budget.

For an explicit sequential daily batch, use `candles-batch AAPL,MSFT,BRK.B [count=COUNT] [adjusted=true|false] [before=TIMESTAMP | date=YYYY-MM-DD]`. It accepts 1–20 symbols and preserves requested spelling and order; duplicate symbols including case variants, malformed symbols and invalid shared options fail before authentication or HTTP. The interval is always `1d`; count remains 1–200/default 100 and adjustment defaults to true. Date-selected market verification and the inclusive New York boundary use the same contract as individual daily queries. Without a date, no market lookup is added. Each symbol gets one page, with no replenishment, automatic pagination or completion inference.

The entire batch uses one client and one maximum 120-second / 40-HTTP-transmission budget, including market checks, authentication and retries. Locks, shared spacing and retry waits consume the same time budget. Individual HTTP requests remain bounded by 15 seconds or the remaining overall time, whichever is shorter; cross-process minimum one-second spacing and stricter provider waits still apply. These are execution limits, not a completion-time or all-symbols guarantee. Existing single commands retain their 60-second / 10-HTTP limits. Do not split a batch into parallel processes to bypass those limits.

Read the batch's single versioned stdout JSON as ordered per-symbol outcomes in `data`. Each item has `symbol`, `status`, `data`, `source` and `retrievedAt`. Successful/partial outcomes retain `omissions` and `page`; failed attempted queries retain `error`. Unstarted symbols have `status=not_queried`, empty data and a `reason` stop code. Inspect each item rather than only top-level omissions. All-success yields success/exit 0; any usable success/partial outcome combined with partial/error/unqueried outcomes yields partial/exit 2; no usable outcome yields error/exit 1 with nested errors retained in `data`. A valid empty success page or empty partial page with a continuation is usable, while a failed query is not an empty success. Input or initial configuration errors retain the ordinary top-level error form.

For each batch item, read `summary.returnedCount` as the number of validated returned candles, not requested count. `latestTimestamp` retains the latest returned candle's original source timestamp. `latestTradeDate` is that candle's New York calendar date only when the existing date-selected lookup confirmed the US market and timezone; it is not the requested upper-bound date. Without that evidence on a nonempty page, the date is null and `tradeDateUnavailableReason=market_timezone_unconfirmed`; do not infer a market from the symbol or slice a Korean display date. Summary calculation adds no market lookup or page request. Empty success and valid empty partial pages have count 0 and both latest values null. Error and not_queried items have all three values null; inspect their existing `error` or `reason`. The unavailable-date reason is null outside the nonempty unconfirmed case.

Keep partial reasons in the item's existing `omissions` (`next_page`, `pagination_unknown`, `invalid_item`) and inspect `page` alongside them. A synthetic page with two valid candles and an excluded invalid item has count 2; a continuation still requires partial/exit 2 even if those candles suffice for the analysis. Decide sufficiency and follow-up pages yourself. Summary values do not establish completion or finality, and candle `completion`/`inProgress` remain unknown. The individual `candles` command does not gain this summary contract.

Individual not-found, malformed response, exhausted transient retries or a 15-second request timeout can leave later symbols queryable within the shared budget. Authentication issuance/recovery failures and confirmed authentication, permission or IP restrictions stop later queries. Retry-After applies to subsequent symbols too; if the required wait cannot fit, no further HTTP is sent. Handled SIGINT/SIGTERM and budget stops preserve completed outcomes, distinguish the current attempted error from remaining unqueried symbols, and release owned locks. A per-item timestamp records when that outcome was recorded; a not_queried timestamp is not a data retrieval time. Additional pages must be individual `candles SYMBOL 1d` queries with that item's exact `page.nextBefore` copied to `before`, no `date`, and the same count/adjustment. No automatic financial-data files or disk resume state are created. Forced termination and process crashes have no recovery guarantee; save stdout explicitly only within approved storage scope. Existing masking, safe stderr codes and unknown freshness/completion remain applicable. Synthetic checks do not establish live provider or consumer validation or authorize new real queries/data transmission.

## Classify prices at report time

State one explicit report timestamp, then recalculate elapsed time from each original `timestamp` to that report timestamp. Use that row's `priceAge.thresholdSeconds`, which carries the threshold selected for the query (default 900 seconds). Do not reuse the query-time `seconds` or `exceedsThreshold` as the report-time decision: a price can cross the threshold during analysis. Classify only a strict excess as a **reference price** and separate it from prices within the threshold; equality remains within the threshold. Show the source timestamp, report timestamp, recalculated seconds and applied threshold alongside the price.

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

Keep `node scripts/toss.ts --help` as the discovery entry point and [the reference](toss-cli.md) as the argument and interpretation authority. Add a command-specific section there when a new query is implemented. Add a synthetic response at the existing external HTTP boundary and a public CLI regression check when extending this exercise; keep live state and fixture state separate. The accepted first-tool-set consumer observations are recorded in [the live consumer record](toss-agent-live-validation.md).

Actual Toss data, account access, credential setup and transmission to external models require the applicable [access conditions](toss-access-readiness.md) and task-specific authorization. Synthetic connection success does not establish any of them.

## Real-data consumer exercise (#298)

Run this exercise independently in Codex and dots after the user approves that consumer's real queries and transmission/storage scope. Use the existing approved launcher and state; do not open credential or selection files, copy credentials, or create a new client. If the launcher is unavailable in a consumer, report the limitation and request the authorized connection route.

1. Read this document and the CLI reference, then discover commands with `node scripts/toss.ts --help`. Run the synthetic rows above, following both the candle boundary and account cursor/context. Interpret permission errors and partial results explicitly. Exit 2 is usable partial data, not a reason to retry authentication.
2. Within the approved query budget, use the approved launcher for `stock`, `prices`, all four ranking types, `tradable`, `orderbook`, `trades`, daily/minute `candles`, `sessions` and `constraints`. Use a verified provider symbol and explicit dates. Link the observed data meanings and limits to [market validation](toss-market-validation.md); a new full provider-validation sweep is not required.
3. Use `holdings`, USD/KRW `buying-power`, period-bound `transactions`, and OPEN/CLOSED `orders` and `conditional-orders`. Keep the selected account and scopes. Link meanings and unobserved samples to [account validation](toss-account-validation.md). Use actual next pages only within the approved budget; synthetic pagination already covers consumer error/continuation handling.
4. Interpret the usable financial fields in that consumer: distinguish cash buying power, valuation and cost, settlement date/status, order creation and execution, and group versus item status. Preserve decimal strings, null, zero and missing fields. Do not infer eligibility, freshness, a complete history or an investment recommendation from a successful query.
5. Record consumer/host, time, code revision, approved scope, command arguments without account identifiers or live cursors, status/exit code, interpretation and limits. Keep financial JSON in the approved consumer context only; do not copy raw responses, financial amounts, credentials, account identifiers or live cursors into shared evidence. Record user-reported dots observations separately from directly observed Codex results.

Use [the #298 record](toss-agent-live-validation.md) for accepted consumer observations, separating direct Codex execution from user-reported dots execution. Use [the transition record](toss-transition.md) for legacy-path removal and residual limits. Existing acceptance does not authorize a new account, consumer environment or data-transmission scope.
