# 종목 유형 평가 표본과 독립 정답

2026-10-22 [#260](https://github.com/mochafreddo/stock-scout/issues/260)의 표본 조사 기록이다. 기준은 [#250](https://github.com/mochafreddo/stock-scout/issues/250), [ADR 0007](adr/0007-llm-security-type-judgment.md)과 [실제 평가 재개 설계](security-type-live-evaluation-design.md)다. 모델 출력 없이 공식 자료로 정답을 확인했다. 실제 모델 평가는 실행하지 않았다.

## 현재 상태

8개 사례, 11개 증권의 유형·상장 연결과 기대 포함·제외를 확보했다. 자료 부족과 미해결 충돌로 제외해야 하는 실제 사례는 미확보다. 따라서 전체 필수 표본은 확정 전이며 정식 3회 평가를 시작할 준비가 되지 않았다. 확보한 사례의 입력과 정답을 버전 `2026-10-22.1`로 기록한 것이며 #260이나 #250의 전체 완료를 뜻하지 않는다.

평가자용 [정답 목록](evidence/issue-260/answers.json)은 입력 파일의 SHA-256과 독립 정답을 기록한다. 각 입력에는 기존 CLI가 허용하는 `securities`, `exchange`, `symbol`만 있다. 자료 부족·충돌의 자리에 가상 티커나 이미 적격으로 확인한 종목의 임의 제외를 넣지 않았다. 모의 HTTP 검사의 부족·충돌 사례를 실제 표본 확보로 계산하지 않는다.

## 확인 범위와 시점

확인일은 2026-10-22다. 현재 상장은 [Nasdaq 상장 디렉터리](https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt)와 [다른 거래소 상장 디렉터리](https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt)의 생성 시각 `1021202621:31`을 확인했다. 생성 시각은 Nasdaq의 [필드 정의](https://www.nasdaqtrader.com/Trader.aspx?id=SymbolDirDefs)에 따라 자료 생성 시각으로 해석하며, 별도 근거 없이 시간대를 단정하지 않는다. 비시험 종목 표시와 개별 증권명·종류·거래소 필드를 대조했다. 디렉터리 이후의 모든 기업행동이나 실시간 거래 가능성을 보장하지 않는다.

KIS 입력 연결은 같은 날 05:30:49 UTC에 받은 NAS·NYS·AMS 공개 마스터로 재확인했다. [선별 관측](evidence/issue-260/kis-identity-observations.json)은 원본 ZIP의 해시와 식별·유형 필드만 담는다. 24열 cp949 자료를 [기존 공식 고정 버전의 열 정의](https://github.com/koreainvestment/open-trading-api/blob/2077773a69a428daf63e148182511f068cc45de3/stocks_info/overseas_stock_code.py)와 대조했다. 공식 예제 코드는 실행하지 않았으며 TLS 검증을 유지한 익명 GET과 표준 ZIP 읽기만 사용했다.

KIS 마스터에는 별도 기준일이 없으므로 수신일을 자료 기준일로 바꾸지 않았다. 현재 공식 디렉터리·발행사 자료와 일치하는 증권 연결을 확인하는 데 사용했으며, 현재 KIS 인증 조회·순위 소속·데이터 기준 세션·거래 가능 여부의 검증은 아니다. 특히 `AMS/SPY`와 `AMS/VXX`는 KIS 입력 코드이며 각각의 외부 상장 시장인 NYSE Arca·Cboe와 구분한다.

## 독립 정답과 근거

아래 기대 결과는 모델의 답을 읽거나 유형 평가를 실행하기 전에 정했다. `포함`은 매회 반드시 포함해야 한다는 뜻이다. 근거 부족을 이유로 이 종목을 제외해도 평가 실패다. `제외`는 확인된 비적격 유형에 따른 제외이며, 유형 미확인으로의 제외를 정답으로 대신하지 않는다.

| 사례와 모델용 입력 | 독립 정답 | 증권 연결·권리·현재 적용 근거 |
| --- | --- | --- |
| [01 보통주](evidence/issue-260/inputs/01-common.json): `NAS/AAPL` | `common`, 포함 | 현재 Nasdaq 디렉터리의 AAPL은 Apple Common Stock이다. [Apple FAQ](https://investor.apple.com/faq/default.aspx)의 현재 Nasdaq/AAPL 거래 설명과 우선주 미발행 설명을 함께 대조했다. FAQ는 날짜가 없어 디렉터리의 생성 시각과 구분한다. |
| [02 같은 회사의 종류주](evidence/issue-260/inputs/02-share-classes.json): `NAS/GOOG`, `NAS/GOOGL` | 각각 `common`, 모두 포함 | 현재 디렉터리는 GOOG를 Class C Capital Stock, GOOGL을 Class A Common Stock으로 구분한다. [Alphabet 2025 Form 10-K](https://d18rn0p25nwr6d.cloudfront.net/CIK-0001652044/e6a3f2b6-bb98-4f54-900f-2a8794a582cf.html)의 Note 11·12는 의결권을 제외한 권리의 동일성을 설명한다. Class C라는 명칭이나 의결권 부재를 우선주 근거로 삼지 않는다. 현재 디렉터리는 두 종류가 여전히 별도 상장되어 있음을 보완한다. |
| [03 같은 회사의 ADR 권리](evidence/issue-260/inputs/03-adr-rights.json): `NYS/BBD`, `NYS/BBDO` | BBD `preferred_adr`, 제외; BBDO `common_adr`, 포함 | 현재 NYSE 연결과 ADR의 기초 권리·후속 확인은 [ADR·워런트 조사](security-evaluation-adr-warrant-research.md)를 따른다. KIS의 동일한 `2`, DR `N`은 두 ADR의 권리를 구별하지 못한다. 보통주 ADS 근거를 BBD에 전용하지 않는다. |
| [04 같은 회사의 우선주](evidence/issue-260/inputs/04-preferred.json): `NYS/BAC/B`, `NYS/BAC/L` | 각각 `preferred`, 모두 제외 | [2026-10-14 발행사 8-K](https://investor.bankofamerica.com/regulatory-and-other-filings/select-sec-filings/content/0000070858-26-000481/bac-20261014.htm)의 표지는 NYSE `BAC PrB`를 Series GG 우선주 지분 1/1,000의 예탁주식, `BAC PrL`을 Series L 전환우선주로 구분한다. [발행사 우선주 현황](https://investor.bankofamerica.com/fixed-income/preferred-stock)은 2026-10-14 기준 두 종목과 CUSIP `060505229`, `060505682`를 제시한다. 현재 디렉터리의 `BAC$B`·`BAC$L` 명칭과 KIS 원표기·시리즈·배당률을 대조했다. 구두점 치환 규칙을 만들지 않는다. 국내 발행사 우선주 예탁주식을 외국 보통주 ADR로 오인하지 않는다. |
| [05 Aclarion 워런트](evidence/issue-260/inputs/05-aclarion-warrant.json): `NAS/ACONW` | `warrant`, 제외 | 현재 Nasdaq 디렉터리의 Aclarion Warrant와 KIS의 같은 발행사·심볼 연결을 확인했다. KIS `securityType: 2`를 보통주로 해석하지 않는다. 워런트의 조건·후속 확인 범위는 [조사 기록](security-evaluation-adr-warrant-research.md)을 따른다. |
| [06 ADS-TEC 워런트](evidence/issue-260/inputs/06-adstec-warrant.json): `NAS/ADSEW` | `warrant`, 제외 | 현재 Nasdaq 디렉터리의 ADS-TEC ENERGY Warrant와 KIS 원심볼을 연결했다. 과거 공시만으로 상장 유지를 추정하지 않았다. 기초 보통주를 살 권리와 워런트 자체를 구분하며 권리·만기와 후속 확인은 [조사 기록](security-evaluation-adr-warrant-research.md)을 따른다. |
| [07 ETF](evidence/issue-260/inputs/07-etf.json): `AMS/SPY` | `etf`, 제외 | [State Street SPY](https://www.ssga.com/us/en/individual/etfs/state-street-spdr-sp-500-etf-trust-spy)는 ETF Trust이며 2026-10-22 기준 NYSE Arca/SPY, CUSIP `78462F103`, ISIN `US78462F1030`을 표시한다. 현재 다른 거래소 디렉터리의 P·SPY·ETF Y와 연결했다. 날짜와 유형이 명시된 발행사 자료가 현재성을 보완한다. |
| [08 ETN·후속 변경](evidence/issue-260/inputs/08-etn-subsequent-change.json): `AMS/VXX` | `etn`, 제외 | 현재 다른 거래소 디렉터리와 [Cboe 상품 페이지](https://www.cboe.com/us/equities/listings/listed_products/symbols/VXX/)의 Series B ETN을 연결했다. Cboe 페이지에는 현재 기준일이 없어 디렉터리를 보완 근거로 쓴다. [2019-05-01 MIAX 공식 공지](https://www.miaxglobal.com/alerts/2019/05/01/miax-options-miax-pearl-and-miax-emerald-corporate-action-alert-ipath-series-b-0)는 2019-05-02 VXXB→VXX 변경을 설명한다. 변경 전 심볼·이전 상품의 자료를 현재 VXX에 무조건 적용하는 반례다. 전체 병합 이력·모든 후속 변경의 전수 검증은 아니다. |

기존 AAPL·GOOG/GOOGL·BBD/BBDO·BAC/B/BAC/L·ACONW/ADSEW·SPY/VXX 사례를 유지했다. 현재 상장 디렉터리와 권리 자료로 확인한 범위에서는 표본 교체를 하지 않았다. 기존 조사 당시 현재성 미확인이었던 ADSEW를 대체한 것이 아니라 이번 근거로 현재 상장 연결을 보완했다. 후속 변경 목적은 VXX의 심볼 변경과 현재 Series B 연결로 구체화했다.

## 미확보 반례

자료 부족으로 제외할 실제 표본과, 같은 증권에 적용되는 구체적인 유형 주장들이 해결되지 않은 채 모순되어 제외할 실제 표본은 확보하지 못했다. 기존 CLI는 종목 식별자만 받으며 출처나 조회 실패를 주입하지 않는다. 평가자가 일부 자료를 못 찾았다는 사실만으로 모델도 적격성을 입증할 수 없다고 단정할 수 없다.

KIS `01=주식`과 공식 보통주 표시는 [ADR 0005](adr/0005-official-security-type-sources.md)에 따라 그 자체로 모순이 아니다. BBD/BBDO의 같은 분류값은 권리 구분의 반례다. SPY·VXX의 과거 KIS 상품 정보와 마스터 차이는 [기존 관측](kis-security-identification.md)으로 보존하지만, 외부 공식 근거로 유형을 확인한 현재 두 종목을 미해결 충돌에 따른 `unknown` 정답으로 재분류하지 않는다.

이 두 검증 목적에 맞는 실제 증권과 현재 적용 가능한 독립 제외 근거가 추가로 필요하다. 현재 경계만으로 실제 사례가 존재하지 않는다거나 새 프레임워크가 반드시 필요하다고 결론내리지 않는다. 실제 자료가 확보되면 평가 전에 입력·정답·근거와 버전을 함께 확정한다. 확보하지 못한 상태에서는 부분 표본만 통과시켜 전체 회차를 통과한 것으로 기록하지 않는다.

## 평가 절차와 근거 심사

1. 정식 평가 전에 미확보 두 사례를 해소하고 전체 표본·정답·근거와 입력 해시를 확정한다. 모델·구현 커밋·설정도 실행 기록에 고정한다. 이후 표본 변경은 새 평가 버전이며 진행 중인 회차의 실패 사례를 교체하지 않는다.
2. 기존 [평가 CLI 사용법](llm-security-probe.md#고정-표본을-같은-판단-경로로-평가하기)에 따라 `--evaluation-input`에는 `inputs/` 아래의 사례별 JSON 하나만 전달한다. `answers.json`, 이 문서, 조사 기록이나 근거 URL을 모델 프롬프트·추가 입력으로 보내지 않는다. CLI는 입력 JSON만 읽으며 정답 파일을 자동 탐색하지 않는다. 파일명은 요청 본문에 담지 않지만 실제 실행의 외부 HTTP 요청도 확인한다.
3. 02·03·04는 같은 회사의 별도 증권을 함께 입력한다. 나머지는 사례별로 실행한다. 현재 확보한 8개와 앞으로 확보할 필수 두 사례를 모두 도는 것을 한 회차로 계산한다. 사례마다 기존 호출·시간 한도를 유지하고 같은 모델·설정·구현으로 전체 3회 평가한다. 실제 KIS 순위에서 여러 종목을 처리하는 검증은 별도로 남긴다.
4. 각 실행의 입력 해시·소스 커밋·모델·설정, 시작·종료 시각, stdout·stderr·종료 코드, 실제 외부 요청과 근거 기록을 비밀 값 없이 보존한다. 실행 오류나 명백한 오분류가 있으면 중단하고 남은 사례·회차는 미수행으로 기록한다. 수정 후에는 전체 3회를 처음부터 다시 시작한다.
5. 평가자는 각 원본 거래소·심볼과 제출한 근거 ID가 같은 증권에 연결되는지, 실제 열린 페이지·읽은 발췌문이 해당 종류·권리를 명시하는지 확인한다. 회사 단위 CIK·회사명·검색 요약·티커 접미사만으로 통과시키지 않는다. 모델 추출 발췌문은 원문 자체와 구분한다.
6. 자료 기준일·적용일, 현재 디렉터리·후속 변경과 반대 근거를 대조한다. 구체적인 모순을 확인하면 해소 근거를 요구하고, 포괄 분류와 구체 유형의 차이는 구분한다. 날짜 없는 페이지는 다른 현재성 근거와 연결한다. 자료를 확인한 시각만으로 현재성을 인정하지 않는다.
7. ADR은 미국 상장 예탁증서와 기초 주식 종류를 각각 확인한다. BBD·BBDO는 같은 발행사라는 이유로 합치지 않고 보통주·우선주 권리를 바꿔 적용하지 않는다. BAC 예탁주식도 기초 우선주 권리로 제외한다.
8. 정답과 모델 근거가 같은 출처여도 허용한다. 출처 공유는 모델 출력과 독립적으로 정답을 확정했다는 조건을 대신하지 않는다. 최종 유형·포함 여부가 맞아도 다른 증권·과거 권리·해결되지 않은 반대 근거를 사용했으면 통과하지 않는다. 확보한 적격 종목 4개는 매회 모두 포함되어야 하며, 나머지 7개는 명시된 비적격 유형에 따라 제외되어야 한다.

## 보관·공개와 한계

공유 파일에는 입력 식별자, 평가자의 짧은 사실 요약·판단, 출처·시점과 파일 해시만 남긴다. 외부 페이지 전체·PDF·가격·보유 종목 표나 모델 응답은 커밋하지 않는다. Nasdaq의 [Symbol Lookup 안내](https://nasdaqtrader.com/trader.aspx?id=symbollookup)는 데이터 범주별 이용 범위를 구분하므로 한 범주의 허용 문구를 모든 외부 자료의 무제한 재배포 허가로 확대하지 않는다. 직접 수집한 원자료는 비동기화 임시 경로에 소유자 전용으로 보관하며 원문 전체의 공개·영구 보관 권한을 확보했다는 주장은 하지 않는다.

직접 익명 수집은 공개 KIS 마스터·Nasdaq 디렉터리·State Street·Bank of America·MIAX에서 성공했다. Apple FAQ와 Alphabet FAQ 및 SEC 세 문서의 직접 수집은 HTTP 403, Bradesco 세 페이지는 네트워크 오류였다. 웹 도구의 페이지 열람과 원문 전체 보관을 구분하며, SEC·Bradesco의 재검토 한계는 [조사 기록](security-evaluation-adr-warrant-research.md#출처-위치와-확인-한계)에 남겼다. Alphabet FAQ는 주식 종류 근거를 제공하지 않아 정답 출처로 사용하지 않았다. SEC·발행사 공시의 웹 열람은 해당 페이지의 확인이며 자동 수집 경로의 운영 검증이 아니다.

이 결과는 독립 표본 조사와 평가 준비의 부분 산출물이다. 실제 모델 정식 평가 0회이며 #250의 정확도·실제 순위 실행, #243의 시장 데이터·#244의 일정·#249·#251의 운영값과 후속 제품 인수 차단을 해소하지 않는다. 토스증권 소수점 거래 가능 여부도 판단하지 않는다.
