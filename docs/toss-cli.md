# 토스 미국 종목 조회 JSON CLI

미국 시장 순위와 거래 가능 종목 목록을 조회하고, 토스 식별자로 종목 정보·현재가·호가·최근 체결·일봉·분봉을 확인하는 CLI입니다. [#278의 전환 명세](https://github.com/mochafreddo/stock-scout/issues/278)와 [#283의 확정 계약](https://github.com/mochafreddo/stock-scout/issues/283#issuecomment-6686267791)에 따라 외부 에이전트가 분석·추천을 맡고 CLI는 조회·검증·오류 처리를 맡습니다. 기존 KIS·내장 모델 명령은 전환 검증 전까지 유지합니다.

## 명령 발견과 실행

저장소 루트에서 실행하세요. Node 환경 준비는 [시작 안내](getting-started.md)를 따르세요.

```sh
node scripts/toss.ts --help
node scripts/toss.ts stock AAPL
node scripts/toss.ts prices AAPL
node scripts/toss.ts prices AAPL,MSFT
```

`--help`는 인증 없이 명령 목록을 JSON으로 출력합니다. `prices`는 공식 API의 `symbols` 식별자 1~200개를 쉼표로 받습니다. 각 식별자는 영문 대소문자·숫자·`.`·`-`만 허용하며 빈 항목과 추가 인수는 거부합니다. 티커 검색·시장 추정·KIS 식별자 변환은 수행하지 않습니다. 공급자가 확인한 식별자를 사용하세요. 미국 장중에도 실행할 수 있으며 증권 유형 관문을 두지 않습니다.

실제 토스 조회·인증 설정·자료의 외부 AI 전달은 아직 검증하거나 승인받지 않았습니다. [#284의 허용 범위 조사](https://github.com/mochafreddo/stock-scout/issues/284)에서 남은 조건을 확인하고 별도 승인을 받은 뒤에만 실제 자격 증명을 준비하세요. 원자료뿐 아니라 요약·가공 결과의 전달에도 같은 조건이 적용됩니다. 이 문서의 예시는 합성 자료입니다.

## 미국 시장 순위와 거래 가능 종목

```sh
node scripts/toss.ts rankings MARKET_TRADING_VOLUME realtime
node scripts/toss.ts rankings MARKET_TRADING_AMOUNT 1d 50
node scripts/toss.ts rankings TOP_GAINERS 1w
node scripts/toss.ts rankings TOP_LOSERS 1mo
node scripts/toss.ts tradable NASDAQ securityType=ETF
node scripts/toss.ts tradable NYSE status=ACTIVE commonShare=false
```

`rankings TYPE DURATION [COUNT]`는 미국 시장 전체를 집계한 순위를 한 번 조회합니다. 거래량·거래대금은 시장 체결 기준이며, 상승·하락은 기간 등락률 기준입니다. 기간은 `realtime`, `1d`, `1w`, `1mo`, `3mo`, `6mo`, `1y`이고, 상승·하락에는 `realtime`을 쓸 수 없습니다. 개수는 1~100이며 CLI 기본값은 20입니다. 공급자의 순서와 `rank`를 그대로 읽으세요. `source.rankedAt`은 집계 시각이고 `retrievedAt`은 CLI 조회 시각입니다. `price.changeRate`는 소수 비율입니다. 상승·하락에서는 기간 시작 가격, 거래량·거래대금에서는 전일 기준가와 비교합니다.

집계 자료가 없어 순위가 비었으면 정상 빈 결과입니다. 예를 들어 20개 요청에 17개를 받으면 종료 코드 2와 `fewer_than_requested`를 반환합니다. 공급자가 시세를 얻지 못해 제외한 종목이 있을 수 있습니다. `invalid_item`은 받은 행의 필수 값이 잘못됐다는 뜻이며, 사용할 수 있는 행이 하나도 남지 않으면 종료 코드 1입니다.

`tradable MARKET`은 NYSE·NASDAQ·AMEX·US_ETC 중 한 시장에서 토스증권으로 거래 가능한 종목을 조회합니다. `status`는 ACTIVE(기본값)·SCHEDULED·DELISTED 중 하나입니다. `securityType`은 아래 종목 정보 표의 아홉 유형 중 하나이며, `commonShare=true|false`로 보통주·우선주를 지정할 수 있습니다. 두 필터 모두 생략하면 해당 조건으로 제한하지 않습니다. `source`에는 적용한 시장과 필터가 담기며, 결과는 해당 조건의 목록입니다.

[공식 OpenAPI 1.2.28](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)에서 두 API 모두 페이지와 커서를 제공하지 않습니다. 부분 순위에서 조회 범위를 넓히려면 예를 들어 `node scripts/toss.ts rankings MARKET_TRADING_VOLUME realtime 50`으로 처음부터 다시 조회하세요. 이 명령은 새 집계 결과를 받을 수 있으므로 앞선 순위에 이어 붙이지 마세요. 거래 가능 종목은 필터에 맞는 목록 전체를 한 번에 받습니다. `node scripts/toss.ts tradable NASDAQ cursor=X`와 같은 후속 페이지 요청은 HTTP 호출 전에 `INPUT_INVALID`로 종료합니다.

## 호가와 최근 체결

```sh
node scripts/toss.ts orderbook AAPL
node scripts/toss.ts trades AAPL
node scripts/toss.ts trades BRK.B 10
```

`orderbook SYMBOL`은 매도·매수 호가와 잔량을 한 번 조회합니다. `trades SYMBOL [COUNT]`는 공급자가 제공하는 당일 최근 체결을 조회하며 개수는 1~50, 기본값은 50입니다. 두 명령 모두 공식 `symbol` 식별자 하나만 받으며, 쉼표로 여러 종목을 지정할 수 없습니다. `source.symbol`은 요청한 식별자입니다. 종목 정보나 유형을 먼저 조회하지 않습니다.

2026-11-07 KST에 다시 확인한 [공식 REST OpenAPI 1.2.28](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)의 계약은 다음과 같습니다. `SymbolQuery`는 KRX 종목 코드와 미국 티커를 지원하며 기존 명령과 같은 식별자 문자 제한을 적용합니다. 호가·체결은 `MARKET_DATA` 호출 제한 그룹입니다.

| 명령·필드 | 공식 계약과 CLI 처리 |
| --- | --- |
| `GET /api/v1/orderbook?symbol=...` | `result` 객체의 `currency`·`asks`·`bids`는 필수입니다. 정상 빈 호가는 두 배열이 비어 있는 객체로 반환합니다. 호가 단계 수·개수·페이지·기간 인수는 없으며 받은 단계를 자르지 않습니다. 공식 단계 수 상한은 미확인입니다. |
| 호가 `asks[]`·`bids[]` | 각 항목의 `price`·`volume`은 필수이며 null이 아닌 최대 30자 소수 문자열입니다. 가격과 잔량을 그대로 반환합니다. 문서 설명은 매도 낮은 가격순·매수 높은 가격순이지만 매도 예시는 그 설명과 다릅니다. CLI는 순서를 재정렬하거나 호가를 합치지 않습니다. |
| 호가 `timestamp` | 선택 필드이며 날짜·시각 문자열 또는 null입니다. 생략과 null을 그대로 구분하고, 값이 있으면 오프셋을 포함한 유효 시각인지 검사합니다. |
| `GET /api/v1/trades?symbol=...&count=...` | `result` 배열을 반환합니다. `count`는 최대 반환 건수이며 적게 받거나 비어 있어도 정상입니다. 요청 개수보다 많은 응답은 형식 오류로 처리합니다. 페이지·커서·과거 날짜 인수는 없으며 추가 자동 조회를 하지 않습니다. |
| 체결 `price`·`volume`·`timestamp`·`currency` | 네 필드 모두 필수이며 null·누락은 오류입니다. 가격·체결 수량은 최대 30자 소수 문자열, 체결 시각은 오프셋을 포함한 유효 시각입니다. 공급자 순서를 보존하고 값이 같은 체결도 삭제하지 않습니다. |
| 통화와 단위 | `currency`는 공식 KRW·USD 및 비어 있지 않은 문자열인 확장 코드를 보존합니다. 가격은 표시 통화의 증권 단위 가격(`source.priceUnit`), `volume`은 증권 수량(`source.volumeUnit`)입니다. 호가 잔량과 개별 체결 수량을 누적 거래량으로 해석하지 마세요. |

소수 문자열 `"0"`은 유효합니다. 가격·수량의 null·누락·숫자 자료형을 0으로 채우지 않습니다. 잘못된 호가 단계가 있으면 `omissions`에 `side`(asks 또는 bids)·0부터 시작하는 `index`·`reason="invalid_item"`을 남깁니다. 체결은 `index`와 같은 사유를 남깁니다. 유효 자료가 남으면 `partial`·종료 코드 2이며, 잘못된 항목만 남으면 `RESPONSE_INVALID`·종료 코드 1입니다. 호가의 필수 배열·통화가 잘못되면 전체 응답 오류입니다. 선택 시각만 잘못됐으면 시각을 제외하고 `omissions`에 `field="timestamp"`·`reason="invalid_timestamp"`를 표시한 부분 결과로 유효 호가를 보존합니다.

호가 결과의 `data`에는 통화·선택 시각·두 배열을 담은 객체 하나가 있고, 체결 결과의 `data`에는 체결 항목들이 있습니다. 예를 들어 합성 호가 결과는 `data=[{"currency":"USD","timestamp":null,"asks":[{"price":"185.7500","volume":"0.1250"}],"bids":[]}]`입니다. 합성 체결 항목은 `{"price":"185.7000","volume":"0.0125","timestamp":"2026-11-06T10:30:42.100-05:00","currency":"USD"}`입니다.

`source`는 공급자·엔드포인트·요청 심볼·단위와 미확인 최신성·세션·동일 시점 스냅샷을 표시합니다. 체결에는 요청 `count`와 `scope="provider_current_day_recent_trades"`도 있습니다. 당일의 날짜 경계·시간대, 세션별 포함 범위·지연·실시간성은 이 REST 스키마만으로 확인되지 않습니다. 호가의 생략되거나 null인 시각을 `retrievedAt`으로 채우지 않으며, 체결 시각이 없으면 해당 항목을 정상 자료로 사용하지 않습니다.

`node scripts/toss.ts trades AAPL cursor=X`나 `node scripts/toss.ts orderbook AAPL 10`은 HTTP 전에 `INPUT_INVALID`로 끝납니다. 공급자의 미지원 응답은 `UNSUPPORTED`, 권한·인증·호출 제한은 공통 오류 코드로 구분하세요. 체결 조회는 계좌의 개인 거래내역이 아닙니다. REST 한 번의 조회를 실시간 구독이나 전체 당일 체결 이력으로 해석하지 마세요. 주문 변경·계좌 조회·내장 판단 모델은 이 두 명령에 포함하지 않습니다.

## 일봉과 분봉

```sh
node scripts/toss.ts candles AAPL 1d
node scripts/toss.ts candles AAPL 1m count=200 adjusted=false
node scripts/toss.ts candles AAPL 1m count=100 adjusted=true before=2026-11-06T09:31:00.123+09:00
```

`candles SYMBOL INTERVAL [count=COUNT] [adjusted=true|false] [before=TIMESTAMP]`는 봉 한 페이지를 조회합니다. `INTERVAL`은 일봉 `1d` 또는 1분봉 `1m`이며 두 주기 모두 같은 선택 인수를 지원합니다. 개수는 1~200, 기본값은 100이고 수정주가 요청은 기본 `true`입니다. 선택 인수 순서는 자유롭지만 같은 인수의 반복은 거부합니다. `before`는 오프셋을 포함한 유효한 ISO 8601 시각이며 해당 시각을 포함하는 상한입니다. 생략하면 최신 봉부터 조회합니다. 공급자는 시작일·종료일·다른 봉 주기 인수를 제공하지 않습니다. `from=...`, `to=...`, `cursor=...`나 주봉 요청을 임의로 변환하지 않습니다.

2026-11-07 KST에 확인한 [공식 REST OpenAPI 1.2.28](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)의 엔드포인트는 `GET /api/v1/candles`이며 호출 제한 그룹은 `MARKET_DATA_CHART`입니다. [공식 FAQ](https://openapi.tossinvest.com/openapi-docs/faq.md)와 함께 다음 의미를 적용합니다. 표의 미국 세션 설명은 미국 종목에 해당하며 심볼의 시장·유형을 이 명령에서 별도로 확인하지 않습니다.

| 자료 | 의미와 출력 |
| --- | --- |
| 가격·거래량 | `timestamp`, `openPrice`, `highPrice`, `lowPrice`, `closePrice`, `volume`, `currency`는 필수이며 null을 허용하지 않습니다. 가격·거래량은 최대 30자 소수 문자열을 그대로 보존합니다. `"0"`은 유효하며 누락·null·숫자 자료형을 0으로 채우지 않습니다. 통화는 비어 있지 않은 확장 코드도 보존합니다. `source.priceUnit`은 통화별 증권 단위 가격, `volumeUnit`은 증권 수량입니다. |
| 일봉 시각 | 해당 거래일의 현지 자정입니다. FAQ의 미국 예시는 현지 자정을 한국 시각으로 표시하므로, 문자열의 날짜만 잘라 미국 거래일로 쓰지 마세요. 미국 거래일 구간은 뉴욕 시각 전일 20:00부터 당일 20:00까지입니다. 조회 시각·정규장 종료 시각과 구분하세요. |
| 미국 일봉 세션 | OHLC는 정규장 기준이며 프리·애프터·데이마켓 체결을 제외합니다. 거래량은 종합 거래량으로 시간외 체결이 포함될 수 있습니다. `source.usSessionSemantics`에서 두 범위를 구분합니다. |
| 분봉 시각·원천 | `timestamp`는 봉 종료 경계이며 `[timestamp - 1분, timestamp)`를 집계합니다. 미국 분봉은 일부 거래소 체결을 사용하고 거래가 없는 분의 봉을 만들지 않습니다. 구체적 원천·세션은 확정하지 않습니다. 일봉의 종합 거래량을 분봉 합계로 재구성하지 마세요. 미국 분봉은 2021-12-01 이후를 제공하며 일봉에는 이 기간 제한이 없습니다. |
| 수정주가 | `source.adjusted`에 요청 선택값을 표시합니다. 미국 수정주가는 가격과 거래량을 함께 조정하며 기준가와 직전 정규장 종가의 차이가 5%를 초과할 때 적용됩니다. 기업행위 종류를 구분하지 않아 모든 배당·분배락의 반영을 보장하지 않습니다. 제공 시작 이전 구간은 `adjusted=false`여도 이미 조정된 자료일 수 있으므로 `source.originalPricesGuaranteed=false`를 표시합니다. |
| 진행·완료 | 각 봉의 `inProgress`·`completion`은 `unknown`입니다. 응답에는 진행·완료 플래그와 공급자 현재 시각이 없고 이 명령은 일정을 추가 조회하지 않습니다. 로컬 시계보다 오래된 봉도 완료나 최종 확정으로 표시하지 않습니다. 현재 분의 봉도 포함될 수 있으며 미국 분봉은 늦게 보고된 체결로 과거 값이 바뀔 수 있습니다. `retrievedAt`은 조회 시각이며 자료 갱신 시각이 아닙니다. |

`data`는 공급자 최신순과 같은 시각의 항목을 그대로 보존합니다. 20개 완료 세션 관문이나 장중 실행 거부를 적용하지 않습니다. 잘못된 필수 필드를 가진 항목은 `invalid_item`으로 제외하고, 유효 봉이 남으면 부분 결과를 반환합니다. 받은 항목이 모두 잘못됐거나 필수 배열·페이지 경계가 잘못되면 `RESPONSE_INVALID`입니다. 요청보다 많은 봉, 최신순 위반, 요청 `before`를 넘는 봉도 형식 오류입니다. 알려지지 않은 응답 필드는 출력하지 않습니다.

`page.nextBefore`는 공급자의 다음 경계를 그대로 반환합니다. 값이 있으면 빈 페이지라도 `omissions=[{"reason":"next_page"}]`·`partial`·종료 코드 2입니다. 에이전트는 같은 심볼·주기·수정 선택으로 그 값을 다음 `before`에 그대로 넣으세요. 위 마지막 예시처럼 `+09:00`도 입력할 수 있으며 CLI가 `+`를 `%2B`로 인코딩합니다. 1밀리초를 빼거나 마지막 봉에서 경계를 새로 계산하지 마세요. 페이지 사이에 같은 봉이 나타나도 CLI는 임의로 제거하지 않습니다.

`nextBefore=null`이면 마지막 페이지이며, 요청 개수보다 적거나 비어 있어도 다른 누락이 없으면 성공입니다. 필드가 생략되면 `page={}`·`pagination_unknown`·종료 코드 2로 끝나며 마지막 페이지로 추정하지 않습니다. 추가 자동 조회는 하지 않습니다. 예를 들어 합성 응답이 `{"candles":[],"nextBefore":"2026-11-06T09:31:00.123+09:00"}`이면 빈 `data`와 그 경계를 반환하고, 에이전트가 같은 인수에 `before=2026-11-06T09:31:00.123+09:00`을 더해 후속 페이지를 요청합니다.

## 종목 식별과 선택

`stock SYMBOL [MARKET [ISIN]]`은 한 종목을 조회합니다. [공식 OpenAPI](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json) 1.2.28의 `GET /api/v1/stocks`는 쉼표로 구분한 심볼을 최대 200개 받습니다. 이 명령은 식별과 선택을 한 번에 한 심볼로 제한합니다. 공급자에 보내는 인수는 `symbols=SYMBOL` 하나입니다. 시장과 ISIN은 새로 받은 행에 적용하는 선택 조건입니다.

| 출력 | 해석 |
| --- | --- |
| `symbol`, `name`, `market` | 요청 심볼과 일치하는 행의 한글 종목명과 상장 시장입니다. 시장은 KOSPI·KOSDAQ·NYSE·NASDAQ·AMEX·KR_ETC·US_ETC이며 확장 코드도 원문으로 표시합니다. |
| `securityType` | STOCK·FOREIGN_STOCK·DEPOSITARY_RECEIPT·INFRASTRUCTURE_FUND·REIT·ETF·FOREIGN_ETF·ETN·STOCK_WARRANTS를 그대로 반환합니다. 빈 문자열 또는 해석할 수 없는 새 유형은 `null`, `partial`, `omissions[].reason="type_unknown"`으로 표시합니다. |
| `status` | 공급자의 상장 상태입니다. 공식 값은 SCHEDULED·ACTIVE·DELISTED이며 확장 코드도 원문으로 표시합니다. 거래 가능 여부와 구분하세요. |
| `isinCode` | 공식 필수 문자열입니다. 비어 있으면 CLI는 `null`을 반환합니다. 그 밖에는 국가 코드 두 글자, 영문 대문자·숫자 아홉 자리, 마지막 숫자 한 자리의 형식을 검사합니다. |
| `source`, `retrievedAt` | 출처는 `tossinvest`의 `/api/v1/stocks`입니다. 종목 정보에 공급자 갱신 시각이 없어 최신성은 `unknown`으로 표시합니다. `retrievedAt`는 CLI 조회 시각입니다. |

공식 `StockInfo`의 필수 필드는 위 여섯 필드와 `englishName`, `isCommonShare`, `currency`, `sharesOutstanding`입니다. 먼저 요청 심볼·시장·ISIN으로 식별할 수 있는 행을 선택지로 묶습니다. 서로 다른 선택지가 남으면 다른 필드가 잘못됐더라도 `IDENTITY_AMBIGUOUS`로 선택을 요청합니다. 선택지가 하나로 좁혀진 뒤 해당 행이 중복이거나 필수 값이 누락·null·잘못된 자료형이면 `RESPONSE_INVALID`입니다. 식별할 수 없는 행은 `invalid_item`으로 제외합니다. 제외 후 선택한 종목의 유효 자료가 남으면 종료 코드 2와 누락 사유를 확인하세요. 이 경우 심볼의 유일성을 확정할 수 없습니다. 제외한 행 때문에 선택 결과를 확인할 수 없으면 `RESPONSE_INVALID`, 정상 빈 배열 또는 유효한 응답에 선택 조건과 일치하는 종목이 없으면 `NOT_FOUND`입니다. 공급자 권한·통신 오류는 공통 오류 계약을 따릅니다.

### 같은 심볼에서 한 종목 고르기

다음은 합성 예시입니다. 실제 인증 없이 전체 흐름을 재현하려면 `node --test tests/toss-stock.test.mjs`를 실행하세요.

1. `node scripts/toss.ts stock DEMO`를 호출합니다. 같은 심볼로 서로 다른 증권이 두 개 반환되면 종료 코드 1, `error.code="IDENTITY_AMBIGUOUS"`, 빈 `data`와 다음과 같은 `error.choices`를 받습니다.

   ```json
   [
     {"symbol":"DEMO","name":"합성 ETN","market":"NYSE","isinCode":"US0000000010"},
     {"symbol":"DEMO","name":"합성 ETF","market":"NASDAQ","isinCode":"US0000000002"}
   ]
   ```

2. 사용자가 첫 번째 종목을 선택하면 `node scripts/toss.ts stock DEMO NYSE US0000000010`으로 다시 조회하세요. 이 예시의 결과 행은 `{"symbol":"DEMO","name":"합성 ETN","market":"NYSE","securityType":"ETN","status":"ACTIVE","isinCode":"US0000000010"}`입니다. 시장만으로 구별할 수 있으면 ISIN을 생략해도 됩니다. 같은 시장에서 ISIN이 없는 행은 마지막 인수로 `-`를 지정하세요. 같은 시장·ISIN의 중복 행은 하나의 선택지로 표시하되, 그 선택지를 다시 조회해도 중복이면 `RESPONSE_INVALID`입니다. 다른 시장·ISIN의 선택지는 독립적으로 조회할 수 있습니다. 선택지의 이름을 확인할 수 없으면 `name`이 `null`입니다.
3. 유형만 미확인이면 확인된 심볼로 `prices DEMO`를 독립적으로 요청할 수 있습니다. 여러 증권이 같은 심볼을 쓰면 `stock`에서 선택한 시장·ISIN이 `prices`로 전달되지 않습니다. 이 경우 심볼만으로 받은 가격을 선택한 증권의 가격이라고 단정하지 마세요.

## 보호된 설정과 공통 상태

승인된 저장소 밖의 단일 디렉터리를 `TOSS_STATE_DIR`로 지정하세요. 디렉터리는 현재 사용자 소유의 `0700`, 그 안의 `credentials.json`은 `0600`이어야 합니다. 파일 내용은 `clientId`와 `clientSecret` 문자열입니다. CLI 인수로 자격 증명을 전달하지 마세요. 경로에 심볼릭 링크가 있거나 Git 저장소 안에 있으면 거부합니다. CLI는 설정 파일을 만들거나 자격 증명을 발급하지 않습니다. 실제 경로·자격 증명을 이 문서에 기록하지 마세요.

같은 클라이언트를 사용하는 모든 로컬 실행은 같은 `TOSS_STATE_DIR`를 사용해야 합니다. 별도 디렉터리·다른 프로그램·다른 기기는 이 공통 제한에 포함되지 않습니다. 승인된 위치 외에 실제 자격 증명이나 토큰을 복사하지 마세요.

공통 모듈이 `state.json`·`client.lock`·`issuance.lock`의 쓰기를 소유합니다. 상태 파일에는 자격 증명 지문·토큰·만료 시각·다음 호출 가능 시각·발급 결과 미확인 표시만 저장합니다. 금융 응답은 별도 파일이나 로그에 기본 저장하지 않습니다. 토큰 만료는 발급 시작 시각과 공식 `expires_in` 초로 보수적으로 계산하며 KIS의 KST 해석·5분 제한을 사용하지 않습니다. 잠금 안에서 캐시를 다시 읽고 유효 토큰을 재사용하며, 토큰 발급에는 자동 재시도를 하지 않습니다.

발급 도중 통신·응답·저장 오류가 발생하면 `AUTH_ISSUANCE_UNKNOWN`으로 후속 자동 발급을 막습니다. 강제 종료로 남은 잠금은 자동으로 빼앗지 않고 전체 실행 한도까지 기다립니다. 복구 전 같은 디렉터리를 사용하는 프로세스가 모두 끝났는지 확인하고 공급자 발급 상태와 토큰 교체 영향을 점검하세요. 실행 중 상태·잠금을 삭제하거나 자격 증명 지문을 수동으로 고치지 마세요. 보관 위치나 자격 증명 변경과 미확인 발급의 재시도는 별도 승인·상태 확인 후 진행하세요.

## 응답 계약

2026-11-06 직접 확인한 [공식 OpenAPI](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)의 버전은 `1.2.28`입니다. `latest` 주소는 바뀔 수 있습니다. [공식 개요](https://openapi.tossinvest.com/openapi-docs/overview.md)의 오류와 호출 제한도 적용합니다. 문서 확인은 실제 응답 호환성 검증과 구분합니다.

`GET /api/v1/prices?symbols=...`의 성공 envelope은 `result` 배열입니다. 페이지가 없는 API이므로 임의 페이지·개수 자르기·후속 자동 조회를 추가하지 않습니다.

| 필드 | 공식 계약과 CLI 처리 |
| --- | --- |
| `symbol` | 필수 문자열. 요청한 식별자와 정확히 연결되는 유일한 행만 반환합니다. 요청 밖의 행과 중복 행은 제외합니다. |
| `lastPrice` | 필수 소수 문자열, 최대 30자. 숫자로 바꾸거나 반올림하지 않습니다. `0` 문자열은 유효하며 null·누락·숫자 자료형은 오류입니다. |
| `currency` | 필수 통화 문자열. 공식 값은 `KRW`·`USD`이며 공식 확장 지침에 따라 다른 세 자리 대문자 코드도 원문으로 반환합니다. 서로 다른 통화는 합산하지 않습니다. |
| `timestamp` | 선택 필드이며 문자열 또는 null입니다. 오프셋이 있는 유효한 날짜·시각 문자열을 검사하고 그대로 반환합니다. 생략과 null을 구분하며 조회 시각으로 채우지 않습니다. |

stdout에는 JSON 하나를 출력하고 stderr에는 원자료·자격 증명·공급자 메시지 없는 오류 코드만 출력합니다. 알려진 자격 증명·사용한 토큰이 결과에 나타나면 `SENSITIVE_OUTPUT`으로 자료 출력을 차단합니다. 공급자 추가 필드는 그대로 전달하지 않습니다.

```json
{
  "version": 1,
  "status": "success",
  "data": [{"symbol":"AAPL","lastPrice":"185.7000","currency":"USD","timestamp":null}],
  "omissions": [],
  "source": {
    "provider":"tossinvest",
    "endpoint":"/api/v1/prices",
    "freshness":"unknown",
    "session":"unknown",
    "snapshot":"unknown",
    "priceUnit":"currency_per_security"
  },
  "retrievedAt":"2026-11-06T15:00:00.000Z"
}
```

`retrievedAt`는 CLI가 결과를 만든 시각입니다. 각 행의 `timestamp`와 구분하세요. 가격은 표시한 통화 기준의 증권 단위 가격이며 세션별 원천·지연·실시간성·동일 시점 스냅샷은 미확인으로 둡니다. 완료 정규장의 종가나 주문 체결 보장 가격으로 해석하지 마세요.

| 상태·종료 코드 | 의미 |
| --- | --- |
| `success`·0 | 유효한 응답입니다. `prices`의 정상 빈 배열은 성공, `stock`의 정상 빈 배열은 `NOT_FOUND`입니다. |
| `partial`·2 | 유효 자료가 남지만 잘못된 행, 요청 종목 누락, 요청보다 짧은 순위, 종목 유형 미확인, 봉의 후속 페이지 또는 페이지 정보 미확인이 있습니다. `omissions`의 `reason`을 확인하세요. 특정 행이나 심볼에 해당하면 0부터 시작하는 `index` 또는 요청 `symbol`도 반환합니다. |
| `error`·1 | 입력·조회 실패 또는 유효 행이 없는 잘못된 응답입니다. `data`는 빈 배열이며 `error.code`로 원인을 구분합니다. |

오류 예시는 `{"version":1,"status":"error","data":[],"error":{"code":"PERMISSION_DENIED","providerCode":"ip-not-allowed","requestId":"SAFE_REQUEST_1"}}`입니다. 실제 출력에는 `source`와 `retrievedAt`도 포함됩니다. 안전한 형식의 공급자 오류 코드·요청 식별자만 보존하며 메시지·오류 상세 자료는 버립니다.

오류 코드는 `IDENTITY_AMBIGUOUS`, `INPUT_INVALID`, `AUTH_CONFIG`, `AUTH_STORAGE`, `AUTH_FAILED`, `AUTH_RESPONSE_INVALID`, `AUTH_ISSUANCE_UNKNOWN`, `PERMISSION_DENIED`, `NOT_FOUND`, `UNSUPPORTED`, `RESPONSE_INVALID`, `RATE_LIMIT`, `NETWORK_ERROR`, `UPSTREAM_ERROR`, `REQUEST_LIMIT`, `TIMEOUT`, `INTERRUPTED`, `SENSITIVE_OUTPUT`, `INTERNAL_ERROR`입니다. 인증·권한·미지원·한도 오류는 정상 빈 결과로 바꾸지 않습니다.

## 실행 한도와 재시도

실행 전체는 최대 60초·HTTP 전송 10회, 요청 하나는 응답 본문 수신까지 최대 15초입니다. 인증·재시도는 전송 수에, 잠금·간격·재시도 대기는 전체 시간에 포함하며 남은 시간보다 긴 대기는 시작하지 않습니다. 응답 본문은 최대 1 MiB로 제한합니다. SIGINT·SIGTERM은 안전한 중단 결과로 처리하고 소유한 잠금을 해제합니다. 강제 종료는 이 보장을 적용할 수 없습니다.

같은 디렉터리를 사용하는 프로세스는 인증과 조회를 합쳐 최소 1초 간격으로 전송을 예약합니다. `Retry-After`와 `X-RateLimit-Reset`의 초 값이 더 긴 대기를 요구하면 공통 상태에 반영합니다. 시간이 부족하면 종료합니다. 다른 실행에서 받은 제한도 이후 예약에 적용됩니다.

조회 중 `401 expired-token`에만 한 번 복구하며 다른 프로세스의 교체 토큰을 먼저 사용합니다. `invalid-token`·권한 오류는 재발급하지 않습니다. 일시 통신 오류·5xx·429에는 한 번 재시도합니다. 만료 복구와 일시 오류를 합쳐 조회는 최대 세 번 전송합니다. 현재가 한 번의 경로는 인증을 포함해 최대 다섯 번이므로 공통 HTTP 10회 상한에 먼저 도달하지 않습니다. 시간 초과·잘못된 성공 응답·토큰 발급의 불명확한 결과는 자동 반복하지 않습니다.

## 합성 검사와 후속 확장

```sh
node --test tests/toss.test.mjs tests/toss-stock.test.mjs tests/toss-discovery.test.mjs tests/toss-market.test.mjs tests/toss-candles.test.mjs
npm run typecheck
```

공개 검증 경계는 실제 CLI 인수·stdout JSON·stderr·종료 코드·외부 HTTP입니다. `tests/toss-cli-helper.mjs`의 `fixture`와 `runCli`는 보호된 합성 설정 및 하위 프로세스를 만들며, `tests/toss-http-mock.mjs`는 네트워크·시계만 대체합니다. 후속 티켓은 이 도우미에 HTTP 시나리오를 추가하고 명령별 소비자 출력을 검사하세요. 서로 독립적인 인증·시계 도우미를 다시 만들지 마세요. 실제 프로세스 경합 검사는 실제 시계를 사용합니다.

`scripts/toss.ts`가 명령 선택·입력·공통 응답 검증과 JSON 출력을 맡고, `scripts/toss-stock.ts`가 종목 정보의 검증과 선택을, `scripts/toss-market.ts`가 호가·체결 응답 검증을, `scripts/toss-candles.ts`가 봉 인수·응답·페이지 검증을 맡습니다. `scripts/toss-client.ts`의 `TossClient.get`이 읽기 전송·공통 인증·잠금·시간 및 호출 제한을 소유합니다. 후속 조회는 같은 클라이언트 인스턴스를 재사용하고 공통 상태에 직접 쓰지 마세요. 인증 외의 POST·주문 변경 경로는 추가하지 마세요. 페이지·계좌·추가 명령의 의미 계약은 각 티켓에서 공식 스키마와 대조하세요.

이번 검증은 합성 자료에 한정합니다. 실제 토스 조회, 실제 자격 증명 설정, 실제 자료 전달 허용, 공급자의 조회 전용 권한, Codex·Dot 각각의 연결과 전체 전환 완료는 별도 관문입니다. 기존 KIS·내장 모델 테스트는 기존 경로의 회귀 확인이며 새 토스 호환성의 근거가 아닙니다.
