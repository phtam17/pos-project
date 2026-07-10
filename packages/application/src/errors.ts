export class ApplicationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number = 400
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}

export function notFound(entity: string, id: string): ApplicationError {
  return new ApplicationError(`${entity} ${id} was not found`, "NOT_FOUND", 404);
}
