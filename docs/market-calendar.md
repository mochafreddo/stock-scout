# 공식 거래 일정 CLI 레퍼런스

`scripts/market-calendar.ts`는 공식 연간 일정과 제한된 공지 스냅샷으로 NAS·NYS·AMS의 공통 세션을 계산하는 도구다. [ADR 0013](adr/0013-llm-calendar-notice-assessment.md)에 따라 공지의 의미는 SIWC 구독 모델이 판단하고 코드는 검증·일정 계산을 담당한다. KIS·웹 검색·추가 조회 도구는 제공하지 않는다. 공지 완전성과 모델의 의미적 정확성은 보장이 아니며 [설계 계약](calendar-notice-assessment-design.md)과 [실제 검증 상태](market-calendar-validation.md)를 구분한다.

## 실행

Node.js 24 이상, 잠금 파일의 AI SDK 의존성, `/usr/bin/xmllint`, `PATH`에서 실행할 수 있는 `pdftotext`, 기존 Stock Scout 전용 SIWC 인증이 필요하다. 새 의존성이나 API 키는 추가하지 않는다. 소스 파서가 없으면 `XML_PARSER_UNAVAILABLE` 또는 `PDF_PARSER_UNAVAILABLE`로 종료한다. 인증은 [기존 연결 절차](llm-security-probe.md#공식-구독-인증-연결하기)를 따르며 Codex 인증이나 브라우저 쿠키로 대체하지 않는다.

```sh
node scripts/market-calendar.ts --auth-dir /absolute/private/stock-scout --model gpt-6.1-sol
node scripts/market-calendar.ts --auth-dir /absolute/private/stock-scout --model gpt-6.1-sol --at 2026-10-26T06:00:00Z
node scripts/market-calendar.ts --auth-dir /absolute/private/stock-scout --model gpt-6.1-sol --at 2026-10-26T15:00:00+09:00
```

`--at`은 초 단위까지 명시한 ISO 시각과 `Z` 또는 UTC 오프셋을 받는다. 실행 중 고정되며 현재 확보한 자료로 해당 시각을 계산한다. 당시 알려져 있던 공지의 복원이나 최종 후보군 CLI의 과거 날짜 지정 기능이 아니다. 필요한 날짜·인접 연도 자료가 없으면 실패한다.

`--auth-dir`과 `--model`은 필수다. 모델은 명시한 값만 사용하고 이용 불가·구독 한도·인증 실패 때 다른 모델이나 유료 API로 전환하지 않는다. 첫 후보 `gpt-6-luna`는 실제 전체 입력에서 근거 누락과 판단 불일치를 보였다. 사용자가 다음 후보로 선택한 `gpt-6.1-sol`은 작은 실제 표본과 전체 CLI를 한 번 통과했다. 이는 모델 접근 가능성·응답 시간·전체 공지 정확성의 보장이 아니다.

## 자료와 수집 한도

매 실행은 [NYSE 휴장일·거래 시간](https://www.nyse.com/trade/hours-calendars), [Nasdaq 연간 일정](https://www.nasdaqtrader.com/Trader.aspx?id=Calendar), [Nasdaq 정규장 시간 레퍼런스](https://www.nasdaqtrader.com/content/productsservices/trading/oe_refguide.pdf)를 조회한다. NYSE와 NYSE American의 Core Trading Session을 각각 읽으며 Nasdaq의 Market Open·Market Close를 System Hours와 구분한다. 연간 표와 NYSE 조기 폐장 각주를 해석하고 세 거래소의 공통 지원 연도에서 휴장·조기 폐장·정규장 시간이 다르면 실패한다. 지원 연도는 조회 자료에서 정하며 고정 연도로 제한하지 않는다.

NYSE Market Status·Trader Updates는 각각 `publishedDate` 내림차순 첫 페이지의 부모 공지 최대 100건과 포함된 자식 공지를 확인한다. [Nasdaq Equity RSS](https://www.nasdaqtrader.com/rss.aspx?categorylist=2%2C6%2C7&feed=currentheadlines)는 현재 항목과 각 연결 본문을 확인한다. RSS의 공식 `http` 링크는 같은 공식 호스트·경로의 `https`로 조회한다. 다른 호스트·경로, 페이지 순회, 과거 아카이브와 본문의 연쇄 링크는 사용하지 않는다. 요청 실패 시 더 작은 목록이나 오래된 자료로 대체하지 않는다.

수집 상한은 HTTP 요청 100회, 응답당 2,000,000바이트, 합계 16,000,000바이트, 수집 120초, 개별 요청 15초다. RSS 항목은 90개를 넘으면 실패하며 일부만 처리하지 않는다. 전체 실행은 인증을 포함해 최대 300초이고 모델 판단은 전체 남은 시간 안에서 최대 180초다. 모델 입력은 지침·스키마·공지 데이터가 포함된 직렬화 입력 256KiB, 요청은 한 번이며 자동 재시도·복구 호출·분할·요약·캐시는 없다. 이 값은 승인한 안전 상한이며 공급자 한도·모델의 문맥 수용·처리 시간·최종 후보군 도구의 운영값을 보장하지 않는다. 경과 시간은 단조 시계로 측정하며 파서와 모델도 남은 실행 시간의 적용을 받는다.

## 공지 해석의 지원 범위

NYSE의 명시적인 비대상 시장·데이터 상품 라벨은 NAS·NYS·AMS 일정에서 제외한다. `NYSE BQT`는 [공식 설명](https://www.nyse.com/data-products/catalog/nyse-bqt)에 따른 통합 시세·거래 데이터 피드이며 독립 상장시장이 아니다. `NYSE`·`NYSE AMERICAN EQUITIES` 공지는 부모와 모든 자식의 본문을 검사한다. Nasdaq은 사이드바와 탐색 메뉴를 제외한 실제 기사 본문 전체를 검사한다.

대상 공지 전체는 부모·자식·다른 공지의 정정 관계를 포함해 한 모델 요청에서 판단한다. 정해진 단문 정규식으로 일부 공지를 성공시키는 경로는 없다. 모델은 일정 영향 없음·일정 변경·미래 적용·판단 불가와 본문 근거를 제시한다. 코드는 모든 입력 결과의 존재·중복·본문 근거 연결과 날짜·시간·정정 참조를 검사하고 일정을 계산한다. 모델이 원문을 잘못 해석할 위험은 남으며 구조 검사나 자신감 점수로 의미의 타당성을 증명하지 않는다.

본문 전체는 순서 있는 구간과 코드가 부여한 ID로 전달한다. 구간들을 연결하면 입력 본문이 그대로 복원되며 모델에는 요약본을 보내지 않는다. 모델이 선택한 구간 ID에서 코드가 본문 ID와 정확한 인용을 복원하므로 문자열 복사에 따른 공백 변경이나 ID·인용 조합 오류를 줄인다. 인용은 구간당 최대 240개 유니코드 코드 포인트이며 유효하지만 의미상 부적절한 구간을 선택할 위험은 남는다.

휴장·개장 지연·조기 폐장과 해결된 정정·철회를 반영한다. 부모·자식의 변경 전후 날짜를 추가 휴장으로 합치지 않는다. 불명확·상충·미해결 정정 관계는 실패한다. 지원하지 않는 미래 정규장 범위 변경은 적용일과 근거를 남기고 필요한 세션이 적용일에 도달하면 실패한다. 연간 일정의 날짜·요일 일치 검사와 공통 세션·인접 연도 검사도 유지한다.

2026-10-26의 코드 전용 해석은 NYSE `110000959612`와 Nasdaq `ETA2026-56`의 실제 본문을 처리하지 못했다. 이 과거 실패를 새 모델 경로의 검증 성공으로 바꾸지 않는다. 새 경로의 실제 실행·독립 표본·회귀·음성 대조 결과는 검증 기록에 별도로 남긴다.

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
| `noticeAssessment`, `noticeAssessments` | 사용한 모델·SIWC 인증·요청 수·의미적 신뢰도 미검증과 공지별 판단·이유·본문 근거·일정 변경·정정 참조 |
| `scheduleChanges`, `deferredNotices` | 검증한 공지 판단에서 반영한 일정 변경과 적용일 이전으로 처리를 미룬 변경 |
| `sources` | 자료별 URL·수신 시각·바이트 수·SHA-256. 원문 전체는 저장하거나 출력하지 않음 |

실패는 stdout을 비우고 stderr의 JSON과 종료 코드 1로 알린다. `USAGE`, `SOURCE_SHAPE`, `SOURCE_HTTP_FAILURE`, `CALENDAR_RANGE`, `EXCHANGE_MISMATCH`, `NOTICE_UNRESOLVED`, `COLLECTION_LIMIT`와 파서 부재를 구분한다. 모델 입력·요청·실행 한도, 응답 형식·명시적 완료·인증·구독 한도·모델 이용 불가도 별도로 실패시킨다. 일반적인 429를 확인된 구독 한도 소진으로 취급하지 않는다. 그 밖의 수집 통신·처리 오류는 원문 오류 메시지 없이 `REQUEST_FAILED`다. `source`·`notice`는 자료 수집·파싱 시점의 식별자이며 모델 오류를 마지막으로 읽은 공지의 결함으로 표현하지 않는다.

## 검증과 현재 한계

공개 검증 경계는 CLI 인수·stdout·stderr·종료 코드와 외부 HTTP다. [회귀 검사](../tests/market-calendar.test.mjs)와 [시간 경계 검사](../tests/market-calendar-boundaries.test.mjs)는 외부 HTTP와 시각만 대체하며 실제 XML·PDF 파서를 실행한다. 모의 정상 결과는 실제 공지 전체의 해석 성공이나 제품 인수 완료가 아니다.

2026-10-26 첫 실제 CLI의 NYSE DOM 추출 실패는 수정했고 다음 실행은 Nasdaq `ETA2022-79` 요청 중 `REQUEST_FAILED`로 끝났다. 당시 단건 진단은 HTTP 200이어서 원인은 미확정이며 저장 응답 재생은 미지원 본문으로 실패했다. 2026-10-28에는 실제 공지 113개 본문을 확보했지만 이 수집·크기 측정만으로 새 모델 경로의 정상 실행·판단 품질을 검증하지 않았다. 실제 검증의 현재 상태는 [검증 기록](market-calendar-validation.md)을 따른다. KIS·후보군 연결·매수 추천 인수는 이 도구의 검증으로 대체하지 않는다.
