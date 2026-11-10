# Stock Scout

토스 Open API의 시장·계좌 자료를 조회하는 개인용 로컬 JSON CLI입니다. 외부 AI 에이전트가 조회 순서와 분석·추천을 맡고, CLI는 요청한 자료의 조회·검증·시점 표시·오류 처리를 맡습니다. 주문은 사용자가 직접 판단하고 실행합니다.

## 시작하기

1. [실행 환경과 합성 실행 안내](docs/getting-started.md)를 확인하세요.
2. `node scripts/toss.ts --help`로 명령을 찾고 [CLI 레퍼런스](docs/toss-cli.md)에서 인수를 확인하세요.
3. 실제 조회는 [접근 조건](docs/toss-access-readiness.md)과 해당 계좌·소비 환경의 승인 범위 안에서 실행하세요. Codex·dots는 [에이전트 사용 지침](docs/toss-agent-usage.md)을 따릅니다.

stdout은 버전이 있는 JSON입니다. `success`는 종료 코드 0, `partial`은 2, `error`는 1입니다. 부분 결과의 다음 페이지와 미확인을 확인하고, 조회 시각을 자료 갱신 시각으로 해석하지 마세요.

## 전환과 검증

[#278의 전환 명세](https://github.com/mochafreddo/stock-scout/issues/278)에 따라 기존 KIS·후보군·추천·내장 모델 제품 경로를 제거했습니다. [전환 기록](docs/toss-transition.md)에서 선행 합성 검사·실제 토스 조회·Codex 직접 관측·사용자 보고에 따른 dots 사용을 구분하고, 수용한 예외와 남은 한계를 확인하세요. 공급자의 조회 전용 권한과 세부 처리·보관 조건의 미확인은 남아 있습니다.

기존 제품의 요구사항 [#237](https://github.com/mochafreddo/stock-scout/issues/237), ADR·인수·연구 자료는 당시 이력으로 보존합니다. 옛 명령·JSON·관측 파일의 호환 계층과 KIS 자동 복귀는 제공하지 않습니다.

## 문서

- [사용 안내와 검증·연구 기록](docs/README.md)
- [용어집](GLOSSARY.md)
- [개발·로컬 검사·에이전트 스킬](docs/development.md)

<a name="문서-생성-스킬"></a>
<a name="qa-스킬"></a>
<a name="커밋푸시-검사"></a>
<a name="프로젝트-스킬-검사"></a>

스킬·훅 안내는 [개발과 로컬 검증](docs/development.md)에서 확인하세요.

## 라이선스

[MIT](LICENSE)
