# 문서 안내

[처음 실행하고 검증하기](getting-started.md)에서 실행 환경과 인증을 준비하세요. 도메인 용어는 [용어집](../GLOSSARY.md), 제품 요구사항은 [#237](https://github.com/mochafreddo/stock-scout/issues/237)에서 확인할 수 있습니다.

## 사용과 개발

| 필요한 작업 | 문서 |
| --- | --- |
| 미국 순위·거래 가능 종목·종목 정보·가격 조회 | [토스 JSON CLI](toss-cli.md) |
| 토스 실자료 전달·조회 전용 권한과 접근 준비 | [허용·권한 확인 및 미전송 문의 초안](toss-access-readiness.md) |
| 다음 정규장의 매수 후보 확인 | [매수 후보 보고서](buy-candidates.md) |
| 후보군, 제외 사유, 일봉 확인 | [후보군 조회 CLI](candidate-universe.md) |
| 거래 일정과 다음 정규장 확인 | [공식 거래 일정 CLI](market-calendar.md) |
| KIS 자격 증명 준비와 토큰 복구 | [KIS 인증](kis-auth.md) |
| 구독 연결, 모델 목록 확인, 인증 복구 | [ChatGPT 구독 인증](siwc-auth.md) |
| KIS 응답 조회와 관측 자료 저장 | [KIS 관측 CLI](kis-probe-reference.md), [관측 기록 저장](kis-observe.md) |
| 종목 유형 판단과 외부 공식 근거 조사 | [LLM 종목 유형 CLI](llm-security-probe.md), [공식 자료 관측 CLI](security-type-probe.md) |
| 로컬 검사, Git 훅, 에이전트 스킬 | [개발과 로컬 검증](development.md) |

## 설계 결정과 구현 위치

[ADR 목록](adr/README.md)에서 각 결정의 이유와 어떤 결정이 이전 결정을 대체했는지 확인할 수 있습니다. 아래 표에서 영역별 구현 위치와 관련 결정·계약·기록을 확인하세요. 현재 명령과 출력은 위의 「사용과 개발」에 연결된 문서에서 확인하세요.

| 영역 | 구현 | 관련 결정과 기록 |
| --- | --- | --- |
| 시장 일정 | [일정 CLI](../scripts/market-calendar.ts), [공지 판단](../scripts/calendar-notice-assessment.ts) | [일정 영향 판단 계약](market-calendar.md#공지-해석의-지원-범위) |
| 후보군과 완료 일봉 | [후보군 CLI](../scripts/candidate-universe.ts), [상장 종목과 순위](../scripts/listed-securities.ts), [완료 일봉과 근거](../scripts/completed-daily-bars.ts) | [종가 기반 매수 후보 결정](adr/0009-close-based-daytime-buy-candidates.md), [운영 한도와 지원 조건](operating-limits-and-support.md) |
| 보고서와 유료 전환 | [보고서 CLI](../scripts/buy-candidates.ts), [후보 선정과 의미 검토](../scripts/buy-candidate-assessment.ts), [유료 전환](../scripts/paid-api.ts) | [보고서 실행 이력](buy-candidate-history.md) |
| KIS·구독 인증 | [KIS 인증](../scripts/kis-auth.ts), [KIS 요청](../scripts/kis-query.ts), [구독 인증](../scripts/siwc-auth.ts) | [구독 갱신 정책](adr/0008-siwc-preflight-refresh.md) |
| 종목 유형 | [유형 판단](../scripts/security-type-assessment.ts), [공식 자료 관측](../scripts/security-type-probe.ts) | [유형 자료원 조사 기록](third-party-security-type-sources.md), [유형 평가 정책](adr/0010-incremental-security-type-validation.md), [유형 판단 진단 안내](llm-security-probe.md#기본-실패-진단-읽기) |
| 실패와 실행 관측 | [오류 진단](../scripts/diagnostic-error.ts), [공통 실행 관측](../scripts/execution-observation.ts), [모델 요청 처리](../scripts/model-execution.ts) | [실패 진단 사용 안내](llm-security-probe.md#기본-실패-진단-읽기), [공통 실행 관측](rca-observability-design.md) |
| 개발 검사 | [훅과 문서 검사](../scripts/pre-push.ts), [테스트 사전 확인](../scripts/test-preflight.ts) | [커밋 단계 검사 결정](adr/0004-staged-commit-validation.md) |

## 검증과 조사 기록

| 영역 | 기록 |
| --- | --- |
| 보고서와 제품 인수 | [첫 버전 인수](first-version-acceptance.md), [보고서 실행 이력](buy-candidate-history.md) |
| 시장 일정 | [공식 일정 검증](market-calendar-validation.md) |
| KIS 데이터 | [후보군 데이터 검증](kis-data-validation.md), [장전 순위 조사](kis-ranking-session-investigation.md), [세 시점 장전 관측](kis-premarket-observation-20261019.md), [EGW00316 조사](egw00316-investigation.md) |
| 구독 인증 | [실제 갱신과 재사용](siwc-refresh-live-validation.md) |
| 종목 유형 판단 | [실행 이력](security-type-history.md), [독립 정답과 실제 평가](security-type-evaluation-samples.md), [ADR·워런트 표본 근거](security-evaluation-adr-warrant-research.md) |
| 종목 유형 자료원 | [KIS 유형과 상장 식별](kis-security-identification.md), [외부 공식 자료](official-security-type-validation.md), [대체 공식 자료](alternative-official-security-sources.md), [제3자 자료](third-party-security-type-sources.md), [Massive 문의 초안](massive-reference-usage-inquiry.md) |

선별한 실행·조사 자료와 평가 입력은 [증거 디렉터리](evidence)에 있습니다. 각 기록에서 실제 실행으로 확인한 항목, 모의 검사로 확인한 항목, 아직 검증하지 않은 항목을 확인하세요.
