import { SensitiveCardDataError } from "@pos/payment-contract";

const SENSITIVE_KEY_NAMES = new Set([
  "pan",
  "cardnumber",
  "primaryaccountnumber",
  "cvv",
  "cvc",
  "cid",
  "cardsecuritycode",
  "securitycode",
  "track",
  "track1",
  "track2",
  "trackdata",
  "magstripe",
  "pin",
  "pinblock",
  "emv",
  "emvdata",
  "cryptogram",
  "iccdata",
]);

const PAN_CANDIDATE = /(?<!\d)\d{12,19}(?!\d)/g;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Runtime guard for callers that evade the TypeScript contract. It rejects
 * known sensitive field names and Luhn-valid PAN-like strings anywhere in a
 * request, including metadata.
 */
export function assertNoSensitiveCardData(value: unknown): void {
  inspect(value, new WeakSet<object>());
}

function inspect(value: unknown, seen: WeakSet<object>): void {
  if (typeof value === "string") {
    // A UUID can legitimately end in 12 numeric characters and randomly pass
    // Luhn. Only exempt the complete standards-shaped identifier; PAN-like
    // digit sequences in every other string remain rejected.
    if (CANONICAL_UUID.test(value)) {
      return;
    }
    for (const candidate of value.matchAll(PAN_CANDIDATE)) {
      const digits = candidate[0];
      if (passesLuhn(digits)) {
        throw new SensitiveCardDataError(
          "A PAN-like value was supplied; card data must be collected by the certified reader",
        );
      }
    }
    return;
  }

  if (value === null || typeof value !== "object" || value instanceof Date) {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      inspect(item, seen);
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
    if (SENSITIVE_KEY_NAMES.has(normalizedKey)) {
      throw new SensitiveCardDataError(
        `Sensitive card field '${key}' is not accepted by this adapter`,
      );
    }
    inspect(child, seen);
  }
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const code = digits.charCodeAt(index) - 48;
    let digit = code;
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}
