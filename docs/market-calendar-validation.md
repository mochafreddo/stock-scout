# 공식 거래소 일정의 선행 검증

2026-10-18에 [#244](https://github.com/mochafreddo/stock-scout/issues/244)의 구현 요청을 받아 공식 변경 공지 경로부터 확인한 기록이다. [#237](https://github.com/mochafreddo/stock-scout/issues/237)과 [#239](https://github.com/mochafreddo/stock-scout/issues/239)의 시장 데이터 검증을 대신하지 않는다.

## 판정

공식 연간 일정과 별도 공지의 실제 조회 경로는 확인했지만, 필요한 날짜 구간의 변경 공지를 빠짐없이 최신 상태로 확인했다는 근거는 아직 부족하다. #244의 구현 선행 조건은 미충족이며 일정 CLI는 구현하지 않았다. 접근 불가능하다는 결론이나 공식 자료만으로 구현할 수 없다는 결론은 아니다.

연간 일정만으로 성공하는 도구나 항상 실패하는 임시 CLI는 추가하지 않았다. #244의 완료 조건과 후속 후보군·추천 구현의 차단은 유지한다. 공용 검증 경계는 합의한 CLI 인수·표준 출력·표준 오류·종료 코드이며, 검토 기준점은 `86af4dbe2f0fe204de5a738ac3345246396fe341`이다. [설계 결정](adr/0003-market-calendar-boundary.md)은 구현 완료 기록과 구분한다.

## NYSE와 NYSE American

[공식 휴장일·거래 시간](https://www.nyse.com/trade/hours-calendars)은 2026~2028년의 전체 NYSE 시장 휴장일과 조기 폐장을 제공하며, NYSE와 NYSE American의 Core Trading Session을 각각 09:30~16:00 ET로 명시한다. 이 조회 결과의 연도 범위를 제품의 고정 지원 연도로 정하지 않는다. 필요한 인접 연도와 변경 공지까지 확인해야 한다.

[Market Resources](https://www.nyse.com/markets/resources)는 시장·거래 변경을 Market Status와 Trader Updates에서 확인하도록 안내한다. [Market Status 이력](https://www.nyse.com/market-status/history)과 [Trader Updates 이력](https://www.nyse.com/trader-update/history)의 초기 HTML에는 필터만 있고 공지 본문이 없었지만, 공식 페이지가 불러오는 JavaScript에서 실제 공개 JSON 경로를 찾았다. 빈 HTML을 변경 없음으로 판정하지 않았다.

2026-10-18 13:16 UTC 이후 직접 HTTP로 확인한 결과는 다음과 같다. 개별 공지의 게시 시각과 HTTP 응답 시각은 공지 수집 범위의 최신성 보증과 구분한다.

| 경로 | 관측 결과 | 확인 한계 |
| --- | --- | --- |
| [Market Status 첫 페이지](https://www.nyse.com/api/notifications/public/system/2/summaries/filter?pageSize=9&pageNumber=0&sortKey=publishedDate&sortOrder=desc) | JSON의 `totalCount`는 793, `oldestPublishedYear`는 2007이며 첫 페이지는 9건이다. 첫 공지 게시일은 2026-08-25이다. | 오래된 최근 게시일만으로 응답이 낡았거나 이후 변경이 없다고 판정할 수 없다. |
| [Market Status 마지막 페이지](https://www.nyse.com/api/notifications/public/system/2/summaries/filter?pageSize=9&pageNumber=88&sortKey=publishedDate&sortOrder=desc) | 같은 총건수와 마지막 1건을 받았다. | 중간 87페이지를 전수 수집하거나 페이지 사이의 일관성을 검증하지 않았다. |
| [Trader Updates 첫 페이지](https://www.nyse.com/api/notifications/public/system/1/summaries/filter?pageSize=9&pageNumber=0&sortKey=publishedDate&sortOrder=desc) | `totalCount`는 18,855, `oldestPublishedYear`는 2006이며 첫 페이지는 9건이다. 첫 공지 게시일은 2026-10-15이다. | 조회 응답에는 특정 시각까지의 전체 공지가 반영됐음을 나타내는 별도 필드가 없다. |
| [Status 시장 필드](https://www.nyse.com/api/notifications/public/system/2/field), [Trader Updates 시장 필드](https://www.nyse.com/api/notifications/public/system/1/field) | NYSE와 NYSE AMERICAN EQUITIES가 별도 항목이다. 시장 ID는 채널마다 다르다. | 옵션 시장과 주식 시장을 이름 일부만으로 합치면 안 된다. |
| [Carter 검색](https://www.nyse.com/api/notifications/public/system/1/summaries/filter?searchKey=Carter&pageSize=9&pageNumber=0&sortKey=publishedDate&sortOrder=desc) | 3건 중 공지 `110000946590`의 본문은 NYSE와 NYSE American Equities 등을 명시하고 2025-01-09 휴장을 알린다. | 한 사례 조회는 다른 일정 변경의 수집 완전성을 입증하지 않는다. 검색어가 같은 무관한 공지도 반환된다. |

조회 구현의 근거는 당시 공식 페이지가 참조한 [컴포넌트 목록](https://static.nyse.com/cms/41.10.17/chunks/__generated__/components/main-B_XpGw9E.js), [공지 이력 컴포넌트](https://static.nyse.com/cms/41.10.17/chunks/cms-components/notification-history-2023/Main-BJsb_WRt.js), [시장 필드 조회](https://static.nyse.com/cms/41.10.17/chunks/cms-components/notification-history-2023/hooks/useFetchFields-1QXzp5L0.js)다. 이는 공개 프런트엔드의 관측 경로이며 안정된 외부 API 계약으로 확인한 것은 아니다.

API는 게시일 정렬·페이지 번호·페이지 크기와 시장·서비스 필터를 사용한다. 부모 공지의 `publishedDate`와 `childNotifications`의 게시 시각이 별도로 존재한다. 부모 게시일만으로 조회 기간을 제한하면 오래된 부모 공지에 달린 새 변경을 놓칠 수 있으므로, 날짜 필터가 자식 변경까지 포함하는지 별도 검증해야 한다. 이는 응답 구조에서 도출한 위험이며 실제 누락을 재현했다는 뜻은 아니다.

현재 상태 주소인 `https://www.nyse.com/market-status`에서도 같은 이력 컴포넌트를 확인했다. 이번 조사에서는 필요한 날짜 구간의 공지를 모두 확인했다는 시각 표시나 정상 운영 확인을 확보하지 못했다. HTTP 200, 서버의 응답 날짜, 페이지의 총건수만으로 이 조건을 충족했다고 처리하지 않는다.

## Nasdaq

[공식 거래 달력](https://www.nasdaqtrader.com/Trader.aspx?id=Calendar)은 조기 폐장일의 자세한 운영 시간을 별도 알림에서 확인하도록 안내한다. [RSS 안내](https://www.nasdaqtrader.com/Trader.aspx?id=NewsRSS)는 전체 뉴스와 Equity 뉴스의 구독 경로를 제공한다. 연간 일정과 별도 알림을 결합할 근거는 있지만, 현재 피드만으로 과거 공지까지 모두 확인했다고 볼 수는 없다.

2026-10-18 직접 HTTP 확인에서 [전체 RSS](https://www.nasdaqtrader.com/rss.aspx?categorylist=0&feed=currentheadlines)는 716건, [Equity RSS](https://www.nasdaqtrader.com/rss.aspx?categorylist=2%2C6%2C7&feed=currentheadlines)는 46건이며 선언된 `numItems`와 실제 항목 수가 같았다. 13:16 UTC 조회의 channel 게시 시각은 각각 13:15:52와 13:15:53 GMT, `ttl`은 1이었다. Equity RSS를 다시 조회했을 때는 13:21:00 GMT로 바뀌었고 46건이었다. 이는 실제 생성 시각이 갱신되는 공지 피드를 확인한 결과다. 오래된 항목도 섞여 있으므로 가장 오래된 항목의 날짜를 연속적인 보존 범위로 해석하지 않는다.

분리된 자동화 브라우저로 [뉴스 아카이브](https://www.nasdaqtrader.com/Trader.aspx?id=archiveheadlines&cat_id=2)를 열어 실제 동적 조회도 확인했다. 연도 선택에는 1997~2026년이 있었고 2026년에는 데이터 행 60개가 표시됐다. 2024년을 선택하자 Carter 추모 휴장 공지 링크 `ETA2024-87`을 회수했다. [해당 본문](https://www.nasdaqtrader.com/TraderNews.aspx?id=ETA2024-87)은 2024-12-30 게시와 2025-01-09 미국 주식·옵션 시장 휴장을 구분해 명시한다. URL·목록의 식별자는 `ETA2024-87`이지만 본문 표시 번호는 `#2024 - 86`이었다. 식별자 숫자를 일정이나 본문 정확성의 근거로 사용하지 않는다.

이 조회는 연도 경계를 넘는 실제 돌발 휴장 공지를 아카이브에서 회수한 양성 대조다. 원문 HTML이나 단독 RPC 요청이 비어 있다는 이유로 아카이브 조회 불가능이라고 결론 내리지 않는다. 다만 모든 관련 카테고리·연도의 전수 수집, 갱신·철회 반영과 수집 종료 조건은 검증하지 않았다. 표시된 행 수만으로 누락이 없다고 판정하지 않는다.

[현재 상태](https://www.nasdaqtrader.com/Trader.aspx?id=MarketSystemStatus)는 조회 당일인 일요일에도 시스템 정상으로 표시됐다. [상태 검색](https://www.nasdaqtrader.com/Trader.aspx?id=MarketSystemStatusSearch)은 데이터 시작일을 2000-12-29로 안내하며, 빈 검색 결과의 의미를 해당 날짜의 시스템 정상으로 설명한다. 브라우저에서 시작일 `10/16/2026`, 종료일 `10/19/2026`, subject `All`, 시장 `The Nasdaq Stock Market`으로 실제 검색했을 때 10월 16일의 결과 9행을 받았다. 현재 상태나 이 검색 결과는 다음 월요일의 정규장 개장 시각을 검증한 결과가 아니다.

Nasdaq은 공개 RSS·아카이브·상태 검색을 수집 경로의 후보로 사용할 수 있다. 독립 HTTP RPC 구현이나 특정 SLA가 없다는 이유만으로 배제하지 않는다. 남은 조건은 필요한 공지 범위를 실제로 끝까지 수집하고, 별도 시간 변경 공지의 적용 날짜·시각과 후속 정정을 해석하여 연간 일정에 반영하는 검증이다. 이번 조사는 그 전체 경로의 성공을 입증하지 못했다.

## 재개 조건

1. 거래소별로 직전 완료 세션부터 현재 날짜와 다음 개장까지 필요한 변경 공지의 조회 범위를 정하고, 오래된 공지의 새 수정·철회와 미래 적용 공지도 그 범위에 포함되는지 확인한다.
2. NYSE 페이지 전수 조회 중 변경이 생길 때 누락·중복을 탐지할 수 있는지, 날짜 필터가 자식 공지 갱신을 어떻게 처리하는지 실제 응답으로 검증한다. Nasdaq의 공지 보존·검색 범위도 필요한 구간을 덮는지 확인한다.
3. 정상 시스템 상태와 일정 변경 없음의 의미를 구분하고, 조회 시점까지 필요한 공지가 반영됐다고 판단할 수 있는 공식 근거와 통신·해석 실패 조건을 기록한다. 반드시 특정 형식의 SLA가 있어야 한다는 새 요구사항을 추가하는 것은 아니다.
4. 이 근거를 확보한 뒤 CLI의 작은 수직 기능부터 구현한다. 미확인 공지, 거래소 간 불일치, 인접 연도 누락은 실패로 처리한다. 합의한 시간 경계·실행 도중 개장·고정 `--at` 검사를 CLI에서 수행한다.

## 검증 범위

이번 변경은 선행 조사와 기존 설계 합의의 문서화다. KIS·LLM 호출, 인증 파일 접근, Actions 설정 변경은 수행하지 않았다. 일정 CLI가 없으므로 일정 경계 모의 테스트와 해당 로직의 음성 대조는 수행하지 않았다. 기존 인증 CLI의 모의 테스트 통과를 일정 수집이나 장전 실연동 검증으로 대체하지 않는다.
