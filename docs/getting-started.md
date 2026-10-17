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

   현재 테스트 6개가 모두 통과하면 정상 관측, 오류와 비밀 필드 배제, 지원 모드와 시장, 빈 응답과 연속 조회 표시, 잘못된 입력, 인증 누락에 대한 모의 검사가 끝납니다. 이는 실제 KIS 인증이나 데이터 의미 검증의 결과가 아닙니다.

테스트의 공개 경계는 CLI 인수·stdout·stderr·종료 코드입니다. 구현은 [scripts/kis-probe.ts](../scripts/kis-probe.ts), 테스트는 [tests/kis-probe.test.mjs](../tests/kis-probe.test.mjs), 외부 HTTP 대체 코드는 [tests/kis-http-mock.mjs](../tests/kis-http-mock.mjs)에 있습니다.

## 변경 후 로컬 검사하기

[package.json](../package.json)의 검사 명령을 저장소 루트에서 실행하세요.

```sh
npm run check
npm run typecheck
npm test
```

`check`는 `scripts/`, `tests/`와 지정된 JSON 설정 파일에 Biome 형식·린트 검사를 적용합니다. Markdown은 이 명령의 대상이 아니므로 문서의 내용과 링크는 별도로 확인하세요. `typecheck`는 `scripts/*.ts`를 검사하며 출력 파일을 만들지 않습니다. 검사 설정은 [biome.json](../biome.json)과 [tsconfig.json](../tsconfig.json)을 참고하세요. 저장소 방침에 따라 Actions는 비활성 상태를 유지하고 필요한 검사는 로컬에서 실행합니다.

## 실제 KIS 응답 관측하기

이 단계는 KIS 운영 API로 실제 요청을 보냅니다. 앞선 테스트와 달리 외부 서비스에 접근합니다. 현재 CLI는 토큰을 발급하거나 갱신하지 않습니다. #243의 자동 인증 절차가 구현되기 전까지 승인된 기존 보관소에서 다음 값을 **프로세스 환경으로 준비한 경우에만** 진행하세요.

| 환경 변수 | 필요한 값 |
| --- | --- |
| `KIS_APP_KEY` | 기존 KIS 앱 키 |
| `KIS_APP_SECRET` | 해당 앱 시크릿 |
| `KIS_ACCESS_TOKEN` | 사전 발급된 유효 접근토큰 |

CLI는 `.env` 파일을 자동으로 읽지 않습니다. 비밀 값을 명령 인수·셸 기록·로그에 입력하거나 문서에 붙여 넣지 마세요. 이 안내는 새 자격 증명 발급이나 새 보관 위치 설정을 다루지 않습니다.

필요한 관측 명령 하나를 선택해 실행하세요. 각 명령은 한 번의 요청만 보냅니다.

```sh
node scripts/kis-probe.ts volume NAS
node scripts/kis-probe.ts amount NYS
node scripts/kis-probe.ts daily AMS SPY
node scripts/kis-probe.ts info NYS BAC/B
```

성공하면 stdout에 JSON 한 줄과 종료 코드 0을 받습니다. `request`의 거래소·종목·요청 조건, `rowCount`, `rows`, UTC 요청·수신 시각을 확인하세요. `validation`은 항상 `unverified`, `dataSession`은 항상 `null`입니다. 빈 `rows`나 연속 조회 표시는 추가 판단이 필요한 관측 결과입니다. 후보군 구성·유형 제외·장전 시간 판정은 수행하지 않습니다.

실패하면 stdout은 비어 있고 stderr에 `{"error":"오류 코드"}` 형식의 JSON을 받으며 종료 코드는 1입니다. 코드별 의미는 [오류 레퍼런스](kis-probe-reference.md#오류와-종료-코드)를 참고하세요. 인증 누락은 환경 변수의 준비 여부를 확인하고, HTTP·KIS·통신 오류는 기존 인증 및 서비스 상태를 확인하세요. 도구는 오류 원문을 출력하지 않으므로 이 코드만으로 토큰 만료 등 세부 원인을 확정하지 마세요. 비밀 값이나 인증 헤더를 진단 자료로 공유하지 마세요.

현재 인수·출력의 정확한 계약은 [CLI 레퍼런스](kis-probe-reference.md)에 있습니다. 관측값을 해석하기 전에 [KIS 데이터 검증](kis-data-validation.md)의 실제 관측 범위와 미검증 조건을 확인하세요. 이 문서의 실제 KIS 명령은 이번 문서 작성 과정에서 재실행하지 않았습니다. 기존 실연동 자료와 이번 로컬 모의 검사는 구분합니다.
