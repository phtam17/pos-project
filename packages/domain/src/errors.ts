export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export class DomainValidationError extends DomainError {
  constructor(message: string, code = "DOMAIN_VALIDATION_ERROR") {
    super(message, code);
    this.name = "DomainValidationError";
  }
}

export class InvalidStateTransitionError extends DomainError {
  constructor(aggregate: string, from: string, to: string) {
    super(
      `${aggregate} cannot transition from ${from} to ${to}`,
      "INVALID_STATE_TRANSITION",
    );
    this.name = "InvalidStateTransitionError";
  }
}
