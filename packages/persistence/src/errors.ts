export class PersistenceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "PersistenceError";
  }
}

export class RepositoryConflictError extends PersistenceError {
  constructor(entity: string, id: string, options?: ErrorOptions) {
    super(`${entity} ${id} already exists or has changed`, "REPOSITORY_CONFLICT", options);
    this.name = "RepositoryConflictError";
  }
}

export class RepositoryNotFoundError extends PersistenceError {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} was not found`, "REPOSITORY_NOT_FOUND");
    this.name = "RepositoryNotFoundError";
  }
}

export class IdempotencyConflictError extends PersistenceError {
  constructor(scope: string, key: string) {
    super(
      `Idempotency key ${scope}/${key} was reused with a different request`,
      "IDEMPOTENCY_CONFLICT"
    );
    this.name = "IdempotencyConflictError";
  }
}
