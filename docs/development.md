# 개발과 로컬 검증

[처음 실행하기](getting-started.md)에서 인증 없는 실행을 확인한 뒤 아래 절차를 사용하세요. 요청 처리와 모듈별 책임은 [구조 설명](architecture.md)을 참고하세요. GitHub Actions는 비활성 상태로 유지합니다.

## 개발 환경 준비

[mise.toml](../mise.toml)은 개발용 Node.js와 pnpm 버전을 고정합니다. 저장소 루트에서 도구와 개발 의존성을 준비하세요.

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
```

pnpm은 [lockfile](../pnpm-lock.yaml)에 따라 개발 의존성을 설치합니다. 이 단계에서 뒤의 Git 훅에 필요한 로컬 pnpm 저장소도 준비합니다. 인증 없는 CLI와 합성 예제는 Node.js만으로 실행할 수 있습니다.

### 오프라인 워크트리 준비

새 워크트리에서 작업을 시작할 때는 사용이 승인된 기존 pnpm 저장소의 절대 경로를 지정하고, 아래 설치가 성공하는지 확인하세요. 예시 경로를 사용할 저장소의 실제 경로로 바꾸세요.

```sh
export npm_config_store_dir=/absolute/path/to/prepared-pnpm-store
mise exec -- pnpm install --offline --frozen-lockfile --ignore-scripts
```

[TypeScript 설정](../tsconfig.json)은 `scripts/*.ts`를 검사합니다. JavaScript 테스트·소비 예제는 [형식·린트 설정](../biome.json)과 실제 실행 검사로 확인하세요. 형식 검사가 이 파일들의 타입까지 검사한다고 해석하지 마세요.

## 로컬 검사

저장소 루트에서 실행하세요. 명령 정의와 검사 대상은 [package.json](../package.json)의 `scripts`를 기준으로 합니다.

```sh
mise exec -- pnpm run check
mise exec -- pnpm run typecheck
mise exec -- pnpm test
```

`pnpm test`는 먼저 로컬 루프백 소켓을 열 수 있는지 확인하고 전체 테스트를 실행합니다. 환경 사전 검사에 실패하면 테스트를 실행한 결과로 취급하지 마세요. 토스 검사는 외부 HTTP를 합성 응답으로 대체하고 시계는 사례에 따라 대체합니다. 실제 프로세스 경합·호출 간격 검사는 실제 시계를 사용합니다. 합성 통과는 실제 공급자·계좌·소비 환경 검증과 구분합니다. 테스트 범위와 근거는 [CLI 검증 안내](toss-cli.md#합성-검사와-후속-확장)와 [검증 기록 목록](README.md#토스-검증-기록)에서 확인하세요.

### 테스트와 도우미 찾기

명령별 소스·검사 대응은 [모듈별 책임](architecture.md#모듈별-책임)에 있습니다. 공통 동작을 바꾸면 해당 명령 검사뿐 아니라 공통 인증·시계·계좌·소비 경로도 확인하세요.

| 파일 | 유지보수할 내용 |
| --- | --- |
| [toss-cli-helper.mjs](../tests/toss-cli-helper.mjs) | 격리된 합성 자격 증명·상태, CLI 하위 프로세스, HTTP 전송 기록, 종료 대기와 정리 |
| [toss-http-mock.mjs](../tests/toss-http-mock.mjs) | 공급자 응답·네트워크 오류·시계·동기화 조건 대체 |
| [toss-agent-cli.mjs](../tests/toss-agent-cli.mjs) | 문서에서 직접 실행하는 합성 성공·부분·오류 시나리오 |
| [toss-agent-cli.test.mjs](../tests/toss-agent-cli.test.mjs), [price-consumer.test.mjs](../tests/price-consumer.test.mjs) | 명령 발견·합성 실행과 실제 소비 예제의 입출력 연결 |
| [toss-cli-helper.test.mjs](../tests/toss-cli-helper.test.mjs) | 테스트 도우미의 실패·타임아웃·프로세스 종료 처리 |
| [pre-push.test.mjs](../tests/pre-push.test.mjs) | 문서·스킬·스냅샷 검사와 훅 설치 경계 |
| [test-preflight.test.mjs](../tests/test-preflight.test.mjs), [check.test.mjs](../tests/check.test.mjs) | 테스트 실행 환경 오류 구분과 예제 린트 포함 여부 |

한 영역을 수정하는 동안에는 해당 파일을 지정해 빠르게 확인하세요. 예를 들어 봉 날짜 선택은 다음처럼 검사할 수 있습니다. 이 명령은 루프백 사전 점검을 건너뛰므로 전체 완료 검증은 위의 `pnpm test`로 수행하세요.

```sh
node --test tests/toss-candle-date.test.mjs
```

루프백을 사용하는 테스트만 골라 실행할 때도 같은 저장소 루트와 권한에서 기존 사전 검사를 먼저 실행하세요. 예를 들어 pre-push의 루프백 검사는 다음 명령으로 실행합니다.

```sh
node scripts/test-preflight.ts &&
  node --test --test-name-pattern='push CLI honors the pnpm test loopback preflight' tests/pre-push.test.mjs
```

fixture의 상태는 실행별로 격리하고 하위 프로세스가 종료된 뒤 정리하세요. 정상 빈 배열·부분 페이지·조회 오류를 각각 검사하며, 공급자 순서와 원래 커서·소수 문자열이 소비자에게 그대로 전달되는지도 확인하세요. mock을 바꾸면 테스트 도우미와 소비 예제가 여전히 실제 CLI를 통과하는지 확인하세요.

## 조회 동작을 수정하거나 추가하기

1. [현재 요구사항](README.md)과 [용어집](../GLOSSARY.md), 관련 ADR·명령 계약을 읽고 변경할 외부 동작을 정하세요. 문서와 코드가 다르면 요구사항과 의도부터 확인하세요.
2. [구조 설명](architecture.md)의 모듈에서 입력 생성·응답 검증을 찾아 호출자를 추적하세요. 인증·공유 상태·계좌 헤더·HTTP 제한은 기존 `TossClient` 경로를 사용하세요.
3. CLI 인수·stdout JSON·stderr·종료 코드·외부 HTTP를 통해 계약을 검사하세요. 기대값은 계약이나 독립된 합성 사례에서 정하고, 버그 수정은 수정 전 실패와 수정 후 성공을 확인하세요.
4. 명령 발견 정보와 [CLI 레퍼런스](toss-cli.md)를 함께 갱신하세요. 에이전트의 조회 선택이나 해석이 바뀌면 [에이전트 지침](toss-agent-usage.md), 합성 실행기와 소비 예제 검사도 갱신하세요.
5. 변경을 다시 읽고 문서·형식·타입·전체 검사를 마치세요. 합성 결과를 실제 토스·계좌·모델 전달의 성공으로 확대하지 마세요.

## 문서를 유지하기

README는 시작 경로, 문서 색인은 탐색, 시작 안내는 첫 실행, CLI 레퍼런스는 외부 계약, 에이전트 지침은 조회 선택과 해석, 구조 설명은 구현 책임을 담당합니다. 상세 계약을 여러 문서에서 따로 유지하지 말고 담당 문서로 연결하세요. 명령과 검사 스크립트의 정의는 소스·설정에서 확인하세요.

용어집에는 현재 제품의 개념만 정의하고 구현 절차를 넣지 마세요. 과거 보고서 용어는 [이전 용어 기록](glossary-history.md), 과거 안내·관측은 [과거 제품 기록](README.md#과거-제품-기록)에 보존하세요. 날짜가 붙은 설계·검증 기록은 당시 근거이며 현재 사용 계약을 대체하지 않습니다.

문체는 파일의 독자와 역할에 따라 통일하세요. 실행·복구를 직접 안내하는 시작 안내·CLI 레퍼런스·개발 안내는 한국어 합니다체, 구조·용어·결정·검증 기록은 한국어 평서체로 작성하세요. 에이전트가 주로 소비하는 지침·스킬은 영어 명령형을 사용하세요. 과거 관측의 문장과 사실은 당시 기록으로 유지하세요. ADR은 되돌리기 어렵고 이유를 모르면 이해하기 어려운 실제 설계 선택이 있을 때만 추가하세요.

## 문서 생성 스킬

에이전트 공용 [document-generate](../.agents/skills/document-generate/SKILL.md)는 코드와 테스트를 조사한 뒤 필요한 튜토리얼·작업 안내·레퍼런스·설명 문서를 작성합니다. 사용자 문서는 한국어로 작성하며, 명시적으로 호출할 때만 실행합니다.

- Codex: `$document-generate 토스 조회 CLI의 사용 안내를 작성해 주세요.`
- Claude Code: `/document-generate 토스 조회 CLI의 사용 안내를 작성해 주세요.`
- 다른 에이전트: 위 `SKILL.md`를 읽고 따르도록 명시적으로 요청하세요. 자동 탐색 지원 여부는 도구마다 다릅니다.

공용 본문은 `.agents/skills/`에서 관리하고 Claude Code는 `.claude/skills/`의 심볼릭 링크로 같은 본문을 읽습니다. 목록에 보이지 않으면 저장소에서 새 세션을 시작하세요. gstack 설치는 필요하지 않습니다. 문서 생성 요청만으로 커밋·푸시를 수행하지 않으며, 작업 요청과 저장소의 전달 규칙을 따릅니다.

원본 출처·고정 리비전·변경 범위는 [도입 기록](../.agents/skills/document-generate/UPSTREAM.md)에 있으며, 해당 스킬에는 [원본 MIT 라이선스](../.agents/skills/document-generate/LICENSE)를 포함했습니다.

## QA 스킬

에이전트 공용 [qa](../.agents/skills/qa/SKILL.md)는 지정한 CLI 동작을 점검하고 결함을 재현한 뒤, 회귀 테스트와 최소 수정으로 다시 검증합니다. 명시적으로 호출할 때만 실행하며 gstack 설치는 필요하지 않습니다.

- Codex: `$qa 토스 조회 CLI를 점검하고 발견한 버그를 수정해 주세요.`
- Claude Code: `/qa 토스 조회 CLI를 점검하고 발견한 버그를 수정해 주세요.`
- 다른 에이전트: 위 `SKILL.md`를 읽고 따르도록 명시적으로 요청하세요.

기본은 지정 범위의 전체 점검과 중간 심각도 이상 결함 수정입니다. `--quick`은 빠른 점검, `--exhaustive`는 경미한 결함까지 수정, `--regression <보고서 경로>`는 이전 실패 재검증, `--report-only`는 보고만 수행합니다. 이 옵션은 스킬의 실행 방식을 지정하며 제품 CLI에 전달하지 않습니다.

외부 통신은 기본적으로 모의 처리하며 실연동은 대상과 호출 범위에 대한 승인이 있을 때 수행합니다. 실행별 한국어 보고서와 비밀값을 제외한 증거는 기본적으로 접근을 제한한 임시 디렉터리에 보관합니다. QA 호출만으로 커밋·푸시하지 않습니다. 공용 본문과 Claude Code 연결 방식은 문서 생성 스킬과 같으며, 목록에 보이지 않으면 새 세션을 시작하세요.

출처와 변경 범위는 [도입 기록](../.agents/skills/qa/UPSTREAM.md)에 있으며 [원본 MIT 라이선스](../.agents/skills/qa/LICENSE)를 포함했습니다.

## 커밋·푸시 검사

커밋하거나 스테이징하지 않고 작업 중인 문서를 검사하려면 저장소 안에서 파일을 지정하세요.

```sh
node scripts/pre-push.ts --docs README.md docs/getting-started.md
```

지정한 추적·미추적 Markdown 파일의 공백·로컬 링크·제목 앵커를 기존 훅과 같은 기준으로 검사합니다. 경로는 현재 디렉터리를 기준으로 해석하며 저장소 밖의 파일과 밖으로 연결되는 심볼릭 링크는 거부합니다. 선택하지 않은 문서 전체를 검사하거나 파일·인덱스·훅을 수정하지 않습니다. 검사 실패 시 종료 코드 1을 반환합니다.

작업 문서·staged·push는 같은 링크 검사를 사용합니다. 일반 링크와 괄호가 들어간 경로를 지원하며, 닫히지 않은 링크는 미완성 문법으로 건너뛰고 뒤에 나오는 완성된 링크는 계속 검사합니다. 관련 회귀 검사는 긴 미완성 링크를 제한된 하위 프로세스에서 확인합니다. 이 실행 한도 검사는 실제 사용 환경의 평균 성능을 측정하지 않습니다.

코드 블록의 예시 링크는 인용문 안에서도 건너뜁니다. 인용문 안의 일반 링크는 검사합니다. 닫는 코드 표식이 없는 채 인용문이 끝나면 그 뒤 본문의 링크도 검사합니다.

저장소 루트에서 필요한 Git 훅을 각각 설치하세요. `--install`은 기존과 같이 pre-push만 설치합니다.

```sh
mise exec -- node scripts/pre-push.ts --install-pre-commit
mise exec -- node scripts/pre-push.ts --install
```

pre-commit은 staged 스냅샷의 공백·로컬 Markdown 링크·프로젝트 스킬 설정을 검사합니다. 코드 변경이 있으면 staged 스냅샷에서 `pnpm run check`와 `pnpm run typecheck`도 실행합니다. 부분 스테이징과 최초 커밋을 지원하며 작업 파일과 인덱스를 자동 수정하지 않습니다. 인덱스에 충돌이 남아 있거나 검사 중 staged 내용이 바뀌면 커밋을 차단합니다. 훅을 설치하지 않고 검사하려면 `mise exec -- node scripts/pre-push.ts --staged`를 실행하세요.

staged·push의 변경 분류는 Git의 이름 변경 탐지를 끄고 삭제 경로와 추가 경로를 모두 확인합니다. 코드 파일을 `.md`로 이름 변경해도 삭제된 코드 경로를 기준으로 코드 검사를 실행합니다. 문서끼리 이름 변경하면 문서 검사를 유지하며, 코드끼리 또는 문서에서 코드로 이름 변경하면 코드 검사를 실행합니다. push는 코드 변경이 있으면 `pnpm run check`, `pnpm run typecheck`, `pnpm test`를 모두 실행합니다. 모듈 이름 변경 뒤 남은 호출자의 실제 타입 오류는 작업 디렉터리에서 고쳤더라도 staged·push 스냅샷에 남아 있으면 차단합니다.

staged·push 검사에서 추적 심볼릭 링크의 최종 대상은 같은 스냅샷 안에 있어야 합니다. 외부·끊긴·순환 링크가 있으면 품질 검사 전에 차단합니다.

코드 검사는 작업 트리에서 확인한 로컬 pnpm 저장소를 사용합니다. 훅은 staged·push 스냅샷의 manifest와 lockfile에 맞는 의존성을 그 스냅샷에 오프라인으로 설치합니다. 설치 스크립트 실행을 끄고 패키지 파일을 임시 스냅샷에 복사합니다. 저장소에 필요한 패키지가 없으면 위의 개발 의존성 설치를 먼저 실행하세요. manifest와 lockfile이 불일치하면 두 파일을 함께 갱신한 뒤 다시 검사하세요. [스냅샷 의존성 결정](adr/0021-pnpm-snapshot-dependencies.md)에서 이 방식의 근거를 확인할 수 있습니다.

오프라인 준비에 성공한 셸에서 로컬 검사와 Git 명령을 실행하세요. 다른 셸이나 위임 작업에서 실행한다면 같은 `npm_config_store_dir`를 넘기세요. `ERR_PNPM_NO_OFFLINE_TARBALL`이 나오면 검증을 시작하기 전에 현재 lockfile을 충족하는 저장소를 지정하고 준비 명령을 다시 실행하세요.

Git을 실행하는 환경의 `PATH`에서 고정된 Node.js와 pnpm을 찾을 수 있어야 합니다. 셸에서 mise 활성화를 사용하거나 `mise exec -- git commit ...`, `mise exec -- git push ...`처럼 Git을 실행하세요.

설치 훅에는 설치 시점의 `scripts/pre-push.ts` 내용이 들어갑니다. pre-commit은 현재 인덱스에서 고정한 트리를, pre-push는 푸시 입력에 지정된 각 커밋의 트리를 확인합니다. 대상에 같은 내용의 일반 파일이 있어야 하며, 검사에는 설치본을 사용합니다. 검사기가 없거나 내용이 다르면 커밋 또는 푸시 전체를 차단합니다. 검사기 내용이 다른 ref는 각 버전에 맞는 훅으로 따로 푸시하세요. ref 삭제에는 비교할 커밋이 없습니다. 수동 `--staged`와 `--docs`는 실행한 작업 복사본의 검사기를 사용합니다.

### 기존 훅 이전과 검사기 갱신

설치기는 기존 훅을 덮어쓰지 않습니다. 설치하거나 갱신할 검사기 내용을 먼저 검토하고, 커밋할 때는 그 내용을 스테이징하세요. 푸시할 때는 각 대상 커밋에 그 내용이 들어 있어야 합니다. 기본 훅 디렉터리는 연결된 Git worktree 사이에 공유되므로 한 곳에서 설치본을 바꾸면 같은 훅을 쓰는 다른 worktree에도 적용됩니다.

1. `git config --get core.hooksPath`와 `git rev-parse --git-path hooks`로 설정과 기본 훅 경로를 확인합니다. 기존 파일과 권한을 확인하고 훅 디렉터리 밖에 권한을 유지한 복사본을 백업합니다.
2. 독립된 Stock Scout 훅만 교체합니다. 이전 버전은 작업 트리의 `scripts/pre-push.ts`를 실행하는 짧은 래퍼이고, 새 버전에는 `# Stock Scout snapshot checker (pinned at installation)` 표식이 있습니다. gstack-redact가 상위 `pre-push`를 관리하는 경우에는 Stock Scout의 `pre-push.local`만 교체합니다. 교체할 파일 경로를 `hook`, Git이 실행할 훅 종류(`pre-commit` 또는 `pre-push`)를 `hook_kind`에 지정하세요. 훅과 같은 디렉터리에 새 파일을 생성하고, 생성과 실행 권한 설정이 모두 성공하면 이름을 바꿔 교체합니다.

```sh
draft=$(mktemp "$hook.stock-scout.XXXXXXXX") &&
  mise exec -- node scripts/pre-push.ts --print-hook "$hook_kind" > "$draft" &&
  chmod 700 "$draft" &&
  mv "$draft" "$hook"
```

생성이나 권한 설정에 실패하면 원래 훅이 그대로 남습니다. 교체 후 이전 버전으로 되돌릴 때는 백업을 같은 디렉터리에 복사한 뒤 같은 방식으로 이름을 바꿉니다.

3. 사용자 훅이나 `core.hooksPath`가 있으면 기존 파일을 보존합니다. `--print-hook`으로 새 Stock Scout 훅을 별도 파일에 생성하고, 생성에 성공한 파일에 실행 권한을 준 뒤 기존 훅에서 호출하도록 통합합니다. pre-push가 여러 검사기를 호출한다면 Git이 전달한 인수와 stdin을 각각 그대로 전달하고, 어느 검사든 실패하면 그 종료 상태로 푸시를 중단합니다. 이전에 작업 트리의 검사기를 직접 호출하던 줄은 고정한 훅 호출로 바꿉니다.

### 단일 전체 검사 실험 (2026-11-14)

최종 검증과 pre-push의 중복 전체 검사를 줄일 수 있는지 로컬 bare 원격으로 확인했습니다. `c860b3e`의 실험용 복제본에 예제 린트 범위와 회귀 테스트를 추가하고 실제 `check`, `typecheck`, `test`를 실행했습니다. 표에 실린 네 푸시 시도에서는 공유 `git-preflight.py` 검사를 먼저 통과했습니다. 설치된 gstack-redact 래퍼의 로컬 훅 호출 순서는 유지했고, 보안 검사기 실행만 출력 표식으로 대체했습니다.

| 조건 | 전체 테스트 명령 실행 수 | 보안 검사기 표식 | 로컬 원격 결과 |
| --- | --- | --- | --- |
| 정상 코드와 훅 | 1 | 테스트 뒤 1회 | 전달 성공 |
| 실패 테스트 추가 | 1 | 실행 안 됨 | 전달 차단, 참조 유지 |
| 실패 테스트가 있고 `pre-push.local` 누락 | 0 | 1회 | 실패 코드 전달 |
| 실패 테스트가 있고 주 `pre-push` 훅 누락 | 0 | 실행 안 됨 | 실패 코드 전달 |

훅이 있을 때 테스트 실패는 차단했지만, 훅 누락 시 검증되지 않은 코드의 전달을 막는 합격 조건은 충족하지 못했습니다. 사전 검사의 `ready`는 로컬 Git 상태에 대한 판정이며 훅의 존재나 테스트 성공을 보장하지 않습니다. 따라서 [기존 결정](adr/0004-staged-commit-validation.md)에 따라 최종 검증과 pre-push의 전체 검사를 유지합니다. 이 실험은 보안 검사기 자체나 GitHub 원격을 검증하지 않았습니다.

## 프로젝트 스킬 검사

기존 pre-push 검사는 커밋 스냅샷의 프로젝트 스킬도 확인합니다. `.agents/skills/<이름>/`의 각 스킬에는 같은 이름의 Claude 상대 심볼릭 링크와 Codex 호출 설정이 필요합니다. `UPSTREAM.md`가 있는 스킬에는 비어 있지 않은 일반 파일인 `LICENSE`가 필요하며, 라이선스의 법적 적합성은 별도로 검토합니다.

호출 설정 검사는 `SKILL.md` frontmatter의 `disable-model-invocation` 불리언과 `agents/openai.yaml`의 `policy.allow_implicit_invocation` 불리언이 서로 반대인지 확인합니다. frontmatter의 최상위 키는 따옴표 없는 블록 형식을 지원합니다. 현재 Codex 설정은 `policy` 아래 해당 불리언 하나를 두는 블록 형식만 지원하며, 공백·빈 줄·주석은 허용합니다. 다른 YAML 표현이나 추가 설정은 통과시키지 않으므로 필요한 형식이 생기면 검사와 테스트도 함께 확장하세요. 이 검사는 실제 호스트의 스킬 발견·실행을 검증하지 않습니다.
