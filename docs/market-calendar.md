# 공식 거래 일정 CLI 레퍼런스

`scripts/market-calendar.ts`는 공식 연간 일정과 제한된 공지 스냅샷으로 NAS·NYS·AMS의 공통 세션을 계산하는 독립 도구다. KIS·LLM·계정 인증은 사용하지 않는다. 공지의 완전성은 [ADR 0012](adr/0012-bounded-official-calendar-notices.md)의 미검증 운영 가정이며, 실제 수집한 공지의 미지원 형식은 실패로 처리한다. 현재 공식 공지 전체를 처리할 수 있는 운영 지원은 미완료다.

## 실행

Node.js 24 이상, `/usr/bin/xmllint`, `PATH`에서 실행할 수 있는 `pdftotext`가 필요하다. 기존 macOS XML 파서와 설치된 PDF 텍스트 추출기를 사용하며 새 의존성은 추가하지 않았다. 도구가 없으면 `XML_PARSER_UNAVAILABLE` 또는 `PDF_PARSER_UNAVAILABLE`로 종료한다.

```sh
node scripts/market-calendar.ts
node scripts/market-calendar.ts --at 2026-10-26T06:00:00Z
node scripts/market-calendar.ts --at 2026-10-26T15:00:00+09:00
```

`--at`은 초 단위까지 명시한 ISO 시각과 `Z` 또는 UTC 오프셋을 받는다. 실행 중 고정되며 현재 확보한 자료로 해당 시각을 계산한다. 당시 알려져 있던 공지의 복원이나 최종 후보군 CLI의 과거 날짜 지정 기능이 아니다. 필요한 날짜·인접 연도 자료가 없으면 실패한다.

## 자료와 수집 한도

