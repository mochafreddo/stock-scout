# KIS 관측 CLI 레퍼런스

이 문서는 현재 [scripts/kis-probe.ts](../scripts/kis-probe.ts)의 외부 입출력을 설명한다. 실행 절차는 [시작 안내](getting-started.md), 실제 자료의 해석 한계는 [KIS 데이터 검증](kis-data-validation.md)에 있다. 자동 발급·보호된 캐시 재사용 정책과 복구 절차는 [KIS 인증과 복구](kis-auth.md)에 있다.

## 실행 구문과 입력

```text
node scripts/kis-probe.ts <volume|amount> <NAS|NYS|AMS>
node scripts/kis-probe.ts <daily|info> <NAS|NYS|AMS> <symbol>
```

별도 옵션이나 `--help`는 없다. 모드와 거래소는 표기한 대소문자를 그대로 사용한다. `volume/amount`의 세 번째 인수는 생략하거나 빈 문자열이어야 하며 `daily/info`는 종목이 필수다. 종목 문자열은 정규식 `^[A-Z0-9./^-]{1,20}$`에 맞아야 한다. 이 검사는 존재하는 증권이나 유형을 확인하는 절차가 아니다. 세 번째 위치 인수 뒤의 추가 인수는 거부한다.

예시는 `node scripts/kis-probe.ts info NYS BAC/B`다. OTC는 지원하지 않는다. Node.js 요구 버전과 개발 명령은 [package.json](../package.json)이 기준이다.

| 환경 변수 | 처리 |
| --- | --- |
| `KIS_APP_KEY` | 필수. 요청의 `appkey` 헤더에 사용한다. |
| `KIS_APP_SECRET` | 필수. 요청의 `appsecret` 헤더에 사용한다. |

두 값은 프로세스 환경에서 읽으며 누락 또는 빈 문자열이면 실패한다. 사전 발급 토큰 환경 변수는 사용하지 않는다. `.env`는 자동으로 읽지 않는다. 승인된 캐시를 검사하고 필요한 경우 공식 발급 API로 토큰을 확보한 뒤 조회한다. 입력 인수 검사 뒤에 환경 변수를 검사한다. 계좌번호나 OpenAI 인증은 사용하지 않는다.

