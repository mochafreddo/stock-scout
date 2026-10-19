# 대체 공식 종목 유형 출처 조사

2026-10-19 [#250](https://github.com/mochafreddo/stock-scout/issues/250)의 [추가 설계 합의](security-type-probe-design.md#수집-경로-채택-보류-이후의-설계-인터뷰)에 따라 고정한 세 경로를 한 차례 평가했다. 무료·무로그인 반복 자동 수집의 근거를 먼저 확인하고, 조건이 확인된 경로만 표본 자료를 받는 순서다. [기존 조사](official-security-type-validation.md)와 [ADR 0005](adr/0005-official-security-type-sources.md)의 증권 연결·기초 권리·현재성 조건을 유지한다.

기존 보고서와 공식 안내를 바탕으로 거래소 목록인 Cboe를 우선 경로로, ADR 권리 보완 가능성이 있는 예탁기관 BNY·Citi를 나머지 두 경로로 고정했다. 아래 순서로 접근·자동 이용 조건을 확인했으며, 실패한 경로를 다른 후보로 교체하지 않았다.

**세 경로 모두 채택 보류다. 이번 범위에서 반복 자동 이용이 가능한 운영 출처는 확보하지 못했다.** 접근 가능한 웹페이지나 자동 다운로드 안내만으로 유형 검증을 위한 지속 이용까지 허용됐다고 확정하지 않았다. 이 판정은 이번 프로젝트의 채택 판단이며 영구적인 이용 불가나 포괄적인 법률 판단이 아니다. 후보를 교체하거나 추가 탐색하지 않고 미해결 조건을 다음 결정으로 남긴다.

| 경로 | 정책 단계의 결과 | 재개 조건 |
| --- | --- | --- |
| Cboe US Equities Symbols Traded/reference | 자동 다운로드 안내와 일반 이용 제한의 적용 관계 미해결 | 이 파일의 개인 비상업 반복 수집·증권 유형 검증에 적용되는 공식 허용 범위 확인 |
| BNY DR Directory | 연결된 약관의 자동 검색·복사 제한과 별도 허용 관계 미확인 | 해당 directory의 자동 이용 허용과 필요한 식별 자료의 사용 권한 확인 |
| Citi Global DR Directory | 연결 약관의 데이터 스크래핑 등 무단 이용 제한과 별도 허용 관계 미확인 | directory의 반복 자동 수집·이용에 적용되는 공식 허용 범위 확인 |

## Cboe US Equities Symbols Traded/reference

[2024년 URL 변경 공지](https://cdn.cboe.com/resources/release_notes/2024/Cboe-Updates-Options-Symbol-Reference-and-Equities-Symbols-Traded-File-URLs.pdf)의 Technical Details와 US Equities Links는 자동 다운로드 사용자를 언급하고 BZX·BYX·EDGA·EDGX의 CSV/XML 주소를 안내한다. 같은 파일의 형식·시장별 주소를 별도 후보로 세지 않았다. 옵션용 Symbol Reference를 미국 주식 유형 자료로 혼동하지 않는다.

홈페이지에서 연결한 [이용 조건](https://www.cboe.com/terms) §1은 별도 조건의 우선을 안내한다. §2는 개인 비상업 용도의 사본 다운로드와 그 밖의 저장·다른 자료 검증 등의 이용을 구분한다. 자동 다운로드 공지가 이 프로젝트의 반복 유형 검증에 대한 별도 허용인지 확인하지 못했다. 데이터 CSV/XML은 요청하지 않았으며 실제 필드·표본·현재성·무료 운영 범위는 미검증이다. 기술적으로 자동 다운로드를 예상한다는 사실을 무시하지 않되, 사용 목적의 적용 관계가 해소될 때까지 보류한다.

## BNY DR Directory

[BNY DR 홈페이지](https://www.adrbny.com/)는 DR Directory와 종료 프로그램·기업행동 경로를 제공하며 [Terms of Use](https://www.bny.com/corporate/global/en/terms-of-use.html)를 연결한다. 연결된 약관의 Authorized Use; Intellectual Property 절은 별도 명시나 서면 허용 외 자동 장치·시스템의 검색·감시·복사를 제한한다. directory에 적용되는 별도 허용을 확보하지 못했다.

홈페이지의 CUSIP Disclaimer는 청산·결제 외 해당 자료 이용에 별도 라이선스와 요금이 필요하다고 안내한다. 이를 모든 비CUSIP 자료의 유료 조건으로 확대하지 않지만, 식별자와 관련 설명을 자유롭게 사용할 수 있다는 가정도 두지 않는다. 같은 페이지는 정확성·적시성·완전성과 갱신 의무를 보장하지 않는다. Directory 검색·다운로드·개별 프로그램 조회를 하지 않았다. BBD/BBDO·TSM의 기초 권리, 비CUSIP 식별 경로와 변경 반영 범위는 미검증이다.

## Citi Global DR Directory

[공식 검색 화면](https://depositaryreceipts.citi.com/adr/guides/uig.aspx?pageId=8&subpageid=34)은 회사·티커·CUSIP 검색과 프로그램 상태·적용일·거래소·예탁기관·DR/기초 주식 식별자 필터를 표시한다. 검색 항목이 있다는 사실은 실제 응답의 권리 필드나 현재성 보장을 뜻하지 않는다. 공개 화면을 읽은 결과와 반복 자동 수집 허용을 구분한다.

검색 화면 HTML이 지정한 footer 소스를 실행하지 않고 읽어 [공식 이용 조건](https://www.citigroup.com/global/terms) 링크를 확인했다. Copyrights는 명시된 예외와 사전 서면 동의 없이 복사·저장·후속 이용 등을 제한하며, Use of Information and Materials는 데이터 스크래핑을 포함한 무단 이용을 금지한다. 이 directory의 반복 자동 이용을 허용하는 별도 근거는 확보하지 못했다. 기초 주식 식별자의 존재만으로 BBD/BBDO의 보통주·우선주 권리를 판정하지 않는다.

루트 HTML의 이동 목적지는 다른 호스트로 연결되어 직접 수집기가 HTTP 302로 중단했고, 웹 추출은 콘텐츠 화면을 반환했다. 이는 directory 데이터의 부재나 수집 성공을 뜻하지 않는다. 정책 링크를 찾기 위해 검색 화면·footer·약관만 직접 수집했으며 검색 제출·목록 다운로드·표본 상세 조회는 하지 않았다. 재개에는 directory의 반복 자동 수집·이용에 적용되는 공식 허용 범위 확인이 필요하다.

## 증거와 검증의 한계

[선별 근거](evidence/issue-250/alternative-sources.json)는 확인한 URL·수단·문서 절, 수집 실행 여부, 보류 사유와 재개 조건을 기록한다. 정책·공지를 웹 본문/PDF 텍스트 추출로 읽은 결과와 익명 HTTPS 수집기의 HTTP 결과를 구분한다. 원본은 접근을 제한한 임시 기록으로 보존하며 전체 HTML·목록·식별자 데이터는 이 저장소에 추가하지 않는다. 웹 추출 결과에 HTTP 상태·본문 해시를 만들어 붙이지 않으며 HTTP Date를 자료 기준일로 해석하지 않는다.

조건을 통과한 경로가 없어 표본 대응은 실행하지 않았다. BBD/BBDO·TSM의 ADR 기초 권리, ACONW/ADSEW의 워런트, SPY/VXX의 ETF·ETN 구분, AAPL·SHOP·GOOG/GOOGL의 별도 주식 종류와 BAC/B·BAC/L의 연결을 새 출처로 확인하지 못했다. 정상 조회에서 표본이 없었다는 결과도 아니며, 기존 판정을 바꾸거나 모든 종목을 미확인으로 제외해 성공한 것으로 처리하지 않는다.

이 한정 조사는 부정적 결과까지 기록한 단계다. #250의 실제 적격 보통주·ADR 자동 확인과 #243·#239·#245 및 후속 추천의 차단은 유지한다. 새 파서·분류기·테스트나 운영값을 만들지 않았으며 KIS 호출·인증 변경·로그인·공급자 문의·접근 제한 우회를 하지 않았다. 정책 조건을 다시 논의하기 전에는 같은 요청을 반복하거나 출처를 계속 추가하지 않는다.
