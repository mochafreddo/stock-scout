# Stock Scout

미국 정규장 시작 전에 매수 검토 후보를 확인하는 개인용 CLI 프로젝트입니다. 제품 요구사항의 기준은 [명세 #237](https://github.com/mochafreddo/stock-scout/issues/237)입니다.

현재는 KIS 데이터 검증 단계입니다. TypeScript 관측 CLI로 거래량·거래대금 순위, 일별 시세, 종목 정보를 한 요청씩 조회할 수 있습니다. **관측 성공은 장전 데이터 검증 완료나 매수 후보 추천을 뜻하지 않습니다.**

| 구분 | 현재 상태 |
| --- | --- |
| KIS 관측 CLI | 구현됨. NAS·NYS·AMS에서 한 페이지를 조회하고 선택한 필드를 JSON으로 출력합니다. |
| KIS 자동 토큰 발급·캐시 | [#247](https://github.com/mochafreddo/stock-scout/issues/247)에서 구현했습니다. 앱 키·시크릿으로 발급하고 보호된 캐시를 재사용합니다. 첫 실행은 5분 대기를 기록합니다. 조회 중 만료 복구는 #248의 범위입니다. |
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

## 라이선스

[MIT](LICENSE)
