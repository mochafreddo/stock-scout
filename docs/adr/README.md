# 설계 결정 기록

이 목록에서 각 결정의 배경과 근거를 확인할 수 있습니다. 후속 ADR에서 기존 결정의 일부 범위만 대체한 경우가 있습니다. 각 본문의 대체 안내와 연결된 결정을 함께 확인하세요.

- [0001 KIS 발급 기록이 없는 실행의 대기와 공통 발급 제한](0001-kis-token-issuance-state.md)
- [0002 KIS 명시적 만료의 조건부 캐시 무효화](0002-kis-expired-token-invalidation.md)
- [0003 거래소 일정의 공통 기준 세션과 장전 범위](0003-market-calendar-boundary.md)
- [0004 커밋 대상 스냅샷을 검사한다](0004-staged-commit-validation.md)
- [0005 종목 유형 판별에 외부 공식 자료를 허용한다](0005-official-security-type-sources.md)
- [0006 종목 유형과 증권 연결에 제3자 공급자를 검토한다](0006-third-party-security-type-sources.md)
- [0007 조회 근거에 따른 종목 유형 판단을 LLM에 맡긴다](0007-llm-security-type-judgment.md)
- [0008 구독 인증은 API 실행 전에 자동 갱신한다](0008-siwc-preflight-refresh.md)
- [0009 완료 정규장 데이터로 다음 정규장의 매수 후보를 판단한다](0009-close-based-daytime-buy-candidates.md)
- [0010 종목 유형 판단은 완성된 작은 흐름부터 검증한다](0010-incremental-security-type-validation.md)
- [0011 조회 당시 순위로 탐색하고 실행마다 일봉 준비 여부를 검사한다](0011-ranking-discovery-and-runtime-data-readiness.md)
- [0012 공식 일정과 제한된 변경 공지 수집을 운영 가정으로 사용한다](0012-bounded-official-calendar-notices.md)
- [0013 공식 공지의 일정 영향은 LLM이 판단하고 코드는 일정을 계산한다](0013-llm-calendar-notice-assessment.md)
- [0014 후보군 경로에 공통 마감과 분리된 요청 예산을 적용한다](0014-candidate-runtime-budget.md)
- [0015 검증한 후보군과 일봉으로 구독 매수 후보 보고서를 만든다](0015-subscription-buy-candidate-report.md)
- [0016 구독 한도 소진 뒤 추천 요청의 최대 비용을 먼저 확보한다](0016-bounded-paid-recommendation.md)
- [0017 모델 요청 생명주기는 공통 모듈이 소유한다](0017-model-request-lifecycle.md)
- [0018 상장 종목의 식별과 탐색 순위 누적은 공통 모듈이 소유한다](0018-listed-security-ranking-ownership.md)
