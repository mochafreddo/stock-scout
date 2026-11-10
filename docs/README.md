# 문서 안내

현재 제품의 요구사항은 [#278](https://github.com/mochafreddo/stock-scout/issues/278)과 [#283의 계약](https://github.com/mochafreddo/stock-scout/issues/283#issuecomment-6686267791)을 따른다. 용어는 [용어집](../GLOSSARY.md), 전환 범위와 검증 근거는 [전환 기록](toss-transition.md)에 있다.

## 현재 조회 도구

| 필요한 작업 | 문서 |
| --- | --- |
| 실행 환경과 인증 없는 합성 실행 | [시작 안내](getting-started.md) |
| 시장·계좌 명령의 인수와 JSON 의미 | [토스 CLI 레퍼런스](toss-cli.md) |
| Codex·dots의 명령 발견과 사용 | [에이전트 사용 지침](toss-agent-usage.md) |
| 허용·권한·접근 준비 | [접근 준비와 사용자 재결정](toss-access-readiness.md) |
| 로컬 검사와 Git 훅 | [개발 안내](development.md) |
| 현재 설계와 대체 관계 | [ADR 목록](adr/README.md) |

구현은 [진입점](../scripts/toss.ts)과 공통 [인증·조회 클라이언트](../scripts/toss-client.ts), 명령별 `scripts/toss-*.ts`에 있다. [CLI 검사](../tests/toss.test.mjs)와 명령별 `tests/toss-*.test.mjs`는 외부 HTTP·시계를 대체하여 실제 CLI를 실행한다.

## 토스 검증 기록

| 영역 | 기록 |
| --- | --- |
| 시장 조회와 실제 페이지 | [시장 검증](toss-market-validation.md) |
| 계좌 조회와 실제 페이지·미관측 표본 | [계좌 검증](toss-account-validation.md) |
| Codex·dots 각각의 합성 연결 | [합성 연결 검증](toss-agent-validation.md) |
| Codex 직접 실행과 사용자 보고에 따른 dots 실제 사용 | [실자료 소비 검증](toss-agent-live-validation.md) |
| 최종 전환과 남은 한계 | [전환 기록](toss-transition.md) |

## 과거 제품 기록

아래는 제거된 KIS·내장 모델 제품의 당시 안내·결정·인수·연구 기록이다. 명령과 모델 인증은 현재 체크아웃에서 실행하지 않는다. 기존 [#237](https://github.com/mochafreddo/stock-scout/issues/237)과 아래 기록은 당시 근거로 보존하며 현재 조회 제품의 인수 근거로 승계하지 않는다.

| 영역 | 기록 |
| --- | --- |
| 보고서와 인수 | [매수 후보 안내](buy-candidates.md), [보고서 실행 이력](buy-candidate-history.md), [첫 버전 인수](first-version-acceptance.md) |
| 후보군·일정·운영 제한 | [후보군](candidate-universe.md), [일정](market-calendar.md), [일정 검증](market-calendar-validation.md), [운영 한도](operating-limits-and-support.md) |
| 인증·관측 | [KIS 인증](kis-auth.md), [구독 인증](siwc-auth.md), [실제 구독 갱신](siwc-refresh-live-validation.md), [KIS 관측](kis-probe-reference.md), [관측 기록 저장](kis-observe.md), [실행 관측 설계](rca-observability-design.md) |
| KIS 데이터 | [데이터 검증](kis-data-validation.md), [순위 세션 조사](kis-ranking-session-investigation.md), [장전 관측](kis-premarket-observation-20261019.md), [EGW00316 조사](egw00316-investigation.md) |
| 종목 유형 | [유형 CLI](llm-security-probe.md), [공식 자료 관측 CLI](security-type-probe.md), [실행 이력](security-type-history.md), [평가 표본](security-type-evaluation-samples.md), [ADR·워런트 연구](security-evaluation-adr-warrant-research.md) |
| 유형 자료원 | [KIS 식별](kis-security-identification.md), [외부 공식 자료](official-security-type-validation.md), [대체 공식 자료](alternative-official-security-sources.md), [제3자 자료](third-party-security-type-sources.md), [Massive 문의 초안](massive-reference-usage-inquiry.md) |

[증거 자료](evidence/)와 [당시 ADR](adr/README.md)은 보존한다. 제거한 소스 링크는 전환 직전의 고정 리비전을 가리킨다.
