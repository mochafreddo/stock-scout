# 토스 현재가 JSON CLI

토스 식별자로 현재가를 개별 조회하는 새 CLI입니다. [#278의 전환 명세](https://github.com/mochafreddo/stock-scout/issues/278)와 [#283의 확정 계약](https://github.com/mochafreddo/stock-scout/issues/283#issuecomment-6686267791)에 따라 외부 에이전트가 분석·추천을 맡고 CLI는 조회·검증·오류 처리를 맡습니다. 기존 KIS·내장 모델 명령은 전환 검증 전까지 유지합니다.

## 명령 발견과 실행

저장소 루트에서 실행하세요. Node 환경 준비는 [시작 안내](getting-started.md)를 따르세요.

```sh
node scripts/toss.ts --help
node scripts/toss.ts prices AAPL
node scripts/toss.ts prices AAPL,MSFT
```

`--help`는 인증 없이 명령 목록을 JSON으로 출력합니다. `prices`는 공식 API의 `symbols` 식별자 1~200개를 쉼표로 받습니다. 각 식별자는 영문 대소문자·숫자·`.`·`-`만 허용하며 빈 항목과 추가 인수는 거부합니다. 티커 검색·시장 추정·KIS 식별자 변환은 수행하지 않습니다. 공급자가 확인한 식별자를 사용하세요. 미국 장중에도 실행할 수 있으며 증권 유형 관문을 두지 않습니다.

실제 토스 조회·인증 설정·자료의 외부 AI 전달은 아직 검증하거나 승인받지 않았습니다. [#284의 허용 범위 조사](https://github.com/mochafreddo/stock-scout/issues/284)에서 남은 조건을 확인하고 별도 승인을 받은 뒤에만 실제 자격 증명을 준비하세요. 원자료뿐 아니라 요약·가공 결과의 전달에도 같은 조건이 적용됩니다. 이 문서의 예시는 합성 자료입니다.

## 보호된 설정과 공통 상태

승인된 저장소 밖의 단일 디렉터리를 `TOSS_STATE_DIR`로 지정하세요. 디렉터리는 현재 사용자 소유의 `0700`, 그 안의 `credentials.json`은 `0600`이어야 합니다. 파일 내용은 `clientId`와 `clientSecret` 문자열입니다. CLI 인수로 자격 증명을 전달하지 마세요. 경로에 심볼릭 링크가 있거나 Git 저장소 안에 있으면 거부합니다. CLI는 설정 파일을 만들거나 자격 증명을 발급하지 않습니다. 실제 경로·자격 증명을 이 문서에 기록하지 마세요.

같은 클라이언트를 사용하는 모든 로컬 실행은 같은 `TOSS_STATE_DIR`를 사용해야 합니다. 별도 디렉터리·다른 프로그램·다른 기기는 이 공통 제한에 포함되지 않습니다. 승인된 위치 외에 실제 자격 증명이나 토큰을 복사하지 마세요.

공통 모듈이 `state.json`·`client.lock`·`issuance.lock`의 쓰기를 소유합니다. 상태 파일에는 자격 증명 지문·토큰·만료 시각·다음 호출 가능 시각·발급 결과 미확인 표시만 저장합니다. 금융 응답은 별도 파일이나 로그에 기본 저장하지 않습니다. 토큰 만료는 발급 시작 시각과 공식 `expires_in` 초로 보수적으로 계산하며 KIS의 KST 해석·5분 제한을 사용하지 않습니다. 잠금 안에서 캐시를 다시 읽고 유효 토큰을 재사용하며, 토큰 발급에는 자동 재시도를 하지 않습니다.

발급 도중 통신·응답·저장 오류가 발생하면 `AUTH_ISSUANCE_UNKNOWN`으로 후속 자동 발급을 막습니다. 강제 종료로 남은 잠금은 자동으로 빼앗지 않고 전체 실행 한도까지 기다립니다. 복구 전 같은 디렉터리를 사용하는 프로세스가 모두 끝났는지 확인하고 공급자 발급 상태와 토큰 교체 영향을 점검하세요. 실행 중 상태·잠금을 삭제하거나 자격 증명 지문을 수동으로 고치지 마세요. 보관 위치나 자격 증명 변경과 미확인 발급의 재시도는 별도 승인·상태 확인 후 진행하세요.

## 응답 계약

2026-11-06 직접 확인한 [공식 OpenAPI](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)의 버전은 `1.2.28`입니다. `latest` 주소는 바뀔 수 있습니다. [공식 개요](https://openapi.tossinvest.com/openapi-docs/overview.md)의 오류와 호출 제한도 적용합니다. 문서 확인은 실제 응답 호환성 검증과 구분합니다.

`GET /api/v1/prices?symbols=...`의 성공 envelope은 `result` 배열입니다. 페이지가 없는 API이므로 임의 페이지·개수 자르기·후속 자동 조회를 추가하지 않습니다.

| 필드 | 공식 계약과 CLI 처리 |
| --- | --- |
| `symbol` | 필수 문자열. 요청한 식별자와 정확히 연결되는 유일한 행만 반환합니다. 요청 밖의 행과 중복 행은 제외합니다. |
| `lastPrice` | 필수 소수 문자열, 최대 30자. 숫자로 바꾸거나 반올림하지 않습니다. `0` 문자열은 유효하며 null·누락·숫자 자료형은 오류입니다. |
| `currency` | 필수 통화 문자열. 공식 값은 `KRW`·`USD`이며 공식 확장 지침에 따라 다른 세 자리 대문자 코드도 원문으로 반환합니다. 서로 다른 통화는 합산하지 않습니다. |
| `timestamp` | 선택 필드이며 문자열 또는 null입니다. 오프셋이 있는 유효한 날짜·시각 문자열을 검사하고 그대로 반환합니다. 생략과 null을 구분하며 조회 시각으로 채우지 않습니다. |

stdout에는 JSON 하나를 출력하고 stderr에는 원자료·자격 증명·공급자 메시지 없는 오류 코드만 출력합니다. 알려진 자격 증명·사용한 토큰이 결과에 나타나면 `SENSITIVE_OUTPUT`으로 자료 출력을 차단합니다. 공급자 추가 필드는 그대로 전달하지 않습니다.

```json
{
  "version": 1,
  "status": "success",
  "data": [{"symbol":"AAPL","lastPrice":"185.7000","currency":"USD","timestamp":null}],
  "omissions": [],
  "source": {
    "provider":"tossinvest",
    "endpoint":"/api/v1/prices",
    "freshness":"unknown",
    "session":"unknown",
    "snapshot":"unknown",
    "priceUnit":"currency_per_security"
  },
  "retrievedAt":"2026-11-06T15:00:00.000Z"
}
```

`retrievedAt`는 CLI가 결과를 만든 시각입니다. 각 행의 `timestamp`와 구분하세요. 가격은 표시한 통화 기준의 증권 단위 가격이며 세션별 원천·지연·실시간성·동일 시점 스냅샷은 미확인으로 둡니다. 완료 정규장의 종가나 주문 체결 보장 가격으로 해석하지 마세요.

| 상태·종료 코드 | 의미 |
| --- | --- |
| `success`·0 | 유효한 응답. 정상 빈 `result: []`도 포함합니다. |
| `partial`·2 | 유효 자료가 남지만 잘못된 행 또는 요청 종목 누락이 있습니다. `omissions`에 원래 행의 0부터 시작하는 `index` 또는 요청 `symbol`과 `reason`을 반환합니다. |
| `error`·1 | 입력·조회 실패 또는 유효 행이 없는 잘못된 응답입니다. `data`는 빈 배열이며 `error.code`로 원인을 구분합니다. |

오류 예시는 `{"version":1,"status":"error","data":[],"error":{"code":"PERMISSION_DENIED","providerCode":"ip-not-allowed","requestId":"SAFE_REQUEST_1"}}`입니다. 실제 출력에는 `source`와 `retrievedAt`도 포함됩니다. 안전한 형식의 공급자 오류 코드·요청 식별자만 보존하며 메시지·오류 상세 자료는 버립니다.

오류 코드는 `INPUT_INVALID`, `AUTH_CONFIG`, `AUTH_STORAGE`, `AUTH_FAILED`, `AUTH_RESPONSE_INVALID`, `AUTH_ISSUANCE_UNKNOWN`, `PERMISSION_DENIED`, `NOT_FOUND`, `UNSUPPORTED`, `RESPONSE_INVALID`, `RATE_LIMIT`, `NETWORK_ERROR`, `UPSTREAM_ERROR`, `REQUEST_LIMIT`, `TIMEOUT`, `INTERRUPTED`, `SENSITIVE_OUTPUT`, `INTERNAL_ERROR`입니다. 인증·권한·미지원·한도 오류는 정상 빈 결과로 바꾸지 않습니다.

## 실행 한도와 재시도

실행 전체는 최대 60초·HTTP 전송 10회, 요청 하나는 응답 본문 수신까지 최대 15초입니다. 인증·재시도는 전송 수에, 잠금·간격·재시도 대기는 전체 시간에 포함하며 남은 시간보다 긴 대기는 시작하지 않습니다. 응답 본문은 최대 1 MiB로 제한합니다. SIGINT·SIGTERM은 안전한 중단 결과로 처리하고 소유한 잠금을 해제합니다. 강제 종료는 이 보장을 적용할 수 없습니다.

같은 디렉터리를 사용하는 프로세스는 인증과 조회를 합쳐 최소 1초 간격으로 전송을 예약합니다. `Retry-After`와 `X-RateLimit-Reset`의 초 값이 더 긴 대기를 요구하면 공통 상태에 반영합니다. 시간이 부족하면 종료합니다. 다른 실행에서 받은 제한도 이후 예약에 적용됩니다.

조회 중 `401 expired-token`에만 한 번 복구하며 다른 프로세스의 교체 토큰을 먼저 사용합니다. `invalid-token`·권한 오류는 재발급하지 않습니다. 일시 통신 오류·5xx·429에는 한 번 재시도합니다. 만료 복구와 일시 오류를 합쳐 조회는 최대 세 번 전송합니다. 현재가 한 번의 경로는 인증을 포함해 최대 다섯 번이므로 공통 HTTP 10회 상한에 먼저 도달하지 않습니다. 시간 초과·잘못된 성공 응답·토큰 발급의 불명확한 결과는 자동 반복하지 않습니다.

## 합성 검사와 후속 확장

```sh
node --test tests/toss.test.mjs
npm run typecheck
```

공개 검증 경계는 실제 CLI 인수·stdout JSON·stderr·종료 코드·외부 HTTP입니다. `tests/toss-cli-helper.mjs`의 `fixture`와 `runCli`는 보호된 합성 설정 및 하위 프로세스를 만들며, `tests/toss-http-mock.mjs`는 네트워크·시계만 대체합니다. 후속 티켓은 이 도우미에 HTTP 시나리오를 추가하고 명령별 소비자 출력을 검사하세요. 서로 독립적인 인증·시계 도우미를 다시 만들지 마세요. 실제 프로세스 경합 검사는 실제 시계를 사용합니다.

`scripts/toss.ts`가 명령 선택·입력·명령별 응답 검증·JSON 출력을 소유합니다. `scripts/toss-client.ts`의 `TossClient.get`이 읽기 전송·공통 인증·잠금·시간 및 호출 제한을 소유합니다. 후속 조회는 같은 클라이언트 인스턴스를 재사용하고 공통 상태에 직접 쓰지 마세요. 인증 외의 POST·주문 변경 경로는 추가하지 마세요. 페이지·계좌·추가 명령의 의미 계약은 각 티켓에서 공식 스키마와 대조하세요.

이번 검증은 합성 자료에 한정합니다. 실제 토스 조회, 실제 자격 증명 설정, 실제 자료 전달 허용, 공급자의 조회 전용 권한, Codex·Dot 각각의 연결과 전체 전환 완료는 별도 관문입니다. 기존 KIS·내장 모델 테스트는 기존 경로의 회귀 확인이며 새 토스 호환성의 근거가 아닙니다.
