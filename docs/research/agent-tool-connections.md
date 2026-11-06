# 외부 AI 에이전트의 Stock Scout 도구 연결 방식

조사일은 2026-11-06이다. [Dot·Codex가 사용할 수 있는 도구 연결 방식 조사](https://github.com/mochafreddo/stock-scout/issues/280)의 연결 방식 조사이며, 코드 검토 기준은 `ef64daa3d663e13af8e34001609aa5da4990dcc4`이다. 이 문서는 설명형 연구 기록이다. 구현·배포·인증 설정이나 연결 방식의 최종 선택을 승인하지 않는다.

새 목표는 외부 AI 에이전트가 사용자의 매수·매도 판단과 종목 추천에 필요한 자료를 도구로 조회하는 것이다. 계좌·보유 종목·거래 내역은 설계 검토에 포함하고 주문 제출·정정·취소와 자동매매는 제외한다. 기존 [Stock Scout 명세: KIS와 OpenAI 기반 장전 매수 후보 추천](https://github.com/mochafreddo/stock-scout/issues/237)·용어집·ADR은 기존 제품의 근거로 읽었으며, 그 보고서 전용 조건을 새 목표의 필수 조건으로 승계하지 않는다.

## 조사 결론

로컬 실행을 허용한 Codex를 첫 소비자로 정하면 CLI의 구조화된 결과를 읽는 경로가 가장 작은 후보가 된다. 도구 검색과 인수 스키마가 필요하면 로컬 MCP가 후보이고, ChatGPT 웹에서 소비해야 하면 원격 MCP를 담은 플러그인이 후보가 된다. 이는 아래 공식 지원 범위에서 도출한 설계 추론이며, 모든 연결 계층을 함께 구축해야 한다는 결론은 아니다.

Dot은 공식 문서가 있는 별도 제품이다. 자체 클라우드 컴퓨터·브라우저와 연결 앱을 사용하며, 허용된 경우 사용자 컴퓨터에도 연결한다. 이 사실만으로 Codex의 로컬 MCP 설정이나 임의 플러그인이 Dot에 그대로 적용된다고 볼 수는 없다. Stock Scout용 사용자 지정 도구의 Dot 호환성은 후속 관측이 필요하다. [Introducing dots](https://openai.com/index/introducing-dots/), [Managing dots in ChatGPT workspaces](https://help.openai.com/en/articles/20001554-managing-dots-in-chatgpt-workspaces)

## 제품과 실행 환경별 공식 근거

| 소비 환경 | 공식 문서에서 확인한 연결 방식 | Stock Scout에 적용할 때 남는 조건 |
| --- | --- | --- |
| 로컬 Codex CLI·IDE 확장 | Codex 호스트에 STDIO MCP와 Streamable HTTP MCP를 설정한다. STDIO에는 실행 명령·인수·작업 디렉터리·환경 변수 전달을 설정할 수 있다. HTTP에는 Bearer·OAuth 인증을 지원한다. | Stock Scout 프로세스 또는 서버가 그 실행 환경에서 접근 가능해야 한다. 로컬 설정이 클라우드에도 전파된다고 가정하지 않는다. |
| 같은 Codex 호스트를 사용하는 ChatGPT 데스크톱 앱 | 현재 MCP 문서는 데스크톱 앱·CLI·IDE 확장의 MCP 설정 공유를 명시한다. | 문서가 가리키는 앱·호스트 범위의 지원이다. 사용자 설치 버전과 실제 사용 모드는 확인하지 않았다. |
| ChatGPT 웹의 Chat·Work | 호스팅 채팅에서는 플러그인을 설치해 원격 MCP 도구를 사용한다. 웹은 로컬 Codex 설정 파일을 읽지 않는다. | 웹 소비가 필수이면 서버 접근성·호스팅·플러그인 접근 권한을 결정해야 한다. 로컬 CLI만 배포하는 것으로 충족되지 않는다. |
| Work Cloud·Codex의 원격 실행 환경 | MCP 설정에는 실행 환경 선택이 있으며, 공식 문서는 로컬 MCP·전송이 클라우드에서 사용되지 않을 수 있으므로 연결과 인증을 따로 확인하도록 한다. | 서버가 실행되는 위치, 네트워크 경로, 자격 증명의 위치를 별도로 검증해야 한다. |

표의 근거는 현재 [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)의 `Connect an existing MCP server`, `Supported MCP features`, `Use MCP-backed tools in ChatGPT web` 및 설정 절이다. 문서상 공유 설정은 명시된 호스트에 한정하며, 제품 전체가 하나의 실행 환경이라는 주장은 하지 않는다.

기존 Help Center의 개발자 모드 설명은 원격 MCP 연결과 특정 요금제·웹 환경을 다룬다. 이를 데스크톱 앱 전체의 로컬 MCP 미지원 근거로 확대하지 않는다. 현재 개발자 문서의 데스크톱 지원 설명과 함께, 실제 선택한 요금제·앱 버전·워크스페이스 정책을 확인할 필요가 있다. [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt)

### CLI와 구조화 입출력

공식 `codex exec` 문서는 명령 결과를 Codex 입력으로 전달하는 파이프, 프롬프트와 표준 입력의 결합, 명령 실행 이벤트를 설명한다. 따라서 실행 권한이 있는 로컬 Codex가 Stock Scout CLI 결과를 읽는 경로는 공식 기능을 조합한 후보이다. Stock Scout 전용 연결을 실증한 결과는 아니다. [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)

같은 문서의 `--json`은 **Codex 자신의 실행 이벤트**를 JSONL로 내보내고 `--output-schema`는 **Codex 최종 응답**의 스키마를 지정한다. Stock Scout의 도구 결과 계약을 이 옵션이 대신 만드는 것은 아니다. Stock Scout가 내보낼 JSON·오류·종료 코드는 별도 계약이어야 한다. 이 구분은 파이프 출력을 후속 처리하는 경우에도 필요하다. [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)

CLI 후보는 상시 서버 없이 시작할 수 있다는 장점이 있다. 반면 명령 실행 허용 범위, 실행 파일 접근, 표준 출력 크기와 비밀 제거, 실패를 자연어 성공으로 바꾸지 않는 소비 규칙이 필요하다. 이는 도구 설계에 대한 추론이다. CLI 프로세스가 로컬이라는 이유만으로 그 결과가 로컬에만 머문다고 간주하지 않는다. 에이전트가 결과를 해석하는 경로와 자료 전달 범위를 함께 결정해야 한다.

### MCP와 HTTP

MCP 도구는 이름·설명·입력 스키마와 선택적 출력 스키마로 발견되고, 서버가 인수를 검증해 실행한 결과를 모델이 활용한다. UI는 선택 사항이다. 따라서 읽기 전용 주식 도구를 제공하기 위해 대시보드나 별도 채팅 UI가 필수는 아니다. 공개 운영 서버의 공식 권장 전송은 안정적인 HTTPS 주소의 Streamable HTTP이다. [MCP server](https://developers.openai.com/plugins/concepts/mcp-server)

로컬 STDIO MCP는 소비자가 프로세스를 시작할 수 있을 때의 후보이고, 원격 MCP는 호스트가 접근할 서버가 필요할 때의 후보이다. Stock Scout의 일반 HTTP API를 만드는 것과 MCP의 HTTP 전송을 제공하는 것은 다른 작업이다. 임의 REST 주소를 만들기만 하면 모든 ChatGPT·Dot 환경에서 도구로 등록된다는 근거는 확보하지 않았다. HTTP API가 이미 있으면 MCP 서버가 그 API를 호출하는 구성을 검토할 수 있지만, 이번 조사에서 두 계층을 미리 만들 이유는 확정되지 않았다. [MCP server](https://developers.openai.com/plugins/concepts/mcp-server), [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

### 스킬과 도구 지침

스킬은 `SKILL.md`와 선택적 참조 자료·스크립트로 반복 작업의 절차를 전달한다. 현재 문서는 로컬 독립 스킬과 플러그인으로 배포한 스킬의 지원 환경을 구분한다. 저장소의 스킬 디렉터리를 만들었다고 웹이나 Dot이 자동으로 읽는다고 가정하지 않는다. [Build skills](https://learn.chatgpt.com/docs/build-skills)

MCP의 `instructions`는 Codex가 여러 도구의 공통 사용 규칙을 읽는 통로이다. 스킬은 도구 호출 순서·결과 해석·불완전 결과 대응을 안내하는 선택적 계층으로 검토할 수 있다. 지침 자체가 실제 데이터 연결이나 접근 권한 검사를 대신하지는 않는다. 입력 스키마도 서버의 검증을 대신하지 않는다. [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [MCP server](https://developers.openai.com/plugins/concepts/mcp-server)

### Dot에서 확인된 범위와 미확인

공식 소개와 워크스페이스 문서에서 확인한 사실은 다음과 같다.

- Dot은 자체 클라우드 컴퓨터·브라우저와 연결 앱을 사용한다. [Introducing dots](https://openai.com/index/introducing-dots/)
- 사용자 컴퓨터의 파일과 명령을 사용하는 기능에는 별도 연결과 정책이 적용된다. 워크스페이스 문서는 컴퓨터가 온라인이고 ChatGPT 앱이 열려 있어야 한다고 설명한다. [Managing dots in ChatGPT workspaces](https://help.openai.com/en/articles/20001554-managing-dots-in-chatgpt-workspaces)
- 지원되는 기존 ChatGPT 앱 연결이 Dot에도 제공될 수 있지만, 앱·플러그인 권한과 연결 서비스의 인증 범위가 각각 적용된다. 클라우드 컴퓨터는 로컬 VPN·브라우저 로그인·기기 정책을 자동 승계하지 않는다. [Managing dots in ChatGPT workspaces](https://help.openai.com/en/articles/20001554-managing-dots-in-chatgpt-workspaces)
- 백그라운드의 proactive research에서는 연결 앱 도구가 읽기 전용으로 제한된다. 사용자 규칙과 기본 보호 규칙·행동 검토도 별도로 적용된다. 이 제한은 모든 Dot 작업에 같은 승인 방식이 적용된다는 뜻이 아니다. [Introducing dots](https://openai.com/index/introducing-dots/)

미확인인 부분은 Stock Scout용 사용자 지정 플러그인의 Dot 노출 조건, Dot의 로컬 STDIO MCP 직접 등록, Codex 설정의 자동 승계, 이 저장소 CLI의 실제 실행 호환성이다. 공식 문서의 일반 연결 기능을 근거로 각 경로를 후보로 남기되, 문서 미확인과 제품 미지원을 구분한다. 선택한 사용자 환경에서 한 가지 경로를 관측하기 전에는 Dot 지원 완료로 표시하지 않는다.

## 현재 코드에서 이미 있는 것과 없는 연결

다음은 기준 커밋의 정적 소스 검토 결과이며 실행 검증은 하지 않았다.

| 읽은 소스 | 확인한 동작과 새 도구화에 대한 의미 |
| --- | --- |
| [`scripts/buy-candidates.ts`](../../scripts/buy-candidates.ts) | `runCandidateCli(true)`를 호출한다. 기존 추천 CLI의 진입점이다. |
| [`scripts/candidate-universe.ts`](../../scripts/candidate-universe.ts) | CLI 인수를 검증하고, 일정·탐색 순위·유형 판단·일봉을 수집한다. 정상 결과는 직렬화해 stdout으로, 실패는 오류·단계 등 JSON을 stderr로 보낸다. 구조화된 CLI 패턴은 이미 있지만 새 계좌 도구 계약은 아니다. |
| 같은 파일의 `candidateUniverse()` | `readSiwcCredentials()`와 `assessSecurityTypes()`를 호출한다. 추천 보고서를 생략해도 현재 후보군 조회 전체가 LLM 인증 없이 동작하는 것은 아니다. |
| [`scripts/buy-candidate-assessment.ts`](../../scripts/buy-candidate-assessment.ts) | Vercel AI SDK의 `tool()`로 `get_daily`를 구성해 내장 모델에 이미 조회·검사한 일봉을 제공한다. 현재 함수 내부의 도구이며 외부 MCP 서버로 등록된 구현은 아니다. 추천·의미 검토와 SIWC 인증, 제한된 유료 전환도 이 경로에 있다. |
| [`scripts/calendar-notice-assessment.ts`](../../scripts/calendar-notice-assessment.ts) | 일정 공지 의미 판단과 SIWC 자격 증명 읽기가 있다. 내장 추천만 제거해도 모든 LLM 의존성이 사라진다고 판단할 수 없다. |
| [`docs/adr/0015-subscription-buy-candidate-report.md`](../adr/0015-subscription-buy-candidate-report.md), [ADR 0016](../adr/0016-bounded-paid-recommendation.md), [ADR 0017](../adr/0017-model-request-lifecycle.md) | 기존 보고서·의미 검토·인증 및 비용·모델 생명주기의 계약이다. 새 도구 제품에서 무엇을 유지할지는 별도 결정이다. |

코드의 `get_daily`와 MCP의 도구라는 표현이 비슷해도 외부 클라이언트의 발견·전송·인증 경로까지 구현되어 있다는 뜻은 아니다. 계좌·보유 종목·거래 내역의 공급자 지원과 기존 구현 전체의 존재 여부는 이번 제한된 코드 읽기로 확정하지 않았다.

## 내장 LLM과 인증을 유지해야 하는가

공식 MCP 흐름에서는 클라이언트의 모델이 도구를 고르고 서버는 인수 검증·실행·결과 반환을 담당한다. 이 구성은 Stock Scout 서버 내부의 두 번째 추천 모델을 필수로 요구하지 않는다. [MCP server](https://developers.openai.com/plugins/concepts/mcp-server)

따라서 **외부 에이전트가 추천과 의미 판단을 책임지는 제품으로 결정한다면**, 내장 추천 LLM과 그 전용 구독 인증을 새 조회 도구의 필수 의존성에서 제외하는 방향을 검토할 수 있다. 이는 책임 분리에서 도출한 추론이며 삭제 결정은 아니다. 현재 후보군의 일정·유형 판단에도 모델 의존성이 있으므로, 기존 CLI를 단순히 감싸는 경로와 결정론적 조회 도구를 분리하는 경로의 범위는 다르다.

반대로 Stock Scout 자체가 검토된 추천 보고서를 보장해야 한다면 내장 추천·의미 검토의 유지 여부를 따로 결정해야 한다. 외부 에이전트의 자연어 판단을 기존 보고서의 검증 완료와 동일하게 취급할 수 없다. 어떤 경우에도 데이터 출처·조회 시각·대상 식별·검증·실패 판정은 도구의 코드 계약으로 남겨야 한다는 것이 이 조사의 설계 추론이다.

인증은 적어도 다음 세 경계를 구분한다.

| 경계 | 의미 |
| --- | --- |
| 사용자가 외부 에이전트를 사용하는 인증 | Codex·ChatGPT·Dot 이용 권한이다. 이것만으로 Stock Scout나 증권 계좌의 접근 권한이 생기지 않는다. |
| 에이전트 클라이언트가 Stock Scout에 접근하는 인증 | 로컬 프로세스 권한 또는 원격 서버의 사용자 인증·인가이다. 원격의 개인별 자료에는 인증이 필요하며 공식 플러그인 지침은 OAuth 2.1과 서버의 토큰 검증을 설명한다. |
| Stock Scout가 데이터 공급자에 접근하는 인증 | 시세·계좌 자료를 조회할 자격 증명과 권한이다. 위의 MCP 인증이나 기존 SIWC 모델 인증과 서로 대체되지 않는다. 실제 공급자 요구는 별도 조사 대상이다. |

로컬 Codex의 MCP HTTP 설정에서 현재 ChatGPT 세션 인증을 쓰는 옵션은 신뢰하는 OpenAI 자체 출처에 한정된다. Stock Scout의 임의 서버에 ChatGPT 세션을 그대로 사용하는 일반 인증 방식으로 해석하지 않는다. 원격 MCP 서버는 토큰의 서명·발급자·대상·만료·범위를 직접 검사해야 한다. [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Authentication](https://developers.openai.com/plugins/build/auth)

## 가장 작은 연결 경로의 후보

| 후보 | 성립 조건 | 추가로 결정할 사항 |
| --- | --- | --- |
| A. 로컬 Codex → Stock Scout CLI | 사용자가 로컬 명령 실행을 허용하고 필요한 런타임·공급자 접근이 준비된다. | 첫 조회 명령과 JSON·오류 계약. 기존 LLM 포함 CLI를 재사용할지, 새 조회 기능을 분리할지. |
| B. 로컬 Codex·지원 데스크톱 호스트 → STDIO MCP | 스키마를 가진 도구 발견과 직접 호출이 필요하다. | 첫 도구 모음과 프로세스 권한. CLI와 MCP를 동시에 제공할 이유가 있는지. |
| C. ChatGPT 웹 → 플러그인 → 원격 MCP | 웹에서 직접 도구를 소비하는 것이 필수이고 원격 제공이 허용된다. | 호스팅·접근 제어·OAuth·개인 자료 전달 및 보관 범위. 별도 UI는 필수가 아니다. |
| D. Dot → 지원 연결 앱 또는 허용된 로컬 컴퓨터 | 선택한 Dot 환경에서 사용자 지정 연결 또는 명령 실행이 실제로 가능함을 확인한다. | 플러그인 노출·로컬 연결·정책·인증을 확인하는 최소 관측. A~C의 설정을 자동 승계한다고 가정하지 않는다. |

위 후보는 대안 비교이며 구현 순서나 최종 선택이 아니다. HTTP REST API와 MCP·CLI를 모두 먼저 구현하는 방안은 이번 조사에서 필요성이 입증되지 않았다.

## 후속 사용자 결정과 검증 경계

1. 첫 필수 소비 환경을 로컬 Codex, ChatGPT 웹, Dot 중 어디로 정할지 결정해야 한다. 여러 제품 지원이 필수이면 각 환경의 연결 검증을 따로 둔다.
2. 추천·의미 판단을 외부 에이전트가 책임지고 Stock Scout는 자료를 제공할지, 자체 보고서도 유지할지 결정해야 한다. 일정·유형 판단의 내장 모델 의존성은 함께 검토한다.
3. 첫 도구 모음에 시세 외 계좌·보유 종목·거래 내역 중 무엇을 포함할지 결정해야 한다. 계좌 식별·금액·수량·거래 상세 중 외부 모델에 전달할 필드와 요약·가림 범위도 필요하다.
4. 공급자 자격 증명을 어느 실행 환경에 둘지, 결과를 어떤 모델·호스트에 전달할지, 로그·대화·파일의 보관과 삭제 범위를 결정해야 한다. 로컬 도구 실행과 외부 모델로의 자료 전달은 별도 판단이다.
5. 읽기 전용 도구만 노출할지, 조회마다 사용자 확인이 필요한 개인 자료를 구분할지 결정해야 한다. 주문 기능은 이 조사 범위에 없으며 도구 이름이나 지침만으로 접근 제한을 보장하지 않는다.

연결 방식을 고른 뒤의 최소 공개 검증 후보는 다음과 같다. CLI는 인수·stdout JSON·stderr·종료 코드, MCP는 도구 목록·입출력 스키마·도구 오류·인증 실패, 원격 경로는 접근 거부·만료·사용자별 자료 분리까지다. 잘못된 인수, 자료 없음, 불완전 자료, 접근 거부를 성공한 추천 근거로 소비하지 않는지도 확인할 필요가 있다. 개인 계좌 없이 합성 자료로 소비자의 호출·오류 처리를 먼저 관측하고, 실제 서비스와 제품 호환성은 별도 승인된 관측으로 구분할 수 있다. 이 검증 경계는 제안이며 아직 합의된 인수 조건이 아니다.

## 근거 수집과 한계

공식 OpenAI 문서만 연결 지원의 근거로 사용했다. `developers.openai.com/codex/` 문서가 현재 `learn.chatgpt.com`의 공식 문서로 이동하는 것을 확인했으며, 실제 읽은 현재 주소를 인용했다. 문서의 환경별 설명과 모델의 실행 환경을 구분했다.

MCP·비대화형 CLI·스킬·플러그인 MCP·인증 문서는 익명 공개 수집기로 원문 Markdown을 보관했다. Dot 소개와 워크스페이스 Help 문서는 웹 도구로 본문을 읽었지만 익명 원문 수집은 HTTP 403으로 실패했다. 개발자 모드 Help 문서도 웹 도구로 확인했으며 원문 파일 보관은 하지 않았다. 따라서 이 세 문서의 로컬 원문 보관 근거는 없다.

로컬 코드·ADR 읽기와 공개 문서 조사는 지원되는 연결 후보를 찾은 근거다. 인증·서버 설정·설치·실계좌 조회·도구 실호출·Dot 또는 ChatGPT의 실제 연결·추천 품질·공급자의 계좌 API 지원은 검증하지 않았다. 문서만 추가했으므로 프로젝트 테스트는 실행하지 않았다. 기존 코드와 요구사항·용어집·ADR은 수정하지 않았다.