따라서 잘못된 인수와 인증 누락이 함께 있으면 `USAGE`가 먼저 발생하며 요청을 보내지 않는다. 유효한 인수에서 인증만 누락되면 `CREDENTIALS_MISSING`으로 끝나며 요청을 보내지 않는다. 인증 없는 실행 예시는 [시작 안내의 모의 관측](getting-started.md#인증-없이-관측-json-확인하기)에 있다.

## 요청과 제한

대상은 `https://openapi.koreainvestment.com:9443`의 운영 API다. 시세 요청에 `custtype=P`를 사용하며 리디렉션은 거부한다. 아래 경로 앞에는 `/uapi/`가 붙는다.

| 모드 | 경로 | `tr_id` | 쿼리 조건 |
| --- | --- | --- | --- |
| `volume` | `overseas-stock/v1/ranking/trade-vol` | `HHDFS76310010` | `EXCD=<exchange>`, `NDAY=0`, `VOL_RANG=0`; `KEYB/AUTH/PRC1/PRC2`는 빈 문자열 |
| `amount` | `overseas-stock/v1/ranking/trade-pbmn` | `HHDFS76320010` | `volume`과 같은 조건 |
| `daily` | `overseas-price/v1/quotations/dailyprice` | `HHDFS76240000` | `EXCD=<exchange>`, `SYMB=<symbol>`, `GUBN=0`, `MODP=0`; `AUTH/BYMD`는 빈 문자열 |
| `info` | `overseas-price/v1/quotations/search-info` | `CTPF1702R` | `PDNO=<symbol>`; `PRDT_TYPE_CD`는 NAS `512`, NYS `513`, AMS `529` |

시세 조회는 기본 한 번이며 조회 오류에 구조화된 `EGW00123`이 명시된 경우에만 한 번 복구·재조회한다. 유효한 캐시가 없으면 제한을 지켜 POST `/oauth2/tokenP` 발급 요청을 먼저 보낸다. 복구에도 공통 잠금·300초 발급 간격·안전한 저장을 적용하며, 다른 실행이 이미 갱신한 유효한 토큰은 발급 없이 재사용한다. 조회 전 인증 실패나 복구 중 발급 제한·잠금·무효화·저장 실패에서는 다음 시세 요청을 보내지 않는다. 두 번째 만료는 일치하는 캐시를 무효화한 뒤 추가 발급 없이 실패한다. `AbortSignal.timeout(15_000)`을 각 요청에 적용하지만 프로세스 전체의 완료 시간을 보장하는 별도 제한은 없다. 페이지 이어받기·거래 일정 검사는 없다. 반환 행 수 1000 초과는 거부한다. 이는 관측 도구의 방어 조건이며 KIS의 페이지 크기나 운영 호출 한도를 뜻하지 않는다.

## 성공 출력

stdout에 JSON 객체 하나와 줄바꿈을 출력하고 종료 코드 0으로 끝난다. KIS 성공 코드 `rt_cd`가 문자열 `"0"`이고 선택에 필요한 응답 구조가 유효해야 한다. 데이터 의미나 필수 시장 필드가 검증됐다는 뜻은 아니다.

| 항목 | JSON 타입 | 의미 |
| --- | --- | --- |
| `requestedAt`, `receivedAt` | string | 첫 조회 요청 직전·최종 성공 응답 처리 중에 기록한 UTC ISO 시각. 복구가 있으면 그 구간을 포함하며 데이터 기준 세션과 다르다. |
| `request` | object | `path`·`trId` 문자열과 `params` 문자열 값 객체. 인증 헤더는 포함하지 않는다. |
| `source` | string | 구현에 고정된 KIS 공식 예제 커밋의 URL. 서비스 계약 전체의 입증을 뜻하지 않는다. |
| `validation` | string | 항상 `unverified` |
| `dataSession` | null | 항상 `null` |
| `scope` | string | 항상 `one-page observation; not a candidate universe or verified premarket session` |
| `continuation` | string | 응답의 `tr_cont`. 없으면 빈 문자열. 허용값은 빈 문자열·`D`·`E`·`F`·`M`이다. 의미를 판정하거나 후속 요청을 보내지 않는다. |
| `rowCount` | number | `rows`의 길이. 순위·일별은 빈 배열도 허용하고 종목 정보는 정상 구조일 때 1이다. |
| `summary` | object | 순위·일별의 `output1`에서 선택한 필드. `info`는 항상 빈 객체다. |
| `rows` | object[] | 순위·일별의 `output2` 또는 `info`의 `output` 한 개에서 선택한 필드 |

필드 선택은 아래 허용 목록에서 **값이 문자열인 항목만** 보존한다. 숫자 타입·null·누락 값은 생략하며 문자열 숫자를 변환하거나 단위·유형으로 해석하지 않는다. 허용 필드가 전혀 없는 객체도 빈 객체로 남을 수 있다. 선택 대상이 null·배열·객체 이외의 값이면 실패한다.

순위·일별 응답은 `output2`가 빈 배열이어도 `output1`이 객체여야 한다. `info`는 `output`이 객체여야 하고 `output1`은 읽지 않는다. 필수 시장 필드의 존재를 검사하지 않으므로 `rows: [{}]`도 관측 성공이 될 수 있다. `rowCount`는 유효한 종목이나 분석 가능한 행의 개수가 아니다.

| 위치 | 허용 필드 |
| --- | --- |
| `summary` | `zdiv`, `stat`, `crec`, `trec`, `nrec`, `rsym` |
| `volume/amount`의 `rows` | `rsym`, `excd`, `symb`, `name`, `ename`, `rank`, `last`, `tvol`, `tamt`, `a_tvol`, `a_tamt` |
| `daily`의 `rows` | `xymd`, `open`, `high`, `low`, `clos`, `tvol`, `tamt` |
| `info`의 `rows` | `std_pdno`, `prdt_eng_name`, `natn_cd`, `tr_mket_cd`, `ovrs_excg_cd`, `tr_crcy_cd`, `ovrs_stck_dvsn_cd`, `prdt_clsf_cd`, `prdt_clsf_name`, `prdt_type_cd_2`, `ovrs_item_name`, `sedol_no`, `istt_usge_isin_cd`, `lstg_yn`, `last_rcvg_dtime` |

실제 출력 예시는 저장된 [NAS 거래량 순위](evidence/issue-243/volume-NAS.json), [AAPL 일별 시세](evidence/issue-243/daily-NAS-AAPL.json), [AAPL 종목 정보](evidence/issue-243/info-NAS-AAPL.json)에 있다. 과거의 관측 자료이며 현재 응답이나 검증된 세션을 보장하지 않는다.

## 오류와 종료 코드

실패하면 stdout에 관측 결과를 쓰지 않고 stderr에 다음 형태의 JSON 한 줄을 출력하며 종료 코드는 1이다. 원문 오류·응답 헤더·KIS 메시지는 출력하지 않는다.

```json
{"error":"USAGE"}
```

| 코드 | 발생 조건 |
| --- | --- |
| `USAGE` | 모드·거래소·종목·추가 인수가 입력 조건에 맞지 않음 |
| `CREDENTIALS_MISSING` | 필수 환경 변수가 없거나 빈 문자열임 |
| `AUTH_COOLDOWN` | 초기 대기 또는 발급 제한. `retryAfterSeconds`와 고정 `guidance`를 함께 출력함 |
| `AUTH_LOCKED` | 발급 잠금 충돌. 모든 CLI 종료 확인 후 잠금만 제거하는 `guidance`를 출력함 |
| `AUTH_RECORD` | 손상된 발급 기록. 수동 복구와 새 초기 대기 안내를 출력함 |
| `AUTH_STORAGE` | 캐시 권한·소유자·링크·읽기·안전한 저장 실패 |
| `AUTH_FAILED` | 발급 통신·HTTP·응답·토큰·서버 만료 정보 검증 실패. 복구 발급이 방금 거절된 토큰을 재반환한 경우도 포함함 |
| `HTTP_FAILURE` | HTTP 응답의 `ok`가 false임 |
| `KIS_FAILURE` | 복구 대상이 아닌 KIS 오류, 복구 뒤 다시 발생한 오류 또는 성공 표시와 명시적 만료 코드가 충돌한 응답. `rt_cd` 누락이나 문자열 `"0"` 이외의 값도 포함함 |
| `RESPONSE_SHAPE` | 최상위 또는 선택 대상 객체의 구조가 잘못됨, 순위·일별 행 배열이 아님, 행 수 1000 초과, 연속 조회 표시가 허용값 밖임 |
| `REQUEST_FAILED` | 잘못된 JSON, 통신·시간 제한·리디렉션 등 위 코드로 분류되지 않은 예외 |

오류 코드만으로 토큰 만료·권한·호출 한도 등 KIS 내부 원인을 구분할 수 없다. 빈 응답의 관측 성공도 제품의 [빈 후보군](../GLOSSARY.md) 또는 후보 없음 판정을 뜻하지 않는다.

HTTP 비정상 상태에서도 구조화된 오류 본문을 확인해 명시적 만료만 분류한다. HTTP 상태나 메시지 부분 일치로 만료를 추정하지 않으며, 정상 형태의 데이터가 있는 오류도 성공으로 인정하지 않는다. HTTP 200·`rt_cd: "0"`과 만료 코드가 충돌하면 자동 복구 없이 실패한다. 비정상 HTTP 응답을 만료 복구로 처리할 수 없으면 `HTTP_FAILURE`다. HTTP 성공이어도 잘못된 JSON이면 `REQUEST_FAILED`, JSON의 최상위 값이 배열이나 null이면 `RESPONSE_SHAPE`다. `rt_cd`가 숫자 `0`인 경우도 문자열 `"0"`과 다르므로 성공으로 인정하지 않는다. 인증·응답 오류를 처리한 뒤 행 배열·연속 조회 표시·선택 대상 객체를 검사한다.

## 검증 경계

[CLI 테스트](../tests/kis-probe.test.mjs)는 별도 Node.js 프로세스의 인수·stdout·stderr·종료 코드를 검사하고 [HTTP 모의 코드](../tests/kis-http-mock.mjs)로 외부 통신을 대체한다. 실제 인증·장전 지원 시간·정규장 범위·수치 단위·종목 유형 판별은 이 테스트가 입증하지 않는다. 해당 검증 상태와 공식 자료의 범위는 [KIS 데이터 검증](kis-data-validation.md)에 기록한다.
