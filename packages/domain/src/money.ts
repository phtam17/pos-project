import { DomainValidationError } from "./errors.js";

export interface SerializedMoney {
  readonly minorUnits: string;
  readonly currency: string;
}

const ISO_CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * An immutable monetary value. Amounts are always represented in integer minor
 * units; floating point input is intentionally unsupported.
 */
export class Money {
  readonly minorUnits: bigint;
  readonly currency: string;

  constructor(minorUnits: bigint, currency: string) {
    if (typeof minorUnits !== "bigint") {
      throw new DomainValidationError(
        "Money minorUnits must be a bigint",
        "INVALID_MONEY_AMOUNT",
      );
    }
    const normalizedCurrency = currency.trim().toUpperCase();
    if (!ISO_CURRENCY_PATTERN.test(normalizedCurrency)) {
      throw new DomainValidationError(
        "Money currency must be a three-letter ISO 4217 code",
        "INVALID_CURRENCY",
      );
    }

    this.minorUnits = minorUnits;
    this.currency = normalizedCurrency;
    Object.freeze(this);
  }

  static fromMinor(minorUnits: bigint, currency: string): Money {
    return new Money(minorUnits, currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, currency);
  }

  static fromJSON(value: SerializedMoney): Money {
    if (!/^-?\d+$/.test(value.minorUnits)) {
      throw new DomainValidationError(
        "Serialized money minorUnits must be an integer string",
        "INVALID_MONEY_AMOUNT",
      );
    }
    return new Money(BigInt(value.minorUnits), value.currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  multiply(multiplier: number | bigint): Money {
    const asBigInt =
      typeof multiplier === "bigint"
        ? multiplier
        : Number.isSafeInteger(multiplier)
          ? BigInt(multiplier)
          : undefined;
    if (asBigInt === undefined) {
      throw new DomainValidationError(
        "Money multiplier must be a safe integer or bigint",
        "INVALID_MULTIPLIER",
      );
    }
    return new Money(this.minorUnits * asBigInt, this.currency);
  }

  /** Calculates basis points using half-up rounding for non-negative values. */
  percentageBasisPoints(basisPoints: number): Money {
    if (!Number.isSafeInteger(basisPoints) || basisPoints < 0) {
      throw new DomainValidationError(
        "basisPoints must be a non-negative safe integer",
        "INVALID_BASIS_POINTS",
      );
    }
    const numerator = this.minorUnits * BigInt(basisPoints);
    const rounded =
      numerator >= 0n
        ? (numerator + 5_000n) / 10_000n
        : (numerator - 5_000n) / 10_000n;
    return new Money(rounded, this.currency);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits
      ? -1
      : this.minorUnits > other.minorUnits
        ? 1
        : 0;
  }

  toJSON(): SerializedMoney {
    return Object.freeze({
      minorUnits: this.minorUnits.toString(),
      currency: this.currency,
    });
  }

  assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainValidationError(
        `Currency mismatch: ${this.currency} and ${other.currency}`,
        "CURRENCY_MISMATCH",
      );
    }
  }
}
