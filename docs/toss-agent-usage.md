# Toss CLI instructions for local agents

Use these instructions in the repository root when choosing queries, interpreting results, or connecting a local agent, including Codex and OpenAI dots. Use [the CLI reference](toss-cli.md) as the authority for arguments, JSON fields, limits and errors. Discover the current command list with `node scripts/toss.ts --help`; it requires no authentication.

Actual Toss data, account access, credential setup and transmission to external models require the applicable [access conditions](toss-access-readiness.md) and task-specific authorization. Reuse existing authorization within its scope. Historical acceptance and synthetic exercises do not authorize new accounts, consumer environments or transmission/storage scope.

## Use the CLI for a user request

1. Identify the user's request and the approved scope for queries, account access and data transmission/storage. For real queries, locate the existing launcher approved for this consumer environment and use it for readiness and every query, including follow-up pages. If the launcher is unavailable, report the blocker and confirm the authorized connection route before proceeding.
2. Discover commands with `node scripts/toss.ts --help` and use the CLI reference to choose the queries and arguments needed for the request.
3. Before starting real queries, run `<approved-launcher> readiness` using the launcher from step 1. Inspect its JSON and exit code using [the readiness contract](toss-cli.md#로컬-조회-준비-점검). If blocked or unavailable, stop and report the reasons. For a transition requirement, use [the recovery handoff](auth-recovery.md). If ready, run only the selected queries through the same launcher and inspect their stdout JSON, exit codes, omissions and next-page information together.
4. If more data is needed, request additional queries or pages within the approved scope. Report unresolved gaps when the scope or query budget prevents further retrieval.
5. Use the returned data to write the analysis and recommendations, reflecting its coverage and limits. The agent owns query order and analysis; the CLI owns retrieval, validation, timestamps and error handling. The user decides and executes actual trades.

### Choose queries for the requested task

Use the following starting points, then choose only the queries needed to answer the request. A request does not require every command in its row. Use a verified provider symbol and resolve ambiguous identity with `stock` before combining data for a security.

For example, if NYSE and NASDAQ listings share the synthetic symbol `DEMO`, `stock DEMO NYSE US0000000010` selects the NYSE row for that lookup. `prices`, `orderbook`, `trades`, `candles` and each item in `candles-batch` identify the security by symbol alone. They receive neither the selected market nor the ISIN. The same limit applies to follow-up candle pages requested with `before`. When a symbol is shared, leave the result unattributed unless other evidence links it to the selected listing.

| User task | Query choices | Interpretation and stopping point |
| --- | --- | --- |
| Find securities for further research | `rankings`, `tradable`, then `stock` for selected symbols | Treat rankings as US market discovery data. Confirm security identity and type; a ranking or tradable entry alone does not establish suitability or current eligibility. |
| Review an additional purchase of a held security | Scoped `holdings`, relevant-currency `buying-power`, `stock`, `prices`, and needed market queries | Distinguish the existing position, cash buying power and market evidence. Report [price age at the report timestamp](#classify-prices-at-report-time) and unresolved trade constraints. |
| Compare daily price history for several symbols | `candles-batch`, then selected individual `candles` pages | Inspect each symbol's actual coverage. Follow only pages needed for the analysis, preserving partial and unqueried results. |
| Examine current market context | `orderbook`, `trades`, `sessions`, `constraints` as needed | Preserve provider order and timestamps. Recent trades are not a complete day; documented rules and sessions do not confirm per-symbol eligibility. |
| Review settled or pending account transactions | Period-bound `transactions` | Use settlement date/status and the provider's net amount. Keep this separate from order creation and current order state. |
| Review current general or conditional orders | `orders` or `conditional-orders` for the relevant group | Distinguish group selection from item status and order quantity from execution. Querying an order does not execute or change it. |

For account queries, use the existing approved selection and scopes. If the request needs an unapproved account or scope, report that prerequisite instead of changing selection or opening credential files. Keep arguments and response details in the approved consumer context; shared evidence should contain only the safe metadata described in [the real-data exercise](#real-data-consumer-exercise-298).

Continue with [result interpretation](#interpret-query-results), [daily coverage](#choose-daily-queries-and-follow-up-pages), and [report-time price classification](#classify-prices-at-report-time). For a swing report, also [check candidate earnings releases](#check-candidate-earnings-releases). Use [the synthetic exercise](#synthetic-connection-exercise) to verify a consumer path before approved real queries.

## Prepare a manual Toss app BUY or SELL draft

Use `node scripts/toss.ts order-draft INPUT_JSON_FILE` after the user and agent have agreed the proposed conditions. This offline command needs no readiness check, authentication or state directory. It reads the supplied JSON file without querying sessions, securities, accounts or order endpoints. Copy the selected `stock` result's `symbol`, `market` and available `isinCode` into draft `symbol`, `listingMarket` and `isinCode`; keep draft `market=US`. Keep ambiguity unresolved until the user selects the security. Apply the existing authorization and transmission rules when obtaining or passing any real query results.

Follow [the draft reference](toss-cli.md#오프라인-주문-초안) for the file size limit, input schema, complete synthetic BUY/SELL input/output and errors. Pass the existing `sessions` CLI response for the target New York trade date, `session=regularMarket`, an offset-bearing `expiresAt` no later than its open, `orderType=MARKET` and `currency=USD`. Supply exactly one positive decimal string: USD `amount` for `BUY`, or share `quantity` for `SELL`. Quantity BUY, amount SELL and LIMIT orders are unsupported. The draft does not establish the symbol's current eligibility or the app's reservation acceptance window.

Read stdout JSON and the process exit code together. Only `version=1`, `status=partial`, exit `2`, and a usable `data[0].draftVersion=1` form a draft for a review card. Require the selected `listingMarket` (`NYSE`, `NASDAQ`, `AMEX` or `US_ETC`) before displaying a card. Legacy inputs still return a draft, with `listingMarket=null` and its `not_verified` omission; withhold their cards until the selected listing is confirmed. Missing or null `isinCode` returns null: display a card only if the symbol and listing market distinguish the selected security, and label ISIN as unconfirmed. Never invent missing identity. Keep `appConditions=unknown` visible. On `error` / exit `1`, report its safe `error.code` and show no draft/card. Recheck expiry against the time of display; when it has been reached, withhold the card and request refreshed conditions/evidence as needed. Do not extend expiry past the regular open or describe a draft as submitted, reserved or executed.

The reference's synthetic response contains this `data[0]` at validation time `2026-11-06T14:00:00Z`:

```json
{
  "draftVersion": 1, "symbol": "DEMO", "market": "US", "listingMarket": "NASDAQ", "isinCode": "US0000000002",
  "side": "BUY", "orderType": "MARKET",
  "amount": "25.50", "currency": "USD", "tradeDate": "2026-11-06", "session": "regularMarket",
  "regularMarket": {"startTime": "2026-11-06T23:30:00+09:00", "endTime": "2026-11-07T06:00:00+09:00"},
  "expiresAt": "2026-11-06T09:30:00-05:00",
  "submission": {"route": "toss_app", "method": "manual", "workflow": "fractional_pre_market_reservation"},
  "appConditions": "unknown"
}
```

Map `symbol`, `market`, `listingMarket`, available `isinCode`, `side`, `orderType`, `currency`, `amount`, `tradeDate`, `session` and `expiresAt` to the same line. This synthetic BUY has a selected listing and known ISIN:

> DEMO (US / NASDAQ) · ISIN US0000000002 · 시장가 매수 USD 25.50 · 뉴욕 거래일 2026-11-06 정규장 · 초안 만료 2026-11-06T09:30:00-05:00 · 종목별 예약 조건 미확인 · 토스 앱에서 확인 후 직접 제출

For a share quantity SELL, the reference's synthetic response contains this `data[0]` at the same validation time:

```json
{
  "draftVersion": 1, "symbol": "DEMO", "market": "US", "listingMarket": "NYSE", "isinCode": null,
  "side": "SELL", "orderType": "MARKET",
  "quantity": "0.1250", "currency": "USD", "tradeDate": "2026-11-06", "session": "regularMarket",
  "regularMarket": {"startTime": "2026-11-06T23:30:00+09:00", "endTime": "2026-11-07T06:00:00+09:00"},
  "expiresAt": "2026-11-06T09:30:00-05:00",
  "submission": {"route": "toss_app", "method": "manual", "workflow": "fractional_pre_market_reservation"},
  "appConditions": "unknown"
}
```

Map `quantity` to shares, preserving its decimal spelling. `currency=USD` does not make the quantity a dollar amount. This synthetic SELL assumes `DEMO` and `NYSE` distinguish the selected security despite the unknown ISIN; otherwise withhold its card until identity is confirmed. The user must confirm the security and sellable quantity in the app. Display the same symbol, market, listing market, ISIN confirmation state, side, order type, trade date, session and expiry:

> DEMO (US / NYSE) · ISIN 미확인 · 시장가 매도 0.1250주 · 뉴욕 거래일 2026-11-06 정규장 · 초안 만료 2026-11-06T09:30:00-05:00 · 종목별 예약 조건 미확인 · 토스 앱에서 확인 후 직접 제출

Always retain `종목별 예약 조건 미확인 · 토스 앱에서 확인 후 직접 제출` on that line. The user searches for the security and manually enters, reviews and submits the fractional pre-market reservation in the Toss app. The CLI does not launch or control the app. If `referencePrice` is supplied, label its `price`, `currency` and `timestamp` as an observed reference, never an execution price. Keep account identifiers, credentials, tokens and raw real-order records out of draft inputs, cards and shared evidence.

`node --test tests/toss-order-draft.test.mjs` exercises the real CLI with synthetic JSON and a substituted clock, asserting safe JSON/diagnostics, exit codes and zero external HTTP attempts. It does not establish live app eligibility, reservation acceptance, execution or another agent's card compliance.

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
| `success` | `candles DEMO 1d date=2026-11-05 count=3` | Read two daily bars with a verified synthetic US listing market. |
| `partial` | `candles DEMO 1d date=2026-11-05 count=3` | Analyze two bars while preserving the remaining-page omission and exit 2. |
| `success` | `candles-batch DEMO,EMPTY count=3` | Distinguish two returned bars with unconfirmed trade dates from a successful empty page. |
| `partial` | `candles-batch DEMO,PARTIAL,EMPTY,INVALID,DENIED,LATER date=2026-11-05 count=3` | Read success, usable partial pages, invalid-item/pagination omissions, a permission error and an unqueried symbol with the actual CLI summaries. |
| `error` | `candles DEMO 1d` or `candles-batch DEMO,LATER` | Preserve the permission failure and, for the batch, the unqueried remainder. |
| `error` | `prices DEMO` | Receive a synthetic permission failure. |
| `transition-required` | `prices DEMO` | Receive a local legacy-state transition error without sending HTTP or changing existing protected files. |
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

### Exercise readiness before a query

These executable flows accept exactly `prices DEMO` and reuse the same isolated runner, actual CLI and HTTP mock:

```sh
node tests/toss-agent-cli.mjs readiness-success prices DEMO
node tests/toss-agent-cli.mjs readiness-transition prices DEMO
node tests/toss-agent-cli.mjs readiness-error prices DEMO
node tests/toss-agent-cli.mjs readiness-changed prices DEMO
```

`readiness-success` observes ready and retrieves the needed synthetic price (exit 0). `readiness-transition` observes blocked and returns that readiness JSON/error (exit 1) without attempting market or account queries. `readiness-error` observes ready, then preserves the price query's original permission error, empty data, safe provider details and exit 1. `readiness-changed` observes ready, then the fixture deliberately replaces its synthetic state with legacy state before the query; the real query rejects it with `AUTH_STATE_TRANSITION_REQUIRED` and exit 1, without HTTP. That fixture change is separate from the no-write readiness operation and is not an example of approved operational recovery.

Each invocation prints a clearly synthetic readiness/exit summary on stderr and forwards the final CLI stdout JSON, stderr and exit code unchanged. Inspect those boundaries together. The runner checks no HTTP during readiness, preserved existing protected files, and only the expected price HTTP when a query can proceed; failures trigger no follow-up market or account requests. Its fixtures and checks do not validate an actual consumer's behavior.

Readiness is an observation at one point in time. Concurrent processes can change state between the check and query; it is not an atomic snapshot, permission to skip query validators, or a guarantee of provider acceptance, account scope, data availability or later success. Missing/expired tokens can still be locally ready; normal queries retain their existing automatic issuance behavior. A query failure must retain its JSON, omissions, diagnostics and original exit code, even after readiness passed. Stop unchanged-state transition retries and report judgment deferred for insufficient data; a recommendation to wait requires separate investment evidence.

### Exercise a transition-required stop

Run `node tests/toss-agent-cli.mjs transition-required prices DEMO`. This scenario accepts exactly `prices DEMO`, seeds legacy reservation state and an existing token plus account selection from synthetic literals, then invokes the real query CLI once. Read stdout JSON (`version:1`, `status:"error"`, empty `data`, `error.code:"AUTH_STATE_TRANSITION_REQUIRED"`), stderr (`SYNTHETIC` and the CLI-safe error code), and exit 1 together. Empty data means retrieval failed, not that the security or portfolio is empty. No provider rejection was observed.

The runner asserts zero HTTP requests and compares the protected directory's final file list, file bytes, modification times and modes, plus directory mode, before forwarding the CLI output unchanged. An ordinary query briefly creates/removes its existing lock, so directory modification time is excluded; file access times may change on reads. This exercise does not establish the no-write behavior of a readiness command. Each invocation uses a fresh isolated fixture and removes it afterward; caller state is never used.

On this error, stop the query chain, including holdings and open-order follow-ups and scheduled retries against unchanged state. Follow [the recovery handoff](auth-recovery.md) and the authoritative [reservation recovery contract](toss-cli.md#예약-상태와-복구). Do not inspect or repair actual protected state without the required authorization, delete state, or issue a token to bypass the error. Report a symbol-specific judgment as deferred for insufficient data. A recommendation to wait needs investment evidence independent of the retrieval failure.

Example consumer report: “DEMO: judgment deferred because market data could not be retrieved (`AUTH_STATE_TRANSITION_REQUIRED`). Holdings and open orders were not queried after that failure. The error indicates a local reservation-state transition prerequisite; it does not establish provider authentication rejection. Recovery requires the executor, waiting-period and approval checks in the recovery guide. No investment recommendation follows from this failure alone.” Adapt this example to the actual results; do not claim account queries were skipped if they ran earlier.

The scenario reuses `fixture` and `runCli` in `tests/toss-cli-helper.mjs` and the external HTTP boundary in `tests/toss-http-mock.mjs`. Extend that boundary for future readiness exercises rather than injecting fabricated stdout or adding live credentials. Keep readiness assertions separate: a read-only check must also preserve directory modification time and must not create transient locks. This scenario and the consumer guide are synthetic/code coverage, not observations of Toss or dots and not proof that a consumer follows the guide.

### Check changed candle analysis before real queries

When creating analysis code or changing its field mapping, feed synthetic CLI stdout into the same code that will analyze the actual response, before making real queries. Repeat when that code changes, rather than before every real query. Keep independently chosen expected trade dates, `closePrice`, `volume` and calculation results; checking only extraction in a separate test implementation does not verify the analysis path. A field-mapping failure must stop the analysis. Do not fill a missing close with zero, silently use another field name or query Toss again to repair a code error.

The executable [candle consumer](../examples/candle-consumer.mjs) reads individual daily or batch stdout from stdin. For each usable nonempty result, it compares the first returned close with the last returned close and sums all returned volumes; it does not require exactly two bars. It preserves the top-level `status` and, when present, the CLI-safe `error` object, including early `INPUT_INVALID` or `AUTH_STORAGE` failures that have no daily source metadata. A failed query can therefore produce `status: "error"`, empty `data` and a machine-readable `error.code`; this is not a successful empty query. Provider messages, bodies and secrets excluded by the CLI are not reconstructed. The public regression check runs that executable with synthetic CLI stdout and isolated configuration failures: `node --test tests/toss-agent-cli.test.mjs`.

For an empty query error, the consumer validates the version, status, array data and error structure before forwarding the original safe error, even when the CLI removed the source endpoint to protect sensitive information. The error accepts only a nonempty string `code`, optional string `providerCode` and `requestId`, and optional `choices`. Each choice must contain exactly `symbol` and `market` strings plus `name` and `isinCode` strings or nulls. Unexpected error or choice fields are rejected; accepted details are forwarded unchanged. Only the exact redacted source `{ "provider": "tossinvest" }` bypasses the daily source check; missing or invalid sources and explicit non-candle endpoints or non-daily intervals are rejected. Usable candle results still require the daily candle endpoint and valid bar fields. Removed source metadata is not inferred or fetched again.

The consumer exits 0 when it successfully consumes a query error; retain and interpret the original CLI exit code together with the JSON status and error. To inspect the same calculation directly, use a shell with `pipefail` so the upstream CLI exit remains observable:

```sh
set -o pipefail
node tests/toss-agent-cli.mjs success candles DEMO 1d date=2026-11-05 count=3 | node examples/candle-consumer.mjs
node tests/toss-agent-cli.mjs partial candles-batch DEMO,PARTIAL,EMPTY,INVALID,DENIED,LATER date=2026-11-05 count=3 | node examples/candle-consumer.mjs
```

The first query exits 0. Its newest source timestamp is `2026-11-04T23:00:00-06:00`, whose confirmed New York trade date is `2026-11-05`; the older trade date is `2026-11-04`. Closes `12.50` and `10.00` give a 25% change, and volumes `200` and `100` sum to 300. The example preserves the decimal strings and uses JavaScript numbers for this illustrative calculation; choose suitable precision for actual analysis. A zero latest close is valid; a zero base makes the percentage unavailable (`null`) while volume remains calculable.

Each input bar requires a nonempty string `currency`, which the output bar retains unchanged. If the first and last close currencies differ, `analysis.closeChangePercent` is `null` and `analysis.closeChangeUnavailableReason` is `currency_mismatch`. The example does not convert currencies or fetch exchange rates; it preserves the valid bars, total volume and query coverage. Matching endpoint currencies keep the existing calculation, including a zero base returning `null`.

The second pipeline exits 2, with `PERMISSION_DENIED` on stderr. `DEMO` succeeds; `PARTIAL` has the same usable calculation and a next page, which does not make the analysis fail or change its partial status. `EMPTY` is a usable empty partial page with count 0 and its next boundary. `INVALID` excludes an invalid bar and retains `invalid_item` plus `pagination_unknown`; its two valid bars still give 25% and 300. `DENIED` is an attempted error and `LATER` is unqueried; their summary counts are null and their existing error/reason explains why. The consumer forwards each actual summary, status, omissions, page and error/reason rather than rebuilding a batch schema or partial-reason list. An empty result has no calculation; the consumer does not choose a universal minimum bar count or follow additional pages.

Omit `date` to exercise unconfirmed market/timezone evidence: source timestamps remain available, but trade dates are null with `market_timezone_unconfirmed`. Never derive a US trade date by slicing the timestamp's date portion. The regression check also sends a missing `closePrice` through this same executable and requires failure. When changing the extraction logic, demonstrate that the regression fails for the broken mapping under the repository's negative-control procedure; an earlier validation does not verify a later revision. Synthetic success establishes this fixture and consumer path only, not live provider-schema agreement, live integration success or other agents' continued compliance. It authorizes no real queries or data transmission.

## Interpret query results

Read stdout as one JSON object and retain the process exit code even if it is nonzero. Interpret `version=1`, `status`, `data`, `omissions`, `page`, `source` and `error` together:

- `success` / exit 0 means this request completed. It does not establish live freshness, investment suitability or future availability.
- `partial` / exit 2 preserves usable data and identifies missing coverage. Apply the [follow-up page rules](#follow-up-pages) before requesting another page. Inspect all omissions before treating the requested coverage as complete.
- `error` / exit 1 is a failed query, not evidence of no matching securities. Report the machine-readable error code. A permission failure requires checking access conditions; do not silently change providers, use KIS or start an authentication loop.

For `prices`, read each original `timestamp` with its query-time `priceAge` using [the response contract](toss-cli.md#응답-계약). An elapsed-time warning is not a provider-delay measurement or a reason to discard a valid price. Apply [report-time classification](#classify-prices-at-report-time) when writing the analysis.

Preserve decimal strings and distinguish null from zero and omission. Treat `retrievedAt` as retrieval time, not a provider update timestamp. US market rankings are not exchange-specific rankings. Tradable lists and rankings have no cursor; do not invent a page argument.

### Follow-up pages

Before following pages for transactions, closed regular orders, conditional orders or candles, set the coverage you need and a finite maximum number of additional page requests for the task. Exclude initial pages and count each follow-up request against that task limit, across symbols and queries. Start a new boundary history when query conditions change. The CLI also applies its own budget to each invocation.

- Track every boundary actually requested for the same query. Compare account cursors as exact strings within the same account, client, command, state, period and filters. For candles, compare instants using the offset and full fractional seconds, including differences smaller than a millisecond. Keep the same symbol, interval and adjustment choice. For date-based candles, record `source.before` as the first requested boundary. Track each batch item's candle boundaries separately.
- End pagination at account `hasNext=false` or candle `nextBefore=null`. If pagination is unknown or the next page lacks a usable boundary or required account context, stop and report unconfirmed coverage. Stop if the next boundary matches any previously requested boundary in that query. If the boundary is new, the task budget remains and you still need data, follow it even when the current page is empty. For account queries, copy `page.nextCursor` and its accompanying `page.context` exactly. For candles, pass the exact `page.nextBefore` as `before`, omit `date` and keep the same count and adjustment choice.
- Keep the valid data and omissions from pages already received. When stopping, report the coverage obtained and any requested coverage still unconfirmed, with the reason, such as a repeated boundary, exhausted budget or missing pagination information. Keep live cursors and context out of shared evidence.

See the [CLI reference examples](toss-cli.md#후속-페이지-조회) for a repeated cursor, equivalent candle instants written with different offsets, distinct instants less than a millisecond apart, and an empty page with a new cursor.

### Report holdings coverage

- Report **no holdings in the queried scope** only when `holdings` returns `success` with exit code 0 and an explicit, validated empty `data[0].items` array.
- For `partial`, report any usable holdings and their omissions. If only summary figures are usable, say the summary was read and the holdings list remains unconfirmed. This also applies when all rows were excluded and the returned array is empty.
- For a valid CLI error response, preserve its safe `error.code`, such as `RESPONSE_INVALID` or `PERMISSION_DENIED`, and mark holdings as unconfirmed. If the consumer cannot decode stdout as JSON or validate its structure as a CLI response, report **holdings response interpretation failed** and mark holdings as unconfirmed.

### Report holding review status

When the report already has a holdings response, show a **Holding review status** (`보유 종목 검토 상태`) section separate from the new-candidate ranking. Use only the data already received for the report. Include each confirmed holding in the queried scope, including holdings absent from the ranking. Apply the [holdings coverage rules](#report-holdings-coverage) to the section as a whole. For a partial holdings response, show the usable rows and identify the missing coverage. For an unconfirmed list, show the reason at section level.

- Mark **Review complete** (`검토 완료`) only after confirming that the daily bars belong to the holding, checking that their actual coverage meets the review's needs, and interpreting them for that holding. Give one line of evidence from the review. A partial candle result can support a completed review when its usable bars cover the required period. Preserve any relevant limits on the evidence.
- Mark **Judgment deferred: daily bars unconfirmed** (`일봉 미확인으로 판단 보류`) when usable daily bars cannot be confirmed for the holding. State the known reason, such as a missing query, an empty result, a query error, or ambiguous security identity.
- Mark **Judgment deferred: insufficient daily coverage** (`일봉 범위 부족으로 판단 보류`) when confirmed daily bars fall short of the period the review needs. State the coverage gap.

If the bars are sufficient and the review has yet to be performed, say that the holding is pending review.

Synthetic example with alternative outcomes for one holding. `DEMO` is absent from the new-candidate ranking. This example uses the November 4–5, 2026 US trade dates as its review window.

| Data already received | Holding review status |
| --- | --- |
| `holdings` is partial with one omitted row and a valid `DEMO` row. The partial daily result for `DEMO` contains both required dates. | Holdings list is partial. `DEMO` — **Review complete**. The returned close rose from USD 10.00 on November 4 to USD 12.50 on November 5. The page has an older continuation and candle finality is unconfirmed. |
| The holdings response confirms `DEMO`. There is no usable daily result for it. | `DEMO` — **Judgment deferred: daily bars unconfirmed**. |
| The holdings response confirms `DEMO`. Its usable daily result covers only November 5. | `DEMO` — **Judgment deferred: insufficient daily coverage**. The November 4 bar is missing. |
| `holdings` failed with `PERMISSION_DENIED`. | Holdings list unconfirmed (`PERMISSION_DENIED`). |

## Choose daily queries and follow-up pages

Use [the candle reference](toss-cli.md#일봉과-분봉) to select an inclusive US trade-date upper bound or a provider page boundary. For a date-based query, the CLI independently looks up each symbol and confirms a US listing market before requesting its candles. If that lookup finds multiple listings, it returns `IDENTITY_AMBIGUOUS` for the symbol even after a successful `stock` selection. A follow-up using `before` omits `date` and does not repeat the market check. Date selection does not establish candle completion or finality. Do not infer a market from ticker spelling or a US trade date by slicing a timestamp's displayed date.

For several requested symbols, use [the sequential daily batch](toss-cli.md#순차-일봉-묶음). Keep its shared execution budget; do not split it into parallel processes to bypass limits. Inspect every item's status, data, omissions, page and error/reason, including usable empty pages and unqueried symbols. The reference owns the input limits, aggregate status, summary fields and stop policy.

Use each item's summary to assess the actual returned coverage, then decide whether it is sufficient for the requested analysis. Requested count and date are not returned count and date; a summary does not establish completion or analytical sufficiency. Choose only the needed follow-up pages under the [follow-up page rules](#follow-up-pages), using individual `candles` queries. Do not rebuild the batch schema or duplicate its partial reasons in a new summary.

Preserve the query exit code and completed results when a batch stops. An item's `retrievedAt` for `not_queried` does not mean its data was fetched. Forced termination and process crashes have no recovery guarantee; save stdout only within approved storage scope. Synthetic checks establish their exercised path, not live provider or consumer validation, and authorize no real queries or data transmission.

## Classify prices at report time

Show the **retrieval time** and **provider-confirmed price session** separately. Label a US retrieval as **before the regular-session open** only when `retrievedAt` precedes the valid `regularMarket.startTime` returned by `sessions` for the retrieval's New York local date. If that opening time is unavailable, show the retrieval timestamp alone for this item. Report the price session only when the provider explicitly identifies it for that price. Keep the price session **unconfirmed** for current `prices` results with `source.session=unknown`, including when a prior-day price is retrieved before the next regular-session open. A calendar window and a price timestamp cannot establish the price's source session.

State one explicit report timestamp, then recalculate elapsed time from each original `timestamp` to that report timestamp. Use that row's `priceAge.thresholdSeconds`, which carries the threshold selected for the query. Do not reuse the query-time `seconds` or `exceedsThreshold` as the report-time decision: a price can cross the threshold during analysis. Classify only a strict excess as a **reference price** and separate it from prices within the threshold; equality remains within the threshold. Show the source timestamp, report timestamp, recalculated seconds and applied threshold alongside the price.

Classify a missing, null or report-future source timestamp as a **timestamp-unknown price**, separately from a reference price. Preserve missing versus null and explain the unavailable reason. Never substitute `retrievedAt` for a source timestamp. Preserve the original response, including its `retrievedAt`, `priceAge`, decimal strings, omissions and source metadata. A price within the threshold still has no guarantee of realtime freshness, provider transport delay or a simultaneous snapshot. The agent owns report wording and classification; the CLI does not enforce report compliance.

Use [the executable consumer example](../examples/price-consumer.mjs) with the same code for synthetic and approved real inputs. It reads one usable `prices` CLI JSON response from stdin and requires an explicit report timestamp with an offset. For a synthetic exercise:

```sh
node tests/toss-agent-cli.mjs success prices DEMO | node examples/price-consumer.mjs 2026-11-06T15:45:00Z
node --test tests/price-consumer.test.mjs
```

The first command uses the runner's null source timestamp, so `report.prices[0].classification` is `timestamp_unknown`. The test command runs that same consumer with the actual CLI, isolated synthetic state, mocked HTTP and a substituted clock for threshold boundaries, elapsed analysis time, custom thresholds and unavailable timestamps. Inspect both process exit codes when invoking queries; consumer success does not replace the query's exit code or make partial coverage complete.

The example retains the complete input in `query` and puts the report timestamp in `report.asOf`. Each `report.prices` row retains the price and original `timestamp`, adds `classification` (`reference_price`, `timestamp_unknown` or `within_threshold`), and recalculates `priceAge` at `report.asOf`. Read `timestamp`, `report.asOf`, `priceAge.seconds` and `priceAge.thresholdSeconds` together. This is a consumption example, not a report generator; synthetic checks establish its observed behavior, not every external agent's compliance or live Toss response validity. Real queries and data transmission still require their existing authorization.

## Check candidate earnings releases

For each selected US swing candidate, use the verified issuer's official investor relations (IR) calendar or announcement. Use the scheduled release of the results when the release and the earnings call have separate times. Follow an official notice that explicitly reschedules the release. If official sources disagree and you cannot establish which schedule applies, report `미확인` with the conflicting links and a short explanation.

Use the explicit report timestamp and the first regular session that opens strictly after it. Start with `sessions` for the report's New York date. Use `nextBusinessDay` when `today.regularMarket` is explicitly `null` or that session has already opened. End the window at the selected session's `regularMarket.endTime`, including an early close. Compare timestamps as instants using their offsets. The window includes both endpoints. If the next opening or its closing time cannot be established, report `미확인` and retain any verified IR release timing and link. Keep any usable market and account findings in the report.

Show one line per candidate with `구간 내 확인` if the release falls within the window, `구간 밖 확인` if the verified release falls outside it, or `미확인` if the timing or its relation to the window is unclear. Preserve the IR date and time zone or its published timing label and link to the official source. Use date-only or relative timing only when the entire range it allows falls inside or outside the window. For example, a date-only announcement on the closing day can straddle the close, and a before-open announcement can straddle the report timestamp. Leave either case `미확인` unless the IR notice provides enough detail. If no official source confirms a schedule, show `미확인` with the reason. Keep the candidate visible so the user can weigh the release timing alongside the price signal.

## Verify each consumer separately

In each actual consumer, ask the agent to read this document, discover the CLI, choose arguments for the normal market queries, follow the partial page and interpret the error. Record the consumer and execution host, commands, exit codes and its interpretation. A shell command run by Codex proves only that Codex path. A Node regression test proves the runner behavior, not that dots can discover or execute it.

If dots cannot read this checkout or run a local process, record the observed limitation and ask whether to connect dots to this computer or reconsider the CLI interface. Evaluate each new consumer connection from its own evidence; use [the synthetic validation record](toss-agent-validation.md) for the accepted #295 observations. Do not add a server or drop a consumer automatically.

## Extend to later commands

Keep `node scripts/toss.ts --help` as the discovery entry point and [the reference](toss-cli.md) as the argument, JSON, limit and error-contract authority. Keep workflow, consumer validation and report-time classification in this document. Add a command-specific section there when a new query is implemented. Add a synthetic response at the existing external HTTP boundary and a public CLI regression check when extending this exercise; keep live state and fixture state separate. The accepted first-tool-set consumer observations are recorded in [the live consumer record](toss-agent-live-validation.md).

## Real-data consumer exercise (#298)

The completed first-tool-set exercise is preserved in [the #298 record](toss-agent-live-validation.md), separating direct Codex execution from user-reported dots observations. Its one-time command sweep is not a routine query checklist. Use [the transition record](toss-transition.md) for legacy-path removal and residual limits.

For a new consumer, verify its own discovery, execution and interpretation path. Follow [the query procedure](#use-the-cli-for-a-user-request) and confirm the approved account, query budget, and transmission/storage scope before real queries. Do not open credential or selection files, copy credentials, or create a new client.

Keep financial JSON in the approved consumer context. Shared evidence may record consumer/host, revision, approved scope, safe command arguments, status/exit code, interpretation and limits, but must exclude raw responses, financial amounts, credentials, account identifiers and live cursors. Distinguish direct observations from user reports.
