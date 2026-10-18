# Stock Scout

미국 정규장 시작 전에 매수 검토 후보를 확인하는 개인용 CLI 프로젝트입니다. 제품 요구사항의 기준은 [명세 #237](https://github.com/mochafreddo/stock-scout/issues/237)입니다.

현재는 KIS 데이터 검증 단계입니다. TypeScript 관측 CLI로 거래량·거래대금 순위, 일별 시세, 종목 정보를 각각 한 페이지씩 조회할 수 있습니다. **관측 성공은 장전 데이터 검증 완료나 매수 후보 추천을 뜻하지 않습니다.**

| 구분 | 현재 상태 |
| --- | --- |
| KIS 관측 CLI | 구현됨. NAS·NYS·AMS에서 한 페이지를 조회하고 선택한 필드를 JSON으로 출력합니다. |
| KIS 자동 토큰 발급·캐시 | [#247](https://github.com/mochafreddo/stock-scout/issues/247)에서 발급·캐시 재사용을, [#248](https://github.com/mochafreddo/stock-scout/issues/248)에서 명시적 만료의 한 번 복구를 구현했습니다. 첫 실행은 5분 대기를 기록하며 복구에도 같은 발급 제한을 적용합니다. 실제 만료 복구는 미검증입니다. |
| 장전 후보군 조회 | [#239](https://github.com/mochafreddo/stock-scout/issues/239)의 계획입니다. 데이터 의미·종목 유형·지원 시간 검증이 남아 있습니다. |
| AI 매수 후보 추천 | #237의 계획입니다. Vercel AI SDK·OpenAI 인증·모델 호출·비용 제한은 아직 구현하지 않았습니다. |

## 시작하기

Node.js 24 이상과 npm이 필요합니다. [처음 실행하고 검증하기](docs/getting-started.md)에서 외부 통신을 대체한 로컬 테스트부터 시작하세요. 실제 KIS 관측은 기존 자격 증명이 준비된 경우에만 진행하세요.

이 저장소는 자동 주문·뉴스 수집·웹 UI·예약 실행·알림을 제공하지 않습니다. 목표 제품의 범위와 제외 사항은 #237에서 확인하세요.

## 문서

- [용어집](GLOSSARY.md)
- [처음 실행하고 검증하기](docs/getting-started.md): 개발 환경, 인증 없는 모의 실행, 오류 확인, 실제 관측 절차
- [KIS 인증과 복구](docs/kis-auth.md): 캐시, 발급 간격, 수동 복구와 검증 범위
- [KIS 관측 CLI 레퍼런스](docs/kis-probe-reference.md): 인수, 환경 변수, 출력, 오류
- [KIS 데이터 검증](docs/kis-data-validation.md): 실제 관측 근거, 자동 검사 범위와 한계, 후속 차단 조건
- [작업 이슈](https://github.com/mochafreddo/stock-scout/issues)

## 문서 생성 스킬

에이전트 공용 [document-generate](.agents/skills/document-generate/SKILL.md)는 코드와 테스트를 조사한 뒤 필요한 튜토리얼·작업 안내·레퍼런스·설명 문서를 작성합니다. 사용자 문서는 한국어로 작성하며, 명시적으로 호출할 때만 실행합니다.

- Codex: `$document-generate KIS 관측 CLI의 사용 안내를 작성해 주세요.`
- Claude Code: `/document-generate KIS 관측 CLI의 사용 안내를 작성해 주세요.`
- 다른 에이전트: 위 `SKILL.md`를 읽고 따르도록 명시적으로 요청하세요. 자동 탐색 지원 여부는 도구마다 다릅니다.

공용 본문은 `.agents/skills/`에서 관리하고 Claude Code는 `.claude/skills/`의 심볼릭 링크로 같은 본문을 읽습니다. 목록에 보이지 않으면 저장소에서 새 세션을 시작하세요. gstack 설치는 필요하지 않습니다. 문서 생성 요청만으로 커밋·푸시를 수행하지 않으며, 작업 요청과 저장소의 전달 규칙을 따릅니다.

원본 출처·고정 리비전·변경 범위는 [도입 기록](.agents/skills/document-generate/UPSTREAM.md)에 있으며, 해당 스킬에는 [원본 MIT 라이선스](.agents/skills/document-generate/LICENSE)를 포함했습니다.

## QA 스킬

에이전트 공용 [qa](.agents/skills/qa/SKILL.md)는 지정한 CLI 동작을 점검하고 결함을 재현한 뒤, 회귀 테스트와 최소 수정으로 다시 검증합니다. 명시적으로 호출할 때만 실행하며 gstack 설치는 필요하지 않습니다.

- Codex: `$qa KIS 관측 CLI를 점검하고 발견한 버그를 수정해 주세요.`
- Claude Code: `/qa KIS 관측 CLI를 점검하고 발견한 버그를 수정해 주세요.`
- 다른 에이전트: 위 `SKILL.md`를 읽고 따르도록 명시적으로 요청하세요.

기본은 지정 범위의 전체 점검과 중간 심각도 이상 결함 수정입니다. `--quick`은 빠른 점검, `--exhaustive`는 경미한 결함까지 수정, `--regression <보고서 경로>`는 이전 실패 재검증, `--report-only`는 보고만 수행합니다. 이 옵션은 스킬의 실행 방식을 지정하며 제품 CLI에 전달하지 않습니다.

외부 통신은 기본적으로 모의 처리하며 실연동은 대상과 호출 범위에 대한 승인이 있을 때 수행합니다. 실행별 한국어 보고서와 비밀값을 제외한 증거는 기본적으로 접근을 제한한 임시 디렉터리에 보관합니다. QA 호출만으로 커밋·푸시하지 않습니다. 공용 본문과 Claude Code 연결 방식은 문서 생성 스킬과 같으며, 목록에 보이지 않으면 새 세션을 시작하세요.

출처와 변경 범위는 [도입 기록](.agents/skills/qa/UPSTREAM.md)에 있으며 [원본 MIT 라이선스](.agents/skills/qa/LICENSE)를 포함했습니다.

## 프로젝트 스킬 검사

기존 pre-push 검사는 커밋 스냅샷의 프로젝트 스킬도 확인합니다. `.agents/skills/<이름>/`의 각 스킬에는 같은 이름의 Claude 상대 심볼릭 링크와 Codex 호출 설정이 필요합니다. `UPSTREAM.md`가 있는 스킬에는 비어 있지 않은 일반 파일인 `LICENSE`가 필요하며, 라이선스의 법적 적합성은 별도로 검토합니다.

호출 설정 검사는 `SKILL.md` frontmatter의 `disable-model-invocation` 불리언과 `agents/openai.yaml`의 `policy.allow_implicit_invocation` 불리언이 서로 반대인지 확인합니다. frontmatter의 최상위 키는 따옴표 없는 블록 형식을 지원합니다. 현재 Codex 설정은 `policy` 아래 해당 불리언 하나를 두는 블록 형식만 지원하며, 공백·빈 줄·주석은 허용합니다. 다른 YAML 표현이나 추가 설정은 통과시키지 않으므로 필요한 형식이 생기면 검사와 테스트도 함께 확장하세요. 이 검사는 실제 호스트의 스킬 발견·실행을 검증하지 않습니다.

## 라이선스

[MIT](LICENSE)
