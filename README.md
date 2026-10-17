# Stock Scout

미국 정규장 시작 전에 매수 검토 후보를 확인하는 개인용 CLI 프로젝트다. 제품 요구사항의 기준은 [명세 #237](https://github.com/mochafreddo/stock-scout/issues/237)이다.

현재는 KIS 데이터 검증 단계다. 실제 응답을 확인하는 TypeScript 관측 CLI가 있으며, 장전 후보군 조회와 Vercel AI SDK를 사용하는 추천 기능은 아직 구현하지 않았다. 관측 결과와 남은 차단 조건은 [KIS 데이터 검증](docs/kis-data-validation.md)에 정리했다.

## 문서

- [용어집](GLOSSARY.md)
- [KIS 데이터 검증과 관측 CLI](docs/kis-data-validation.md)
- [작업 이슈](https://github.com/mochafreddo/stock-scout/issues)

## 문서 생성 스킬

에이전트 공용 [document-generate](.agents/skills/document-generate/SKILL.md)는 코드와 테스트를 조사한 뒤 필요한 튜토리얼·작업 안내·레퍼런스·설명 문서를 작성한다. 사용자 문서는 한국어로 작성하며, 명시적으로 호출할 때만 실행한다.

- Codex: `$document-generate KIS 관측 CLI의 사용 안내를 작성해 주세요.`
- Claude Code: `/document-generate KIS 관측 CLI의 사용 안내를 작성해 주세요.`
- 다른 에이전트: 위 `SKILL.md`를 읽고 따르도록 명시적으로 요청한다. 자동 탐색 지원 여부는 도구마다 다르다.

공용 본문은 `.agents/skills/`에서 관리하고 Claude Code는 `.claude/skills/`의 심볼릭 링크로 같은 본문을 읽는다. 목록에 보이지 않으면 저장소에서 새 세션을 시작한다. gstack 설치는 필요하지 않다. 문서 생성 요청만으로 커밋·푸시를 수행하지 않으며, 작업 요청과 저장소의 전달 규칙을 따른다.

원본 출처·고정 리비전·변경 범위는 [도입 기록](.agents/skills/document-generate/UPSTREAM.md)에 있으며, 해당 스킬에는 [원본 MIT 라이선스](.agents/skills/document-generate/LICENSE)를 포함했다.

## 라이선스

[MIT](LICENSE)
