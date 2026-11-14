# 토스 미국 종목 조회 JSON CLI

미국 시장 순위와 거래 가능 종목 목록을 조회하고, 토스 식별자로 종목 정보·현재가·호가·최근 체결·일봉·분봉과 미국 세션·거래 제약을 확인하는 CLI입니다. [#278의 전환 명세](https://github.com/mochafreddo/stock-scout/issues/278)와 [#283의 확정 계약](https://github.com/mochafreddo/stock-scout/issues/283#issuecomment-6686267791)에 따라 외부 에이전트가 분석·추천을 맡고 CLI는 조회·검증·오류 처리를 맡습니다. 기존 KIS·내장 모델 명령은 제거했으며 [전환 기록](toss-transition.md)에 대체 관계와 한계를 남겼습니다.

## 명령 발견과 실행

Codex와 dots에서 합성 자료로 연결을 확인하려면 [에이전트 사용 지침](toss-agent-usage.md)을 읽고 같은 CLI 경로를 사용하세요. 정상·부분 결과·오류의 [환경별 검증 기록](toss-agent-validation.md)은 실제 토스 조회와 구분합니다.

저장소 루트에서 실행하세요. Node 환경 준비는 [시작 안내](getting-started.md)를 따르세요.

```sh
node scripts/toss.ts --help
node scripts/toss.ts stock AAPL
node scripts/toss.ts prices AAPL
node scripts/toss.ts prices AAPL,MSFT
node scripts/toss.ts prices AAPL,MSFT staleAfterSeconds=300
```

`--help`는 인증 없이 명령 목록을 JSON으로 출력합니다. `prices`는 공식 API의 `symbols` 식별자 1~200개를 쉼표로 받습니다. 각 식별자는 영문 대소문자·숫자·`.`·`-`만 허용하며 빈 항목과 정의되지 않은 추가 인수는 거부합니다. 티커 검색·시장 추정·KIS 식별자 변환은 수행하지 않습니다. 공급자가 확인한 식별자를 사용하세요. 미국 장중에도 실행할 수 있으며 증권 유형 관문을 두지 않습니다.

[실자료 허용·조회 권한과 접근 준비](toss-access-readiness.md)에서 [#284의 조사](https://github.com/mochafreddo/stock-scout/issues/284) 이후의 사용자 재결정, 제한된 실제 연결 결과와 남은 미확인을 확인하세요. 새 연결이나 범위 변경에는 해당 작업의 별도 승인이 필요합니다. 원자료뿐 아니라 요약·가공 결과의 전달에도 승인 범위가 적용됩니다. 이 문서의 예시는 합성 자료입니다.

## 기본 계좌와 보유·매수 가능 금액

```sh
node scripts/toss.ts account-select /absolute/path/to/protected-selection.json
node scripts/toss.ts holdings
node scripts/toss.ts holdings AAPL
node scripts/toss.ts buying-power USD
node scripts/toss.ts buying-power KRW
```

`account-select FILE`은 사용자가 명시적으로 선택한 계좌 하나와 허용 범위를 저장합니다. 입력 파일은 소유자만 읽고 쓸 수 있는 일반 JSON 파일(0600)이어야 하며 심볼릭 링크는 거부합니다. 다음은 합성 선택 자료입니다. 실제 파일은 저장소·동기화 폴더 밖의 승인된 위치에서 준비하고 계좌 식별자를 명령 인수나 대화에 직접 넣지 마세요.

```json
{"alias":"primary","accountSeq":741,"scopes":["holdings","buying-power"]}
```

`alias`는 소문자 영문으로 시작하는 소문자·하이픈 1~40자입니다. 계좌번호나 키를 별칭으로 쓰지 마세요. `accountSeq`는 공식 계좌 목록의 int64 식별자(`-9223372036854775808`~`9223372036854775807`)이며 임의 순번이 아닙니다. JSON 정수 또는 같은 숫자의 문자열을 받으며, 큰 식별자는 문자열로 준비하세요. HTTP 헤더까지 숫자 자릿수를 그대로 보존합니다. `scopes`에는 `holdings`·`buying-power`·`transactions`·`orders`·`conditional-orders` 중 허용할 조회만 중복 없이 넣습니다. 적어도 하나가 필요합니다. `account-select`는 HTTP 없이 선택을 저장하며 계좌 존재 확인은 다음 조회에서 수행합니다. 별칭·계좌·범위를 바꾸려면 선택 파일을 명시적으로 수정한 뒤 같은 명령을 다시 실행하세요. 기존 선택 하나를 원자적으로 교체합니다.

선택 정보는 기존 `TOSS_STATE_DIR`의 보호된 `account.json`에 계좌 식별자·별칭·허용 범위·클라이언트 지문으로 저장됩니다. 실제 인증 설정이나 보관 위치를 새로 승인하는 명령은 아닙니다. 입력 파일과 `account.json`은 에이전트에 전달하지 마세요. 실제 계좌 연결은 공급자 조회 전용 권한을 확인하거나 사용자가 그 제한을 명시적으로 수용한 뒤 진행합니다. 어느 경우든 자료 전달 허용과 별도 접근 승인은 필요합니다. 조회 전용 권한이 없거나 미확인이고 사용자의 명시적 제한 수용도 없으면 연결을 보류합니다. [접근 준비의 재개 조건](toss-access-readiness.md)을 확인하세요.

조회는 선택 정보를 읽고 범위를 검사한 다음 `GET /api/v1/accounts`로 선택 계좌가 현재 목록에 유일하게 존재하는지 확인합니다. 계좌 목록의 필수 필드가 잘못됐거나 선택 키가 중복됐으면 `RESPONSE_INVALID`로 중단합니다. 선택 계좌의 `accountSeq`는 해당 조회의 `X-Tossinvest-Account` 헤더에만 넣고 계좌 목록은 출력하지 않습니다. 첫 계좌를 자동 선택하지 않으며 계좌가 없어졌거나 선택 파일이 없거나 잘못됐거나 클라이언트 자격 증명이 달라졌으면 `ACCOUNT_SELECTION_REQUIRED`로 중단합니다. 범위 밖 조회는 HTTP 전에 `ACCOUNT_SCOPE_DENIED`로 중단합니다. 유효한 선택과 범위는 다음 실행에서도 재사용하며 조회마다 재승인을 요구하지 않습니다. 사용자가 직접 제공한 자료도 판단에 사용할 수 있지만, 자동 조회를 수동 입력으로만 대체하도록 강제하지 않습니다. 실제 자료의 수동 전달에도 동일한 외부 전달 허용 조건이 적용됩니다.

2026-11-07 KST에 확인한 [공식 OpenAPI 1.2.28](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)의 계좌 계약을 적용합니다.

| 명령 | 공식 범위와 결과 |
| --- | --- |
| `holdings [SYMBOL]` | `GET /api/v1/holdings`의 국내(KR)·미국(US) 주식이며 해외 옵션·채권은 제외합니다. 심볼을 생략하면 전체 보유, 지정하면 해당 종목과 그 종목 기준 요약입니다. `data[0].items`에 종목·이름·시장 국가·통화·수량·현재가·평균매수가·평가금액·손익·일간 손익·비용을 반환합니다. |
| 보유 요약 | `totalPurchaseAmount`, `marketValue`, `profitLoss`, `dailyProfitLoss`를 공급자 값 그대로 반환합니다. `krw`는 KRW 종목의 합, `usd`는 USD 종목의 합입니다. 통화 간 합산이나 환산을 하지 않습니다. 공급자의 전체 손익률은 현재 환율로 원화 환산한 비율이며 CLI가 계산한 값이 아닙니다. |
| 소수·선택 필드 | 금액·가격·수량·비율은 최대 30자 소수 문자열로 보존합니다. 필수 값의 null·누락·숫자형은 거부합니다. 요약의 `usd`와 종목 비용의 `tax`는 선택 필드이며 생략·null·소수 문자열을 구분합니다. `"0"`을 빈 값으로 취급하지 않습니다. 손익률은 소수 비율입니다. |
| `buying-power CURRENCY` | `GET /api/v1/buying-power?currency=...`의 `currency`·`cashBuyingPower`를 반환합니다. 미수거래를 제외한 현금 기반 매수 가능 금액이며 총 현금·출금 가능 금액이 아닙니다. KRW는 원, USD는 달러 단위입니다. 통화를 합산하지 않습니다. 요청은 대문자 세 자리 코드이며 확장 코드는 공급자가 지원 여부를 판단합니다. 응답 통화는 요청과 일치해야 합니다. |

두 조회 모두 전체 반환 API이며 페이지·커서·개수 인수가 없습니다. 계좌나 심볼을 바꿀 때도 새 조회로 실행하고 이전 결과를 이어 붙이지 마세요. 정상 빈 보유는 `items=[]`와 공급자 요약을 반환합니다. 잘못된 항목은 제외하고 `omissions.index`·`invalid_item`을 남기며 유효 항목이 있으면 부분 결과입니다. 모든 항목이 잘못됐더라도 유효한 요약이 남으면 요약과 항목별 누락 사유를 부분 결과로 반환합니다. 잘못된 요약 필드는 제외하고 `omissions.field`·`invalid_summary`를 남깁니다. `items`가 누락되거나 배열이 아니면 해당 필드를 제외하고 `invalid_items`와 필드 경로를 표시하며 유효한 요약을 보존합니다. 이를 정상 빈 보유로 해석하지 마세요. 요약과 항목 모두 사용할 수 없으면 오류입니다. 사용 가능한 요약도 전체 조회 범위를 나타내므로 일부 항목이 제외된 경우 남은 항목의 합으로 해석하지 마세요.

출력의 `source.accountAlias`는 로컬 별칭입니다. 계좌번호·공급자 계좌 식별자·키·토큰과 미정의 응답 필드는 출력하지 않습니다. 수량·금액 등 필요한 금융자료는 보존합니다. `source.scope`는 포함 범위이며 최신성과 동일 시점 스냅샷은 미확인입니다. 공급자가 제공하지 않는 갱신 시각을 `retrievedAt`으로 채우지 않습니다. 보유·매수 가능 금액·계좌 목록 원문은 별도 파일이나 로그에 기본 저장하지 않습니다. stdout에는 금융자료가 있으므로 소비 에이전트의 대화·터미널 보관 정책과 공급자 허용을 함께 확인하세요.

인증·권한·호출 제한·응답 오류와 부분 결과는 공통 계약을 따릅니다. 선택 계좌 확인과 금융 조회는 같은 인증·실행 예산을 사용하고 인증 복구·일시 오류 재시도에도 같은 계좌 헤더를 유지합니다. `--help`와 합성 검사 통과, 구현 완료나 이슈 라벨은 실제 계좌 접근·키 설정·실자료 전달의 승인이 아닙니다.

## 기간별 거래내역

승인 후 확인한 보유·매수 가능 금액·거래내역·주문과 실제 페이지의 결과는 [계좌 조회 검증 기록](toss-account-validation.md)에서 확인하세요. 진행 중 주문과 조건 주문의 다음 페이지는 미관측으로 구분합니다.

```sh
node scripts/toss.ts transactions 2026-09-01 2026-10-31
node scripts/toss.ts transactions 2026-09-01 2026-10-31 transactionTypes=BUY,SELL limit=20
node scripts/toss.ts transactions 2026-09-01 2026-10-31 transactionTypes=BUY,SELL cursor=PROVIDER_CURSOR context=PREVIOUS_PAGE_CONTEXT
```

기본 계좌의 허용 범위에 `transactions`를 명시적으로 추가한 뒤 조회하세요. 기존 선택에 자동으로 권한을 추가하지 않습니다. 예시의 커서와 context는 설명용이며 이전 출력의 실제 `page.nextCursor`·`page.context`를 복사하세요. 기본 계좌 확인·별칭·가림·오류·기본 비저장과 실행 한도는 다른 계좌 명령과 같습니다. 실제 개인 거래 자료는 [접근 준비 조건](toss-access-readiness.md)을 충족하고 별도 승인을 받기 전까지 조회하지 마세요.

2026-11-07 KST에 확인한 [공식 OpenAPI 1.2.28](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)의 `GET /api/v1/transactions`를 사용합니다. 국내·미국의 매매·증권 입출고·입출금·환전·배당·이자·수수료를 포함하며 옵션·채권도 포함합니다. 주식 전용 목록으로 해석하지 마세요.

| 입력 | 계약 |
| --- | --- |
| `FROM TO` | CLI에서 둘 다 필수인 `YYYY-MM-DD` 날짜입니다. KST 결제일 기준 양 끝을 포함하며 FROM이 TO보다 늦으면 거부합니다. 공식 API는 두 날짜 생략을 허용하지만 CLI는 명시한 기간만 조회합니다. 별도 최대 기간은 공식 스키마에 없습니다. |
| `transactionTypes=...` | `BUY`, `SELL`, `SECURITIES_TRANSFER_IN`, `SECURITIES_TRANSFER_OUT`, `DEPOSIT`, `WITHDRAWAL`, `EXCHANGE_IN`, `EXCHANGE_OUT`, `DIVIDEND`, `INTEREST`, `FEE`의 쉼표 구분 OR 필터입니다. 생략·빈 문자열은 전체 유형이며 중간 빈 항목은 거부합니다. |
| `limit=...` | 페이지 최대 크기 1~100, 기본 20입니다. 반환 개수만으로 완료를 추정하지 않습니다. |
| `cursor=... context=...` | 첫 페이지에서는 생략합니다. 다음 페이지는 공급자의 커서를 그대로 전송합니다. context는 CLI가 계좌·클라이언트·기간·유형 필터·커서에 연결한 확인값이며 HTTP에는 보내지 않습니다. 계좌·필터를 바꾸면 둘 다 빼고 처음부터 조회하세요. limit만 바꿀 수 있습니다. context 불일치는 HTTP 전에 `INPUT_INVALID`로 중단합니다. 공급자 커서 오류도 자동 처음 페이지 재조회 없이 오류로 반환합니다. |

`data`의 각 항목은 아래 필드를 모두 요구하며 nullable 필드의 null을 생략하거나 0으로 바꾸지 않습니다. 추가 공급자 필드는 출력하지 않고 식별 근거 없는 중복 제거·정렬 변경도 하지 않습니다.

| 필드 | 형식과 의미 |
| --- | --- |
| `transactionType`, `marketCountry`, `currency` | 필수 문자열입니다. 응답의 미지 열거값도 보존합니다. 현재 시장은 KR·US, 통화는 KRW·USD입니다. |
| `symbol`, `assetClass`, `isinCode` | 필수 nullable 문자열입니다. 상품은 STOCK·OPTION·BOND 또는 현금 거래의 null입니다. 옵션 심볼을 주식 조회에 그대로 쓰지 마세요. ISIN은 거래 당시 식별자이며 현재 값과 다를 수 있습니다. |
| `quantity`, `filledPrice`, `amount`, `netAmount`, `exchangeRate` | 필수 nullable 소수 문자열이며 최대 30자입니다. 수량은 주식 수·옵션 계약 수·채권 개수입니다. 금액·단가는 currency 통화, 환율은 1 USD당 KRW입니다. |
| `commission`, `tax` | null을 허용하지 않는 필수 소수 문자열입니다. 값이 없으면 공급자의 `"0"`을 보존합니다. |
| `settlementDate`, `settled` | 필수 KST 결제일과 결제 완료 불리언입니다. 미결제의 날짜는 예상 결제일이며 날짜만으로 완료를 추정하지 않습니다. |
| `transactionTime` | 필수 nullable 처리 시각입니다. 결제 완료 매매에서는 결제 처리 시각이며 주문 생성·체결 시각이 아닙니다. 미결제에서는 null입니다. |
| `isCancellation` | 필수 불리언입니다. true는 원거래 유형을 유지한 취소 내역이며 현금 방향이 반대가 됩니다. 모든 취소 방식을 나타내지는 않습니다. |

미결제를 먼저 반환하고 각 그룹 안의 공급자 순서를 보존합니다. 국내 주식은 미결제 합산 기준과 결제 후 합산 기준이 다르므로 한 항목을 하나의 주문이나 체결로 해석하지 마세요. 주문 식별자는 제공되지 않습니다. `to`가 오늘이면 미래 예상 결제일의 미결제는 제외됩니다. 해당 미결제를 포함하려면 종료일을 예상 결제일까지 명시하세요.

공급자의 `amount`·`netAmount`를 그대로 사용하세요. 예를 들어 수량 `0.123456789012345678`, 단가 null, 거래금액 `23.450000`, 수수료 `0.01`, 세금 `0`, 정산 금액 `23.469999`인 합성 내역의 정산 금액을 재계산하지 않습니다. 반올림·상품별 정산 규칙 때문에 단가×수량이나 거래금액±비용과 다를 수 있습니다. 증권 입출고의 금액·정산 금액은 null일 수 있습니다. 환전은 통화별 두 거래로 나오며, 취소·원거래 표시 규칙 때문에 합계를 실제 잔액 변화로 취급할 수 없습니다.

기본은 한 페이지입니다. `page.hasNext=true`이면 0건이어도 `partial`·종료 코드 2와 `next_page` 사유 및 다음 커서·context를 반환합니다. `hasNext=false`·`nextCursor=null`인 정상 빈 결과는 success·0입니다. 필수 페이지 필드 누락·불일치는 오류이며, 잘못된 행은 인덱스와 사유를 남깁니다. 유효 행이 남으면 partial·2, 받은 행이 모두 잘못됐으면 `RESPONSE_INVALID`·1입니다.

## 일반·조건 주문의 현재 상태

```sh
node scripts/toss.ts orders OPEN
node scripts/toss.ts orders CLOSED symbol=AAPL from=2026-10-01 to=2026-11-07
node scripts/toss.ts conditional-orders OPEN symbol=AAPL
node scripts/toss.ts conditional-orders CLOSED limit=20
node scripts/toss.ts orders CLOSED cursor=PROVIDER_CURSOR context=PREVIOUS_PAGE_CONTEXT
```

기본 계좌의 허용 범위에 `orders` 또는 `conditional-orders`를 명시적으로 추가하세요. 계좌 선택·별칭·가림·기본 비저장·공통 인증·실행 한도는 다른 계좌 조회와 같습니다. 주문 제출·정정·취소 명령이나 HTTP 경로는 제공하지 않습니다. 실제 조회와 금융자료 전달은 별도 접근 조건을 충족한 뒤 수행하세요.

2026-11-07 KST에 확인한 [공식 OpenAPI 1.2.28](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)의 `GET /api/v1/orders`·`GET /api/v1/conditional-orders`를 사용합니다. 아래 목록 조회로 기존 주문의 현재 상태를 확인하며 단건 상세 명령은 추가하지 않습니다.

| 입력·범위 | 계약 |
| --- | --- |
| `orders OPEN` | 국내·미국의 진행 중 일반 주문을 전량 반환합니다. 지정가·시장가·장마감지정가 등 Open API가 지원하는 호가 유형으로 접수된 주문만 조회됩니다. 장전·장후 시간외 종가 등 API 미지원 유형은 목록에 나타나지 않습니다. 앱의 모든 주문 목록으로 해석하지 마세요. |
| `orders CLOSED` | 종료된 일반 주문 한 페이지입니다. 기본 20개, `limit=1`~`100`을 허용합니다. |
| `conditional-orders OPEN\|CLOSED` | 국내·미국의 조건 주문 한 페이지입니다. API뿐 아니라 앱 등 다른 채널에서 등록한 SINGLE·OCO·OTO 등 모든 타입을 포함하며 타입 필터는 없습니다. 두 상태 모두 기본 20개, 최대 100개입니다. |
| `symbol=...` | 두 명령의 선택 필터입니다. 영문 대소문자·숫자·점·하이픈을 허용합니다. |
| `from=...`, `to=...` | 일반 주문만 지원하는 선택 날짜입니다. KST 주문 생성 시각 `orderedAt` 기준 양 끝 포함이며 결제일 필터가 아닙니다. 각각 생략할 수 있고 둘 다 생략하면 전체 기간입니다. `YYYY-MM-DD`와 시작일 ≤ 종료일을 검사합니다. 조건 주문에 날짜 필터를 추측해 추가하지 않습니다. |
| `cursor=... context=...` | 일반 종료 주문과 모든 조건 주문에서 이전 출력의 `page.nextCursor`·`page.context`를 함께 복사하세요. 공급자 커서를 변형하지 않고 전송하며 context는 HTTP에 보내지 않습니다. 조건 주문 커서는 영문·숫자·밑줄·하이픈 형식입니다. 계좌·명령·상태·심볼·기간 변경 시 둘 다 빼고 첫 페이지부터 조회하세요. limit만 바꿀 수 있습니다. 일반 `OPEN`의 limit·cursor·context는 무시하지 않고 입력 오류로 거부합니다. |

`OPEN`·`CLOSED`는 조회 그룹이며 항목의 세부 `status`와 다릅니다. 일반 OPEN 그룹은 PENDING·PARTIAL_FILLED·PENDING_CANCEL·PENDING_REPLACE, CLOSED 그룹은 FILLED·CANCELED·REJECTED·REPLACED·CANCEL_REJECTED·REPLACE_REJECTED·PARTIAL_FILLED를 포함합니다. PARTIAL_FILLED는 두 그룹에 나타날 수 있습니다. 조건 OPEN은 WATCHING·PAUSED·ORDERING·ORDERED, CLOSED는 COMPLETED·EXPIRED입니다. 조건별 `first.status`·`second.status`에는 HOLDING·CANCELED도 있습니다. 알려진 상태가 요청 그룹과 어긋난 항목은 제외합니다. 미래 응답 코드는 문자열 그대로 보존하며 알려진 상태로 추정하지 않습니다.

| 응답 필드 | 필수·nullable·의미 |
| --- | --- |
| 일반 주문 | `orderId`, `symbol`, `side`, `orderType`, `timeInForce`, `status`, `quantity`, `currency`, `orderedAt`, `execution`이 필수입니다. `price`·`orderAmount`·`canceledAt`은 선택 nullable입니다. `orderedAt`은 주문 생성 시각, `canceledAt`은 취소 시각입니다. `orderType`·`timeInForce`를 함께 해석하세요. |
| 일반 `execution` | `filledQuantity`가 필수 소수 문자열이고 `averageFilledPrice`·`filledAmount`·`commission`·`tax`·`filledAt`·`settlementDate`는 모두 필수 nullable입니다. `filledAt`은 최종 체결 시각, `settlementDate`는 KST 결제 예정일이며 거래내역의 `settled`를 대신하지 않습니다. |
| 조건 주문 | `conditionalOrderId`, `type`, `status`, `symbol`, `market`, `quantity`, `orderType`, `first`, `createdAt`이 필수입니다. `createdAt`은 등록 시각입니다. `expireDate`는 선택 날짜이며 null을 허용하지 않습니다. `second`는 선택 nullable 조건입니다. SINGLE은 첫 조건, OCO·OTO는 두 조건을 제공하며 두 조건의 타입은 같습니다. |
| 조건 `first`·`second` | 객체가 있으면 `type`·`status`·`orderSide`가 필수입니다. `triggerPrice`·`targetProfitRate`·`orderPrice`·`triggeredOrderId`는 선택 nullable입니다. `targetProfitRate`는 퍼센트 단위이며 `10.5`는 +10.5%입니다. `triggeredOrderId`는 조건으로 생성된 일반 주문 식별자입니다. |

금액·가격·수량은 소수 문자열로 보존하며 null·0·누락을 구분합니다. 일반 주문의 소수 필드는 최대 30자이며 조건 주문 소수 필드에는 공식 스키마에 없는 길이 제한을 추가하지 않습니다. 일반 주문 가격과 체결 금액·수수료·세금은 `currency` 통화, `orderAmount`는 금액 기반 미국 시장가 매수 주문의 USD 금액입니다. 조건 주문 응답에는 통화 필드가 없으므로 `market`을 보존하고 통화를 만들어 넣지 않습니다. 수량은 주 단위이며 원자료의 금액을 수량×가격으로 재계산하지 않습니다. 조회 시각은 `retrievedAt`, 원천은 `source.endpoint`, 자료 갱신 시각과 동일 시점 스냅샷은 미확인입니다.

일반 OPEN은 임의 페이지나 개수 자르기 없이 반환합니다. 나머지는 기본 한 페이지이며 공급자가 다음 페이지를 표시하면 빈 배열이어도 `partial`·종료 코드 2와 페이지 정보를 반환합니다. 조건 주문의 `nextCursor`는 공식 스키마에서 선택 필드입니다. 다음 페이지가 있는데 커서가 없거나 null이면 `missing_next_cursor`로 표시하며 완료로 해석하지 마세요. 일반 주문의 `orders`·`hasNext`·`nextCursor`, 조건 주문의 `conditionalOrders`·`hasNext`는 필수입니다. 잘못된 페이지 형식은 오류입니다.

정상 빈 결과는 성공입니다. 잘못된 항목은 인덱스와 `invalid_item`으로 제외하고 유효 항목이 남으면 부분 결과, 전부 잘못됐으면 `RESPONSE_INVALID`입니다. 계좌·인증·권한·미지원·한도 오류는 공통 오류 계약을 따르며 빈 주문 목록으로 바꾸지 않습니다. 미지원 일반 주문 유형은 조회 범위의 한계이며 주문이 없다는 증거가 아닙니다. 출력은 정의된 필드만 포함하고 계좌번호·공급자 계좌 식별자·키·토큰을 가립니다.

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

## 미국 세션과 거래 제약

```sh
node scripts/toss.ts sessions 2026-11-06
node scripts/toss.ts constraints AAPL 2026-11-06
```

두 명령 모두 미국 현지 날짜 `YYYY-MM-DD`를 필수로 받습니다. 유효한 달력 날짜만 허용하며 오늘 날짜를 자동 선택하지 않습니다. `constraints`는 기존 명령과 같은 문자 규칙의 심볼 하나도 받습니다. 시장·ISIN·수량·금액·주문 인수는 받지 않으며 심볼의 미국 상장 여부나 계좌 적격성을 확인하지 않습니다. `requestedMarket=US`는 요청 범위입니다.

2026-11-07 KST에 재확인한 [공식 OpenAPI 1.2.28](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)과 [FAQ](https://openapi.tossinvest.com/openapi-docs/faq.md)를 적용합니다. 두 명령의 외부 조회는 `GET /api/v1/market-calendar/US?date=DATE` 한 번이며 호출 제한 그룹은 `MARKET_INFO`입니다. 공식 스키마에 종목별 거래 가능 여부·접수 시간·수량·금액 제약을 통합 조회하는 API는 없습니다. 주문 생성 API의 문서만 읽어 아래 규칙을 구현했으며 해당 API를 호출하지 않습니다.

### 세션 응답

`sessions`의 `data[0]`은 공급자의 `today`·`previousBusinessDay`·`nextBusinessDay`입니다. `today`는 조회 시각의 오늘이 아니라 요청 날짜이며 일치 여부를 검사합니다. 공급자가 반환한 인접 영업일을 보존하고 다음 정규장을 따로 계산하지 않습니다. 각 날짜는 미국 현지 기준이며 네 세션의 `startTime`·`endTime`은 공식 KST 시각입니다. `source.dateTimeZone=America/New_York`, `sessionTimeZone=Asia/Seoul`로 두 의미를 구분합니다. 시간 문자열의 오프셋과 날짜를 그대로 읽으세요.

| 필드 | 의미와 처리 |
| --- | --- |
| `dayMarket`·`preMarket`·`regularMarket`·`afterMarket` | 각각 데이·장전·정규·장후 세션입니다. 객체는 유효한 시작·종료 시각과 시작 < 종료를 요구합니다. 뉴욕 날짜가 해당 거래일과 일치하는지도 검사하며 데이마켓 시작은 전날도 허용합니다. 알려지지 않은 추가 필드는 출력하지 않습니다. |
| 명시적 `null` | 해당 세션 휴장입니다. 네 필드가 모두 null이면 휴장일 자료로 정상 반환합니다. |
| 필드 생략·잘못된 세션 | 생략과 휴장을 구분합니다. 해당 필드를 제외하고 `session_unknown` 또는 `invalid_session`과 필드 경로를 표시하며 부분 결과로 끝냅니다. |
| 잘못된 날짜·요청 날짜 불일치 | 요청 날짜 자료를 사용할 수 없으면 `RESPONSE_INVALID`입니다. 요청 날짜의 세션을 하나도 확인할 수 없는 경우도 오류입니다. 인접 날짜 자료만 잘못됐으면 그 날짜를 제외하고 `invalid_day` 부분 결과를 반환합니다. |

장중·주말·휴장일에도 조회하며 기존 보고서의 장중 거부·공식 일정 수집·공지 해석·내장 모델을 사용하지 않습니다. `retrievedAt`은 CLI 조회 시각이고 공급자 갱신 시각은 미제공이므로 `source.freshness=unknown`입니다. 로컬 시계로 현재 세션이나 거래 가능 여부를 판정하지 않습니다.

시각 비교는 오프셋을 반영하며 밀리초 미만 소수초도 보존합니다. 예를 들어 `2026-03-25T22:30:00.1234+09:00`~`2026-03-25T13:30:00.1235Z`는 유효한 양의 구간이고, 끝이 `2026-03-25T13:30:00.123400Z`이면 같은 시각이므로 제외합니다.

### 거래 제약 응답 해석

`constraints`의 `data[0]`에는 `symbol`·`date`·`requestedMarket`·동일한 `calendar`와 다음 세 방식의 문서상 규칙이 담깁니다. `source.rulesVersion=1.2.28`, `rulesCheckedOn=2026-11-07`, `rulesSource`와 `rulesScope`는 코드에 반영한 문서 기준입니다. 실행할 때 최신 스키마를 다시 읽는 기능은 아닙니다.

| 방식 | 확인된 API 규칙 | 미확인 또는 미제공 |
| --- | --- | --- |
| `regular` | 지정가·시장가, 기본 양의 정수 수량. 수량과 금액은 정확히 하나만 지정합니다. `DAY` 기본, `CLS`는 미국 지정가, `OPG`는 국내 전용입니다. 미국 지정가 가격은 1달러 미만 소수점 4자리·이상 2자리이며 초과 자릿수는 공급자가 절삭합니다. | 종목별 가능 여부와 접수 시간, 최소·최대 수량은 미확인입니다. 일반 주문 지원을 모든 종목·세션에서의 거래 가능으로 해석하지 마세요. |
| `conditional` | `SINGLE`은 지정가·시장가, `OCO`·`OTO`는 지정가입니다. OCO는 매도·매도이며 첫 감시가 > 현재가 > 둘째 감시가, OTO는 매수 후 매도입니다. 미국 조건 감시·발동은 거래 가능한 모든 시간대이며 API에서 감시 세션을 선택할 수 없습니다. 만료일은 필수이며 오늘부터 최대 1년입니다. | 접수 시간·종목별 가능 여부·소수점 수량 지원·수량 상하한은 미확인입니다. 발동 세션은 접수 시간 보장이 아닙니다. |
| `fractional` | 금액 주문은 미국 시장가 전용이며 달러 단위입니다. 소수점 수량은 미국 시장가 매도만 허용하고 소수점 6자리까지입니다. 접수 구간은 정규장 시작부터 종료 1시간 전까지입니다. | 최소·최대 금액·수량과 종목별 가능 여부는 미확인입니다. 종료 경계의 포함 여부도 미확인입니다. |

세 방식 모두 1억 원 이상 주문에는 별도 확인이 필요합니다. `highValueConfirmation`에 원화 기준액을 소수 문자열로 표시하며 미국 달러 금액의 환산 기준은 `unknown`입니다. 이 기준은 주문 상한이나 최소 금액이 아닙니다.

`fractional.acceptanceWindow.status=documented_schedule`이면 공급자의 정규장 `startTime`과 종료 1시간 전인 `endTime`을 표시합니다. 계산한 종료 시각은 UTC로 출력하며 `endBoundary=unknown`입니다. 정규장이 null이면 `closed`, 정규장 정보가 없거나 접수 구간을 산출할 수 없으면 `unknown`입니다. 이는 문서 규칙을 일정에 적용한 구간이며 현재 시점의 접수 가능 판정이 아닙니다.

예를 들어 합성 정규장이 `2026-11-27T23:30:00+09:00`~`2026-11-28T03:00:00+09:00`이면 소수점 접수 종료 기준은 `2026-11-27T17:00:00.000Z`입니다. 이 구간 안이라도 `eligibility`와 세 방식의 `availability`는 계속 `unknown`입니다. `eligibilityLookup=api_not_provided`는 공식 조회 기능 부재, `appConditions=unknown`은 앱 조건 근거 미확인을 뜻합니다. 미확인을 거래 가능으로 바꾸거나 앱의 예약·조건과 동일시하지 마세요.

접수 종료 기준은 UTC로 출력하며 소수초는 최소 세 자리로 표시하고 밀리초 미만 자릿수도 유지합니다. 예를 들어 정규장 종료가 `2026-03-26T05:00:00.1234+09:00`이면 종료 1시간 전은 `2026-03-25T19:00:00.1234Z`입니다. 계산한 종료 기준이 시작 시각 이하이면 접수 구간은 `unknown`입니다.

확인된 규칙과 일정은 유효 자료로 제공하지만 종목별 조회 기능 부재와 앱 미확인을 `omissions`에 남기므로 `constraints`는 항상 부분 결과·종료 코드 2입니다. 2026-11-08 [#296의 요구 범위 재결정](toss-market-validation.md#2026-11-08-요구-범위-재결정)에 따라 첫 버전은 문서상 규칙과 세션, 종목별 거래 가능 여부·수량·금액·앱 조건의 미확인 표시를 제공하는 범위로 인수합니다. 종목별 확정 정보의 직접 조회는 시장 조회 인수의 필수 조건에서 제외하며, 실제 거래 전 종목별 조건은 직접 확인하세요. 미확인은 다른 공급자·추정값으로 보완하지 않습니다. 최근 체결의 남은 실제 검증과 계좌·소비 환경 등 별도 전환 조건은 유지합니다. 주문 제출·정정·취소·계좌 조회는 수행하지 않습니다.

## 일봉과 분봉

```sh
node scripts/toss.ts candles AAPL 1d
node scripts/toss.ts candles AAPL 1d date=2026-11-06 count=100
node scripts/toss.ts candles AAPL 1m count=200 adjusted=false
node scripts/toss.ts candles AAPL 1m count=100 adjusted=true before=2026-11-06T09:31:00.123+09:00
```

`candles SYMBOL INTERVAL [count=COUNT] [adjusted=true|false] [before=TIMESTAMP | date=YYYY-MM-DD]`는 봉 한 페이지를 조회합니다. `INTERVAL`은 일봉 `1d` 또는 1분봉 `1m`입니다. 개수는 1~200, 기본값은 100이고 수정주가 요청은 기본 `true`입니다. 선택 인수 순서는 자유롭지만 같은 인수의 반복은 거부합니다. `before`는 오프셋을 포함한 유효한 ISO 8601 시각이며 해당 시각을 포함하는 상한입니다. `date`는 미국 일봉 전용입니다. 두 상한을 모두 생략하면 기존처럼 최신 봉부터 조회하며 시장 확인 호출을 추가하지 않습니다. 공급자는 시작일·종료일·다른 봉 주기 인수를 제공하지 않습니다. `from=...`, `to=...`, `cursor=...`나 주봉 요청을 임의로 변환하지 않습니다.

`date`는 유효한 달력 날짜를 받아 뉴욕 현지 자정으로 변환하고 서머타임을 반영합니다. 지정 거래일의 봉을 포함하며 그 이전 봉을 함께 조회합니다. 예를 들어 `date=2026-03-08`은 `before=2026-03-08T05:00:00.000Z`, 다음 날 `date=2026-03-09`는 `before=2026-03-09T04:00:00.000Z`로 요청합니다. 휴장일은 그날 이하에서 존재하는 봉을 조회하며 오늘 자동 제외·직전 완료 거래일 추정·봉 필터링·개수 보충은 하지 않습니다. 분봉 날짜 선택·잘못된 날짜·`date`와 `before`의 동시 입력은 인증을 포함한 첫 HTTP 호출 전에 `INPUT_INVALID`로 거부합니다.

날짜 옵션을 쓰면 먼저 `GET /api/v1/stocks?symbols=SYMBOL`로 종목을 확인합니다. 공급자가 식별한 시장이 `NYSE`·`NASDAQ`·`AMEX`·`US_ETC` 중 하나일 때만 봉을 조회하며 티커 모양이나 통화로 시장을 추정하지 않습니다. 미국 외 시장과 미확인 시장은 `UNSUPPORTED`, 모호한 식별은 `IDENTITY_AMBIGUOUS`, 정상 빈 종목 목록은 `NOT_FOUND`, 중복·잘못된 식별 자료는 `RESPONSE_INVALID`로 중단합니다. 식별에 영향을 주는 잘못된 항목이 섞여도 봉을 조회하지 않습니다. 증권 유형 미확인만으로 확인된 미국 시장 조회를 막지는 않습니다. 시장 확인·인증·재시도와 대기를 모두 같은 단일 조회의 60초·HTTP 10회 예산에 포함하며 개별 HTTP 최대 15초와 공통 최소 1초 간격을 유지합니다.

`source.date`·`source.dateTimeZone=America/New_York`·`source.market`은 선택한 거래일과 확인한 시장이며 `source.before`는 공급자에게 전송한 시각 상한입니다. 날짜 선택·과거 날짜·반환 개수는 봉 완료나 최종 확정의 근거가 아니며 `completion`·`inProgress`는 계속 `unknown`입니다. 날짜로 첫 페이지를 받은 뒤에는 `date`를 빼고 `page.nextBefore`를 `before`에 그대로 넣어 후속 개별 조회를 요청하세요.

2026-11-12 KST에 확인한 [공식 REST OpenAPI 1.2.28](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)의 엔드포인트는 `GET /api/v1/candles`이며 호출 제한 그룹은 `MARKET_DATA_CHART`입니다. [공식 FAQ](https://openapi.tossinvest.com/openapi-docs/faq.md)와 함께 다음 의미를 적용합니다. 표의 미국 세션 설명은 미국 종목에 해당하며 날짜 옵션이 없으면 심볼의 시장·유형을 별도로 확인하지 않습니다.

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

## 순차 일봉 묶음

```sh
node scripts/toss.ts candles-batch AAPL,MSFT,BRK.B
node scripts/toss.ts candles-batch AAPL,MSFT date=2026-11-05 count=100 adjusted=false
```

`candles-batch SYMBOL[,SYMBOL...] [count=COUNT] [adjusted=true|false] [before=TIMESTAMP | date=YYYY-MM-DD]`는 최대 20종목의 일봉을 요청 순서대로 한 페이지씩 조회합니다. 주기 인수는 받지 않으며 `1d`를 사용합니다. 심볼 형식은 개별 봉 조회와 같고 요청한 표기·순서를 보존합니다. 빈 항목·잘못된 형식·20종목 초과·대소문자만 다른 항목을 포함한 중복 심볼과 잘못된 공통 옵션은 인증을 포함한 첫 HTTP 전에 거부합니다. `count`는 종목당 1~200·기본 100이며 `adjusted` 기본값은 `true`입니다. 날짜·시각 상한과 수정주가 의미는 개별 일봉과 같습니다.

날짜를 지정하면 각 종목의 공급자 식별과 미국 시장을 확인한 뒤 뉴욕 기준 지정일을 포함하는 일봉 상한을 적용합니다. 모호하거나 잘못된 식별·미국 외 또는 미확인 시장에서는 해당 종목의 봉을 조회하지 않고 다음 종목으로 진행합니다. 날짜를 생략하면 시장 확인을 추가하지 않습니다. 오늘 자동 제외·완료 거래일 추정·필터 후 개수 보충·자동 후속 페이지 조회는 하지 않습니다. `completion`·`inProgress`는 계속 `unknown`이며 기존 OHLC·거래량 세션 범위를 유지합니다.

묶음 전체는 최대 120초·HTTP 전송 40회 중 먼저 도달한 한도에서 멈춥니다. 하나의 클라이언트와 예산으로 시장 확인·토큰 발급·인증 복구·재시도 전송을 모두 세고 잠금·공통 간격·재시도 대기를 시간에 포함합니다. 개별 HTTP는 응답 본문까지 최대 15초 또는 남은 전체 시간 중 짧은 쪽을 적용합니다. 같은 보호된 상태 디렉터리를 쓰는 프로세스 간 최소 1초 간격과 더 긴 공급자 대기를 유지합니다. 이 값은 실행 상한이며 12종목이나 20종목의 완료 시각·조회 완료를 보장하지 않습니다. 기존 단일 조회의 60초·HTTP 10회 상한은 유지합니다.

종목 부재·응답 형식 오류·조회별 재시도 후 실패·개별 15초 초과는 해당 종목의 오류로 남기고 예산이 있으면 다음 종목을 조회합니다. 명시적 만료 인증 복구와 일시 오류 재시도는 기존 조회별 정책을 따르며, 토큰 발급·복구 실패나 인증·권한·IP 제한에서는 남은 조회를 중단합니다. `Retry-After`를 지킬 예산이 없으면 추가 전송을 하지 않습니다. 먼저 받은 공급자 제한은 이후 종목과 다른 프로세스에도 공통 상태를 통해 적용합니다.

stdout의 버전 1 JSON 하나에서 `data`는 요청 순서의 종목별 결과입니다. 각 항목의 `symbol`·`status`·`data`·`source`·`retrievedAt`을 함께 읽으세요. 성공·부분 결과에는 해당 봉 조회의 `omissions`와 `page`를 포함하며 오류에는 안전한 `error`를 넣습니다. 아직 조회하지 않은 항목은 `status=not_queried`·빈 `data`·중단 코드인 `reason`을 반환합니다. 처리 중이던 항목의 `error`와 이후 항목의 `reason`을 구분하세요. 종목별 `retrievedAt`은 그 결과를 기록한 시각이며 미조회 항목의 시각은 자료 조회 시각을 뜻하지 않습니다.

모든 항목이 성공이면 전체 `success`·종료 코드 0입니다. 정상 빈 페이지와 다음 경계가 있는 유효한 빈 부분 페이지도 사용 가능한 조회 결과입니다. 사용 가능한 성공·부분 결과가 하나라도 있고 다른 부분 결과·오류·미조회가 있으면 전체 `partial`·2, 사용 가능한 조회 결과가 하나도 없으면 전체 `error`·1입니다. 전체 `omissions` 대신 각 항목의 `status`·`omissions`·`error`·`reason`을 검사하세요. 모든 종목이 실패해도 종목별 오류는 `data`에 남으며 최상위 `error`가 필요하지 않습니다. 입력·초기 설정 오류처럼 묶음을 시작하지 못한 실패는 기존 최상위 오류 형식을 사용합니다. stderr에는 실패한 조회의 안전한 오류 코드만 출력합니다.

각 종목의 `summary`는 실제 반환한 유효 봉을 요약합니다. `returnedCount`는 검증·조회 조건을 통과한 `data`의 개수이며 요청한 `count`가 아닙니다. `latestTimestamp`는 최신 반환 봉의 원천 시각 표기를 그대로 보존합니다. `latestTradeDate`는 기존 날짜 선택 조회에서 미국 시장과 시간대를 확인했을 때만 `America/New_York`로 계산한 해당 봉의 거래일이며 지정한 기준 거래일로 대체하지 않습니다. 시장·시간대 근거가 없는 비어 있지 않은 결과는 거래일을 `null`, `tradeDateUnavailableReason`을 `market_timezone_unconfirmed`로 반환합니다. 요약을 위한 시장 확인·추가 페이지 HTTP는 없습니다.

정상 빈 결과와 유효한 빈 부분 페이지의 요약은 `returnedCount=0`, `latestTimestamp=null`, `latestTradeDate=null`입니다. 오류·미조회는 세 값 모두 `null`이며 기존 `error`·`reason`으로 구분합니다. `tradeDateUnavailableReason`은 위 근거 부재 외에는 `null`입니다. 부분 사유는 기존 `omissions`의 `next_page`·`pagination_unknown`·`invalid_item`과 `page`를 함께 읽고 별도 요약 사유로 복제하지 않습니다. 예를 들어 요청 개수가 100이어도 유효 봉 두 개와 다음 경계를 반환하면 개수는 2이고 `partial`·종료 코드 2를 유지합니다. 분석에 필요한 개수와 후속 페이지는 소비 에이전트가 판단하며, 요약은 봉 완료·최종 확정을 보장하지 않습니다. 이 요약은 일봉 묶음에만 추가됩니다.

각 항목의 `page.nextBefore`는 공급자 경계를 그대로 보존합니다. 필요한 종목만 `candles SYMBOL 1d count=COUNT adjusted=VALUE before=NEXT_BEFORE`로 추가 조회하고 `date`는 빼세요. 빈 부분 페이지도 같은 방식으로 이어 갑니다. 봉 timestamp에서 경계를 새로 계산하거나 시간을 빼지 마세요.

한도 도달과 처리 가능한 SIGINT·SIGTERM에서는 확보한 결과를 반환하고 소유한 잠금을 해제합니다. 자동 금융자료 파일 저장·디스크 재개 상태를 만들지 않으며 강제 종료·프로세스 충돌 후 복구는 보장하지 않습니다. 보관이 필요하면 승인된 자료 보관 범위 안에서 stdout을 직접 저장하세요. 기존 출처·시각·필드 검증·출력 가림을 동일하게 적용하며 이 명령의 구현이나 합성 검사 통과가 실제 조회·계좌 접근·새 자료 전달의 승인은 아닙니다.

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

공통 모듈이 `state.json`·`cooldown-<UUID>.json`·`client.lock`·`issuance.lock`의 쓰기를 소유합니다. 상태 파일에는 자격 증명 지문·토큰·만료 시각·예약 규약 버전·부팅과 시계 기준·다음 호출 가능 시각·발급 결과 미확인 표시를 저장합니다. 금융 응답은 별도 파일이나 로그에 기본 저장하지 않습니다. 토큰 만료는 발급 시작 시각과 공식 `expires_in` 초로 보수적으로 계산하며 KIS의 KST 해석·5분 제한을 사용하지 않습니다. 잠금 안에서 캐시를 다시 읽고 유효 토큰을 재사용하며, 토큰 발급에는 자동 재시도를 하지 않습니다.

상태 파일의 읽기·저장 상한은 전체 JSON을 UTF-8로 직렬화한 16,384바이트입니다. 토큰과 만료 시각뿐 아니라 모든 상태 메타데이터를 포함하며, 한도와 같은 크기는 허용합니다. 발급 응답을 반영한 전체 상태가 상한을 넘으면 첫 실행은 `AUTH_RESPONSE_INVALID`로 실패합니다. 토큰을 잘라 저장하거나 읽을 수 없는 상태를 게시하지 않으며, 읽을 수 있는 발급 결과 미확인 상태를 보존합니다.

발급 도중 통신·응답·저장 오류가 발생하면 `AUTH_ISSUANCE_UNKNOWN`으로 후속 자동 발급을 막습니다. 크기 초과 응답으로 실패한 뒤에도 같은 차단을 적용합니다. 강제 종료로 남은 잠금은 자동으로 빼앗지 않고 전체 실행 한도까지 기다립니다. 복구 전 같은 디렉터리를 사용하는 프로세스가 모두 끝났는지 확인하고 공급자 발급 상태와 토큰 교체 영향을 점검하세요. 실행 중 상태·잠금을 삭제하거나 자격 증명 지문을 수동으로 고치지 마세요. 보관 위치나 자격 증명 변경과 미확인 발급의 재시도는 별도 승인·상태 확인 후 진행하세요.

### 예약 상태와 복구

조회 실행은 macOS와 Linux를 지원하며 다른 운영체제에서는 HTTP 전송 전에 중단합니다. 기존 보호 저장소 검사에서 먼저 실패할 수 있으므로 미지원 운영체제의 오류 코드가 같다는 보장은 없습니다. 부팅·시계 기준을 확인할 수 없으면 `CLOCK_UNCERTAIN`입니다. macOS는 `kern.bootsessionuuid`, Linux는 `/proc/sys/kernel/random/boot_id`, `/proc/self/ns/time`의 시간 네임스페이스 식별자와 `/proc/self/timens_offsets`의 단조 시계 오프셋을 사용합니다. Linux의 오프셋은 자식용 네임스페이스에 속하므로 `/proc/self/ns/time_for_children`이 현재 네임스페이스와 같을 때만 사용합니다. 두 네임스페이스가 다르거나 필요한 정보를 읽을 수 없으면 전송하지 않습니다. 서로 다른 시간 네임스페이스나 오프셋에서 같은 상태를 사용하면 기준 불일치로 중단합니다. 오프셋을 함께 비교하므로 네임스페이스 식별자가 재사용되더라도 다른 시계 기준을 정상으로 받아들이지 않습니다.

예약 규약 v2는 `version:2`, `nextAt:null`, `clock.id`, `clock.nextNs`를 사용합니다. `clock.nextNs`는 같은 부팅·시계 기준의 나노초 마감을 앞에 0을 채운 고정 30자리 십진 문자열로 저장합니다. 마감이 커져도 상태 크기는 늘어나지 않습니다. `nextAt:null`은 구버전이 새 상태를 정상 벽시계 예약으로 읽지 못하게 하는 값입니다. 구버전은 `AUTH_STORAGE`, 새 버전은 지문·발급 상태·토큰이 유효하고 마감이 유한한 음이 아닌 수인 구형 벽시계 상태에 `AUTH_STATE_TRANSITION_REQUIRED`를 반환합니다. 손상된 구형 상태는 `AUTH_STORAGE`입니다. 새 버전은 구형 상태를 자동 변환하거나 삭제하지 않으며 토큰을 자동 재발급하지 않습니다. 부팅·시계 기준이 저장된 기준과 다르면 `CLOCK_UNCERTAIN`입니다.

양수인 공급자 대기 헤더를 받으면 응답별 `cooldown-<UUID>.json`에 자격 증명 지문·부팅과 시계 기준·절대 나노초 마감을 먼저 원자 저장합니다. 이 기록에는 토큰이나 금융 응답을 넣지 않으며, 다른 보호 파일과 같은 소유자·권한·크기 검사를 적용합니다. 응답 도착 때 실행 예산이나 개별 HTTP 제한을 넘었더라도 기록을 남기며, 응답을 기다리는 동안 다른 요청의 전송을 잠그지 않습니다. 다음 잠금 소유자는 읽은 기록 중 가장 늦은 마감을 `state.json`에 내구성 있게 저장한 뒤 해당 기록만 삭제합니다. 저장 실패 시 기록을 남기고 전송하지 않습니다. 저장 후 삭제 전에 중단되면 같은 절대 마감을 다시 반영하므로 대기를 처음부터 시작하지 않습니다. 후속 실행에서 병합을 마치면 기록은 제거되며, 훼손되거나 안전하지 않은 기록은 `AUTH_STORAGE`, 시계 기준이 다른 기록은 `CLOCK_UNCERTAIN`으로 전송을 막습니다.

각 전송 예약은 공통 잠금 안에서 그때 게시된 대기 기록을 읽습니다. 이 확인 이후에 게시된 기록은 이미 진행 중인 예약 하나와 겹칠 수 있으며, 다음 예약부터 반영합니다. 실제 전송 시작 사이의 최소 1초 간격은 계속 적용합니다. 대기 기록 게시를 포함한 저장 작업의 I/O 오류는 `AUTH_STORAGE`이며, 네트워크 오류로 자동 재시도하지 않습니다.

`AUTH_STATE_TRANSITION_REQUIRED`와 저장된 부팅·시계 기준 불일치로 발생한 `CLOCK_UNCERTAIN`의 복구에는 별도로 승인된 상태 전환이 필요합니다. 운영체제 정보가 없거나 읽기 권한이 없어서 발생한 `CLOCK_UNCERTAIN`은 먼저 지원 환경과 정보 읽기 권한을 복구하세요. 유효한 상태를 다시 쓰는 것만으로 해결되지 않습니다. 손상된 상태나 대기 기록의 `AUTH_STORAGE`도 원인을 확인하고 실제 상태의 읽기·수정 승인을 받은 뒤 복구해야 하며 자동 전환 대상이 아닙니다.

1. 같은 클라이언트와 상태를 쓰는 구버전·새 버전 실행을 모두 종료하고, 이후 실행기가 새 버전만 사용하도록 확인하세요. 남은 잠금의 삭제도 실행 종료 확인과 별도 승인 없이 수행하지 마세요.
2. 공급자가 요구한 남은 대기를 확인하고 실제 대기를 마치세요. `cooldown-<UUID>.json`에 남은 대기도 포함합니다. 구형 상태의 벽시계 마감만으로 시계 보정 이전의 잔여 시간을 복원할 수 없습니다. 남은 대기를 확인할 수 없으면 전환과 조회를 보류하세요.
3. 실제 보호 상태의 읽기·수정 승인을 받은 뒤, 자격 증명 지문·토큰·만료 시각·`pending`과 다른 상태 필드는 보존하고 예약 필드만 현재 부팅·시계 기준의 v2로 원자적으로 바꾸세요. 이미 대기를 마친 상태의 `clock.nextNs`는 `"000000000000000000000000000000"`으로 시작할 수 있습니다. 남은 기록의 정리는 모든 관련 실행 종료·대기 완료 확인과 별도 승인을 받은 뒤에만 수행하세요. `account.json`과 자격 증명은 바꾸지 마세요. `pending:true`는 이 전환으로 해소되지 않습니다.
4. 새 실행기로 다시 조회하세요. 이 안내는 전환 명령이나 실제 상태 변경의 승인이 아닙니다. 상태 파일을 삭제하여 인증을 다시 시작하는 방법으로 대체하지 마세요.

## 응답 계약

2026-11-06 직접 확인한 [공식 OpenAPI](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)의 버전은 `1.2.28`입니다. `latest` 주소는 바뀔 수 있습니다. [공식 개요](https://openapi.tossinvest.com/openapi-docs/overview.md)의 오류와 호출 제한도 적용합니다. 문서 확인은 실제 응답 호환성 검증과 구분합니다.

`GET /api/v1/prices?symbols=...`의 성공 envelope은 `result` 배열입니다. 페이지가 없는 API이므로 임의 페이지·개수 자르기·후속 자동 조회를 추가하지 않습니다.

| 필드 | 공식 계약과 CLI 처리 |
| --- | --- |
| `symbol` | 필수 문자열. 요청한 식별자와 정확히 연결되는 유일한 행만 반환합니다. 요청 밖의 행과 중복 행은 제외합니다. |
| `lastPrice` | 필수 소수 문자열, 최대 30자. 숫자로 바꾸거나 반올림하지 않습니다. `0` 문자열은 유효하며 null·누락·숫자 자료형은 오류입니다. |
| `currency` | 필수 통화 문자열. 공식 값은 `KRW`·`USD`이며 공식 확장 지침에 따라 다른 세 자리 대문자 코드도 원문으로 반환합니다. 서로 다른 통화는 합산하지 않습니다. |
| `timestamp` | 선택 필드이며 문자열 또는 null입니다. 오프셋이 있는 유효한 날짜·시각 문자열을 검사하고 그대로 반환합니다. 생략과 null을 구분하며 조회 시각으로 채우지 않습니다. |
| `priceAge` | CLI가 계산한 종목별 경과 시간 정보입니다. `seconds`는 원천 시각부터 결과의 `retrievedAt`까지 지난 초이며 소수초를 포함할 수 있습니다. `thresholdSeconds`는 이번 호출의 임계값, `exceedsThreshold`는 엄격한 초과 여부입니다. `seconds`의 숫자 표현은 JavaScript 정밀도에 따르며 경고 판정은 원천 시각의 소수초를 보존하여 비교합니다. |

`staleAfterSeconds=SECONDS`는 호출별 오래됨 경고 임계값이며 기본 900초입니다. 0~9007199254740991 범위의 정수를 십진 표기로 받으며 선행 0·부호·소수·지수 표기·반복 입력은 HTTP 전에 거부합니다. 공급자 요청에는 이 옵션을 보내지 않습니다. 경과 시간이 임계값과 같으면 `exceedsThreshold=false`, 초과하면 `true`입니다. 예를 들어 조회 시각이 `2026-11-06T15:45:00Z`이고 원천 시각이 `2026-11-06T15:30:00Z`이면 900초이므로 기본 임계값 경고가 없습니다.

시각이 생략·null·미래이면 `seconds`와 `exceedsThreshold`는 null이고 `unavailableReason`은 각각 `timestamp_missing`·`timestamp_null`·`timestamp_future`입니다. 원래 `timestamp`의 생략·null·문자열을 보존합니다. 경고나 판정 불가만으로 유효 가격을 제외하거나 `omissions`에 추가하거나 `partial`로 바꾸지 않습니다. 임계값 이내라는 사실도 최신·실시간 보장이 아니며 이 값은 공급자의 전송 지연 측정값이 아닙니다.

보고서에서는 원천 `timestamp`부터 명시한 보고서 기준 시각까지 경과 시간을 다시 계산하고, 해당 행의 `priceAge.thresholdSeconds`를 적용하세요. 엄격히 초과한 가격만 현재가와 구분한 참고가로 표시하며, 같은 값은 초과가 아닙니다. 원천 시각·보고서 기준 시각·재계산한 경과 시간·적용 임계값을 함께 표시하세요. 조회 당시에는 임계값 이내였어도 분석 중에 초과할 수 있습니다. 원천 시각 누락·null·보고서 기준 시각보다 미래인 경우는 참고가와 별도로 시점 미확인 가격으로 표시하세요. 원래 `retrievedAt`·`priceAge`·원천 값과 누락·null 구분은 보존하고, 조회 시각을 원천 시각으로 대신하지 마세요. 임계값 이내도 실시간성·공급자 전송 지연·동일 시점 스냅샷을 보장하지 않습니다. [에이전트 보고 지침](toss-agent-usage.md#classify-prices-at-report-time)과 [실행 가능한 소비 예시](../examples/price-consumer.mjs)에 적용 방법이 있습니다. 보고서 작성과 분류는 외부 에이전트의 책임입니다.

stdout에는 JSON 하나를 출력하고 stderr에는 원자료·자격 증명·공급자 메시지 없는 오류 코드만 출력합니다. 알려진 자격 증명·사용한 토큰이 결과에 나타나면 `SENSITIVE_OUTPUT`으로 자료 출력을 차단합니다. 공급자 추가 필드는 그대로 전달하지 않습니다.

```json
{
  "version": 1,
  "status": "success",
  "data": [{"symbol":"AAPL","lastPrice":"185.7000","currency":"USD","timestamp":null,"priceAge":{"seconds":null,"thresholdSeconds":900,"exceedsThreshold":null,"unavailableReason":"timestamp_null"}}],
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

오류 코드는 `IDENTITY_AMBIGUOUS`, `INPUT_INVALID`, `ACCOUNT_SELECTION_REQUIRED`, `ACCOUNT_SCOPE_DENIED`, `AUTH_CONFIG`, `AUTH_STORAGE`, `AUTH_STATE_TRANSITION_REQUIRED`, `CLOCK_UNCERTAIN`, `AUTH_FAILED`, `AUTH_RESPONSE_INVALID`, `AUTH_ISSUANCE_UNKNOWN`, `PERMISSION_DENIED`, `NOT_FOUND`, `UNSUPPORTED`, `RESPONSE_INVALID`, `RATE_LIMIT`, `NETWORK_ERROR`, `UPSTREAM_ERROR`, `REQUEST_LIMIT`, `TIMEOUT`, `INTERRUPTED`, `SENSITIVE_OUTPUT`, `INTERNAL_ERROR`입니다. 인증·권한·미지원·한도 오류는 정상 빈 결과로 바꾸지 않습니다.

## 실행 한도와 재시도

단일 조회 실행 전체는 최대 60초·HTTP 전송 10회이며, `candles-batch`는 위 순차 일봉 묶음의 120초·40회 예산을 사용합니다. 요청 하나는 응답 본문 수신까지 최대 15초입니다. 인증·재시도는 전송 수에, 잠금·간격·재시도 대기는 전체 시간에 포함하며 남은 시간보다 긴 대기는 시작하지 않습니다. 응답 본문은 최대 1 MiB로 제한합니다. SIGINT·SIGTERM은 안전한 중단 결과로 처리하고 소유한 잠금을 해제합니다. 강제 종료는 이 보장을 적용할 수 없습니다.

같은 디렉터리를 사용하는 프로세스는 인증과 조회를 합쳐 최소 1초 간격으로 전송을 예약합니다. `Retry-After`와 `X-RateLimit-Reset`의 초 값이 더 긴 대기를 요구하면 공통 상태에 반영합니다. 시간이 부족하면 종료합니다. 다른 실행에서 받은 제한도 이후 예약에 적용됩니다.

예약은 `process.hrtime.bigint()`의 공유 단조 기준을 사용하며 벽시계 전진·후진 보정으로 대기를 줄이지 않습니다. 매 전송 직전 잠금 안에서 최신 상태를 다시 읽고 대기 후에도 재검사합니다. 공급자 대기는 새 실행에서도 같은 마감으로 이어지므로 매번 전체 길이를 다시 시작하지 않습니다. 실행·개별 HTTP 예산의 기존 벽시계·프로세스 경과 검사도 유지하며 실행 예산에는 공유 시계의 경과를 함께 반영합니다.

근거를 확인한 [Node.js 24.0.0의 Darwin libuv](https://github.com/nodejs/node/blob/v24.0.0/deps/uv/src/unix/darwin.c)와 [로컬 libuv 1.52.1](https://github.com/libuv/libuv/blob/v1.52.1/src/unix/darwin.c)은 `mach_continuous_time()`을 사용합니다. [Apple 헤더](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/mach_time.h)는 이 시계가 절전 중에도 진행한다고 명시합니다. [Linux libuv](https://github.com/libuv/libuv/blob/v1.x/src/unix/linux.c)의 고해상도 시계는 `CLOCK_MONOTONIC`이며 [공식 매뉴얼](https://man7.org/linux/man-pages/man3/clock_gettime.3.html)에 따라 벽시계의 불연속 보정을 따르지 않고 절전 시간은 세지 않습니다. Linux 절전은 예약 대기를 더 길게 만드는 보수적인 방향입니다. NTP의 점진적 속도 보정까지 영향을 받지 않는 시계라는 뜻은 아닙니다. [시간 네임스페이스](https://man7.org/linux/man-pages/man7/time_namespaces.7.html)가 다르면 같은 부팅이어도 직접 비교하지 않습니다.

2026-11-14 로컬 macOS arm64의 Node.js 26.12.1·libuv 1.52.1에서 독립 자식 프로세스의 시각이 부모의 호출 전후 시각 사이에 드는지 확인했습니다. 프로세스별 상대 시계로 바꾼 음성 대조는 비교를 거부했습니다. 이는 같은 부팅에서의 로컬 비교 실험이며 실제 운영체제 시각 변경·절전·재부팅 실험이나 Linux 실행 검증은 아닙니다. 회귀 검사는 실제 CLI에 합성 HTTP·시계 보정·부팅 기준 변경을 적용합니다.

조회 중 `401 expired-token`에만 한 번 복구하며 다른 프로세스의 교체 토큰을 먼저 사용합니다. `invalid-token`·권한 오류는 재발급하지 않습니다. 일시 통신 오류·5xx·429에는 한 번 재시도합니다. 만료 복구와 일시 오류를 합쳐 조회는 최대 세 번 전송합니다. 현재가 한 번의 경로는 인증을 포함해 최대 다섯 번이므로 공통 HTTP 10회 상한에 먼저 도달하지 않습니다. 시간 초과·잘못된 성공 응답·토큰 발급의 불명확한 결과는 자동 반복하지 않습니다.

## 합성 검사와 후속 확장

```sh
node --test tests/toss.test.mjs tests/toss-stock.test.mjs tests/toss-discovery.test.mjs tests/toss-market.test.mjs tests/toss-candles.test.mjs tests/toss-sessions.test.mjs tests/toss-account.test.mjs tests/toss-transactions.test.mjs tests/toss-orders.test.mjs
npm run typecheck
```

공개 검증 경계는 실제 CLI 인수·stdout JSON·stderr·종료 코드·외부 HTTP입니다. `tests/toss-cli-helper.mjs`의 `fixture`와 `runCli`는 보호된 합성 설정 및 하위 프로세스를 만들며, `tests/toss-http-mock.mjs`는 네트워크·시계만 대체합니다. 후속 티켓은 이 도우미에 HTTP 시나리오를 추가하고 명령별 소비자 출력을 검사하세요. 서로 독립적인 인증·시계 도우미를 다시 만들지 마세요. 실제 프로세스 경합 검사는 실제 시계를 사용합니다.

`scripts/toss.ts`가 명령 선택·입력·공통 응답 검증과 JSON 출력을 맡고, `scripts/toss-stock.ts`가 종목 정보의 검증과 선택을, `scripts/toss-market.ts`가 호가·체결 응답 검증을, `scripts/toss-candles.ts`가 봉 인수·응답·페이지 검증을 맡습니다. `scripts/toss-orders.ts`가 일반·조건 주문 인수·현재 상태·페이지 검증을 맡고, `scripts/toss-transactions.ts`가 기간별 거래내역 검증을 맡습니다. `scripts/toss-account.ts`가 보유·매수 가능 금액의 응답 검증을 맡고, `scripts/toss-sessions.ts`가 미국 세션 검증과 문서상 거래 제약을 맡습니다. `scripts/toss-client.ts`의 `TossClient.get`이 읽기 전송·공통 인증·잠금·시간 및 호출 제한을 소유합니다. 후속 조회는 같은 클라이언트 인스턴스를 재사용하고 공통 상태에 직접 쓰지 마세요. 인증 외의 POST·주문 변경 경로는 추가하지 마세요. 페이지·계좌·추가 명령의 의미 계약은 각 티켓에서 공식 스키마와 대조하세요.

위 검사는 합성 자료에 한정합니다. 승인 후 수행한 시장 조회와 실제 봉 페이지의 결과는 [실제 응답 검증 기록](toss-market-validation.md)에서 확인하세요. 비어 있지 않은 최근 체결 항목의 원응답 대조를 완료했습니다. 종목별 거래 제약은 합의에 따라 미확인으로 표시합니다. 기존 로컬 인증·연결의 준비 결과와 자료 전달·공급자 조회 전용 권한의 남은 미확인은 [접근 준비 기록](toss-access-readiness.md)에, Codex·dots 각각의 합성 연결 결과는 [환경별 검증 기록](toss-agent-validation.md)에 구분했습니다. 각 환경의 실제 자료 사용은 [실자료 소비 검증](toss-agent-live-validation.md)에, 기존 경로 제거와 최종 소스의 검증은 [전환 기록](toss-transition.md)에 구분했습니다. 제거된 KIS·내장 모델 테스트의 과거 통과 결과를 새 토스 호환성의 근거로 승계하지 않습니다.