매 실행은 [NYSE 휴장일·거래 시간](https://www.nyse.com/trade/hours-calendars), [Nasdaq 연간 일정](https://www.nasdaqtrader.com/Trader.aspx?id=Calendar), [Nasdaq 정규장 시간 레퍼런스](https://www.nasdaqtrader.com/content/productsservices/trading/oe_refguide.pdf)를 조회한다. NYSE와 NYSE American의 Core Trading Session을 각각 읽으며 Nasdaq의 Market Open·Market Close를 System Hours와 구분한다. 연간 표와 NYSE 조기 폐장 각주를 해석하고 세 거래소의 공통 지원 연도에서 휴장·조기 폐장·정규장 시간이 다르면 실패한다. 지원 연도는 조회 자료에서 정하며 고정 연도로 제한하지 않는다.

NYSE Market Status·Trader Updates는 각각 `publishedDate` 내림차순 첫 페이지의 부모 공지 최대 100건과 포함된 자식 공지를 확인한다. [Nasdaq Equity RSS](https://www.nasdaqtrader.com/rss.aspx?categorylist=2%2C6%2C7&feed=currentheadlines)는 현재 항목과 각 연결 본문을 확인한다. RSS의 공식 `http` 링크는 같은 공식 호스트·경로의 `https`로 조회한다. 다른 호스트·경로, 페이지 순회, 과거 아카이브와 본문의 연쇄 링크는 사용하지 않는다. 요청 실패 시 더 작은 목록이나 오래된 자료로 대체하지 않는다.

안전 상한은 HTTP 요청 100회, 응답당 2,000,000바이트, 합계 16,000,000바이트, 실행 120초, 요청 15초다. RSS 항목은 90개를 넘으면 수집 한도로 실패하며 일부만 처리하지 않는다. 이 값은 구현의 안전 상한이며 공급자 한도나 최종 후보군 도구의 운영값이 아니다. 실행 시간은 단조 시계로 측정해 벽시계 변경을 타임아웃으로 오인하지 않는다. 반복 XML 파싱도 남은 실행 시간의 적용을 받는다.

## 공지 해석의 지원 범위

NYSE의 명시적인 비대상 시장·데이터 상품 라벨은 NAS·NYS·AMS 일정에서 제외한다. `NYSE BQT`는 [공식 설명](https://www.nyse.com/data-products/catalog/nyse-bqt)에 따른 통합 시세·거래 데이터 피드이며 독립 상장시장이 아니다. `NYSE`·`NYSE AMERICAN EQUITIES` 공지는 부모와 모든 자식의 본문을 검사한다. Nasdaq은 사이드바와 탐색 메뉴를 제외한 실제 기사 본문 전체를 검사한다.

지원하는 본문은 완결된 정상 운영 단문, 정해진 필드로 구성된 짧은 상장 단문, 단일 문장으로 완결된 추모 휴장 형식과 미래 거래 확대 안내 형식이다. 단어 일부가 맞거나 제목이 알려진 유형이라는 이유로 나머지 본문을 무시하지 않는다. 추가 문장·정정·미지원 표현이 남으면 `NOTICE_UNRESOLVED`다. 여러 문단의 실제 공지를 짧은 단문 형식과 같다고 취급하지 않는다. 거래 확대의 전체 본문이 지원 형식에 맞고 적용일이 판단 대상 세션보다 뒤일 때만 적용일과 미해석 사유를 `deferredNotices`에 남긴다. 적용일에 도달했거나 이미 영향을 받는 대상 세션이면 실패한다.

휴장 공지나 연간 일정에 요일과 숫자 날짜가 함께 있으면 둘의 일치를 검사한다. 부모·자식 공지의 휴장 날짜를 추가 휴장으로 합치지 않는다. 자식이 있는 휴장 공지와 제목에 정정·대체 표지가 있는 일정 변경은 관계를 지원하지 못한 상태로 실패시킨다.

2026-10-26에 저장한 실제 응답을 재생했을 때 NYSE 공지 `110000959612`의 Openbook Ultra 기술 문제 본문은 미지원 형식으로 차단됐다. 개별 종목·시세 장애라는 조사자의 판단을 코드의 전체 본문 해석 성공으로 승격하지 않았다. 실제 Nasdaq `ETA2026-56`의 여러 문단도 단문 거래 확대 형식으로 자동 유예하지 않는다. 본문에서 시간 변경의 영향을 배제할 수 없는 공지를 지원하려면 전체 형식을 확인하고 같은 공개 CLI 경계의 검사와 음성 대조를 추가해야 한다.

## 출력과 실패

성공은 stdout의 JSON 하나와 종료 코드 0이다. 확인된 장중도 독립 도구에서는 `analysisEligible: false`인 정상 결과다. 최종 후보군 CLI의 장중 거부와 구분한다. 정규장 폐장 시각부터 해당 세션을 완료된 세션으로 삼고, 다음 개장은 판정 시각보다 엄격히 뒤인 첫 개장이다. 현재 시각 실행은 자료 수집 이후와 출력 직전에 시각을 확인한다.

| 필드 | 의미 |
| --- | --- |
| `evaluatedAt`, `timeZone` | 판정 순간과 거래 날짜에 사용하는 뉴욕 시간대 |
| `dataSession`, `targetSession` | 직전 완료 세션과 다음 정규장의 거래 날짜·개장·폐장 시각 |
| `analysisEligible` | 폐장부터 다음 개장 직전까지의 일정상 분석 대상 여부 |
| `calendarCoverage` | 거래소별 연간 자료의 연도와 출처 |
| `noticeCompleteness` | 항상 `unverified`인 공지 완전성 한계 |
| `noticeCollections` | 채널·조회 조건·부모와 자식 수·연결 본문 수·관측 게시일 범위. 연속적인 보존 범위는 `unverified` |
| `scheduleChanges`, `deferredNotices` | 지원 형식에서 반영한 휴장과 적용일 이전으로 처리를 미룬 단문 안내 |
| `sources` | 자료별 URL·수신 시각·바이트 수·SHA-256. 원문 전체는 저장하거나 출력하지 않음 |

실패는 stdout을 비우고 stderr의 JSON과 종료 코드 1로 알린다. `USAGE`, `SOURCE_SHAPE`, `SOURCE_HTTP_FAILURE`, `CALENDAR_RANGE`, `EXCHANGE_MISMATCH`, `NOTICE_UNRESOLVED`, `COLLECTION_LIMIT`와 파서 부재를 구분한다. 그 밖의 통신·처리 오류는 원문 오류 메시지 없이 `REQUEST_FAILED`다. `source`·`notice`는 오류 시점에 처리하던 자료와 공지의 식별자이며 원인 전체를 단일 자료로 확정한다는 뜻은 아니다.

## 검증과 현재 한계

공개 검증 경계는 CLI 인수·stdout·stderr·종료 코드와 외부 HTTP다. [회귀 검사](../tests/market-calendar.test.mjs)와 [시간 경계 검사](../tests/market-calendar-boundaries.test.mjs)는 외부 HTTP와 시각만 대체하며 실제 XML·PDF 파서를 실행한다. 모의 정상 결과는 실제 공지 전체의 해석 성공이나 제품 인수 완료가 아니다.

2026-10-26 첫 실제 CLI 실행은 NYSE 패널의 DOM 추출 실패를 드러냈고 실제 버튼·패널 구조로 수정했다. 수정 후 실제 실행은 Nasdaq `ETA2022-79` 요청 중 `REQUEST_FAILED`와 빈 stdout으로 끝났다. 그 공지의 단건 진단에서는 HTTP 200·UTF-8 응답을 받았으므로 앞선 요청 실패의 원인은 확정하지 못했다. 같은 전체 실행을 반복해 성공으로 바꾸려 하지 않았다. 별도의 저장 응답 재생은 위 미지원 NYSE 공지에서 실패했다. 현재 실제 정상 일정 JSON 출력과 #244의 운영 완료는 미확보이며 KIS·후보군 연결·매수 추천 인수는 이 도구의 검증으로 대체하지 않는다.
