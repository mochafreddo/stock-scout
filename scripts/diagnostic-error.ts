type DiagnosticReason =
  | 'unknown'
  | 'missing_required_field'
  | 'unobserved_source'
  | 'unknown_evidence_id'
  | 'cross_security_evidence'
  | 'RANKING_INCOMPLETE'
  | 'IDENTITY_AMBIGUOUS'
  | 'SENSITIVE_OUTPUT'
  | 'AUTH_FAILED'
  | 'MODEL_LIMIT'
  | 'MODEL_INCOMPLETE'
  | 'SEARCH_FAILED'
  | 'SEARCH_UNSUPPORTED'
  | 'SUBSCRIPTION_LIMIT'
  | 'PAID_BUDGET_UNPROVABLE'
  | 'siwc_refresh_not_allowed'
  | 'siwc_relogin_required';

type ResponseLocation =
  | `evidence[${number}]`
  | `evidence[${number}].${'exchange' | 'symbol' | 'sourceId' | 'excerpt' | 'identityLink' | 'asOf' | 'effectiveDate' | 'subsequentChanges' | 'currentness'}`
  | `judgments[${number}]`
  | `judgments[${number}].${'exchange' | 'symbol' | 'type' | 'identity' | 'applicable' | 'reason' | 'evidence'}`
  | `judgments[${number}].evidence[${number}]`;

export class DiagnosticError extends Error {
  readonly reason: DiagnosticReason;
  readonly location: ResponseLocation | null;

  constructor(
    reason: DiagnosticReason,
    code: string = reason,
    location: ResponseLocation | null = null,
  ) {
    super(code);
    this.reason = reason;
    this.location = location;
  }
}
