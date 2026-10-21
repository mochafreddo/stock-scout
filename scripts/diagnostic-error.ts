type DiagnosticReason =
  | 'RANKING_INCOMPLETE'
  | 'IDENTITY_AMBIGUOUS'
  | 'SENSITIVE_OUTPUT'
  | 'siwc_refresh_not_allowed'
  | 'siwc_relogin_required';

export class DiagnosticError extends Error {
  readonly reason: DiagnosticReason;

  constructor(reason: DiagnosticReason, code: string = reason) {
    super(code);
    this.reason = reason;
  }
}
