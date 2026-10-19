# 외부 공식 종목 유형 자료의 자동화 가능성 조사

2026-10-19 사용자의 `$implement` 요청으로 수행한 [#250](https://github.com/mochafreddo/stock-scout/issues/250)의 후속 조사다. [ADR 0005](adr/0005-official-security-type-sources.md)와 최신 이슈 명세를 기준으로 Nasdaq·NYSE의 공개 구조화 목록, SEC 공시와 발행사 자료를 확인했다. [기존 KIS 조사](kis-security-identification.md)는 당시의 관측 기록이며, 종목 유형에 외부 공식 자료를 허용한 이번 합의와 구분한다. 시세·거래량·거래대금·순위와 그 밖의 종목 정보는 KIS로 유지한다.

## 결론

**무료 공개 파일의 실제 수집과 명시적인 유형 필드는 확인했다. 실행마다 현재 유효한 보통주·적격 ADR을 자동 판별하는 운영 경로의 검증은 미완료다. #250·#243 및 후속 후보군·추천 구현의 차단을 유지한다.** Nasdaq 목록 두 개와 NYSE Pillar 매핑 세 개를 인증 없이 내려받았다. NYSE 파일은 보통주·우선주·워런트의 구조화된 코드를 제공하지만 ADR 기초 권리까지 구분하지 않는다. SEC 공시와 발행사 자료로 BBD/BBDO의 차이를 확인할 수 있으나 결정적 자동 추출·후속 변경 확인은 검증하지 않았다.

조사 산출물은 이 문서와 [선별 수집 근거](evidence/issue-250/external-official-sources.json)다. 원본 해시·HTTP Date·크기·선별 행·실패를 남기고 전체 종목 파일이나 공시 원문은 커밋하지 않는다. 원본은 접근을 제한한 임시 조사 기록에 보관한다. HTTP 성공·웹 추출 성공·실제 CLI 자동 판별 성공을 구분하며 후보군 분류기는 만들지 않았다.

## Nasdaq 수집 경로와 실제 자료

공식 HTTPS 경로는 [nasdaqlisted.txt](https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt)와 [otherlisted.txt](https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt)다. 기존 공개 자료 수집기로 원본을 보존했으며 HTTP 응답 메타데이터와 필요한 표본을 읽었다. 아래 HTTP Date는 서버 응답 헤더의 시각이며 데이터 기준일이나 수집 프로세스의 시작·종료 시각이 아니다.

| 자료 | HTTP 상태 / HTTP Date | 크기 | 마지막 행의 원문 값 |
| --- | --- | --- | --- |
| `nasdaqlisted.txt` | `200` / `2026-10-19T07:31:27Z` | 349398 bytes | `File Creation Time: 1019202603:02` |
| `otherlisted.txt` | `200` / `2026-10-19T07:31:26Z` | 543200 bytes | `File Creation Time: 1019202603:02` |

실제 헤더는 다음과 같다. 구분자는 `|`이며 생성 시각 행을 종목 행으로 읽지 않아야 한다.

```text
Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares
ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol
```

## Nasdaq 공식 필드의 의미와 판별 한계

[공식 필드 정의](https://www.nasdaqtrader.com/Trader.aspx?id=SymbolDirDefs)에 따르면 Nasdaq 목록의 `Symbol`은 개별 상장 증권의 식별자다. `Market Category`의 `Q/G/S`는 상장 요건에 따른 시장 구분이며 증권 유형이 아니다. `Test Issue`도 시험 종목 여부다. 다른 거래소 목록의 `ETF=Y/N`은 ETF 여부를 명시한다. 보통주·우선주·워런트·ADR·ETN을 각각 구분하는 독립 유형 열은 두 실제 헤더에 없다. Nasdaq 목록의 실제 `ETF/NextShares` 열은 이 정의 페이지의 해당 절에 설명이 누락되어 있다. 다른 목록의 정의를 그대로 확대 적용하지 않는다.

같은 정의는 `Security Name`에 유형이나 주식 종류가 포함될 수 있다고 설명한다. 그러나 표본에는 기초 권리가 없는 BBD, ADR 표시 자체가 없는 TSM, `Common Stock` 대신 다른 권리 명칭을 쓰는 SHOP도 있다. 공식 명시 문구를 관측하는 것과 회사명·이름 단어·티커 접미사로 적격성을 추정하는 것은 구분한다. 자유 형식 이름의 키워드만으로 모든 권리를 분류하는 규칙은 검증하지 않았다. 이름에 특정 단어가 없다는 이유로 보통주에 포함하거나 ADR을 부정하지 않는다.

## Nasdaq 표본에서 실제 확인한 값

아래는 수집한 원본 행의 선별 기록이다. 회사 단위로 합치지 않았으며 원문 이름의 필요한 부분만 표시했다. KIS 값은 기존 증거를 재사용하며 이번에 KIS를 재조회한 것은 아니다.

| 표본 | 외부 식별자와 값 | 명시 문구 또는 한계 |
| --- | --- | --- |
| AAPL | Nasdaq `AAPL`, ETF `N` | 이름에 `Common Stock`이 있다. |
| SHOP | Nasdaq `SHOP`, ETF `N` | `Class A Subordinate Voting Shares`다. 외국 기업 여부로 제외하지 않는다. |
| GOOG / GOOGL | Nasdaq 각각 별도 `Symbol`, ETF `N` | 각각 `Class C Capital Stock` / `Class A Common Stock`이다. 회사명 중복으로 합치지 않는다. |
| ACONW / ADSEW | Nasdaq 각각 별도 `Symbol`, ETF `N` | 둘 다 이름에 `Warrant`가 있다. ETF `N`이 보통주를 뜻하지 않는 반례다. |
| BBD / BBDO | Exchange `N`, ACT·CQS·NASDAQ Symbol 모두 각각 원본 티커, ETF `N` | BBD는 `American Depositary Shares`만 표시한다. BBDO는 추가로 보통주 한 주를 나타낸다는 문구가 있다. BBD의 기초 우선주 권리는 이 목록으로 확정하지 못한다. |
| TSM | Exchange `N`, 세 심볼 모두 `TSM`, ETF `N` | 이름은 회사명이다. ADR과 기초 보통주 권리를 확정하지 못한다. |
| SPY | Exchange `P`, 세 심볼 모두 `SPY`, ETF `Y` | 명시적 ETF 표시는 기존 KIS 상품 `01=주식`보다 구체적이다. 포괄적·구체적 분류 차이 자체를 실제 충돌로 보지 않는다. |
| VXX | Exchange `Z`, 세 심볼 모두 `VXX`, ETF `N` | 이름에는 `ETN`이 있다. ETF `N`만으로 ETN을 판별할 수 없다. 기존 KIS `AMS`와 외부 시장 표기를 직접 등치하지 않는다. |
| BAC/B | ACT `BAC$B`, CQS `BACpB`, NASDAQ `BAC-B`, Exchange `N`, ETF `N` | 이름에는 Series GG 우선주 지분 1/1000을 나타내는 예탁증권이라는 설명이 있다. 원본 KIS `BAC/B`와 표기가 다르다. |
| BAC/L | ACT `BAC$L`, CQS `BACpL`, NASDAQ `BAC-L`, Exchange `N`, ETF `N` | 이름에 Series L 우선주 약어가 있다. BAC/B·BAC 보통주와 별도 유지한다. |

## Nasdaq 자료와 KIS 상장 종목의 연결

외부 `Exchange` 정의는 `N=NYSE`, `A=NYSE MKT`, `P=NYSE ARCA`, `Z=BATS`, `V=IEXG`다. 공식 페이지의 오래된 시장 명칭을 현행 명칭이나 KIS 코드로 임의 치환하지 않는다. Nasdaq 파일 소속과 동일 `Symbol`은 NAS/AAPL 등 단순 표본의 연결 근거가 되지만, 모든 KIS NAS·NYS·AMS 행에 대한 완전한 대응표는 입증하지 않았다. 특히 SPY의 외부 `P`, VXX의 `Z`가 모두 기존 KIS `AMS`에 대응하므로 `AMS=A` 또는 NYSE American이라는 일대일 규칙은 성립하지 않는다.

다른 거래소 파일은 동일 행 안에서 ACT·CQS·NASDAQ 표기를 함께 제공하지만 KIS 표기 열은 없다. `BAC/B`를 `BAC$B`나 `BAC-B`로 바꾸는 규칙은 이 파일만으로 정당화되지 않는다. 별도 공식 식별 근거를 확인해야 하며 구두점을 지우거나 회사명으로 연결하지 않는다. 두 파일에는 ISIN 열이 없으므로 선택적 ISIN 누락 자체가 수집 실패인 것은 아니다. 그 대신 외부 행과 KIS 증권의 대응이 유일한지 확인할 다른 근거가 필요하다.

## Nasdaq 기준일·최신성과 호출 부담

필드 정의는 하루 중 주기적으로 갱신하며 마지막 행이 Nasdaq의 파일 생성 시각이라고 설명한다. [Symbol Lookup](https://www.nasdaqtrader.com/Trader.aspx?id=symbollookup)은 현재 거래일의 정보를 제공한다고 안내한다. 그러나 확인한 페이지에는 이 두 텍스트 파일의 생성 시각 시간대, 고정 배포 간격, 장전 갱신 완료 시각, 최대 지연 보장이 명시되어 있지 않다. 다른 유료 피드나 Fund Network의 운영 시각을 가져와 적용하지 않는다.

이번 두 footer는 날짜와 시간이 같지만 시간대가 없어 HTTP Date와의 시차를 데이터 나이로 확정하지 않는다. 같은 날 생성됐다는 사실만으로 개별 종목의 권리 변경·상장 이동까지 반영됐다고 보장할 수도 없다. 실행마다 새 파일을 수집하고 헤더·footer·예상 범위를 검사하는 것은 최소 제안이며, 이것만으로 최신성 검증 완료가 되지는 않는다. 시간대와 허용 지연은 미확정 운영값으로 남긴다.

일괄 목록 두 개를 한 실행에서 각각 한 번 수집하면 종목별 반복 요청 없이 표본을 조회할 수 있다. 이 제안의 본문 합계는 이번 관측에서 892598 bytes다. 초당 요청 수 제한·재시도 횟수·시간 제한의 공식 운영값은 확보하지 못했다. 임의의 숫자를 검증된 기준으로 정하지 않는다. HTTP 성공은 최신성 보장이 아니며, 이전 실행의 저장 자료를 대신 사용해 성공 처리하지 않는다.

## Nasdaq 이용 조건

[공식 도움말](https://www.nasdaqtrader.com/Trader.aspx?id=Help)은 Symbol Directory를 로그인 없이 내려받는 공개 경로와 텍스트 가져오기를 안내한다. 실제 HTTPS 수집에서도 로그인·유료 계약·새 자격 증명이 필요하지 않았다.

[Symbol Lookup의 별도 조건](https://www.nasdaqtrader.com/Trader.aspx?id=symbollookup)은 Nasdaq Events Data의 범위로 Nasdaq Listed 등을 열거하고 해당 자료에 추가 라이선스를 요구하지 않는다고 밝힌다. 같은 페이지의 Fund Network에는 별도의 내부 비상업 사용 제한이 있으므로 섞지 않는다. 다만 이 문구는 `otherlisted.txt`의 타 거래소 자료를 파일명으로 명시하지 않는다. 두 파일 전체에 대한 무제한 재배포 허가로 확대하지 않는다.

[일반 저작권·면책 문서](https://www.nasdaqtrader.com/Trader.aspx?id=CopyDisclaimMain)는 개인 비상업 사용의 원본 사본과 별도 허용의 예외를 두며 정확성·적시성·완전성을 보장하지 않는다. 공개 접근 성공과 재배포 권한은 다른 문제다. 이번 조사에서 전체 원본을 공유 저장소에 추가하지 않으며, 지속 자동 사용·선별 증거 게시의 조건을 출처 범위와 함께 확인할 필요가 있다.

## Nasdaq 채택 제안과 남은 검증

Nasdaq 목록은 일괄 식별 보조 자료와 명시적인 ETF 여부의 후보 출처다. 이것만으로 모든 유형을 판별하는 단독 출처로 채택할 근거는 부족하다. 외부 상장 시장과 KIS 코드의 연결, BBD·TSM 등의 기초 권리, 이름 필드의 해석 범위, 최신성 시간대·허용 지연, 타 거래소 목록의 이용 조건을 확정한 뒤 채택 범위를 정해야 한다. SEC·발행사 자료의 후속 조사와 결합해도 회사 단위 식별자만으로 증권을 연결하지 않는다.

정상 자료에서 외부 대응이 없거나 권리를 확정하지 못하면 유형 미확인으로 개별 제외한다. 어느 증권인지 모호하면 전체 실패한다. 필요한 파일의 조회·해석·최신성 확인 실패도 전체 실패이며, 유형 미확인이나 정상 빈 후보군으로 바꾸지 않는다. 이 상태 전이는 후속 구현의 계약이며 이번에 실행 검증한 분류기 동작이 아니다.

이번 Nasdaq 조사는 실제 공개 수집과 공식 설명의 대조다. 전 시장 정확도, 모든 종목의 현재 권리, 실행마다 자동 판별이 가능한 운영 체계는 검증하지 않았다. 코드·테스트·인증 정책·Actions를 변경하지 않았으며 새 분류 동작의 테스트나 음성 대조는 추가하지 않았다. 문서 원문과 표본·공식 정의를 다시 대조했으며 미확정 조건을 유지한다.

## NYSE Pillar 공개 매핑

[NYSE 기술 문서 목록](https://www.nyse.com/market-data/technical-documents)의 Current 링크는 Pillar Common Client Specification v2.4r이다. 해당 [고정 버전](https://www.nyse.com/publicdocs/nyse/data/NYSE_Pillar_Equities_Common_Client_Specification_v2.4r.pdf)의 32~33쪽을 원문과 렌더링으로 확인했다. 무버전 PDF는 v2.4u이며 Upcoming Q4 링크이므로 현재 적용판으로 쓰지 않는다. 현재판의 공개 파일 배포 안내는 `12 midnight EST`이며, 향후판의 `8:40PM EST`를 현재 운영값으로 가져오지 않는다. 날짜 파일은 해당 날짜의 매핑이라는 근거지만 장중 수정 반영과 시각 해석의 세부 운영 조건까지 검증한 것은 아니다.

실제 [NYSE](https://ftp.nyse.com/NYSESymbolMapping/NYSESymbolMapping_20261019.txt)·[American](https://ftp.nyse.com/AmericanSymbolMapping/AmericanSymbolMapping_20261019.txt)·[Arca](https://ftp.nyse.com/ARCASymbolMapping/ARCASymbolMapping_20261019.txt)의 생산용 날짜 파일을 각각 한 번 수집했다. HTTP 200, 크기 458316/447901/453612 bytes, 행 수 13325/13325/13327이었다. 행 수는 파일 구조 점검값이며 전체 시장 유형 정확도를 조사한 결과가 아니다. 인증·추가 계약·새 자격 증명 없이 접근했지만 지속 자동 이용 조건까지 확정했다는 뜻은 아니다.

현재판 §9.1은 `Symbol`·`CQS Symbol`·`SymbolIndex`·`MarketID`·`ExchangeCode`·`SecurityType` 등을 정의한다. `MarketID`는 원시장, `ExchangeCode`는 상장시장이다. 각 파일에 다른 거래소 상장 종목도 있으므로 파일 경로만으로 상장 거래소를 판정하지 않는다. `SymbolIndex`의 시장 간 교차 식별 사용은 명시적으로 허용되지 않는다. ISIN 열은 없으며 선택적 식별자 누락과 연결 모호함을 구분해야 한다.

| 표본 | NYSE 파일의 상장시장 / 유형 | 공식 의미와 실제 대응 |
| --- | --- | --- |
| AAPL·GOOG·GOOGL·SHOP | `Q / C` | 보통주 코드다. 외국 기업 SHOP도 포함하며 별도 주식 종류를 회사명으로 합치지 않는다. |
| BAC PRB·BAC PRL | `N / P` | 우선주 코드다. CQS 표기는 각각 `BACpB`·`BACpL`이며 원본 KIS `BAC/B`·`BAC/L`와의 연결은 별도 근거가 필요하다. |
| ACONW·ADSEW | `Q / W` | 명시적인 워런트 코드로, 이름·접미사 추정 없이 두 반례의 유형 근거를 확보했다. |
| BBD·BBDO·TSM | `N / A`, `N / H`, `N / A` | `A`는 ADR, `H`는 ADS다. 이 차이를 우선주 ADR·보통주 ADR의 차이로 읽지 않는다. |
| SPY | `P / E` | ETF 코드이며 상장시장은 NYSE Arca다. KIS 상품 `01=주식`과의 구체성 차이만으로 충돌로 보지 않는다. |
| VXX | `Z / E` | 현재판은 `E`를 ETF로 정의하지만 아래 발행사 공시는 같은 ISIN의 Series B ETN을 명시한다. 이 파일의 `E`를 임의로 모든 ETP의 포괄 코드로 바꾸지 않는다. |

세 파일에서 위 표본의 유형과 상장시장 값은 같았고 원시장·일부 운영 필드는 달랐다. 이를 서로 독립적인 세 공급자의 일치 검증으로 보지 않는다. 별도 [Security Master v4.1](https://www.nyse.com/publicdocs/nyse/data/NYSE_Group_Security_Master_Client_Specification_v4.1.pdf)은 Nasdaq·CBOE ETP의 ETF 기본값을 설명하지만, 그 규칙을 다른 상품인 Pillar 매핑에 자동 적용할 근거는 확인하지 못했다. 따라서 VXX는 유형 충돌 또는 코드 적용 관계의 미해결 사례로 남긴다.

[Security Master 상품](https://www.nyse.com/data-products/catalog/nyse-group-security-master)과 [ADR Master 규격](https://www.nyse.com/publicdocs/nyse/data/NYSE_Group_ADR_Master_Client_Specification_v4.1.pdf)에는 더 상세한 유형과 식별자 경로가 있지만 구매·고객 대시보드·IP/SSH 키 등록 방식이 안내된다. 이 상품의 `H/I`와 Pillar의 `H`는 같은 코드 체계가 아니다. 이번 무료·무로그인 범위의 운영 출처로 채택하지 않는다.

NYSE의 일반 Listings Directory는 종목 유형 선택 UI까지 확인했으며, 실제 목록 응답의 공식 계약·갱신 범위·세부 유형 보장은 확인하지 못했다. 경로가 없다는 결론은 아니다. [ICE 이용 조건](https://www.ice.com/privacy-security-center/terms-of-use)은 개인 비상업 다운로드와 체계적 추출에 서로 다른 제한을 둔다. 공개 매핑의 다운로드 안내와 정기 자동 사용에 적용되는 별도 허용 관계는 미확정이다. 자동 수집이 무료로 지속 가능하다는 운영 결론을 내리지 않는다.

## SEC 공시와 발행사 자료

Context7의 SEC 문서 검색은 제3자 서비스·라이브러리만 반환하여 공식 SEC 문서로 확인했다. 제3자 공급자나 라이브러리를 도입하지 않았다. [SEC API 문서](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)는 무인증 JSON과 submissions의 공시 이력·티커·거래소 정보를 설명한다. XBRL 집계는 표준 taxonomy의 제출자 전체에 적용되는 사실을 대상으로 하므로 회사별 companyfacts만으로 주식 종류별 권리를 구분할 근거는 부족하다. 새 공시를 빠르게 전달하는 것과 증권 권리를 매일 재확인하는 것은 다르다.

| 증권별 근거 | 확인한 사실 | 현재 자동 운영까지 남은 조건 |
| --- | --- | --- |
| [Bradesco 2025 20-F의 증권별 표지](https://www.sec.gov/Archives/edgar/data/1160330/000129281426001753/R1.htm) | BBD는 우선주 문맥, BBDO는 보통주 문맥의 ADS이며 둘 다 NYSE다. 제목은 같아도 증권별 XBRL 문맥이 다르다. | 제목·CIK만 추출하거나 같은 회사의 권리를 합치면 차이를 잃는다. 문맥을 보존하는 자동 추출과 후속 변경 확인이 필요하다. |
| [Aclarion 2026-03-31 표지](https://www.sec.gov/Archives/edgar/data/1635077/000168316826003822/R1.htm) | ACON 보통주와 ACONW 워런트를 별도 NASDAQ 증권으로 표시한다. | 거래 심볼이 없는 별도 권리까지 같은 종목으로 합치지 않아야 한다. |
| [ADS-TEC 2025 표지](https://www.sec.gov/Archives/edgar/data/1879248/000121390026057891/R1.htm) | ADSE 보통주와 ADSEW 워런트를 별도 NASDAQ 증권으로 표시한다. | 해당 공시 시점의 권리 근거이며 현재의 후속 변경 미발생을 입증하지 않았다. |
| [Shopify 2025 10-K](https://www.sec.gov/Archives/edgar/data/1594805/000159480526000007/shop-20251231.htm) | 캐나다 법인의 Nasdaq SHOP은 Class A Subordinate Voting Shares이며 common stock에 포함된다. | 표지의 이름에서 common 단어가 없다고 ADR로 분류하거나 제외하지 않는다. |
| [SPY 2026 투자설명서](https://www.sec.gov/Archives/edgar/data/884394/000119312526022316/d77353d485bpos.htm)와 [발행사 상품 페이지](https://www.ssga.com/us/en/individual/etfs/state-street-spdr-sp-500-etf-trust-spy) | SPY와 NYSE Arca, ETF 성격의 명시적 근거가 있다. | 기초자산의 보통주 성격을 SPY 자체의 유형으로 혼동하지 않는다. |
| [Barclays 2026-02-13 pricing supplement](https://www.sec.gov/Archives/edgar/data/312070/000191870426004069/form424b2.htm) | VXX는 CBOE BZX의 Series B ETN이며 ISIN `US06748M1962`가 기존 KIS 표본과 일치한다. 과거 VXX는 2019년 만기된 다른 증권이라고 명시한다. | 티커만으로 과거 증권을 연결하지 않는다. NYSE 매핑 `E`의 적용 관계와 후속 변경 확인은 미완료다. |

위 표는 웹 추출로 읽은 공식 자료의 사실이다. 공시의 기간·제출일과 다운로드일을 구분한다. 최신 공시인지, 후속 변경·정정이 없는지까지 확인한 결과는 아니다. 원문 iXBRL의 결정적 추출·문맥 보존·지원하지 않는 발행사별 표현의 처리도 실행 검증하지 않았다. [SEC XBRL Guide](https://www.sec.gov/files/edgar/filer-information/specifications/xbrl-guide-2026-08-14.pdf)의 증권별 문맥 설명은 유용하지만 모든 공시에 같은 형태의 유형 열이 있다는 보장은 아니다.

[Bradesco 주식 안내](https://www.bradescori.com.br/en/services/bradesco-shares/)와 [FAQ](https://www.bradescori.com.br/en/services/faq/)도 BBD 우선주 ADR·BBDO 보통주 ADR을 명시한다. 반면 [ADR Program](https://www.bradescori.com.br/en/services/adr-program/)의 표는 두 CUSIP 행의 티커를 모두 BBD로 표시하고 갱신일은 2025-07-23이다. 같은 발행사 자료도 식별 표를 무조건 우선하지 않는다. 이름이 같은 두 행을 합치지 않고 원본의 오류 가능성과 적용일을 확인해야 한다.

공개 수집기의 SEC ticker/submissions·공시 원문·렌더링 요청은 HTTP 403이었고 Bradesco 두 페이지는 네트워크 오류였다. 웹 추출에서는 관련 본문을 읽었으므로 두 접근 방식의 결과를 구분한다. 이 실패를 SEC·Bradesco 자료 자체가 존재하지 않거나 자동화가 불가능하다는 결론으로 확대하지 않는다. 추가 인증·브라우저 프로필·차단 우회는 사용하지 않았다.

[SEC 접근 안내](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data)는 식별 가능한 User-Agent와 효율적인 수집을 요구한다. [보안 정책](https://www.sec.gov/about/privacy-information)의 초당 10요청은 총 접근 상한이며 처리량 목표나 가용성 보장이 아니다. [SEC FAQ](https://www.sec.gov/about/webmaster-frequently-asked-questions)의 무료 공개·재사용 안내와 별개로 접근 정책을 지켜야 한다. 현재 공용 수집기는 임의의 식별 헤더를 받지 않으므로 이번 조사에서 그 호환 경로를 구현하지 않았다. 식별 문자열·수집 경로·재시도·시간 제한은 후속 작업에서 결정할 항목이다.

## 조사 결과와 다음 결정

| 후보 출처 | 이번에 입증한 범위 | 채택 전 남은 조건 |
| --- | --- | --- |
| NYSE Pillar 공개 매핑 | 실제 날짜 파일 수집, 보통주·우선주·워런트·ADR/ADS 코드와 표본 대응 | ADR 기초 권리, VXX 유형 관계, KIS 표기 연결, 현재 적용 범위, 지속 자동 이용 조건 |
| Nasdaq 목록 | 일괄 수집·개별 심볼·일부 명시적 ETF 분류 | ADR 기초 권리와 상세 유형, 생성 시각 해석·허용 지연, KIS 거래소·심볼 연결, 타 거래소 자료 이용 범위 |
| SEC 증권별 공시 | 같은 회사의 증권과 기초 권리를 구분할 명시적 표본 | 원문 수집 호환성, 문맥을 보존하는 결정적 추출, 후속 공시·정정 확인 범위 |
| 발행사 페이지 | 개별 표본의 명시적 설명 | 공통 형식·발견 경로·현재 적용일·표 오류·지속 수집 조건 |

**권고는 NYSE 공개 매핑을 구조화 분류의 우선 검토 후보로 두고, ADR 권리는 SEC의 증권별 공시를 보완 후보로 두는 것이다. 운영 출처의 채택 완료나 구현 착수 승인은 아니다.** Nasdaq 목록은 식별·ETF 표시의 보조 후보로 남기며 모든 종목에 두 출처를 강제하지 않는다. 한 출처가 충분하면 그것으로 판단하되 확인된 반대 근거는 해결해야 한다.

호출 부담의 관측치는 목록 다섯 개의 본문 합계 2252427 bytes다. 실행당 필요한 파일을 한 번씩 읽는 방식은 가능한 최소 제안이지만, 세 NYSE 파일이 모두 필수라고 결정하지 않았다. 초당 요청 수·재시도·전체 실행 시간·최대 허용 지연·자료 유효기간은 검증된 운영값으로 확정하지 않았다. 날짜·파일 형식·필수 필드·공식 정의의 적용 범위를 확인하지 못하면 실패하는 기존 계약은 유지한다.

정상 자료에서 증권 대응이 없거나 기초 권리가 불명확하면 유형 미확인으로 개별 제외한다. 식별이 모호하거나 필요한 자료의 조회·해석·최신성 확인이 실패하면 전체 실패다. VXX처럼 구체적 유형이 다르게 표시되면 근거 없이 한 자료를 우선하지 않으며, 해결되지 않으면 유형 미확인으로 제외한다. 이 처리는 명세 계약이며 새 분류기의 실행 결과가 아니다.

한정된 출처 조사는 완료했지만 실제 적격 종목 자동 판별의 검증은 미완료다. 다음 결정은 위 후보의 채택 범위와 남은 이용·연결·현재성 조건을 어떻게 검증할지다. 고정 표본 허용 목록·이름 추정·LLM·유료 상품·오래된 저장 자료로 해결한 것으로 처리하지 않는다. #243의 장전 데이터·공식 일정·운영값 등 다른 미검증 조건과 후속 차단도 유지한다.

이번에는 런타임 코드·테스트·공용 인증을 변경하지 않았고 KIS 호출이나 계좌·자격 증명 조회를 수행하지 않았다. 새 TDD 검사·mutation-probe는 적용 대상이 아니며 기존 형식·린트·타입·전체 테스트는 회귀 확인으로만 수행한다. 검토 기준은 기존 `835bebed44de81a821660370428101b931953e05`를 유지하고 이번 시작점 `4f42003f1267779c03f6d7f3c2031470417c7d8f` 이후의 작업 파일을 별도로 고정한다. 기존 미커밋 용어집·검증 문서의 변경은 커밋 범위에 포함하지 않는다.
