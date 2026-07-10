import { DomainValidationError } from "./errors.js";

export function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new DomainValidationError(`${field} must not be empty`, "EMPTY_FIELD");
  }
  return normalized;
}

export function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainValidationError(
      `${field} must be a non-negative safe integer`,
      "INVALID_INTEGER",
    );
  }
  return value;
}

export function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DomainValidationError(
      `${field} must be a positive safe integer`,
      "INVALID_INTEGER",
    );
  }
  return value;
}

export function copyDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new DomainValidationError(`${field} must be a valid Date`, "INVALID_DATE");
  }
  return new Date(value.getTime());
}

export function readonlyMetadata(
  value: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...value });
}
