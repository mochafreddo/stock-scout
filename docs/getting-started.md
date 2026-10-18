# 처음 실행하고 검증하기

이 안내에서는 로컬 테스트로 관측 CLI의 입출력을 확인한 뒤, 기존 자격 증명이 준비된 경우 실제 KIS 데이터를 조회합니다. 현재 개발 대상과 계획은 [README](../README.md), 용어는 [용어집](../GLOSSARY.md)에서 확인하세요.

## 로컬 테스트로 시작하기

저장소 루트에서 진행하세요. Node.js 24 이상과 npm이 필요합니다. 테스트는 외부 HTTP를 모의 응답으로 대체하므로 KIS 계정이나 OpenAI 인증이 필요하지 않습니다.

1. 실행 환경을 확인하세요.

   ```sh
   node --version
   npm --version
   ```

   Node.js 버전이 24 이상인지 확인하세요. 버전 요구사항은 [package.json](../package.json)의 `engines`가 기준입니다.

2. 잠금 파일에 고정된 개발 의존성을 설치하세요.

   ```sh
   npm ci
   ```

   패키지 다운로드가 발생하며 기존 `node_modules/`를 다시 구성합니다. TypeScript·Biome·Node.js 타입 정의를 설치하며 AI SDK는 아직 포함되어 있지 않습니다.

3. CLI 프로세스 테스트를 실행하세요.

   ```sh
   npm test
   ```

   실패한 테스트가 없으면 정상 관측, 오류와 비밀 필드 배제, 지원 모드와 시장, 빈 응답과 연속 조회 표시, 잘못된 입력, 인증 누락에 대한 모의 검사가 끝납니다. 이는 실제 KIS 인증이나 데이터 의미 검증의 결과가 아닙니다.

테스트의 공개 경계는 CLI 인수·stdout·stderr·종료 코드입니다. 구현은 [scripts/kis-probe.ts](../scripts/kis-probe.ts), 테스트는 [tests/kis-probe.test.mjs](../tests/kis-probe.test.mjs), 외부 HTTP 대체 코드는 [tests/kis-http-mock.mjs](../tests/kis-http-mock.mjs)에 있습니다.

## push 전 로컬 검증 설정하기

저장소 루트에서 `node scripts/pre-push.ts --install`을 한 번 실행하세요. 기존 gstack 보안 훅이 있으면 `pre-push.local`에 연결하며 기존 훅의 내용을 보존합니다. 다른 훅이나 사용자 지정 `core.hooksPath`가 있으면 설치를 중단하므로 수동으로 연결해야 합니다. GitHub Actions는 사용하지 않습니다.

훅은 Git이 전달한 각 ref의 커밋을 임시 디렉터리에 복원해 검사합니다. 작업 중인 파일은 검사 대상에 섞이지 않습니다. 원격 커밋과 비교해 `.md`만 바뀌면 공백 오류와 저장소 내부 링크를 확인합니다. 그 밖의 파일이 바뀌면 `npm run check`, `npm run typecheck`, `npm test`도 차례로 실행합니다. 새 ref는 전체 파일을 변경 범위로 취급하며, 삭제하는 ref는 건너뜁니다. 원격 비교 커밋이 로컬에 없으면 검증이 실패하므로 먼저 가져와야 합니다.

링크 검사는 인라인 링크와 참조 링크 정의의 로컬 경로, `#` 제목과 명시적인 HTML 앵커를 확인합니다. 외부 URL과 코드 블록은 검사하지 않습니다. Markdown 전체 문법이나 외부 사이트의 유효성을 보장하는 검사는 아닙니다.

코드 검사는 push할 `package-lock.json`과 로컬 잠금 파일이 같고 설치된 의존성이 준비되어 있어야 합니다. 기존 `node_modules/`를 임시 디렉터리에 복사하고 `npm ls --offline --all`로 확인합니다. 훅이 패키지를 설치하거나 파일을 자동 수정하지는 않습니다. npm은 오프라인 모드로 실행되지만 이는 실행하는 스크립트의 네트워크 접근까지 차단하는 격리 환경은 아닙니다. 현재 테스트는 외부 HTTP를 모의 응답으로 대체합니다.

