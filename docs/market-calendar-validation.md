# 공식 거래소 일정의 선행 검증

2026-10-18에 [#244](https://github.com/mochafreddo/stock-scout/issues/244)의 구현 요청을 받아 공식 변경 공지 경로부터 확인한 기록이다. [#237](https://github.com/mochafreddo/stock-scout/issues/237)과 [#239](https://github.com/mochafreddo/stock-scout/issues/239)의 시장 데이터 검증을 대신하지 않는다.

## 2026-10-26 구현 상태

후속 `$implement` 요청으로 독립 [일정 CLI](market-calendar.md)와 공개 CLI·외부 HTTP 회귀 검사를 구현했다. 아래 설계의 수집 한계는 유지하며 공지 본문 전체가 지원 형식과 맞지 않으면 실패한다. 실제 현재 공지의 정상 처리와 #244의 운영 완료는 아직 확보하지 못했다. 첫 실연동의 NYSE DOM 추출 실패는 실제 버튼·패널 구조로 수정했고, 다음 실제 실행은 Nasdaq `ETA2022-79` 요청 중 실패했다. 단건 진단은 정상이어서 당시 요청 실패의 원인을 확정하지 못했다. 저장한 실제 응답 재생에서는 NYSE `110000959612`가 미지원 본문으로 차단됐다. 실제 수집 확인·모의 회귀·미지원 실패를 구분하며 KIS·모델은 호출하지 않았다.

## 2026-10-26 설계 확정 당시 기준

설계 인터뷰에서 [ADR 0012](adr/0012-bounded-official-calendar-notices.md)의 제한된 수집과 공지 완전성 미검증을 운영 가정으로 채택했다. 필요한 공지를 빠짐없이 수집했다는 입증은 첫 버전의 구현·완료 관문에서 제외한다. 공식 연간 일정과 공지는 실행마다 조회하며, 수집한 공지의 일정 영향을 배제하지 못하고 대상 시장·적용일·시간·정정 관계도 확정하지 못하면 실패한다. 이 합의는 일정 CLI의 구현·회귀 검사·실제 일정 해석 완료나 후속 제품의 차단 해제를 뜻하지 않는다.

NYSE Market Status·Trader Updates는 채널별 최신 부모 공지 최대 100건과 응답에 포함된 자식 공지 전체, Nasdaq은 현재 Equity RSS 항목과 연결 본문을 확인한다. 페이지·과거 아카이브·본문의 연쇄 링크는 순회하지 않는다. 목록 밖의 유효한 공지나 오래된 부모 공지의 새 변경을 놓칠 위험을 허용하고 결과에 표시한다. 정상 JSON에는 출처·채널·조회 시각·조회 조건·실제 항목 수·목록에 표시된 날짜 범위와 공지 완전성 미검증을 포함한다. 표시된 날짜 범위는 연속적인 보존 범위가 아니다. `--at`은 현재 확보한 자료로 지정 시각을 계산하며 당시 공지 상태를 복원하지 않는다.

2026-10-26 06:27~06:30 UTC의 인증 없는 직접 HTTP 관측은 다음과 같다. 모두 HTTP 200이며 실제 JSON·XML 구조와 항목 수를 확인했다. 이는 아래 요청 형태의 일회 수집 확인이며 안정된 외부 API 계약이나 향후 응답을 보장하지 않는다.

| 출처·요청 | 실제 관측 | 확인 한계 |
| --- | --- | --- |
| [NYSE Market Status 첫 페이지 100건](https://www.nyse.com/api/notifications/public/system/2/summaries/filter?pageSize=100&pageNumber=0&sortKey=publishedDate&sortOrder=desc) | 부모 100건·자식 162건, `totalCount` 796 | 전체 이력 중 일부이며 자식 공지의 최근 갱신을 기준으로 정렬한다는 근거는 없다. |
| [NYSE Trader Updates 첫 페이지 100건](https://www.nyse.com/api/notifications/public/system/1/summaries/filter?pageSize=100&pageNumber=0&sortKey=publishedDate&sortOrder=desc) | 부모 100건·자식 2건, `totalCount` 18,869 | 전체 이력·수정·철회를 모두 확인한 결과가 아니다. |
| [Nasdaq Equity RSS](https://www.nasdaqtrader.com/rss.aspx?categorylist=2%2C6%2C7&feed=currentheadlines) | 항목 44건과 게시 시각·연결 URL·HTML 설명을 확인 | 전체 이력·수정 관계의 메타데이터와 연속적인 보존 범위는 확인하지 못했다. 연결 본문 전체를 이번에 수집·해석한 것은 아니다. |

NYSE 첫 페이지 9건 요청도 두 채널에서 각각 9건을 반환했다. 100건 상한의 실제 요청 지원은 확인했지만 적용 시장·적용일·시간을 자동 해석할 공지 형식은 아직 검증하지 않았다. 구현 전에는 연간 일정과 세 거래소의 적용 근거, 지원 공지 형식·관련성 판정·정정 처리를 확인하고, 일정 영향이 불명확한 공지를 실패시키는 경로를 마련한다. 지원 형식을 확인하지 못한 항목은 미결정 사항으로 남긴다. 완전성이나 과거 아카이브 전수 확인을 이 작업의 선행 조건으로 다시 추가하지 않는다.

#244는 독립 일정 도구의 실제 수집 확인·구현·공개 CLI 및 외부 HTTP 회귀 검사·음성 대조로 완료를 평가한다. 기존 개폐장·서머타임·휴장·조기 폐장·공통 세션·필요한 인접 연도·출력 직전 재판정 검사는 유지한다. KIS 데이터 준비·후보군 연결·매수 추천 인수는 후속 티켓 범위다. 이번 변경은 로컬 설계 문서와 이슈 수정안 작성이며 코드·원격 이슈·완료 상태는 변경하지 않는다.

이하 절은 2026-10-18 당시 조사와 재개 조건을 보존한 기록이다. 공지 완전성 관문과 전수 수집 조건은 위 현재 기준으로 대체하며 당시 관측·실패·미검증 사실은 유지한다.

## 2026-10-18 당시 판정

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
