import { Money } from "@pos/domain";

const typeKey = "__variPosType";
const legacyTypeKey = "__openPosType";

type Rehydrator<T> = { rehydrate(snapshot: never): T };

export function encodeAggregate(value: { toSnapshot(): unknown }): unknown {
  return encodeValue(value.toSnapshot());
}

export function decodeAggregate<T>(
  encoded: unknown,
  rehydrator: Rehydrator<T>
): T {
  return rehydrator.rehydrate(decodeValue(encoded) as never);
}

function encodeValue(value: unknown): unknown {
  if (value instanceof Money) {
    return {
      [typeKey]: "Money",
      minorUnits: value.minorUnits.toString(),
      currency: value.currency
    };
  }
  if (value instanceof Date) {
    return { [typeKey]: "Date", value: value.toISOString() };
  }
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, encodeValue(child)])
    );
  }
  if (typeof value === "bigint") return { [typeKey]: "BigInt", value: value.toString() };
  return value;
}

function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const encodedType = record[typeKey] ?? record[legacyTypeKey];
  if (encodedType === "Money") {
    if (typeof record.minorUnits !== "string" || typeof record.currency !== "string") {
      throw new TypeError("Invalid Money value in persisted snapshot");
    }
    return Money.fromMinor(BigInt(record.minorUnits), record.currency);
  }
  if (encodedType === "Date") {
    if (typeof record.value !== "string") {
      throw new TypeError("Invalid Date value in persisted snapshot");
    }
    const date = new Date(record.value);
    if (Number.isNaN(date.getTime())) throw new TypeError("Invalid persisted Date");
    return date;
  }
  if (encodedType === "BigInt") {
    if (typeof record.value !== "string") {
      throw new TypeError("Invalid bigint value in persisted snapshot");
    }
    return BigInt(record.value);
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, decodeValue(child)])
  );
}