검증 실패 시 출력된 경로나 명령을 확인해 수정한 뒤 다시 push하세요. 임시 디렉터리는 성공과 실패 모두에서 삭제됩니다. 훅 자체의 동작은 `node --test tests/pre-push.test.mjs`로 확인할 수 있습니다.

## 인증 없이 관측 JSON 확인하기

테스트 결과에 이어 CLI의 JSON을 직접 확인하려면 저장소 루트에서 다음 명령을 실행하세요. 테스트 도우미가 임시 홈과 캐시, 통제된 시각, 모의 자격 증명만 전달합니다. `--import`로 불러온 테스트 전용 코드가 `fetch`를 대체하므로 실제 KIS 요청이나 토큰 발급은 발생하지 않습니다.

```sh
node --input-type=module -e '
import { fixture, runCli } from "./tests/kis-cli-helper.mjs";
const f = fixture();
try {
  const result = runCli(f, "ok");
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status;
} finally { f.close(); }
'
```

종료 코드 0과 JSON 한 줄을 확인하세요. 모의 응답의 `rowCount`는 1이며 `rows[0]`에는 `symb: "AAPL"`, `tvol: "123"`, `tamt: "456"`이 있습니다. `validation: "unverified"`와 `dataSession: null`도 확인하세요. 시각은 실행할 때 생성하며 수치는 테스트용입니다. 이 결과를 실제 시세로 사용하지 마세요.

같은 명령에서 `runCli(f, "ok")`의 `"ok"`를 다음 값으로 바꿔 경계 동작도 확인하세요.

| 값 | 예상 결과 |
| --- | --- |
| `empty` | 종료 코드 0, `rowCount: 0`, `rows: []`. 정상적인 빈 후보군이라는 뜻은 아닙니다. |
| `continued` | 종료 코드 0, `continuation: "M"`. 다음 페이지는 요청하지 않습니다. |
| `api-error` | 종료 코드 1, stdout은 비어 있고 stderr에 `{"error":"KIS_FAILURE"}`를 출력합니다. |

이 모의 코드는 테스트용 헤더 값과 요청 조건을 검사합니다. 실제 인증 값을 넣지 마세요. 다른 모드·거래소의 모의 실행도 실제 상장 여부나 종목 유형을 확인하는 절차는 아닙니다.

## 변경 후 로컬 검사하기

[package.json](../package.json)의 검사 명령을 저장소 루트에서 실행하세요.

```sh
npm run check
npm run typecheck
npm test
```

`check`는 `scripts/`, `tests/`와 지정된 JSON 설정 파일에 Biome 형식·린트 검사를 적용합니다. Markdown은 이 명령의 대상이 아니므로 문서의 내용과 링크는 별도로 확인하세요. `typecheck`는 `scripts/*.ts`를 검사하며 출력 파일을 만들지 않습니다. 검사 설정은 [biome.json](../biome.json)과 [tsconfig.json](../tsconfig.json)을 참고하세요. 저장소 방침에 따라 Actions는 비활성 상태를 유지하고 필요한 검사는 로컬에서 실행합니다.

## 실제 KIS 응답 관측하기

이 단계는 KIS 운영 API로 실제 요청을 보냅니다. 앞선 테스트와 달리 외부 서비스에 접근합니다. CLI는 자동 발급과 실행 간 재사용을 처리합니다. 승인된 기존 보관소에서 다음 값을 프로세스 환경으로 준비하세요. [인증과 복구](kis-auth.md)의 첫 실행 대기와 캐시 보호 조건을 확인하세요.

| 환경 변수 | 필요한 값 |
| --- | --- |
| `KIS_APP_KEY` | 기존 KIS 앱 키 |
| `KIS_APP_SECRET` | 해당 앱 시크릿 |

