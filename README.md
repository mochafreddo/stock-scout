# Stock Scout

직전에 끝난 미국 정규장의 KIS 일봉을 바탕으로 다음 정규장의 매수 검토 후보를 최대 5개 찾는 개인용 CLI입니다. 보고서에서 기준 종가, 선정 근거, 관찰 기간, 주요 위험을 확인할 수 있습니다. 주문과 소수점 거래 가능 여부는 증권사에서 직접 확인하세요.

## 토스 조회 도구 전환

새 제품은 외부 AI 에이전트가 필요한 자료를 조회하는 로컬 JSON CLI입니다. [미국 순위·거래 가능 종목·종목 정보·현재가 조회 안내](docs/toss-cli.md)에서 `node scripts/toss.ts --help`로 명령을 발견할 수 있습니다. 구현 범위는 [현재가 #285](https://github.com/mochafreddo/stock-scout/issues/285), [종목 정보 #286](https://github.com/mochafreddo/stock-scout/issues/286), [순위와 거래 가능 종목 목록 #287](https://github.com/mochafreddo/stock-scout/issues/287)입니다. 새 요구사항은 [#278의 통합 전환 명세](https://github.com/mochafreddo/stock-scout/issues/278)를 따릅니다. 실제 토스 조회·자료 전달 허용·Codex 및 Dot 연결은 미검증이며, 아래 기존 KIS 제품은 전환 검증 전까지 유지합니다.

## 시작하기

1. [실행 환경과 인증을 준비하세요](docs/getting-started.md).
2. [매수 후보 보고서를 실행하세요](docs/buy-candidates.md#준비와-실행). 실행 시점은 필요한 데이터가 준비된 뒤부터 다음 정규장이 열리기 전까지입니다.
3. [보고서 확인 방법을 살펴보세요](docs/buy-candidates.md#보고서-확인). 분석은 끝났지만 후보가 없는 경우와 자료가 부족해 분석이 중단된 경우를 구분하세요.

첫 버전을 한국 시간으로 낮에 통합 실행해, 완료 일봉으로 분석을 정상적으로 마치고 후보가 없다는 보고서가 나온 것을 확인했습니다. 실제 실행에서 후보가 담긴 보고서가 나오는지, 한국 시간으로 낮 시간대 내내 사용할 수 있는지, 추천 품질이 어떤지는 아직 검증하지 않았습니다. [첫 버전 인수 기록](docs/first-version-acceptance.md#2026-11-03-한국-낮-통합-실행)

## 문서

- [사용 안내·CLI 레퍼런스·설계 및 검증 기록](docs/README.md)
- [용어집](GLOSSARY.md)
- [개발·로컬 검사·에이전트 스킬](docs/development.md)
- [제품 요구사항과 인수 범위](https://github.com/mochafreddo/stock-scout/issues/237)

<a name="문서-생성-스킬"></a>
<a name="qa-스킬"></a>
<a name="커밋푸시-검사"></a>
<a name="프로젝트-스킬-검사"></a>

기존 스킬·훅 안내는 [개발과 로컬 검증](docs/development.md)에서 확인하세요.

## 라이선스

[MIT](LICENSE)
