# Codex·dots 합성 CLI 연결 검증

2026-11-08 KST의 #295 검증 기록이다. 구현 기준은 착수 시 깨끗한 `main`의 `528310ef5210ac2d75bd031160fe9d7422eadf42`이며, 갱신한 `origin/main`과 일치했다. 이슈의 계획 기준 `ef64daa3d663e13af8e34001609aa5da4990dcc4` 이후에 구현된 토스 CLI를 사용했다. 공개 검증 경계는 CLI 인수·stdout JSON·stderr·종료 코드·외부 HTTP다.

## 실행 경로

Codex 데스크톱의 이 작업에서 저장소 파일을 읽고 `exec_command`로 Node 26.12.1을 실행했다. [에이전트 지침](toss-agent-usage.md) → 합성 실행기의 `success --help` → 명령별 인수 작성 → 실제 `scripts/toss.ts` 하위 프로세스 → 기존 `tests/toss-http-mock.mjs` → JSON·종료 코드 해석의 경로를 관찰했다. 별도 Codex CLI 에이전트를 실행한 결과는 아니다.

합성 실행기는 기존 `tests/toss-cli-helper.mjs`의 임시 상태와 HTTP mock 실행 방식을 재사용한다. 각 실행은 새 상태를 사용하고 종료 후 삭제한다. 자격 증명·토큰·응답은 모두 합성이며 실제 토스 인증 설정·조회·계좌 접근을 수행하지 않았다. stdout은 실제 CLI 결과를 유지하고 stderr에 `SYNTHETIC` 표기를 붙인다. 출력의 공급자 이름과 조회 시각도 이 모의 실행의 값이다.

사용자는 dots를 ChatGPT 앱의 OpenAI dots로 확인했다. [공식 소개](https://openai.com/ko-KR/index/introducing-dots/)는 자체 클라우드 환경과 권한을 받은 노트북 연결을 구분한다. 이 설명만으로 사용자의 로컬 연결 상태나 CLI 실행 기능을 확인한 것으로 취급하지 않는다.

## Codex 관찰 결과

아래 인수는 모두 저장소 루트에서 `node tests/toss-agent-cli.mjs` 뒤에 전달했다. 정상 조회 세 건은 각각 독립 프로세스로 실행했고, 페이지 조회는 첫 결과를 읽은 뒤 다음 인수를 작성했다.

| 인수 | 종료 코드 | 관찰 및 해석 |
| --- | --- | --- |
| `success --help` | 0 | 실제 CLI의 명령 목록에서 prices·rankings·tradable·candles의 인수를 발견했다. |
| `success prices DEMO` | 0 | `lastPrice="10.0100"`, `currency="USD"`, `timestamp=null`이다. 소수 문자열을 유지하고 자료 기준 시각은 미확인으로 해석했다. |
| `success rankings TOP_GAINERS 1d 1` | 0 | 원래 순위 1·DEMO·집계 시각과 `aggregation=US_market`를 확인했다. 거래소별 순위로 해석하지 않았다. |
| `success tradable NASDAQ` | 0 | ACTIVE 기본 필터의 합성 종목 1개와 원문 유형·빈 ISIN 문자열을 확인했다. 후속 커서를 만들지 않았다. |
| `partial candles DEMO 1m count=1` | 2 | `data=[]`여도 `next_page`와 `page.nextBefore`가 있으므로 조회 완료로 해석하지 않았다. |
| `partial candles DEMO 1m count=1 before=2026-11-06T09:31:00.123+09:00` | 0 | 직전 경계를 그대로 전달해 봉 1개와 `nextBefore=null`을 확인했다. `completion`·`inProgress`는 unknown이며 봉 확정 근거로 사용하지 않았다. |
| `error prices DEMO` | 1 | `PERMISSION_DENIED`, `providerCode=ip-not-allowed`와 합성 요청 식별자를 확인했다. 빈 종목 결과나 재인증 사유로 바꾸지 않았다. |
| `success prices DEMO/` | 1 | `INPUT_INVALID`를 확인했다. 실패를 정상 빈 결과로 해석하지 않았다. |

HTTP는 기존 mock이 전송 대상·메서드·인증 형식을 검사하는 경계에서 대체했다. 실행기는 봉의 실제 HTTP 쿼리에 요청한 `before`가 그대로 전달됐는지도 검사한다. 실제 네트워크 응답이나 공급자 호환성을 입증한 결과는 아니다. 합성 실행기 회귀 검사는 별도 프로세스에서 실제 CLI의 명령 발견·정상 자료·다음 페이지·오류·종료 코드 전달과 임시 상태 생성 실패 시 합성 표기 유지를 검사한다. 이 자동 검사는 소비 에이전트의 이해 자체를 판정하지 않는다.

## dots 보류와 재개 조건

ChatGPT 앱의 실행 경로를 확인하기 위해 Computer Use의 `getApp("ChatGPT")`를 호출했으나, 도구는 대상을 `com.openai.codex`로 식별하고 안전상 접근을 거부했다. 화면이나 대화 내용은 얻지 못했다. 이는 이 작업의 앱 접근 제한이며 dots 자체가 로컬 CLI를 지원하지 않는다는 증거는 아니다.

dots에서 지침을 읽고 명령을 발견·실행·해석하는 경로, 로컬 연결 상태, 정상·부분 결과·오류 처리는 모두 미관측이다. 사용자에게 같은 지침으로 합성 검증을 실행하고 명령·종료 코드·해석 또는 접근 불가 사유를 전달하도록 요청했다. 개인 화면·대화·실자료를 공유 증거에 복사하지 않는다.

이슈 #295와 두 소비 환경의 연결 완료 판정은 보류한다. dots의 실제 경로가 확인되면 같은 합성 사례를 실행해 이 기록을 보완한다. 로컬 CLI 연결이 성립하지 않는 것으로 확인되면 사용자에게 로컬 연결을 준비해 재검증할지, 제공 인터페이스를 재결정할지 묻는다. MCP·HTTP 서버를 자동 추가하거나 dots를 필수 범위에서 제외하지 않는다.

명령별 지침의 확장 경로는 [에이전트 지침](toss-agent-usage.md#extend-to-later-commands)을 따른다. 전체 도구 모음의 소비 환경 검증은 후속 통합 작업에서 수행한다. 이번 합성 결과는 실제 토스 조회·실자료 전달 허용·실계좌 사용·투자 판단 품질이나 기존 KIS 경로 제거의 근거가 아니다.
