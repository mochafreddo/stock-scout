# 토스증권 API의 시장·계좌 데이터 제공 범위

조사일은 2026-11-06이며, [토스증권 API로 제공할 수 있는 시장·계좌 데이터의 범위와 제약 조사](https://github.com/mochafreddo/stock-scout/issues/279)의 문서 조사 결과다. 현재 코드의 검토 기준은 `ef64daa3d663e13af8e34001609aa5da4990dcc4`다. 문서의 성격은 기능과 제약을 설명하는 참고 자료다. 기존 제품의 인수 이력은 [Stock Scout 명세: KIS와 OpenAI 기반 장전 매수 후보 추천](https://github.com/mochafreddo/stock-scout/issues/237)에 남기며, 새 제품의 탐색 방식·보고서·연결 형태·분류 정책은 이 조사에서 결정하지 않는다. 계좌·키·실제 인증 응답에는 접근하지 않았다.

## 결론과 증거 범위

토스증권 공식 명세에는 미국 시장 순위, 현재가, 과거 일봉, 종목 유형·보통주 여부·ISIN, 거래소별 거래 가능 종목 목록, 본인 종합매매 계좌, 보유 주식, 현금 기반 매수 가능 금액, 거래내역 조회가 있다. 그러나 현재 KIS의 거래소별 여섯 순위를 그대로 재현하는 순위 조회 계약은 없다. 미국 일봉의 OHLC는 정규장 기준이지만 거래량은 시간외가 포함될 수 있는 종합 거래량이다. 따라서 공급자를 바꾸는 것만으로 기존 데이터 의미가 보존된다고 볼 수 없다. [정식 명세 S1](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json), [FAQ S3](https://openapi.tossinvest.com/openapi-docs/faq.md)

공식 FAQ는 제공 정보의 이용을 투자자 본인의 매매 목적에 한정하고, 비상업적 이용을 포함해 제3자 배포를 금지한다. 외부 AI 에이전트나 모델에 원자료·가공 결과를 전달하는 것이 허용되는지, 어디까지가 배포인지에 대한 구체적 설명은 확인하지 못했다. 개인용이라는 이유만으로 AI 연결의 이용 조건이 해소된다고 판단할 수 없다. 이는 기능 존재와 별개의 연결 방식 결정 자료다. [S3, 데이터 이용 정책](https://openapi.tossinvest.com/openapi-docs/faq.md)

| 출처 | 읽은 자료와 우선순위 |
| --- | --- |
| [S0: 공식 LLM 안내](https://developers.tossinvest.com/llms.txt) | API 서버가 소유한 OpenAPI JSON을 엔드포인트·스키마·인증·오류·한도의 진실 원본으로 지정한다. |
| [S1: OpenAPI JSON](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json) | 2026-11-06 11:47 UTC에 공개 GET으로 확보한 `info.version=1.2.28`. 아래 경로와 `components.schemas`를 직접 확인했다. `latest` URL은 불변 버전 링크가 아니다. |
| [S2: 개요](https://openapi.tossinvest.com/openapi-docs/overview.md) | 시작 절차, 인증 헤더, 그룹별 요청 한도, 오류·웹소켓 개요를 확인했다. |
| [S3: FAQ](https://openapi.tossinvest.com/openapi-docs/faq.md) | 세션·거래량·수정주가·과거 범위·주문 조회·이용 정책을 확인했다. |
| [C1: KIS 조회 공통 모듈](https://github.com/mochafreddo/stock-scout/blob/ef64daa3d663e13af8e34001609aa5da4990dcc4/scripts/kis-query.ts) | 현재 사용하는 네 가지 데이터 호출, 파라미터, 보존 필드를 확인했다. |
| [C2: 후보군 실행](https://github.com/mochafreddo/stock-scout/blob/ef64daa3d663e13af8e34001609aa5da4990dcc4/scripts/candidate-universe.ts) | 여섯 순위의 각 1위, 중복 제거, 유형 판단 뒤 20세션 일봉 소비 경로를 확인했다. |
| [C3: 완료 일봉 검사](https://github.com/mochafreddo/stock-scout/blob/ef64daa3d663e13af8e34001609aa5da4990dcc4/scripts/completed-daily-bars.ts) | 날짜·필수 OHLCV·식별 검사와 `MODP=0` 운영 가정 표시를 확인했다. |

검색 색인의 `/docs`는 v1.2.14를 표시했고 Context7 응답의 일부 자료 생성일은 2026-10-12였다. 반면 직접 확보한 S1에는 `/api/v1/transactions`와 `/api/v1/stocks/all`이 있다. 검색·Context7의 누락을 미지원 근거로 사용하지 않았다. 검색 색인의 REST 전용 설명보다 S0·S1·S2의 현재 REST 및 웹소켓 설명을 우선했다. 웹소켓 상세 AsyncAPI는 이번 REST 중심 조사에서 읽지 않았다.

아래의 **지원 확인**은 문서에 계약이 있다는 뜻이며 실제 호출·계좌 적합성·응답 완전성을 검증했다는 뜻은 아니다. **미지원 명시**는 공식 자료가 제한을 명시한 경우다. **미확인**은 설명이나 필드가 없어 판단할 수 없는 경우이며 공급자가 지원하지 않는다는 뜻이 아니다.

## 현재 KIS 호출과 토스 대응

| 현재 호출·소비 경로 | 토스 문서의 대응 | 판정과 의미 차이 |
| --- | --- | --- |
| `queryKis('volume')`: `/uapi/overseas-stock/v1/ranking/trade-vol`, `HHDFS76310010`; `candidate-universe.ts`, `llm-security-probe.ts`, `kis-probe.ts`가 호출한다. | `GET /api/v1/rankings`, `type=MARKET_TRADING_VOLUME`, `marketCountry=US` | **지원 확인**: 미국 시장 거래량 순위. **미확인**: NAS·NYS·AMS별 독립 순위와의 동등성. 명세의 요청 필드는 시장 국가이며 거래소 필터가 없다. [C1](https://github.com/mochafreddo/stock-scout/blob/ef64daa3d663e13af8e34001609aa5da4990dcc4/scripts/kis-query.ts), [S1: getRankings](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json) |
| `queryKis('amount')`: `/uapi/overseas-stock/v1/ranking/trade-pbmn`, `HHDFS76320010`; 위와 같은 소비자다. | 같은 경로, `type=MARKET_TRADING_AMOUNT`, `marketCountry=US` | **지원 확인**: 미국 시장 거래대금 순위. 거래소별 1위를 미국 통합 순위의 일부 행으로 대체하면 탐색 의미가 달라진다. 이는 코드 구조에서 나오는 차이이며 채택 결정은 아니다. [C2](https://github.com/mochafreddo/stock-scout/blob/ef64daa3d663e13af8e34001609aa5da4990dcc4/scripts/candidate-universe.ts), [S1: RankingItem](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json) |
| `queryKis('daily')`: `/uapi/overseas-price/v1/quotations/dailyprice`, `HHDFS76240000`; `GUBN=0`, `BYMD=''`, `MODP=0`. `candidate-universe.ts` → `CompletedDailyBars` → `buy-candidate-assessment.ts`의 `get_daily`가 소비한다. `kis-probe.ts`에서도 호출한다. | `GET /api/v1/candles`, `interval=1d`, `adjusted=false` | **지원 확인**: OHLCV·거래 통화·시각·과거 페이지. **미지원 명시**: 상장폐지 종목 과거 시세. **미확인**: 기존 KIS 값과의 일치·완료 데이터 게시 시각. 미국 일봉 OHLC와 거래량의 세션 범위가 서로 다르다. [C3](https://github.com/mochafreddo/stock-scout/blob/ef64daa3d663e13af8e34001609aa5da4990dcc4/scripts/completed-daily-bars.ts), [S1: Candle](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json), [S3](https://openapi.tossinvest.com/openapi-docs/faq.md) |
| `queryKis('info')`: `/uapi/overseas-price/v1/quotations/search-info`, `CTPF1702R`; `PRDT_TYPE_CD=512/513/529`와 원본 종목 코드. `security-type-assessment.ts`의 `get_infos`, `kis-probe.ts`가 호출한다. | `GET /api/v1/stocks?symbols=...`; `StockInfo` | **지원 확인**: 시장·ISIN·유형·보통주 여부·상장 상태. **미확인**: 모든 ADR의 기초 권리 분류 및 KIS 식별자와의 개별 대응. KIS의 `rsym`·SEDOL·분류 코드 전체를 그대로 돌려주는 계약은 확인되지 않았다. [C1](https://github.com/mochafreddo/stock-scout/blob/ef64daa3d663e13af8e34001609aa5da4990dcc4/scripts/kis-query.ts), [유형 소비자](https://github.com/mochafreddo/stock-scout/blob/ef64daa3d663e13af8e34001609aa5da4990dcc4/scripts/security-type-assessment.ts), [S1: StockInfo](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json) |
| `kis-auth.ts`의 `POST /oauth2/tokenP`, 앱 키·시크릿, 공통 캐시·발급 잠금. 모든 KIS 호출에 선행한다. | `POST /oauth2/token`, OAuth 2.0 Client Credentials | **지원 확인**: 토큰 발급. **미지원 명시**: refresh token. 재발급은 이전 토큰을 즉시 무효화한다. 기존 KIS의 5분 제한·만료시각 해석을 토스 계약으로 승계할 근거는 없다. [인증 생산자](https://github.com/mochafreddo/stock-scout/blob/ef64daa3d663e13af8e34001609aa5da4990dcc4/scripts/kis-auth.ts), [ADR 0001](../adr/0001-kis-token-issuance-state.md), [S1: OAuth2TokenResponse](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json), [S3](https://openapi.tossinvest.com/openapi-docs/faq.md) |
| 순위 행의 `last` 및 일봉 OHLC를 읽으며 독립 KIS 현재가 엔드포인트는 현재 `kinds`에 없다. | `GET /api/v1/prices?symbols=...`, 호가·최근 체결·상하한가 API도 존재한다. | **지원 확인**: 현재가 다건 조회, 시각·가격·통화. **미지원 명시**: 미국 NBBO·전체 시장 시세라는 보장. **미확인**: 현재가의 세션별 원천·지연 수준·정확한 최종 갱신 보장. [C1](https://github.com/mochafreddo/stock-scout/blob/ef64daa3d663e13af8e34001609aa5da4990dcc4/scripts/kis-query.ts), [S1: PriceResponse](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json), [S3](https://openapi.tossinvest.com/openapi-docs/faq.md) |

`kis-observe.ts`는 `kis-probe.ts` 등을 격리 복사해 실행하는 관측 도구이며 별도의 KIS 상품 API를 추가하지 않는다. `security-type-probe.ts`는 저장된 요청 경로와 필드를 검사한다. `ListedSecurities`는 `exchange:symbol`과 `rsym`의 일관성·중복 및 원래 순위를 관리하므로 토스의 `symbol`만 기존 키에 끼워 넣을 수는 없다. [관측 도구](https://github.com/mochafreddo/stock-scout/blob/ef64daa3d663e13af8e34001609aa5da4990dcc4/scripts/kis-observe.ts), [자료 검사](https://github.com/mochafreddo/stock-scout/blob/ef64daa3d663e13af8e34001609aa5da4990dcc4/scripts/security-type-probe.ts), [식별 소유자](https://github.com/mochafreddo/stock-scout/blob/ef64daa3d663e13af8e34001609aa5da4990dcc4/scripts/listed-securities.ts)

현재 계좌·보유·현금·거래내역에 대응하는 KIS 호출은 C1에 없다. 아래 항목은 기존 호출 대체와 구분되는 새 도구의 데이터 조사다.

## 순위·종목 식별·유형

순위의 `type`에는 `MARKET_TRADING_AMOUNT`, `MARKET_TRADING_VOLUME`, `TOP_GAINERS`, `TOP_LOSERS`, `TOSS_SECURITIES_TRADING_AMOUNT`, `TOSS_SECURITIES_TRADING_VOLUME`이 있다. `TOSS_SECURITIES_*`의 거래량·거래대금은 토스증권 체결 기준이고 나머지는 시장 전체 기준이다. `duration`은 거래일 기준 `realtime`, `1d`, `1w`, `1mo`, `3mo`, `6mo`, `1y`이며, `TOP_GAINERS`·`TOP_LOSERS`의 `realtime`은 **미지원 명시**다. `MARKET_*`를 선택하는 것과 토스 고객 거래를 선택하는 것은 다르다. [S1: `/api/v1/rankings`, RankingItem](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)

순위는 `count=1..100`이고 기본 100이다. 후속 페이지 파라미터는 없으며 집계 시각 `rankedAt`과 순위 오름차순 목록을 준다. 시세 조회 실패 종목이 빠져 `count`보다 적을 수 있고, 집계가 없는 조합은 빈 배열과 `rankedAt=null`이다. `tradingVolume`·`tradingAmount`는 해당 `duration` 누적이다. `TOP_*`의 `basePrice`·`changeRate`는 기간 시작 기준이며 나머지는 기간과 무관하게 전일 기준이다. `changeRate`는 소수 비율이고 기준가가 0이면 null이다. **미확인**: 미국 순위의 장별 집계 경계·초기화 시각·지연·OTC 포함 여부·모든 상장 종목 포괄 여부. `US`라는 값만으로 NASDAQ·NYSE·AMEX 전체를 빠짐없이 포함한다고 해석하지 않는다. [S1: RankingResponse, RankingPrice](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)

`GET /api/v1/stocks/all`은 `market=NYSE|NASDAQ|AMEX|US_ETC` 등으로 거래소별 목록을 제공하지만 토스증권에서 거래 가능한 종목만 반환한다. `status` 기본값은 `ACTIVE`이며 유형·보통주 여부 필터가 있다. symbol 오름차순으로 페이지 없이 한 번에 반환하며 일 배치 갱신과 하루 한 번 캐시를 권장한다. 이 목록을 이용해 미국 통합 순위를 거래소별로 걸러도 각 거래소의 원래 상위 순위를 복원할 수 있다는 보장은 없다. 목록은 새로운 탐색 자료 후보일 뿐 채택한 탐색 방식이 아니다. [S1: `/api/v1/stocks/all`, ListedStock](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)

상세 정보는 `GET /api/v1/stocks`에서 최대 200개 symbol을 콤마로 묶어 조회한다. 미국 symbol은 티커이며 허용 문자는 영문 대소문자·숫자·`.`·`-`다. 현재 KIS 입력 허용 문자에는 `/`·`^`도 있으므로 단순 문자열 재사용의 호환성은 **미확인**이다. `StockInfo.market`의 `NASDAQ/NYSE/AMEX`와 KIS의 `NAS/NYS/AMS`는 명칭상 대응 후보지만, 특수 클래스 표기·이전 상장·재사용 티커를 포함한 실제 대응은 확인하지 않았다. 토스는 `isinCode`, `market`, `status`, 종목명·영문명, 통화, 발행주식수, nullable 상장·상폐일을 제공한다. [C1](https://github.com/mochafreddo/stock-scout/blob/ef64daa3d663e13af8e34001609aa5da4990dcc4/scripts/kis-query.ts), [S1: SymbolQuery, StockInfo](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)

유형 enum은 `STOCK`, `FOREIGN_STOCK`, `DEPOSITARY_RECEIPT`, `INFRASTRUCTURE_FUND`, `REIT`, `ETF`, `FOREIGN_ETF`, `ETN`, `STOCK_WARRANTS`다. `isCommonShare`는 우선주이면 false라고 정의한다. ETF 예시에도 true가 있으므로 true 하나만으로 보통주 적격성을 판단할 수 없다. **지원 확인**은 이 분류와 필드의 존재까지다. **미확인**은 미국 ADR 표본에서 `DEPOSITARY_RECEIPT`·`isCommonShare`가 어떻게 조합되는지, 보통주 성격의 기초 권리까지 나타내는지, 분류 근거·변경 시각·과거 유효기간이다. 기존 [용어집](../../GLOSSARY.md)의 ADR 기준과 [ADR 0005](../adr/0005-official-security-type-sources.md)는 별도 근거를 요구하므로 토스 필드만으로 기존 검증을 없앨 수 있다고 결론 내리지 않는다. [S1: StockInfo, `/api/v1/stocks/all`](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)

거래내역의 `assetClass=STOCK`에는 ETF·리츠·ETN도 포함된다. 이 값은 주식형 거래 상품군이며 보통주 판정이 아니다. 또한 S1의 Transaction·AssetClass 설명은 `GET /api/v1/stocks/{symbol}`을 참조하지만 S1의 실제 `paths`에는 그 상세 경로가 없고 `/api/v1/stocks?symbols=...`만 있다. 구현 후보는 실제 정의된 다건 경로이며, 설명상의 단건 경로는 문서 불일치로 남긴다. [S1: AssetClass, Transaction, paths](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)

## 일봉·분봉·완료 세션

캔들은 `interval=1m|1d`, `count=1..200`이며 기본 100이다. 최신순으로 반환하고 `before`는 inclusive 상한이다. 다음 페이지에는 응답의 `nextBefore`를 그대로 전달하며 마지막 페이지는 null이다. 오프셋의 `+`는 URL 인코딩한다. **미확인**: inclusive 경계에서 페이지 중복이 발생하는지와 진행 중 봉·동시 갱신 때의 일관성. 이를 임의의 1밀리초 차감 규칙으로 바꾸는 근거는 없다. [S1: `/api/v1/candles`, CandlePageResponse](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)

미국 일봉의 시가·고가·저가·종가는 정규장 기준이며 종가는 정규장 공식 종가다. 프리·애프터·데이마켓 체결은 OHLC에서 제외되지만 거래량은 종합 거래량이므로 시간외 체결이 포함될 수 있다. 미국 1분봉은 일부 거래소 실시간 체결을 사용하므로 1분봉을 합쳐 일봉이나 정규장 전체 거래량을 재구성할 수 없다. 일봉 거래량을 정규장 거래량으로 제공하는 별도 필터는 S1에서 확인되지 않았다. 정규장 전용 거래량을 반드시 요구할지는 후속 제품 결정이다. [S3, 시세·캔들](https://openapi.tossinvest.com/openapi-docs/faq.md)

`1m.timestamp`는 봉 종료이며 집계 구간은 `[timestamp-1분, timestamp)`다. `1d.timestamp`는 거래일 현지 자정을 KST로 나타낸 값이다. FAQ의 미국 예시는 서머타임 때 `13:00+09:00`, 비서머타임 때 `14:00+09:00`이며 미국 거래일 범위는 뉴욕 시각 전일 20:00부터 당일 20:00까지다. 조회시각·KST 날짜·완료 정규장 날짜를 같은 필드로 취급할 수 없다. OHLC가 정규장이라는 설명이 거래일 전체나 조회 순간의 봉 완료를 보장하지 않는다. **미확인**: 완료 일봉의 최초 게시·최종 확정 시각과 데이터 준비 SLA. [S1: Candle](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json), [S3](https://openapi.tossinvest.com/openapi-docs/faq.md)

`adjusted` 기본값은 true이므로 KIS의 `MODP=0`과 같은 의도로 원가격을 요청하려면 명시적인 false가 필요하다. 수정은 가격뿐 아니라 거래량도 바꾼다. FAQ는 미국 가격에 수정비율을 곱하고 거래량을 수정비율로 나눈 뒤 정수 반올림한다고 설명한다. 미국은 기준가가 직전 정규장 종가와 5%를 초과해 차이 날 때만 조정하며 기업행위 종류를 구분하지 않으므로 5% 이하 배당·분배락이 반영되지 않을 수 있다. 제공 시작 이전 구간은 이미 조정된 자료만 보유해 false여도 당시 원가격을 제공하기 어려울 수 있다. 따라서 false를 모든 과거 구간의 무수정 보장으로 표현할 수 없다. [S1: `/api/v1/candles`](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json), [S3](https://openapi.tossinvest.com/openapi-docs/faq.md)

미국 분봉은 2021-12-01 이후를 제공하며 그 이전은 **미지원 명시**다. 일봉에는 그 기간 제한을 적용하지 않는다고 설명하지만 모든 종목의 상장 이후 전체 일봉 보장은 **미확인**이다. 상장폐지 시세는 404로 조회 불가다. 미국 분봉은 거래소 정정·취소를 반영하지 않고 지연 보고된 체결로 과거 봉이 바뀔 수 있으며, 가격 이상값을 제거하거나 정정 여부 필드를 주지 않는다. 일봉의 사후 정정 정책 전체는 **미확인**이다. [S3](https://openapi.tossinvest.com/openapi-docs/faq.md)

참고로 `GET /api/v1/market-calendar/US?date=...`는 미국 현지 기준일의 전일·당일·익일 영업일과 데이·프리·정규·애프터 세션별 nullable 시간을 제공한다. 응답 시각은 KST다. 일정 조회 지원은 캔들 집계 범위·완료·원천의 증명이 아니며 기존 공식 일정 판정의 대체 여부도 이 조사에서 결정하지 않는다. [S1: UsMarketCalendarResponse, UsMarketDay](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)

## 계좌·보유·현금·이력

| 항목 | 지원 확인 | 미지원 명시 또는 미확인 |
| --- | --- | --- |
| 계좌 목록 | `GET /api/v1/accounts`: `accountNo`, `accountSeq`, `accountType`. 계좌가 없으면 빈 배열. | **미지원 명시**: 현재 `BROKERAGE`만 반환하며 자녀계좌 사용 불가. 다른 유형 enum의 존재는 실제 지원을 뜻하지 않는다. **미확인**: 다른 증권사·다른 사용자 계좌. [S1: Account](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json) |
| 보유 주식 | `GET /api/v1/holdings`: KR·US 종목별 보유수량·현재가·매수평균가·투자원금·평가금액·손익·일간손익·수수료·세금 및 합계. 선택적 symbol 필터는 합계도 다시 계산한다. 페이지 파라미터는 없다. | **미지원 명시**: 해외 옵션·채권 보유는 제외. **미확인**: 과거 기준일 스냅샷·취득 로트·보유/미결제 수량의 세부 구분·동시 조회 원자성·자료 기준시각. [S1: HoldingsOverview, HoldingsItem](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json) |
| 현금 기반 매수 가능 금액 | `GET /api/v1/buying-power?currency=KRW|USD`: `cashBuyingPower`. 미수거래를 제외한 현금 기반 금액. KRW 원 단위 정수, USD 달러 단위 소수. | **미확인**: 예수금·출금 가능 현금·결제 완료 현금과의 대응. 이 값으로 총 현금 잔액을 대신하거나 거래내역 합산으로 잔액을 복원할 근거는 없다. 별도 현금 잔액 경로는 S1에서 확인하지 못했다. [S1: BuyingPowerResponse, paths](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json) |
| 거래내역 | `GET /api/v1/transactions`: 매수·매도·현금 입출금·환전 입출금·배당·이자·별도 수수료·증권 입출고. KR·US 통합, 옵션·채권도 포함하며 `assetClass`로 구분. | **미지원 명시**: 해당 주문 식별자를 제공하지 않는다. **미확인**: 별도 영속 거래 ID·스냅샷 일관성·보존 시작시점·정정 이력·이전 티커의 현재 상세정보 연결. [S1: getTransactions, Transaction](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json) |
| 주문·체결 조회 | `GET /api/v1/orders`, `GET /api/v1/orders/{orderId}`. 주문별 누적 수량·평균 체결가·금액·비용·최종 체결시각·결제일. 앱·WTS 주문도 채널과 무관하게 포함. | **미지원 명시**: API 미지원 호가 유형의 주문, REST 계좌 전체 개별 체결 이벤트 이력. 거래내역과 주문 조회는 서로 다른 단위다. 주문 제출·정정·취소는 이번 범위 밖이다. [S1: Order, OrderExecution](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json), [S3, 주문·체결 조회](https://openapi.tossinvest.com/openapi-docs/faq.md) |

보유 합계의 `krw`·`usd`는 각 통화로 거래한 종목만 합산하며 통화 간 환산 합계가 아니다. 반면 전체 손익률·일간손익률은 현재 환율로 원화 환산한 기준이다. 해외 종목이 없으면 usd가 null이고 국내 종목이 없으면 krw는 0이다. 종목 수량·금액은 decimal 문자열로 제공되므로 null과 0 및 금액과 비율을 구분해야 한다. 자료의 비율은 소수 비율이다. 이것은 응답 필드 의미이며 제품의 평가손익 계산 정책을 정한 것이 아니다. [S1: Price, OverviewProfitLoss, OverviewDailyProfitLoss, HoldingsItem](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)

### 거래내역 날짜·페이지·합산의 제약

`transactionTypes`는 콤마로 묶은 OR 필터다. `from`·`to`는 KST 결제일의 inclusive 범위이고, 미결제에는 예상 결제일을 적용한다. `to=오늘`이면 미래 결제 예정 매매가 빠질 수 있다. 날짜가 오늘·과거라는 이유로 결제 완료로 간주하지 않고 `settled`를 사용한다. 미결제는 매수·매도에만 나타나며 입출금·환전·배당·이자 등은 결제 완료로 반환한다. `transactionTime`은 결제 완료 처리시각이며 매매 주문·체결시각이 아니고 미결제는 null이다. [S1: `/api/v1/transactions`, Transaction](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)

미결제를 먼저 반환하고 그 뒤 결제 완료를 반환한다. 미국 주식은 주문별 체결 합계이며 국내 주식은 미결제와 결제 완료의 합산 기준이 달라 한 행이 결제 후 여러 행으로 바뀔 수 있다. `limit`은 기본 20·최대 100이고 적은 행이나 빈 페이지에도 다음 페이지가 있을 수 있어 `hasNext`와 `nextCursor`가 종료 기준이다. 계좌·필터를 바꾸면 cursor 없이 다시 시작하며 커서는 해석·직접 생성하지 않는다. 동일 조회 중 거래가 결제될 때의 중복·누락 방지나 스냅샷 보장은 **미확인**이다. [S1: getTransactions, PaginatedTransactionResponse](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)

미국 주식 미결제 `filledPrice`는 null이고 결제 후에는 주문별 평균가다. `amount`를 수량×단가로 재계산하지 않으며 `netAmount`도 반올림·정산 규칙 때문에 금액·수수료·세금으로 재구성하지 않는다. 금액에는 부호가 없으며 방향은 거래유형과 `isCancellation`에 따른다. 취소 거래는 원유형을 유지하고 원거래는 목록에서 빠질 수 있다. 공식 설명은 거래금액 합산이 실제 잔액 변화와 일치하지 않을 수 있고 `netAmount`도 예수금 변동과 같지 않을 수 있다고 명시한다. [S1: Transaction](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)

환전은 KR·US 두 행으로 나뉘며 환율은 결제 완료 USD 행에서 확인한다. 거래시점 ISIN은 현재 종목 ISIN과 다를 수 있고, 주식 symbol도 확인할 수 없으면 null이다. 옵션 symbol은 OCC 계약 식별자여서 주식 API에 전달할 수 없으며 채권은 symbol이 null이고 ISIN으로 식별한다. `assetClass` 분기는 주식 조회 전에 필요하지만 옵션·채권 도구를 제품에 추가하겠다는 결정은 아니다. [S1: Transaction, AssetClass](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)

주문 목록은 별도 계약이다. `OPEN`은 전량 반환하며 limit·cursor를 무시하고, `CLOSED`는 기본 20·최대 100의 cursor 페이지를 사용한다. `from`·`to`는 거래내역과 달리 KST 주문 생성일 기준이다. FAQ는 미지정 시 계좌 개설 이후 전체 기간을 조회한다고 설명한다. 이 설명을 `/transactions`의 보존 기간으로 확대할 근거는 없다. [S1: `/api/v1/orders`](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json), [S3](https://openapi.tossinvest.com/openapi-docs/faq.md)

## 인증·권한·한도·이용 조건

WTS 설정의 Open API에서 클라이언트 ID·시크릿과 허용 IP를 등록하는 절차가 문서화되어 있다. 허용 목록에 없는 IP는 403으로 차단한다. 토큰 발급은 form-urlencoded 본문의 `grant_type=client_credentials`, `client_id`, `client_secret`을 사용한다. 이후 Bearer 토큰을 보내며 시크릿은 서버 측에서 사용하도록 정의한다. 클라이언트당 유효 토큰은 하나이고 재발급 시 기존 토큰이 무효화되며 refresh token은 없다. `expires_in`은 남은 초이고 86400은 예시값이다. 별도 사용자 위임 Authorization Code 흐름·읽기 전용 scope는 S1에 정의되지 않았다. `securitySchemes`의 clientCredentials `scopes`가 빈 객체라는 사실이 실제 읽기 전용 권한을 보장하지 않는다. [S1: OAuth2TokenRequest, OAuth2TokenResponse, securitySchemes](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json), [S2, 시작하기](https://openapi.tossinvest.com/openapi-docs/overview.md), [S3](https://openapi.tossinvest.com/openapi-docs/faq.md)

계좌 목록 자체는 Bearer 토큰으로 조회하며 계좌 선택 헤더 파라미터가 없다. 보유·매수 가능 금액·거래내역·주문 조회에는 목록에서 받은 `accountSeq`를 `X-Tossinvest-Account`로 전달한다. 문서 개요의 계좌 카테고리 전체에 대한 요약보다 각 경로의 파라미터를 구분했다. 본인 인증 정보가 주문 권한까지 갖는지와 조회 전용 클라이언트 발급 가능 여부는 **미확인**이다. 제품 도구에서 주문을 제외하는 것과 공급자 자격증명 자체를 조회 전용으로 제한하는 것은 다르다. [S1: `/api/v1/accounts`, AccountSeq, 각 계좌 경로](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)

| 이번 조사 대상 요청 그룹 | 문서상 초당 최대 요청 수 |
| --- | --- |
| `AUTH` / `ACCOUNT` | 5 / 1 |
| `ASSET` / `TRANSACTION` | 5 / 5 |
| `STOCK` / `STOCK_ALL` | 5 / 1 |
| `MARKET_DATA` / `MARKET_DATA_CHART` | 15 / 20 |
| `RANKING` / `MARKET_INFO` | 5 / 3 |
| `ORDER_HISTORY` / `ORDER_INFO` | 5 / 6. `ORDER_INFO`는 09:00~09:10 KST에 3 |

한도는 클라이언트×그룹 단위이며 사전 공지 없이 바뀔 수 있다. 정상·429 응답의 `X-RateLimit-Limit`, `Remaining`, `Reset` 및 429의 `Retry-After`가 현재 계약의 관측값이다. 의심 IP 대역은 초당 1회로 제한할 수 있다. 표는 실행 성능 측정값이 아니며 총 일일 한도·계정별 과금·유료 시세 권리·요금제별 차이는 이번 자료에서 확인하지 못했다. [S2, Rate Limits](https://openapi.tossinvest.com/openapi-docs/overview.md)

오류는 일반 API의 `error.requestId/code/message/data` envelope과 OAuth 표준 오류가 구분된다. 401의 만료·무효·폐기 토큰, 403의 IP·권한, 404 종목·계좌, 429 요청 한도를 성공 빈 결과로 바꿀 수 없다. 동일 클라이언트의 병렬 프로세스별 재발급은 서로를 무효화한다는 FAQ 설명이 있으므로, KIS 제거 후 인증·공유 상태 설계는 토스의 실제 계약을 기준으로 별도 결정해야 한다. [S1: ErrorResponse, OAuth2ErrorResponse](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json), [S2, 에러 응답](https://openapi.tossinvest.com/openapi-docs/overview.md), [S3, 인증·접속](https://openapi.tossinvest.com/openapi-docs/faq.md)

가입 자격·별도 약관 전문·데이터 장기 보관 및 AI 처리 허용·재배포 정의·보안 요구의 전체 조건은 **미확인**이다. FAQ의 제3자 배포 금지는 확인했지만, 그 적용 범위를 이번 조사에서 법률 판단하거나 사용자 대신 약관에 동의하지 않았다. 실제 인증 준비와 데이터 전달·보관 경계는 후속 결정 대상이다. [S3, 데이터 이용 정책](https://openapi.tossinvest.com/openapi-docs/faq.md)

## 남은 질문과 최소 관측 후보

다음 항목은 미확인 사항을 좁히기 위한 후보이며 실호출 승인이나 제품 요구사항 확정이 아니다. 공식 문서가 이미 명시한 한계를 반복 호출로 뒤집으려 하지 않는다.

1. **이용 조건과 조회 권한**: 원자료·요약·추천 근거를 외부 AI에 전달할 수 있는지, 조회 전용 자격증명이 가능한지 공급자 공식 설명으로 확인한다. 계좌 자료를 실제 모델에 보내는 실험보다 먼저 해소할 질문이다.
2. **식별·유형**: 승인된 시장 데이터 자격증명이 준비되면 특수 티커, 보통주, 보통주·우선주 ADR, ETF·ETN·워런트의 작은 고정 표본을 `/stocks`에서 읽어 시장·ISIN·유형·보통주 플래그를 독립된 증권 근거와 연결한다. 분류 필드의 ADR 기초 권리 의미는 공급자 설명 없이는 표본 일치만으로 일반화하지 않는다.
3. **캔들 날짜·페이지·원천**: 미국 표본 하나에서 완료 거래일과 진행 중 거래일, 서머타임 전후의 timestamp, `nextBefore` 경계, true/false 조정 차이를 소량 관측한다. OHLC·종합 거래량의 표시와 반환 날짜를 검사하며 NBBO·정규장 전용 거래량을 기대값으로 두지 않는다. 완료 게시 시각 보장은 관측 한 번으로 확정하지 않는다.
4. **순위**: 미국 시장 거래량·거래대금 순위에서 `rankedAt`, 원래 순위, count 이하 반환과 마스터 연결을 관측한다. 거래소별 상위 순위 보존이 필요한지 먼저 결정하며, 미국 전체 상위 100개를 거래소별 완전 순위로 해석하지 않는다.
5. **계좌 자료**: 별도 승인을 받은 뒤 본인 계좌 한 개의 보유·KRW/USD 매수 가능 금액과 거래내역 소량을 로컬에서만 비교한다. 미결제 포함·결제일 필터·취소·환전 두 행·페이지 종료를 검사한다. 개인 원자료를 연구 문서나 공유 증거에 저장하지 않는다. 주문 생성·정정·취소는 관측에 필요하지 않다.

문서만으로 확정할 수 있는 API 존재와 명시적 제약은 위에 기록했다. 기존 여섯 순위·20일 분석·내장 LLM·보고서·유형 판단을 유지할지, 어떤 계좌·현금 의미가 필요한지는 이 결과를 입력으로 별도 결정한다. 다른 공급자나 추정치로 빈틈을 채우는 방안은 채택하지 않았다.

## 조사 작업 기록과 검증 한계

- `research` 스킬과 호스트의 자료 수집 절차, 작업 질문·지도, 기존 제품 명세와 이번 조사 티켓의 본문 및 댓글 부재, 용어집·관련 ADR·현재 호출 생산자와 소비자를 확인해 범위를 정했다.
- Context7 조회는 일반 샌드박스에서 mise 추적 경고와 `fetch failed`로 종료 코드 1을 반환했고, 동일 명령의 승인된 외부 재시도는 성공했다. 설치·인증 설정은 바꾸지 않았다.
- 웹 읽기에서 `/docs`·시장·계좌·자산 페이지는 JavaScript 셸만 보였고 `/docs/stock` 및 `/llms.txt`는 Internal Error였다. 공식 도메인 검색은 오래된 참조를 찾았으며 결론은 현재 공개 원본으로 다시 확인했다.
- 공개 수집기의 `/llms.txt` 첫 호출은 `network_error`로 종료 코드 1을 반환했고 승인된 재시도는 성공했다. 안내된 정식 JSON·개요·FAQ도 인증 없는 공개 GET으로 수집했다. 전체 원본은 저장소 밖의 작업 전용 디렉터리에 보관했다.
- 작성한 변경은 이 문서 한 개다. 수정·되돌리기 실패는 없었다. 소스·필드·경로를 대조하는 내용 검토만 수행했다. 제품 코드·테스트·훅·실제 인증·계좌 접근·키 발급·약관 동의·주문·커밋·푸시·원격 이슈 쓰기는 범위 밖이므로 실행하지 않았다.
