# 처음 실행하고 검증하기

인증 없이 CLI의 명령과 성공·오류 출력을 확인하는 안내입니다. 저장소 루트의 터미널에서 시작하세요. 실제 시장·계좌 조회 준비는 아래 [실제 조회 준비하기](#실제-조회-준비하기)에서 구분합니다.

## 로컬 테스트로 시작하기

[package.json](../package.json)은 Node.js 24 이상을 요구합니다. 다음 명령으로 설치된 버전을 확인하세요. 선택 사항인 mise의 개발 버전은 [mise.toml](../mise.toml)에 있습니다.

```sh
node --version
```

아래 연습은 Node.js 기본 기능과 저장소 코드만 사용하므로 `npm ci`, 실제 자격 증명, `TOSS_STATE_DIR` 설정이 필요하지 않습니다. macOS 또는 Linux에서 실행하세요. 내장 모델이나 OpenAI 인증도 필요하지 않습니다.

### 1. 명령 찾기

```sh
node scripts/toss.ts --help
echo $?
```

stdout의 JSON에서 `version=1`, `status="success"`, `data.commands`의 명령 목록을 확인하세요. 다음 줄의 `0`은 종료 코드입니다. 도움말은 인증이나 HTTP 없이 출력됩니다. 명령 인수와 한도는 [CLI 레퍼런스의 명령 목록](toss-cli.md#명령-목록)에서 찾을 수 있습니다.

### 2. 합성 성공 결과 읽기

```sh
node tests/toss-agent-cli.mjs success prices DEMO
echo $?
```

종료 코드는 `0`입니다. stdout의 JSON은 `status="success"`이며 `data` 배열에 `symbol="DEMO"`인 합성 가격을 담습니다. 가격 `lastPrice`는 숫자가 아닌 문자열이고, `source.endpoint`는 `/api/v1/prices`입니다. `retrievedAt`과 공급자 `timestamp`의 의미는 [응답 계약](toss-cli.md#응답-계약)을 확인하세요. 실행 시각에 따라 달라지는 값을 고정된 기대값으로 비교하지 마세요.

stderr의 `SYNTHETIC` 표시는 실제 시세가 아님을 뜻합니다. 합성 실행기는 격리된 임시 상태와 합성 자격 증명·HTTP 응답만 사용하고 종료할 때 임시 상태를 정리합니다. 실제 인증이나 시장·계좌 자료는 사용하지 않습니다.

### 3. 오류와 빈 결과 구분하기

```sh
node tests/toss-agent-cli.mjs error prices DEMO
echo $?
```

종료 코드는 `1`입니다. stdout의 JSON에서 `status="error"`, `data=[]`, `error.code="PERMISSION_DENIED"`를 확인하세요. stderr에는 합성 표시와 안전한 오류 코드가 나옵니다. 빈 `data`만 보고 정상 빈 결과로 해석하지 마세요. 부분 결과는 별도로 `status="partial"`·종료 코드 `2`를 사용합니다.

이 연습은 로컬 CLI 연결과 출력 형식을 확인합니다. 빈 부분 페이지의 후속 조회·계좌 자료·소비 예시로 이어가려면 [에이전트 지침](toss-agent-usage.md)을 읽으세요. 실제 공급자 연결을 확인한 결과와는 구분하세요.

## 실제 조회 준비하기

[접근 준비 기록](toss-access-readiness.md)의 사용자 재결정과 남은 미확인을 먼저 확인하세요. 실제 인증·보관 위치·계좌 선택·자료 전달은 해당 작업의 승인 범위가 필요합니다. 비밀값·계좌 식별자를 대화·명령 인수·공유 로그에 붙여 넣지 마세요.

승인된 기존 실행기와 보호 상태를 사용해 [CLI 레퍼런스](toss-cli.md)의 필요한 명령을 실행하세요. `.env`는 자동으로 읽지 않습니다. 상태·커서·미확인·자료 시점의 의미는 명령별 계약을 따릅니다. 주어진 부분 결과를 전체 이력이나 거래 가능의 보장으로 해석하지 마세요.

## 변경 후 로컬 검사하기

[개발 안내의 로컬 검사](development.md#로컬-검사)에 따라 형식·린트·타입 검사와 전체 테스트를 실행하세요. 문서 수정은 [문서 검사](development.md#커밋푸시-검사)로 지정한 파일의 공백·로컬 링크·제목 앵커를 확인하세요. 합성 검사와 실제 토스 호출 성공을 구분하며 Actions는 비활성 상태로 유지합니다.

기존 KIS·구독·추천 명령의 안내는 [과거 제품 기록](README.md#과거-제품-기록)이며 현재 체크아웃에서 실행할 수 없습니다.
