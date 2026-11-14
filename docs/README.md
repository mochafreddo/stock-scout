# 문서 안내

현재 제품의 요구사항은 [#278](https://github.com/mochafreddo/stock-scout/issues/278)과 [#283의 계약](https://github.com/mochafreddo/stock-scout/issues/283#issuecomment-6686267791)을 따른다. 용어는 [용어집](../GLOSSARY.md), 전환 범위와 검증 근거는 [전환 기록](toss-transition.md)에 있다.

용어집은 개념의 정의, CLI 레퍼런스는 인수·JSON·한도·오류 계약, 에이전트 사용 지침은 조회 선택·결과 해석·소비 코드 검증·보고서 가격 분류를 다룬다. 설계와 검증 기록은 당시 결정·관측과 후속 결과를 연결하며 현재 사용 계약을 별도로 유지하지 않는다.

## 현재 조회 도구

| 필요한 작업 | 문서 |
| --- | --- |
| 실행 환경과 인증 없는 합성 실행 | [시작 안내](getting-started.md) |
| 시장·계좌 명령의 인수와 JSON 의미 | [토스 CLI 레퍼런스](toss-cli.md) |
| Codex·dots의 명령 발견과 사용 | [에이전트 사용 지침](toss-agent-usage.md) |
| 허용·권한·접근 준비 | [접근 준비와 사용자 재결정](toss-access-readiness.md) |
| 로컬 검사와 Git 훅 | [개발 안내](development.md) |
| 요청 흐름·모듈 경계·공유 상태의 소유권 | [구조 설명](architecture.md) |
| 현재 설계와 대체 관계 | [ADR 목록](adr/README.md) |

구현은 [진입점](../scripts/toss.ts)과 공통 [인증·조회 클라이언트](../scripts/toss-client.ts), 명령별 `scripts/toss-*.ts`에 있다. [CLI 검사](../tests/toss.test.mjs)와 명령별 `tests/toss-*.test.mjs`는 외부 HTTP를 합성 응답으로 대체하여 실제 CLI를 실행한다. 시계는 사례에 따라 대체하며 실제 프로세스 경합·호출 간격 검사는 실제 시계를 사용한다.

처음 실행할 때는 시작 안내에서 CLI 레퍼런스로, 소비 에이전트를 연결할 때는 에이전트 지침에서 필요한 계약으로 이동한다. 유지보수는 구조 설명에서 담당 모듈을 찾고 개발 안내의 변경·검사 절차를 따른다. [문서 검토 기록](documentation-review.md)은 2026-11-14 개편의 영역별 조사·검증 범위와 남은 한계를 기록한다.

## 테스트 감사 이력

[2026-11-14 테스트 감사](testing-audit.md)는 당시 검증 공백·실험 결과와 후속 조치 커밋을 연결한 기록이다. 현재의 미해결 목록과 구분하며, 검사와 수정 절차는 [개발 안내](development.md)를 따른다.

## 조회 개선 설계 기록

[가격 시각·일봉 날짜 선택·묶음 조회 개선 설계](query-improvements.md)는 2026-11-12~13의 설계 합의와 후속 구현 연결 기록이다. 현재 인수·출력 계약은 [CLI 레퍼런스](toss-cli.md), 소비 절차와 보고서 가격 분류는 [에이전트 사용 지침](toss-agent-usage.md)을 따른다.

## 토스 검증 기록

각 기록의 날짜·리비전·관측 범위를 기준으로 읽는다. 초기 보류·계획과 뒤에 추가한 결과는 당시 이력이며, 후속 변경 전체의 실검증이나 새 계좌·소비 환경에 대한 승인을 뜻하지 않는다.

| 영역 | 기록 |
| --- | --- |
| 시장 조회와 실제 페이지 | [시장 검증](toss-market-validation.md) |
| 계좌 조회와 실제 페이지·미관측 표본 | [계좌 검증](toss-account-validation.md) |
| Codex·dots 각각의 합성 연결 | [합성 연결 검증](toss-agent-validation.md) |
| Codex 직접 실행과 사용자 보고에 따른 dots 실제 사용 | [실자료 소비 검증](toss-agent-live-validation.md) |
| 최종 전환과 남은 한계 | [전환 기록](toss-transition.md) |
| 접근·자료 전달 판단과 남은 미확인 | [접근 준비](toss-access-readiness.md) |

## 과거 제품 기록

아래는 제거된 KIS·내장 모델 제품의 당시 안내·결정·인수·연구 기록이다. 명령과 모델 인증은 현재 체크아웃에서 실행하지 않는다. 기존 [#237](https://github.com/mochafreddo/stock-scout/issues/237)과 아래 기록은 당시 근거로 보존하며 현재 조회 제품의 인수 근거로 승계하지 않는다.

| 영역 | 기록 |
| --- | --- |
| 보고서와 인수 | [매수 후보 안내](buy-candidates.md), [보고서 실행 이력](buy-candidate-history.md), [첫 버전 인수](first-version-acceptance.md) |
| 이전 개념 정의 | [이전 보고서 용어](glossary-history.md) |
| 후보군·일정·운영 제한 | [후보군](candidate-universe.md), [일정](market-calendar.md), [일정 검증](market-calendar-validation.md), [운영 한도](operating-limits-and-support.md) |
| 인증·관측 | [KIS 인증](kis-auth.md), [구독 인증](siwc-auth.md), [실제 구독 갱신](siwc-refresh-live-validation.md), [KIS 관측](kis-probe-reference.md), [관측 기록 저장](kis-observe.md), [실행 관측 설계](rca-observability-design.md) |
| KIS 데이터 | [데이터 검증](kis-data-validation.md), [순위 세션 조사](kis-ranking-session-investigation.md), [장전 관측](kis-premarket-observation-20261019.md), [EGW00316 조사](egw00316-investigation.md) |
| 종목 유형 | [유형 CLI](llm-security-probe.md), [공식 자료 관측 CLI](security-type-probe.md), [실행 이력](security-type-history.md), [평가 표본](security-type-evaluation-samples.md), [ADR·워런트 연구](security-evaluation-adr-warrant-research.md) |
| 유형 자료원 | [KIS 식별](kis-security-identification.md), [외부 공식 자료](official-security-type-validation.md), [대체 공식 자료](alternative-official-security-sources.md), [제3자 자료](third-party-security-type-sources.md), [Massive 문의 초안](massive-reference-usage-inquiry.md) |

[증거 자료](evidence/)와 [당시 ADR](adr/README.md#과거-제품의-결정)은 기존 경로에 보존한다. 제거한 소스 링크는 전환 직전의 고정 리비전을 가리킨다. 과거 기록 안의 실행 명령·계획·차단 상태는 해당 날짜의 문맥으로 읽으며 현재 절차는 위의 현재 조회 도구 문서를 따른다.
