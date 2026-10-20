# 제3자 종목 유형·증권 연결 공급자 조사

2026-10-19 [#250](https://github.com/mochafreddo/stock-scout/issues/250)의 후속 조사다. [ADR 0006](adr/0006-third-party-security-type-sources.md)에 따라 개인이 직접 가입하여 자동 API 이용을 할 수 있는 제3자 공급자를 검토했다. [ADR 0005](adr/0005-official-security-type-sources.md)의 개별 증권 연결·ADR 기초 권리·현재성 조건은 유지하며 시세·거래량·거래대금·순위의 공급자는 KIS로 유지한다.

## 결과와 확인 범위

현재 차단 범위는 [2026-10-20 재검토](#2026-10-20-자동-이용보관-차단-범위-재검토)를 따른다. 아래 2026-10-19 조사와 후속 확인은 당시 근거와 판단의 이력이다.

**공개 문서 조사는 완료했지만 공급자 채택은 보류한다.** 상세 후보는 Massive, EODHD, Financial Modeling Prep(FMP)의 3개다. Massive는 보통주 ADR과 우선주 ADR을 나누는 문서상 분류가 가장 직접적이나 자동 판별 용도에 적용되는 추가 이용 조건이 미해결이다. EODHD는 유형과 미국 종목별 세부 범주를 제공하지만 ADR 기초 권리를 확정할 필드 조합의 의미가 부족하다. FMP는 ADR·ETF 표시와 식별자를 제공하지만 필요한 전체 유형 구분을 입증하지 못했다. 세 판정의 근거와 재개 조건은 아래 공급자별 절에 기록한다.

이번에는 공개 문서·요금·정책을 웹 본문 추출로 읽었다. 가입·약관 동의·키 발급·결제·인증 API 요청·데모 토큰 요청·KIS 호출을 하지 않았다. 문서에 실린 JSON과 종목 예시는 문서 예시로만 취급한다. 실제 표본 응답, 무료 계정의 종목별 접근 권한, KIS와의 대응, 현재 적용 가능성을 확인한 결과가 아니다. 정상 응답에서 표본이 없었다는 관측도 없다.

[선별 수집 근거](evidence/issue-250/third-party-sources.json)는 별도 익명 HTTPS 수집과 웹 추출을 구분한다. 직접 수집에서 Massive의 지정 문서 6개와 EODHD 약관은 HTTP 200이었고, EODHD 유형·가격 문서는 30초 시간 초과, FMP 가격·갱신 주기·약관은 HTTP 403이었다. 실패 본문은 확보하지 않았다. 아래 해당 내용은 웹 추출로 읽은 결과이며 직접 수집 성공이나 공급자 API의 접근 거부를 뜻하지 않는다.

## 개요 선별

공개 소개와 참조 자료를 먼저 비교한 뒤 아래 3개만 상세 평가했다. Alpha Vantage와 Finnhub는 이번 상세 평가 대상에 넣지 않았으며 영구적인 부적합 판정은 아니다. 영업 문의나 기업 계약이 필수인 경로는 상세 평가하지 않았다.

| 개요 후보 | 개요 단계에서 확인한 범위와 상세 평가 선택 |
| --- | --- |
| Massive | 무료 Reference Data와 종목 유형 API를 명시하여 상세 평가에 포함했다. [요금](https://massive.com/pricing), [유형 API](https://massive.com/docs/rest/stocks/tickers/ticker-types) |
| EODHD | 무료 Search와 구조화된 유형·식별자, 유료 Fundamentals를 제공하여 상세 평가에 포함했다. [Search](https://eodhd.com/financial-apis/search-api-for-stocks-etfs-mutual-funds), [Fundamentals](https://eodhd.com/financial-apis/stock-etfs-fundamental-data-feeds) |
| FMP | 개인 무료·유료 요금과 종목별 Profile·식별자 경로를 제공하여 상세 평가에 포함했다. [요금](https://site.financialmodelingprep.com/pricing-plans), [Profile](https://site.financialmodelingprep.com/developer/docs/stable/profile-symbol) |
| Alpha Vantage | 공식 개요가 주식·ETF·펀드·Fundamental Data와 무료 키를 안내한다. 이 개요만으로 ADR 기초 권리의 세부 분류를 확인하지 못했으며 위 3개를 우선했다. [공식 개요](https://www.alphavantage.co/) |
| Finnhub | 공식 API 명세에 MIC·OpenFIGI 유형을 받는 Stock Symbol 경로가 있다. 개요 선별에서 확인한 기능이며 요금·약관·ADR 권리·최신성까지 평가한 네 번째 상세 후보가 아니다. [공식 OpenAPI](https://github.com/Finnhub-Stock-API/finnhub-go/blob/master/api/openapi.yaml) |

## Massive

### 이용 경로와 비용

개인용 API 계약과 계정 등록 경로가 있다. Individuals Terms §2는 개인·비상업·비사업 목적의 서비스 사용권을 명시하고 §3은 계정을 요구한다. 함께 적용되는 Market Data Terms §5(d)는 라이선스 없는 non-display use와 투자 전략 등을 포함하는 파생물 생성을 제한하며 §9는 충돌 시 해당 조건의 우선을 설명한다. **Reference API의 기술적 제공과 이 CLI 용도에 대한 허용을 같은 것으로 판단하지 않는다.** 호가·체결가를 다루는 Market Data 조건이 참조 분류 메타데이터에 적용되는 범위와 명시적 예외를 확인하지 못했다. 따라서 이 CLI가 금지됐다는 결론도, 개인 요금만으로 필요한 권리가 충족된다는 결론도 내리지 않는다. 이번 보류는 이용 목적의 적용 관계가 미해결인 채택 판단이다. [Individuals Terms](https://massive.com/legal/individuals-terms-of-service), [Market Data Terms](https://massive.com/legal/market-data-terms-of-service)

Stocks Basic은 $0/월, 분당 5회이며 Reference Data를 포함한다. Ticker Types·All Tickers·Overview 문서는 모두 Basic을 포함한 모든 Stocks 요금제의 접근을 명시한다. 따라서 필요한 필드의 문서상 최소 요금은 무료다. 유료 최저 Stocks Starter는 월 결제 $29/월이며 무제한 API 호출을 표시한다. 유료 전환이 ADR 권리 의미나 이용 목적의 허용 문제를 해결한다는 근거는 없다. [요금](https://massive.com/pricing), [Types 접근](https://massive.com/docs/rest/stocks/tickers/ticker-types), [All Tickers 접근](https://massive.com/docs/rest/stocks/tickers/all-tickers), [Overview 접근](https://massive.com/docs/rest/stocks/tickers/ticker-overview)

유료 계약은 월·연 반복 결제이며 세금은 별도다. 연간 구매는 연간 전체 금액을 청구하고 취소는 현재 기간 말에 적용되며 이미 낸 금액의 비례 환불을 보장하지 않는다. 연간 할인율을 월 결제 가격으로 오인하지 않는다. 가입 시 비전문가 자격과 적용되는 추가 조건 확인도 남아 있다. [Individuals Terms §4·§8](https://massive.com/legal/individuals-terms-of-service), [비전문가 안내](https://massive.com/knowledge-base/article/am-i-a-professional-or-non-professional-subscriber)

### 유형·증권 연결·현재성

공식 유형 안내는 `CS=Common stock`, `PFD=Preferred stock`, `ETF`, `ETN`, `WARRANT`, `ADRC=American Depositary Receipt, common`, `ADRP=American Depositary Receipt, preferred`를 구분한다. ADR 여부만 제공하는 자료보다 직접적인 후보 근거다. 다만 안내 자체가 현재 전체 코드의 권위는 Types API라고 명시한다. 실제 코드 목록과 BBD/BBDO·TSM의 반환 분류는 아직 받지 않았다. `ADRC` 문구를 수탁 비율·의결권 등 모든 기초 권리의 보장으로 확대하지 않는다. [공식 유형 안내](https://massive.com/knowledge-base/article/what-are-the-different-types-of-tickers-that-massive-supports), [Types 계약](https://massive.com/docs/rest/stocks/tickers/ticker-types)

Overview는 개별 `ticker`, `primary_exchange`의 ISO 코드, 선택적 `composite_figi`·`share_class_figi`, `type`을 제공한다. 회사 단위 CIK만 쓰는 것보다 증권별 연결에 적합한 필드 구성이라는 판단이다. 실제 FIGI 존재·유일성과 KIS 거래소·원본 코드의 대응은 미검증이다. All Tickers는 페이지당 최대 1000개와 `next_url`을 문서화하므로 전체 목록을 한 응답으로 가정하지 않는다. [Overview](https://massive.com/docs/rest/stocks/tickers/ticker-overview), [All Tickers](https://massive.com/docs/rest/stocks/tickers/all-tickers)

심볼은 대소문자를 보존해야 한다. 공식 안내의 종류주 `.`와 우선주 소문자 `p` 규칙은 공급자 표기의 설명이며 KIS `BAC/B`·`BAC/L`을 기계 치환해도 같은 증권이라는 증명은 아니다. 워런트·권리·유닛은 추측 대신 조회하도록 안내한다. 이름 검색은 발견 보조 수단이며 회사명이 같은 결과의 자동 병합 근거가 아니다. [심볼 표기 안내](https://massive.com/knowledge-base/article/why-are-ticker-symbols-with-dashes-not-showing-in-massives-system)

All Tickers·Overview는 일일 갱신, Types는 필요시 갱신을 명시한다. All Tickers의 선택적 `last_updated_utc`는 정보가 정확한 기준 시각으로 정의된다. Overview의 `date` 기본값은 최신 가용 날짜이며 SEC 정보에는 보고 대상 기간을 비교하는 별도 의미가 있다. 일일 갱신을 장전 특정 시각까지 기업행동·권리 변경이 반영된다는 보장으로 읽지 않는다. 표본별 기준 시각·필드 누락·상장 변경 반영 지연과 허용 유효기간은 미확정이다. [All Tickers](https://massive.com/docs/rest/stocks/tickers/all-tickers), [Overview](https://massive.com/docs/rest/stocks/tickers/ticker-overview), [Types](https://massive.com/docs/rest/stocks/tickers/ticker-types)

**판정: 채택 보류, 기술적 우선 후보.** 재개 조건은 이 용도의 자동 이용에 적용되는 권리 확인, 실제 Types·표본 분류와 KIS 증권 연결, 현재성 검사 기준이다. 유료 구매나 계정 생성을 먼저 진행할 근거로 삼지 않는다.

## EODHD

### 이용 경로와 비용

개인 토큰을 사용하는 API가 있으며 Search는 무료 가입 토큰을 안내하고 데모 토큰은 지원하지 않는다. Terms는 비전문 개인의 투자 활동을 위한 비공개 저장·가공·분석을 허용하고 계정 공유와 제3자 재배포·표시를 제한한다. 개인 CLI 자동 분석의 검토 근거는 있으나 선별 실응답을 저장소나 이슈에 게시할 권한까지 확인한 것은 아니다. [Search](https://eodhd.com/financial-apis/search-api-for-stocks-etfs-mutual-funds), [Terms의 Personal Use·Access](https://eodhd.com/financial-apis/terms-conditions)

무료는 하루 20 API call 단위·분당 20요청이며 Fundamentals는 포함하지 않는다. Search의 무료 유형·선택 ISIN만으로 ADR 권리 전체를 충족하지 못한다. `General.HomeCategory`와 `UpdatedAt`을 평가할 유료 최소 후보는 Fundamentals Data Feed다. 가격은 월 결제 $59.99/월 또는 연 결제 $599.90/년이며 표시 월 환산 $49.99를 월별 결제로 취급하지 않는다. 유료는 하루 100000 call 단위·분당 1000요청이고 Fundamentals 한 요청은 10 call 단위를 소비한다. 하루 한도는 GMT 자정에 초기화된다. 일반 약관의 100000요청 문구를 무료 요금 한도로 적용하지 않는다. [현재 일반 요금표](https://eodhd.com/pricing)

최소 이용 기간은 한 달이며 구독 결제는 환불하지 않는다고 안내한다. 현재 공개 요금에는 연 결제도 있으므로 일반 약관의 월 구독 설명만으로 연 결제 취소·갱신 조건을 추정하지 않는다. 실제 결제 총액·세금·자동 갱신 조건은 선택 시 확인할 항목이다. [요금 안내](https://eodhd.com/pricing), [Terms의 Non-Refundable Payments·Access](https://eodhd.com/financial-apis/terms-conditions)

### 유형·증권 연결·현재성

목록은 `Code`, `Exchange`, `Type`, 선택적 `Isin`을 제공하고 `common_stock`, `preferred_stock`, `stock`, `etf`, `fund` 필터를 문서화한다. `US`는 NYSE·Nasdaq·NYSE Arca·OTC 등을 합한 코드이므로 KIS 거래소와 일대일 대응하지 않는다. 기본 목록은 지난 한 달에 활성 상태였던 종목을 포함한다. 이를 실행 시점의 거래 가능성 보장으로 읽지 않는다. [Supported Tickers](https://eodhd.com/financial-apis/covered-tickers-eodhd)

Fundamentals 용어집은 `General.Type`을 Common Stock 또는 Preferred Stock으로 정의하고 `HomeCategory`에 ADR·ADR Primary·ADR Secondary·ADR Preferred·ADR Warrant·ETN·Warrant 등을 열거한다. 그러나 ADR·ADR Primary가 기초 보통주를 뜻한다는 명시적 정의와 `Type`이 ADR 자체 및 기초 주식 중 어느 권리를 분류하는지까지 확인하지 못했다. `HomeCategory=ADR`와 `Type=Common Stock`의 조합만으로 BBD의 기초 우선주를 배제하는 규칙을 정하지 않는다. [Fundamentals 용어집](https://eodhd.com/financial-academy/financial-faq/fundamentals-glossary-common-stock)

같은 용어집은 `Exchange`가 이 공급자의 거래소 코드이며 primary exchange가 아니라고 명시한다. `PrimaryTicker`와 `Listings`는 같은 회사의 다른 상장 정보를 다루므로 서로 다른 종류주·ADR의 동등성을 뜻하지 않는다. Search의 `isPrimary`·ISIN도 실제 표본의 증권별 대응과 함께 확인해야 한다. [용어집](https://eodhd.com/financial-academy/financial-faq/fundamentals-glossary-common-stock), [Search 응답 정의](https://eodhd.com/financial-apis/search-api-for-stocks-etfs-mutual-funds)

`UpdatedAt`은 수동 또는 자동으로 해당 Fundamentals 파일을 마지막 갱신한 날짜다. 용어집이 해당 시각과 직접 연결하는 범위는 Highlights·SharesStats·Valuation이며, 종목 권리·유형의 적용일이나 모든 기업행동의 반영 시각이라는 정의는 아니다. 따라서 파일 날짜만으로 현재 권리를 통과시키거나 임의의 하루 유효기간을 설정하지 않는다. [UpdatedAt 정의](https://eodhd.com/financial-academy/financial-faq/fundamentals-glossary-common-stock)

**판정: 채택 보류, 유료 보완 후보.** 재개 조건은 ADR 범주와 기초 권리의 관계, 실제 BBD/BBDO 등의 값과 KIS 연결, 유형·권리 변경의 반영 범위 확인이다. 무료 Search만으로 완료하거나 Fundamentals 결제만으로 해결됐다고 판단하지 않는다.

## Financial Modeling Prep

### 이용 경로와 비용

FMP는 계정 가입으로 API 데이터에 접근하는 개인 사용권을 제공한다. Personal Use는 본인의 비사업·비상업 목적에 한정되고 가격표는 표시·재배포에 별도 Data Display and Licensing Agreement가 필요하다고 밝힌다. Terms §2.2는 사전 서면 승인 없는 복사·파생물 생성을 제한하고 §2.2.1은 콘텐츠의 복사·다운로드에도 사전 서면 승인을 요구한다. API 제공 조건과 이 제한이 개인 CLI의 자동 조회·저장·유형 분류에 어떻게 함께 적용되는지 확인하지 못했다. 개인 API 접근권만으로 이 용도의 허용을 확정하지 않으며 API 자체의 이용 금지라고 단정하지도 않는다. 제3자에게 결과·원자료를 게시할 권한도 별도 확인 대상이다. [Terms §1·§2.1–§2.2.1](https://site.financialmodelingprep.com/terms-of-service), [가격표의 이용 조건](https://site.financialmodelingprep.com/pricing-plans)

Basic은 $0/월, 하루 250회와 최근 30일 500MB 한도다. Profile and Reference Data가 포함된다고 표시하지만 문서의 `Limited Access`와 요금표의 종목 제한 표시 때문에 모든 필수 표본이 무료로 가능하다고 확정하지 않는다. 공개 추출된 요금표는 기능과 권한의 열 대응을 모두 보존하지 못하므로 최저 필요 요금제도 확정하지 않는다. Starter의 확인한 가격은 **월 환산 $19, 연 결제**이며 연간 환산 합계는 $228다. 분당 300회·최근 30일 20GB·US Coverage를 표시한다. 취소선 $29를 검증된 월 결제 선택 결과로 기록하지 않는다. [현재 요금표](https://site.financialmodelingprep.com/pricing-plans), [통합 API 문서](https://site.financialmodelingprep.com/developer/docs)

계약상 별도 표시가 없으면 USD·세금 별도·선불·자동 갱신이며 현재 결제 기간 종료 전에 취소하면 다음 기간부터 적용된다. 환불을 보장하지 않는다. 유료 결제가 필수 세부 유형을 추가한다는 문서 근거는 확보하지 못했다. [Terms §1](https://site.financialmodelingprep.com/terms-of-service)

### 유형·증권 연결·현재성

통합 문서의 Profile 예시는 `symbol`, `exchange`, `isin`, `cusip`, `cik`, `isEtf`, `isFund`, `isAdr`, `isActivelyTrading`을 포함한다. 예시와 Profile 안내는 증권 연결에 활용할 식별자 경로의 근거지만 `isAdr=true`가 기초 보통주를 뜻하지 않는다. 확인한 문서에는 이 불리언 조합으로 우선주·워런트·ETN을 모두 구분하거나 보통주임을 긍정하는 완전한 유형 계약이 없다. 모두 false라는 이유만으로 보통주에 포함할 수 없다. [통합 Profile 예시](https://site.financialmodelingprep.com/developer/docs), [Profile 안내](https://site.financialmodelingprep.com/developer/docs/stable/profile-symbol)

CIK 조회와 회사명은 증권 연결의 최종 키로 삼지 않는다. ISIN·CUSIP·거래소·심볼을 제공하는 것과 BAC/B·BAC/L, GOOG·GOOGL을 KIS 원본 코드에 유일하게 대응한 것은 별개다. Exchange Variants는 여러 거래소의 상장을 찾는 기능이며 증권별 동등성을 검증하는 작업이 남는다. [검색·Exchange Variants 문서](https://site.financialmodelingprep.com/developer/docs), [Profile 식별자](https://site.financialmodelingprep.com/developer/docs/stable/profile-symbol)

Cycle Times는 Company Profile Data를 `Ad-Hoc`, Delisted Companies를 2~4시간, Company Profile Bulk를 4~6시간으로 표시한다. Symbol Changes API는 합병·인수·분할·이름 변경에 따른 심볼 변경 추적을 설명한다. 이 값은 개별 Profile의 권리 적용일이나 장전까지 모든 유형 변경이 반영된다는 보장이 아니다. Bulk의 주기를 단일 Profile에 적용하지 않으며 심볼 변경 이력만으로 권리 변경 전체를 확인했다고 보지 않는다. [Cycle Times](https://site.financialmodelingprep.com/developer/docs/cycle-times-stable), [Symbol Changes](https://site.financialmodelingprep.com/developer/docs/stable/symbol-changes-list)

**판정: 채택 보류, 식별·ETF/ADR 표시의 보완 후보.** 재개 조건은 이 CLI의 자동 조회·저장·분류에 적용되는 이용 조건과 복사·다운로드·파생물 제한의 관계, 보통주·ADR 기초 권리·우선주·워런트·ETN의 명시적 유형 계약, 필수 표본의 접근 권한과 최소 요금, 현재성 기준이다. 유료 업그레이드를 해결책으로 정하지 않는다.

## 실제 응답으로 남은 공통 표본

다음은 [기존 공식 조사](official-security-type-validation.md)와 [설계](security-type-probe-design.md)의 검증 의무를 이어받은 표다. 이번 제3자 자료의 실제 값은 모든 행에서 **미요청·미검증**이다. 아래 목표는 공급자가 현재 해당 값을 반환했다는 주장이 아니며 종목별 정답을 코드에 내장할 계획도 아니다.

| 표본 | 후속 검증의 구분과 필요한 증거 |
| --- | --- |
| BBD / BBDO | 같은 발행사의 우선주 ADR·보통주 ADR을 별도 증권으로 연결하고 명시적인 분류 의미에 대조한다. 공급자 값이 기존 반대 근거와 다르면 해결 근거가 필요하다. |
| TSM | ADR 여부와 기초 보통주 분류를 나누어 확인한다. |
| ACONW / ADSEW | 이름이나 접미사 추정 없이 워런트 분류와 해당 증권 연결을 확인한다. |
| SPY / VXX | ETF와 ETN을 구분하고 기존 자료 간 ETP 표시 차이를 해결한다. VXX의 과거 동명 증권을 현재 증권과 연결하지 않는다. |
| GOOG / GOOGL | 같은 회사의 별도 주식 종류와 식별자를 보존한다. |
| AAPL / SHOP | 보통주와 외국 발행사의 직접 상장을 확인하며 국적·이름만으로 ADR을 추정하지 않는다. |
| BAC/B / BAC/L | KIS의 원본 표기와 공급자의 종류주·우선주 표기를 공식 식별 근거로 연결한다. 구두점 치환·회사명 병합만으로 확정하지 않는다. |

## 채택을 재개할 조건과 종료 범위

이번 비교에서는 무료로 모든 요구사항을 충족한 경로도, 결제하면 나머지가 해결되는 경로도 입증하지 못했다. 기술적 우선 후보인 Massive를 포함하여 채택은 보류하고 최대 3개의 상세 평가를 여기서 종료한다. 공급자를 추가로 바꾸어 계속 조사하거나 승자를 강제로 정하지 않는다.

재개에는 이용 목적에 적용되는 자동 사용권, 필요한 유형의 명시적 의미, 실제 표본의 개별 증권 연결과 반대 근거 해결, 유형·권리의 기준일 및 변경 반영 범위가 필요하다. 가입·키 발급·결제·실연동은 공급자 선택 뒤 별도 승인 범위다. 개인 계약이 허용하는 비공개 이용과 공유 저장소의 실응답 증거 게시 권한도 구분한다.

다음 결정의 우선 대상은 Massive 참조 메타데이터의 개인 자동 사용에 적용되는 문서·계약 범위다. 그 관계가 확인되면 별도 승인된 무료 계정과 최소 표본 요청으로 taxonomy·증권 연결·현재성을 검증할 수 있다. 공급자 문의를 필수 경로로 정한 것은 아니며 이번 조사에서 문의를 보내지 않았다. 공개 문서만으로 해소되지 않으면 보류를 유지한다.

정상 자료의 미대응·권리 불확정은 유형 미확인으로 개별 제외하고, 식별 모호함과 필수 자료의 조회·해석·현재성 확인 실패는 전체 실패로 처리하는 기존 계약을 유지한다. 모든 입력을 미확인으로 제외하는 결과는 적격 보통주·ADR 자동 확인의 성공이 아니다. 이 조사는 후보군 분류기를 구현하거나 운영 유효기간·재시도·전체 시간 제한을 정하지 않았다. #250·#243·#239·#245 및 후속 추천의 기존 차단을 유지한다. [ADR 0005](adr/0005-official-security-type-sources.md), [ADR 0006](adr/0006-third-party-security-type-sources.md), [자동 검증 설계](security-type-probe-design.md)

검증 범위는 인용한 공개 문서의 의미·가격 조건·미검증 표기와 기존 계약의 정합성이다. 코드 변경과 새 코드 테스트가 없는 문서 조사이며, 기존 회귀 검사의 통과나 공개 문서 열람을 실제 API 통합 검증으로 기록하지 않는다.

## Massive 참조 자료의 개인 자동 이용 범위 후속 확인

2026-10-19 후속 설계에 따라 Massive 한 곳의 이용 범위를 확인했다. **최종 판정은 판단 보류이며 공급자 채택 보류를 유지한다.** 개인용 스크립트의 일반적인 이용 안내는 확인했지만, 유형·식별 자료의 자동 연결·후보 포함 여부 판단에 적용되는 비표시 이용 권한과 원자료 없는 검증 결론의 공개 범위까지 확인하지 못했다. 법률상 금지나 영구적인 이용 불가를 확정한 판정은 아니다. [선별 수집 기록](evidence/issue-250/massive-reference-usage.json)과 [문의 초안](massive-reference-usage-inquiry.md)에 근거와 남은 질문을 연결했다.

### 확인한 근거와 적용 한계

| 확인 대상 | 공식 자료에서 확인한 내용 | 이번 용도에서 남은 판단 |
| --- | --- | --- |
| 개인용 서비스의 범위 | Individuals Terms §1은 증권과 금융시장 관련 기타 정보까지 Market Data 정의에 포함하고 Market Data Terms를 편입한다. §2의 개인·비사업·비상업 사용권도 계약 조건을 따른다. | 참조 메타데이터를 시세와 다르다는 이유만으로 편입 조건에서 제외할 근거는 확보하지 못했다. [Individuals Terms](https://massive.com/legal/individuals-terms-of-service) |
| 본인만 쓰는 앱과 스크립트 | 공식 안내는 개인 연구·스크립트·거래와 본인만 쓰는 앱을 개인 요금제의 용도로 설명한다. 다른 사람이 데이터를 보는 앱은 Business 범위로 구분한다. | 이 안내는 개인 도구의 일반적 근거다. 유형 자료의 자동 분류에 대한 별도 허용과 아래 제한의 적용 관계를 설명하지는 않는다. [개인 앱 안내](https://massive.com/knowledge-base/article/which-plan-do-i-need-to-show-massive-data-in-my-app) |
| 자동 연결·후보 포함 판단 | Market Data Terms §2는 별도 약정이 없는 표시 용도 제한을 두며 §5(d)는 허가 없는 비표시 이용과 파생물 생성을 제한한다. §9는 약관 간 충돌 시 이 조건의 우선을 명시한다. | 종목 유형·식별 자료의 코드 처리에 이 제한이 적용되는지, 개인 사용권에 필요한 허가가 포함되는지는 판단 보류다. 개인 CLI라는 사실만으로 예외를 확정하지 않는다. [Market Data Terms](https://massive.com/legal/market-data-terms-of-service) |
| 비공개 저장·공유 문서 | 같은 약관 §5(c)는 원자료뿐 아니라 이를 바탕으로 하거나 참조한 연구·분석 등의 제3자 전달을 제한한다. §8은 계정 등의 종료·제한·정지 시 이용 중단과 보유 자료 삭제를 요구한다. | 원자료를 빼면 종목별 분류 결론이나 검증 요약을 공개할 수 있다고 가정하지 않는다. 필요한 응답의 비공개 보관 범위·기간과 데이터에 의존하지 않는 방법 설명의 공개 가능성을 각각 확인해야 한다. [Market Data Terms](https://massive.com/legal/market-data-terms-of-service) |
| 문의 경로 | 공식 약관 안내는 질문을 `support@massive.com`으로 안내하고 개인 앱 안내는 용도 설명을 통한 문의 경로를 제시한다. | 문의 초안만 작성했다. 전송이나 답변 대기는 이번 작업의 완료 조건이 아니다. [약관 안내](https://massive.com/legal/terms), [개인 앱 안내](https://massive.com/knowledge-base/article/which-plan-do-i-need-to-show-massive-data-in-my-app) |

### 수집과 검증의 범위

Individuals Terms·Market Data Terms·개인 앱 안내·약관 안내의 네 페이지를 익명 HTTPS GET으로 수집해 HTTP 200을 확인했다. 약관 페이지에 표시된 개정일은 각각 2025-07-18과 2025-08-28이다. 수집 HTTP 시각과 약관 개정일을 구분하며 HTTP 시각을 데이터 기준일로 취급하지 않는다. 비표시 이용의 전용 안내를 찾기 위해 시도한 한 주소는 HTTP 404였으며 해당 안내의 존재나 허용·금지 근거로 사용하지 않았다. 공식 도메인 대상 추가 검색에서도 검토한 자료의 미해결 관계를 해소할 근거를 확보하지 못했으며 사이트 전체에 그런 근거가 없다고 주장하지 않는다.

API 문서 확인 경로로 Context7의 Massive 공식 클라이언트 자료를 먼저 조회했지만 참조 API의 기술 설명만 확인되어 사용권 판단의 근거로 삼지 않았다. 실제 계약 범위는 위 공식 약관과 이용 안내를 대조했다. 원문은 저장소 밖 비공개 작업 증거로 보존하고 공유 증거에는 URL·조회 시각·HTTP 결과·해시와 확인 한계만 기록했다. 이번 수집은 인증 API 접근이나 약관 동의·계정 생성을 뜻하지 않는다.

### 종료와 재개 조건

이번 한정 확인은 판단 보류 사유와 문의 초안을 남기는 것으로 종료한다. 재개에는 지정한 참조 자료에 대한 자동 조회·증권 연결·후보 포함 판단·필요 응답 보관의 허용 근거가 필요하다. 검증 결과의 공개는 별도 범위이며 비공개 이용만 허용하는 공급자도 기존 합의에 따라 검토할 수 있다. 공개 불가 원자료는 저장소 밖에 두되 실제 저장 위치·재현 방법·보관과 삭제 조건은 채택 이후 별도로 정한다. 문의는 가능한 확인 수단이며 답변을 기다리는 일을 새 필수 선행 조건으로 추가하지 않는다.

가입·키 발급·결제·실연동·문의 전송·다른 공급자 추가 조사·분류기 확장은 수행하지 않았다. 유형·ADR 기초 권리·KIS 개별 증권 연결·현재성은 계속 미검증이다. 이용 범위가 확인되더라도 이 항목의 실제 검증과 공급자 채택은 다음 단계이며 #250·#243·#239·#245 및 후속 추천의 기존 차단을 유지한다.

## 2026-10-20 자동 이용·보관 차단 범위 재검토

**자동 연결·분류를 수행하는 실제 검증은 보류하되, 보관 기간의 설명 부족과 결과 공개의 미확정을 독립적인 전체 중단 이유로 삼지 않는다.**

이번에는 [Individuals Terms](https://massive.com/legal/individuals-terms-of-service), [Market Data Terms](https://massive.com/legal/market-data-terms-of-service), [개인 앱 안내](https://massive.com/knowledge-base/article/which-plan-do-i-need-to-show-massive-data-in-my-app) 세 건을 익명 HTTPS GET으로 다시 수집했다. 모두 HTTP 200이며 원문 SHA-256은 이전 수집과 각각 일치한다. 약관의 표시 개정일도 2025-07-18·2025-08-28로 같다. 새 허가나 약관 변경을 발견한 결과가 아니라 기존 보류 판단의 적용 범위를 좁힌 결과다. 수집 시각·해시·한계는 [선별 근거의 `reassessment`](evidence/issue-250/massive-reference-usage.json)에 기록한다.

| 대상 | 확인한 사실 | 남은 해석과 분류 | 직접 차단하는 작업 |
| --- | --- | --- | --- |
| 개인 API 이용 | Individuals Terms §1·§2와 개인 앱 안내는 개인·비상업 이용 및 본인 연구·스크립트·거래의 긍정적 근거다. 계약의 다른 조건도 적용된다. | 개인 스크립트 안내 자체가 없다는 설명은 부정확하다. 포괄적 개인 이용 허용과 특정 이용 제한은 함께 읽어야 한다. | 이 사실만으로 문서 열람이나 모든 API 사용을 일괄 차단하지 않는다. 이번 작업은 인증 API를 실행하지 않는다. |
| 자동 연결·분류·후보 포함 판단 | Market Data Terms §2에는 별도 약정이 없는 표시 용도 제한이 있고 §5(d)는 허가 없는 비표시 이용·파생물 생성을 제한한다. §9는 약관 충돌 시 우선순위를 둔다. | 제한은 명시적이다. 참조 유형·식별 필드의 코드 처리가 그 제한에 해당하는지, 필요한 허가가 개인 계약에 포함되는지는 적용 관계의 미확정이다. 개인 스크립트 안내와 법적 모순이라고 단정하지 않는다. | 해당 처리를 수행하는 실제 표본 검증·운영 채택의 재개는 보류한다. 참조 필드라는 이유로 예외를 가정하지 않는다. |
| 필요한 응답의 비공개 보관 | §2의 복사·전송 제한에는 공개·배포 또는 사업·상업 목적이라는 문맥이 있다. §8은 계약·계정의 종료·제한·정지 시 보유 Market Data의 이용 중단과 삭제를 명시한다. | 읽은 조항만으로 개인 로컬 보관 전체가 금지됐다고 볼 수 없다. 정해진 보관 일수가 없다는 점은 설명 부족이며 별도의 금지 근거가 아니다. 반대로 무기한 보관 허가를 확인한 것도 아니다. | 허용된 이용을 전제로 보관·백업·삭제 방법을 정할 필요가 있다. 기간 설명 부족만으로 비공개 검증을 별도 차단하지 않는다. 자동 이용의 미해결 제한은 그대로다. |
| 실제 결과 공개 | §5(c)는 원자료뿐 아니라 이를 바탕으로 한 분석 등의 제3자 전달을 제한한다. | 원자료 없는 종목별 결론의 공개 가능성은 별도 미확정이다. 이번에 재판정하지 않는다. | 해당 실제 결과의 게시 범위에만 적용하며 비공개 검증의 독립적인 차단 이유로 합치지 않는다. |

재개에 부족한 핵심 근거는 지정한 참조 자료의 자동 연결·분류·후보 포함 판단에 표시 용도 제한과 비표시 이용 제한이 어떻게 적용되는지다. 필요한 근거는 적용 계약·데이터별 조건의 허용 또는 예외다. 본문에 이 CLI의 이름이 없다는 이유만으로 별도 허가를 요구하는 것은 아니며, API의 기술적 접근 성공도 이용 범위의 증거는 아니다. 보관은 허용된 이용 범위와 삭제 의무에 맞춰 별도로 설계할 항목이며 기간 설명 부족을 추가 차단 조건으로 삼지 않는다. 공유 결과의 공개 권한은 그 결과를 게시할 때 판단한다.

문의가 이 적용 관계를 확인하는 수단일 수는 있지만, 문의 전송이나 답변 대기를 다음 필수 단계로 정하지 않는다. 이번 한 차례 재검토는 위 차단 범위와 부족한 근거를 기록하고 종료한다. 기존 문서·저장된 KIS 자료 검토와 독립적인 일정 검증은 Massive의 이용 범위에 의존하지 않으므로 계속할 수 있다. 이 작업에서 해당 검증을 추가 실행한 것은 아니다.

세 공식 문서의 수집 외에 가입·약관 동의·키 발급·결제·인증 API 요청·문의·분류기 변경은 수행하지 않았다. 실제 taxonomy·ADR 기초 권리·KIS 연결·현재성도 검증하지 않았다. 공급자 채택 및 #250 완료 조건 2의 부분 충족과 #243·#239·#245의 후속 차단은 유지한다. 이번 판단은 프로젝트의 재개 근거 평가이며 해당 사용의 법률상 금지나 영구적 이용 불가를 확정하지 않는다.
