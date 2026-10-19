# KIS 종목 유형과 상장 종목 식별 검증

2026-10-19 [#250](https://github.com/mochafreddo/stock-scout/issues/250)의 조사 기록이다. 상위 요구사항은 [#237](https://github.com/mochafreddo/stock-scout/issues/237)·[#239](https://github.com/mochafreddo/stock-scout/issues/239), 부모는 [#243](https://github.com/mochafreddo/stock-scout/issues/243)이다. [기존 검증 기록](kis-data-validation.md)의 2026-10-17 관측을 재사용하고, 공식 코드 정의·공개 마스터·추가 상품 정보로 보완했다. 기존 기록의 코드 정의 미확보와 워런트 표본 미확보 상태는 아래 조사 결과로 갱신한다.

## 결론과 후속 차단

**현재 확인한 KIS 필드만으로 보통주·적격 ADR을 안전하게 자동 판별할 수 있다는 검증은 미완료다. #250과 #243 및 후속 후보군·추천 구현의 차단을 유지한다.** 공식 코드 정의와 실제 응답의 불일치를 확인했으며, KIS 자체의 수정 가능성이나 다른 공식 필드로 해결할 가능성까지 부정한 결론은 아니다.

- 공식 상품기본정보는 `ovrs_stck_dvsn_cd`를 `01=주식`, `02=WARRANT`, `03=ETF`, `04=우선주`로 정의한다. `01`의 정의는 보통주가 아니라 주식이다.
- SPY는 마스터 `3/001`의 ETF지만 상품 정보는 `01`이다. 2026-10-19 재조회에서도 같다. VXX도 기존 마스터 `3/006`의 VIX ETN과 상품 정보 `01`이 함께 관측됐다. 임의로 마스터나 상품 정보에 우선권을 주지 않는다.
- 실제 워런트 ACONW·ADSEW를 확보했다. 두 표본의 마스터 유형은 `2`, 상품 정보는 `01`이다. 공식 정의에 있는 마스터 `4`·상품 `02`와 연결되는 실제 표본은 아직 없다. 이름과 접미사로 이 불일치를 보정하지 않는다.
- 우선주 성격의 ADR인 BBD와 보통주 ADR인 BBDO는 모두 마스터 `2`, DR `N`, 상품 `01`이다. 발행사 자료로 표본의 차이는 확인했지만, 이 세 KIS 필드로 둘을 구분하는 규칙은 만들 수 없다. DR `N`을 보통주라는 증거로 쓰지 않는다.
- BAC/B·BAC/L의 실제 `04`는 공식 우선주 정의와 대응한다. 그러나 `04`만 제외하면 BBD와 워런트가 남고, `2`·`01`·DR `N`을 모두 보통주로 포함하면 이 반례가 섞인다. 회사명·국가·ISIN의 국가 접두사로 보충 판정하지 않는다.

이 조사는 후보군 분류기·중복 제거기·새 인증 로직을 구현하지 않았다. 공식 자료의 빈틈을 LLM 판단이나 다른 공급자의 자동 판별 데이터로 대체하지 않았다.

## 조사 경로와 재현 범위

기존 자료는 [issue-243 표본](evidence/issue-243)의 2026-10-17 실제 응답이다. 추가 자료는 [issue-250 표본](evidence/issue-250)에 있다. 각 자료의 `requestedAt`·`receivedAt`은 조회 시각이며 데이터 기준 세션이 아니다. 추가 API 관측은 2026-10-19T04:22:06.309Z~04:22:13.256Z에 SHOP·BBD·BBDO·ACONW·ADSEW·SPY 순서로 수행했다. 모두 정상 JSON 한 개와 종료 코드 0을 확인했다. `validation: unverified`, `dataSession: null`을 유지한다.

사용자가 기존 앱 키·시크릿 두 값의 조회와 사용을 승인한 뒤, 변경하지 않은 [관측 CLI](../scripts/kis-probe.ts)를 별도 프로세스로 실행했다. 요청은 `info <exchange> <symbol>`이며 기존 [공용 인증](../scripts/kis-auth.ts)의 발급·캐시·복구 정책을 사용했다. 앱 키·시크릿·토큰·인증 헤더·계좌 정보는 증거 자료에 포함하지 않았다. 인증 요청 수나 캐시 재사용 여부는 별도 계측하지 않았으므로 여섯 상품 조회 성공을 발급 횟수·복구 검증으로 확대하지 않는다.

공식 공개 마스터 세 ZIP을 TLS 검증을 유지한 채 메모리에서 읽고 cp949·탭 구분 24열로 해석했다. NAS/NYS/AMS의 행 수는 각각 5265/2839/4765, 유형 `4` 행 수는 모두 0이었다. 전체 파일에서 해당 코드의 존재를 확인한 뒤 필요한 소수 표본만 저장했으며, 모든 상장 종목의 유형을 조사하거나 정확도를 검증한 작업은 아니다. ZIP을 디스크에 추출하거나 공식 예제의 TLS 검증 해제를 실행하지 않았다.

Context7에서 공식 저장소를 찾았으나 해당 코드 정의 검색은 결과가 없었다. 이후 고정 커밋의 공식 원본과 KIS 포털의 공개 상세 JSON을 직접 읽었다. 포털 HTML의 문서 로더가 사용하는 `/api/apis/public/detail?accessUrl=...` 경로이며 로그인·비공개 서비스 우회 경로가 아니다. 필요한 필드명과 설명만 [공식 필드 기록](evidence/issue-250/official-fields.json)에 보존했다. 이 설명을 실제 값과 별개로 대조했다.

## 공식 정의와 실제 대응

| 분류 필드 | 공식 의미 | 실제 대응과 채택 한계 |
| --- | --- | --- |
| 마스터 `securityType` | `1` 지수, `2` 주식, `3` ETP(ETF), `4` 워런트 | `2`는 AAPL·TSM·BAC 우선주·BBD·워런트에서도 관측된다. `2`를 보통주로 채택하지 않는다. `3`은 SPY·VXX에서 확인했고 `1/4`의 실제 대응은 이번 표본에 없다. |
| 마스터 `etpType` | `001` ETF, `002` ETN, `003` ETC, `004` Others, `005` VIX Underlying ETF, `006` VIX Underlying ETN | SPY `001`, VXX `006`은 공식 의미와 마스터 표본이 연결된다. `002/003/004/005`는 정의만 확인했으며 실제 대응을 검증했다고 하지 않는다. 상품 정보와의 충돌이 남아 있어 전체 자동 판별 완료는 아니다. |
| 마스터 `dr/drCountry` | DR 여부 `Y/N`, DR 국가코드 | TSM `Y/TW`는 보통주 성격 ADR 표본과 연결된다. BBD·BBDO는 공식 ADR인데 `N/빈 값`이다. `Y`만으로 기초 증권의 권리를 알 수 없고 `N`도 ADR 부재를 보장하지 않는다. |
| 상품 `ovrs_stck_dvsn_cd` | `01` 주식, `02` WARRANT, `03` ETF, `04` 우선주 | BAC/B·BAC/L `04`의 공식 의미와 실제 대응을 확보했다. `01`은 포함 규칙으로 불충분하다. 워런트의 `02`, ETF의 `03`은 이번 실제 응답에서 확보하지 못했다. ETN·ADR·보통주 전용 코드 정의는 이 열거에 없다. |
| 상품 `prdt_clsf_cd/name` | 상품분류코드·분류명 | 기존 AAPL·TSM·SPY·VXX·BAC 및 추가 여섯 응답 모두 `101210/해외주식`이다. 유형 구분에 사용하지 않는다. `prdt_type_cd_2`도 이 표본에서는 빈 값이다. |

마스터 정의는 [KIS 공식 고정 커밋](https://github.com/koreainvestment/open-trading-api/blob/2077773a69a428daf63e148182511f068cc45de3/stocks_info/overseas_stock_code.py), 상품 정의는 [KIS 해외주식 상품기본정보](https://apiportal.koreainvestment.com/apiservice-apiservice?/uapi/overseas-price/v1/quotations/search-info)의 응답 필드다. 코드 값이 공식적으로 존재한다는 사실과 실제 값이 해당 증권에 올바르게 적용됐다는 사실은 구분한다.

## 유형별 대표 표본과 반례

아래 보조 공식 자료는 표본 자체의 성격을 확인하는 근거다. 개별 발행사의 설명으로 KIS 코드의 일반적 의미를 정의하거나 자동 판별용 대체 공급자로 사용하지 않는다. 확인일은 2026-10-19다.

| 표본 | 실제 KIS 근거 | 표본의 공식 성격과 판정 범위 |
| --- | --- | --- |
| AAPL 보통주 | [기존 상품](evidence/issue-243/info-NAS-AAPL.json), 마스터 `2/N`, 상품 `01`, `US0378331005` | [Apple 제출 문서](https://www.sec.gov/Archives/edgar/data/320193/000032019326000013/aapl-20260328.htm)의 표지에 Nasdaq AAPL Common Stock으로 기재된다. 표본 확인은 가능하지만 `01=보통주`라는 일반 규칙은 아니다. |
| SHOP 외국 기업 보통주 | [추가 상품](evidence/issue-250/info-NAS-SHOP.json), 마스터 `2/N`, 상품 `01`, `CA82509L1076` | [Shopify 제출 문서](https://www.sec.gov/Archives/edgar/data/1594805/000159480526000011/shop-20251231.htm)는 캐나다 법인과 Nasdaq SHOP Class A Subordinate Voting Shares를 명시한다. 국가 때문에 제외하지 않는다. KIS `nationalCode=US`, `natn_cd=840`을 기업 소재지로 해석하지 않는다. |
| TSM 적격 ADR 표본 | [기존 상품](evidence/issue-243/info-NYS-TSM.json), 마스터 `2/Y/TW`, 상품 `01`, `US8740391003` | [TSMC 공식 발표](https://pr.tsmc.com/english/news/2085)는 NYSE TSM ADR 한 개가 보통주 다섯 주를 나타낸다고 설명한다. 표본의 보통주 성격은 확인했지만 DR 필드 전체의 완전성이나 모든 ADR의 적격성을 보장하지 않는다. |
| SPY ETF | [기존 상품](evidence/issue-243/info-AMS-SPY.json)과 [재조회](evidence/issue-250/info-AMS-SPY.json), 마스터 `3/001`, 상품 `01` | [State Street 상품 자료](https://www.ssga.com/us/en/individual/etfs/state-street-spdr-sp-500-etf-trust-spy)도 ETF임을 확인한다. 마스터의 공식 의미와 표본은 연결되나 상품 정보와의 불일치는 미해결이다. |
| VXX ETN | [기존 상품](evidence/issue-243/info-AMS-VXX.json), [마스터](evidence/issue-250/master-ams.json) `3/006`, 상품 `01`, `US06748M1962` | KIS 공식 마스터의 `006=VIX Underlying ETN`과 실제 표본이 연결된다. 일반 ETN `002`의 실제 표본을 대신 검증한 것은 아니며 상품 정보와의 불일치도 남는다. |
| BAC/B 우선주 성격의 예탁증권 | [기존 상품](evidence/issue-243/info-NYS-BAC_B.json), 마스터 `2/N`, 상품 `04`, `US0605052291` | [발행사 우선주 표](https://investor.bankofamerica.com/fixed-income/preferred-stock)의 Series GG는 CUSIP `060505229`, 티커 `BAC PrB`이며 우선주 지분을 나타내는 depositary shares다. BAC/B를 Series B와 혼동하지 않는다. 실제 `04`와 우선주 공식 정의가 대응하며 후보군 제외 대상이다. KIS의 DR `N`만으로 예탁증권 부재를 판정하지 않는다. |
| BAC/L 우선주 | [기존 상품](evidence/issue-243/info-NYS-BAC_L.json), 마스터 `2/N`, 상품 `04`, `US0605056821` | 같은 발행사 표의 Series L Convertible/CUSIP `060505682`와 대응한다. BAC 보통주·BAC/B와 별도 증권이며 제외 대상이다. |
| BBD 우선주 ADR / BBDO 보통주 ADR | [BBD 상품](evidence/issue-250/info-NYS-BBD.json)·[BBDO 상품](evidence/issue-250/info-NYS-BBDO.json), 둘 다 마스터 `2/N/빈 ETP`, 상품 `01` | [Bradesco 공식 자료](https://www.bradescori.com.br/en/services/bradesco-shares/)는 NYSE BBD가 preferred ADR, BBDO가 common ADR임을 명시한다. 표준상품번호는 `US0594603039`와 `US0594604029`로 다르다. 표본의 권리는 다르지만 현재 KIS 유형 필드로 자동 구분하는 근거는 없다. 둘을 회사명으로 합치거나 `01/N`을 이유로 BBD를 포함하지 않는다. |
| ACONW·ADSEW 워런트 | [ACONW 상품](evidence/issue-250/info-NAS-ACONW.json)·[ADSEW 상품](evidence/issue-250/info-NAS-ADSEW.json), 모두 마스터 `2/N`, 상품 `01` | [Nasdaq ACONW 페이지](https://www.nasdaq.com/market-activity/stocks/aconw/analyst-research)와 [Nasdaq의 ADSEW 공지](https://www.nasdaqtrader.com/TraderNews.aspx?id=eca2021-291)가 워런트임을 명시한다. 실제 표본은 확보했으나 KIS `4/02` 대응을 확보한 결과가 아니다. 마스터와 상품의 주식 표시를 보통주로 신뢰하면 오분류한다. |

ACONW·ADSEW는 조사할 표본을 찾는 단계에서만 마스터의 이름을 활용했고, 유형 결론은 거래소 공식 자료로 확인했다. 순위 밖 추가 표본은 분류 검증에만 사용하며 후보군에 편입하거나 상위 N개를 보충하지 않았다. 이름·티커 접미사 규칙이나 개별 종목 허용·차단 목록을 구현하지 않았다.

## 상장 종목 연결과 실패 조건

[공식 순위 필드 기록](evidence/issue-250/official-fields.json)은 `excd=거래소코드`, `symb=종목코드`, `rsym=실시간조회심볼`을 정의한다. 마스터는 `Exchange code`와 `Symbol`을 별도 열로 정의한다. 상품 조회의 공식 입력은 `PRDT_TYPE_CD=512/513/529`가 NAS/NYS/AMS, `PDNO`가 상품번호이며 예시는 AAPL이다. 다음은 원본 필드를 그대로 연결한 실제 표본이다.

| 상장 종목 | 거래량 / 거래대금 순위 | 마스터 | 상품 조회와 응답 |
| --- | --- | --- | --- |
| NAS/AAPL | `excd=NAS`, `symb=AAPL`, `rsym=DNASAAPL`; 순위 `26/5` | `exchangeCode=NAS`, `symbol=AAPL`, `realtimeSymbol=NASAAPL` | `512/AAPL` → `NASD`, 표준상품번호·ISIN `US0378331005` |
| NAS/GOOG | `NAS/GOOG`, `DNASGOOG`; 순위 `100/21` | `NAS/GOOG`, `NASGOOG` | `512/GOOG` → `NASD`, `US02079K1079` |
| NAS/GOOGL | `NAS/GOOGL`, `DNASGOOGL`; 순위 `59/15` | `NAS/GOOGL`, `NASGOOGL` | `512/GOOGL` → `NASD`, `US02079K3059` |
| NYS/TSM | `NYS/TSM`, `DNYSTSM`; 순위 `57/1` | `NYS/TSM`, `NYSTSM` | `513/TSM` → `NYSE`, `US8740391003` |
| AMS/SPY | `AMS/SPY`, `DAMSSPY`; 순위 `7/1` | `AMS/SPY`, `AMSSPY` | `529/SPY` → `AMEX`, `US78462F1030` |

순위와 상품 응답은 [2026-10-17 자료](evidence/issue-243)에, 같은 표본을 재확인한 마스터는 [NAS](evidence/issue-250/master-nas.json)·[NYS](evidence/issue-250/master-nys.json)·[AMS](evidence/issue-250/master-ams.json)에 있다. 표본의 거래소·원본 종목 코드 조합으로 연결할 근거를 확보했지만, 서로 다른 날짜의 자료를 하나의 실행으로 간주하지 않는다. 후속 구현에서는 실행마다 받은 자료 안에서 식별의 유일성을 확인해야 한다.

AAPL의 두 순위는 같은 상장 종목의 서로 다른 근거다. GOOG·GOOGL은 이름이 ALPHABET INC로 같아도 다른 종목 코드·표준상품번호·ISIN을 가진다. BBD·BBDO와 BAC·BAC/B·BAC/L도 별도 유지한다. `DNAS...`·`NAS...`·`NASD`는 원본 표기로 보존하며 접두사를 지워 키를 만들지 않는다. 구두점도 제거하지 않으며 과거 `BAC/PB` 조회 실패를 `BAC/B`의 자동 정규화 규칙으로 바꾸지 않는다. 심볼 변경·거래소 이동 전후의 영구 식별은 검증하지 않았다.

ISIN은 보조 식별자로 사용하며 모든 종목에 필수로 강제하지 않는다. 선택적 ISIN·SEDOL이 누락되어도 검증된 거래소·종목 코드 대응이 유일하면 누락 자체를 조회 실패로 간주하지 않는다. ADSEW는 실제 `sedol_no`가 빈 값이어도 정상 상품 응답이었다. 반대로 표준상품번호·ISIN 등이 상충하여 같은 거래소·종목 코드가 어느 증권인지 확정할 수 없으면 임의로 하나를 선택하지 않는다. 실제 식별 충돌 표본이나 선택적 ISIN 누락 표본은 이번 조사에서 확보하지 못했으며, 그 실패 동작의 실행 검사는 후속 후보군 구현 범위다.

후속 처리 계약은 다음과 같다. 이 표는 조사 결과에 적용할 계약이며 분류기를 구현·실행한 결과가 아니다.

| 상태 | 후속 후보군 처리 |
| --- | --- |
| 식별 뒤 정상 응답에서도 유형을 확정할 수 없음, 미해결 유형 충돌 | 해당 종목을 유형 미확인으로 개별 제외한다. 권리 성격을 확인하지 못한 DR도 여기에 포함한다. |
| 식별 자체가 모호함, 같은 거래소·종목 코드의 증권 식별자가 충돌함 | 전체 실패한다. 다른 종목의 근거를 잘못 합치지 않는다. |
| 인증·통신 실패, 응답 구조 오류 | 조회 실패로 전체 실패한다. 유형 미확인·빈 결과로 바꾸지 않는다. 조사 중에는 확보한 자료와 미완료 항목을 남긴다. |

## 남은 필수 조건과 재개 기준

1. SPY·VXX의 상품 `01`과 마스터 ETP 표시의 불일치를 공식 설명으로 해결해야 한다. 해결 전에는 한 필드를 우선하여 자동 적격성을 확정하지 않는다.
2. 보통주·적격 ADR과 우선주 ADR·워런트를 구분할 수 있는 KIS의 공식 필드·의미·실제 대응이 필요하다. `01`이나 마스터 `2`의 부정확한 보통주 해석, DR `N`에 대한 추정으로 대체하지 않는다. 특히 BBD/BBDO·ACONW/ADSEW 반례를 같은 규칙으로 해결해야 한다.
3. 마스터 `4`·상품 `02/03`, 일반 ETN 세부 코드 `002` 등 실제 대응이 없는 코드는 미검증이다. 워런트 실물 표본을 확보한 것과 공식 코드가 실제 응답에서 작동함을 확인한 것은 별개다. 추가 관측이나 공식 설명으로 갱신되면 해당 유형만 다시 평가한다.
4. 식별의 실제 모호함·자료 충돌·선택적 식별자 누락에 대한 후보군 실행 검사는 후속 구현에서 공용 CLI 경계로 수행한다. 이번에는 식별 표본과 실패 계약을 확인했으며 실행 전체의 완전한 연결이나 시장 전체의 정확도를 보장하지 않는다.
5. #243의 장전 세 시점·정규장 범위·단위·준비 시각·운영값과 #244·#251의 일정·최종 지원 시간 조건은 별개로 남아 있다. 이번 상품 정보 조회 시각이나 표본 확인을 장전 세션 검증으로 취급하지 않는다.

코드와 테스트는 변경하지 않아 TDD용 새 검사나 mutation-probe 음성 대조를 추가하지 않았다. 문구를 고정하는 테스트도 만들지 않았다. 로컬 형식·린트·타입·전체 테스트는 기존 CLI의 회귀 확인이며 실제 유형 분류의 통과 증거가 아니다. Actions 설정을 변경하지 않았다. 두 축의 검토는 합의한 기준점 `835bebed44de81a821660370428101b931953e05` 이후 자료를 문맥으로 사용하고, 이번 추가 문서·증거와 기존 설계 수정·다른 티켓 변경의 책임 범위를 구분한다.
