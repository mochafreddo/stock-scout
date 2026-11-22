# 주문 검토 카드에 선택한 상장 종목을 보존한다

`stock`에서 같은 심볼의 미국 상장 종목을 구별해 선택해도 주문 초안에 심볼과 `market=US`만 남으면 검토 카드로 두 선택을 구별할 수 없다. 호출자는 `stock`에서 선택한 상장 시장과 확인 가능한 ISIN을 초안에 전달하고, 에이전트는 그 값을 카드에 표시한다. 초안 검증은 [ADR 0022](0022-offline-order-draft-validation.md)에 따라 호출자가 제공한 자료로 오프라인에서 수행한다.

`market=US`와 `draftVersion=1`을 유지하고, 기존 입력도 계속 읽을 수 있게 한다. 상장 시장이 빠진 초안은 선택한 종목을 확인할 때까지 카드 표시를 보류한다. ISIN이 없으면 심볼과 상장 시장만으로 대상을 구별할 수 있는지 확인한다. 토스 앱에서 같은 종목인지 최종 확인하고 주문을 제출하는 사람은 사용자다.

이 결정은 2026-11-21에 합의한 설계다. 검토 기준은 `4e4988d29b456f9be71b4d37748cfddcb375e398`이다. 구현은 [PR #347](https://github.com/mochafreddo/stock-scout/pull/347)로 반영했다. 합성 CLI와 카드 예제의 검증 결과는 [#344](https://github.com/mochafreddo/stock-scout/issues/344)에 기록했다.