CLI는 `.env` 파일을 자동으로 읽지 않습니다. 비밀 값을 명령 인수·셸 기록·로그에 입력하거나 문서에 붙여 넣지 마세요. 이 안내는 새 자격 증명 발급이나 새 보관 위치 설정을 다루지 않습니다.

필요한 관측 명령 하나를 선택해 실행하세요. 각 명령은 시세를 조회하며 필요한 경우 발급 요청이 먼저 발생합니다. 조회 중 명시적 토큰 만료에서만 한 번 복구·재조회하며, 복구에도 300초 발급 간격을 적용합니다. 발급 기록이 없는 첫 실행은 요청 없이 실패하고 300초 뒤 재실행을 안내합니다. CLI가 자동으로 기다리지는 않습니다.

```sh
node scripts/kis-probe.ts volume NAS
node scripts/kis-probe.ts amount NYS
node scripts/kis-probe.ts daily AMS SPY
node scripts/kis-probe.ts info NYS BAC/B
```

성공하면 stdout에 JSON 한 줄과 종료 코드 0을 받습니다. `request`의 거래소·종목·요청 조건, `rowCount`, `rows`, UTC 요청·수신 시각을 확인하세요. `validation`은 항상 `unverified`, `dataSession`은 항상 `null`입니다. 빈 `rows`나 연속 조회 표시는 추가 판단이 필요한 관측 결과입니다. 후보군 구성·유형 제외·장전 시간 판정은 수행하지 않습니다.

실패하면 stdout은 비어 있고 stderr에 `{"error":"오류 코드"}` 형식의 JSON을 받으며 종료 코드는 1입니다. 코드별 의미는 [오류 레퍼런스](kis-probe-reference.md#오류와-종료-코드)를 참고하세요.

| 코드 | 확인할 항목 |
| --- | --- |
| `USAGE` | 모드·거래소의 대소문자, 종목 인수의 필요 여부와 허용 문자, 추가 인수를 확인하세요. `--help`도 지원하지 않습니다. |
| `CREDENTIALS_MISSING` | 필요한 두 환경 변수를 현재 프로세스에 전달했는지 확인하세요. `.env` 파일을 두는 것만으로는 전달되지 않습니다. |
| `AUTH_COOLDOWN` | `retryAfterSeconds` 이상 지난 뒤 재실행하세요. 시계 확인 안내가 있으면 시스템 시각을 확인하세요. |
| `AUTH_LOCKED`, `AUTH_RECORD`, `AUTH_STORAGE`, `AUTH_FAILED` | [인증 복구 절차](kis-auth.md)를 확인하세요. |
| `HTTP_FAILURE`, `KIS_FAILURE` | 기존 인증과 서비스 상태를 확인하세요. 이 코드만으로 토큰 만료를 확정하거나 자동 재발급을 기대하지 마세요. |
| `RESPONSE_SHAPE` | 응답 구조가 CLI의 허용 조건을 벗어났습니다. 요청 모드·시각·오류 코드를 기록하고 레퍼런스의 응답 조건과 대조하세요. |
| `REQUEST_FAILED` | 통신·시간 제한·리디렉션·JSON 해석 실패 등을 포함합니다. 연결 상태와 서비스 상태를 확인하세요. |

도구는 오류 원문을 출력하지 않으므로 이 코드만으로 세부 원인을 확정하지 마세요. 비밀 값이나 인증 헤더를 진단 자료로 공유하지 마세요.

현재 인수·출력의 정확한 계약은 [CLI 레퍼런스](kis-probe-reference.md)에 있습니다. 관측값을 해석하기 전에 [KIS 데이터 검증](kis-data-validation.md)의 실제 관측 범위와 미검증 조건을 확인하세요. 이 문서의 실제 KIS 명령은 이번 문서 작성 과정에서 재실행하지 않았습니다. 기존 실연동 자료와 이번 로컬 모의 검사는 구분합니다.
