import { DomainValidationError } from "./errors.js";
import { Money } from "./money.js";
import { copyDate, requireNonEmpty } from "./validation.js";

export interface MerchantSettingsSnapshot {
  readonly id: string;
  readonly merchantName: string;
  readonly locationName: string;
  readonly registerName: string;
  readonly currency: string;
  readonly receiptHeader: string;
  readonly receiptFooter: string;
  readonly showSkuOnReceipt: boolean;
  readonly discountsEnabled: boolean;
  readonly tipsEnabled: boolean;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MerchantSettingsInput {
  readonly id?: string;
  readonly merchantName: string;
  readonly locationName: string;
  readonly registerName: string;
  readonly currency: string;
  readonly receiptHeader?: string;
  readonly receiptFooter?: string;
  readonly showSkuOnReceipt?: boolean;
  readonly discountsEnabled?: boolean;
  readonly tipsEnabled?: boolean;
  readonly version?: number;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export type MerchantSettingsChanges = Omit<
  MerchantSettingsInput,
  "id" | "version" | "createdAt" | "updatedAt"
>;

export class MerchantSettings implements MerchantSettingsSnapshot {
  readonly id: string;
  readonly merchantName: string;
  readonly locationName: string;
  readonly registerName: string;
  readonly currency: string;
  readonly receiptHeader: string;
  readonly receiptFooter: string;
  readonly showSkuOnReceipt: boolean;
  readonly discountsEnabled: boolean;
  readonly tipsEnabled: boolean;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  constructor(input: MerchantSettingsInput) {
    this.id = requireNonEmpty(input.id ?? "default", "merchantSettings.id");
    this.merchantName = boundedText(input.merchantName, "merchantSettings.merchantName", 120);
    this.locationName = boundedText(input.locationName, "merchantSettings.locationName", 120);
    this.registerName = boundedText(input.registerName, "merchantSettings.registerName", 120);
    this.currency = Money.zero(input.currency).currency;
    this.receiptHeader = optionalBoundedText(input.receiptHeader ?? "", "merchantSettings.receiptHeader", 240);
    this.receiptFooter = optionalBoundedText(
      input.receiptFooter ?? "Thank you for your purchase.",
      "merchantSettings.receiptFooter",
      240
    );
    this.showSkuOnReceipt = input.showSkuOnReceipt ?? true;
    this.discountsEnabled = input.discountsEnabled ?? true;
    this.tipsEnabled = input.tipsEnabled ?? true;
    const version = input.version ?? 1;
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw new DomainValidationError(
        "merchantSettings.version must be a positive safe integer",
        "INVALID_MERCHANT_SETTINGS_VERSION"
      );
    }
    this.version = version;
    const createdAt = copyDate(input.createdAt ?? new Date(), "merchantSettings.createdAt");
    const updatedAt = copyDate(input.updatedAt ?? createdAt, "merchantSettings.updatedAt");
    if (updatedAt < createdAt) {
      throw new DomainValidationError(
        "merchantSettings.updatedAt cannot be before createdAt",
        "INVALID_MERCHANT_SETTINGS_TIMESTAMP"
      );
    }
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    Object.freeze(this);
  }

  static defaults(at: Date = new Date()): MerchantSettings {
    return new MerchantSettings({
      merchantName: "VariPOS",
      locationName: "Downtown",
      registerName: "Register 01",
      currency: "USD",
      receiptHeader: "Sandbox demonstration",
      receiptFooter: "Thank you for your purchase.",
      createdAt: at,
      updatedAt: at
    });
  }

  static rehydrate(snapshot: MerchantSettingsSnapshot): MerchantSettings {
    return new MerchantSettings(snapshot);
  }

  withChanges(changes: MerchantSettingsChanges, at: Date = new Date()): MerchantSettings {
    return new MerchantSettings({
      id: this.id,
      ...changes,
      version: this.version + 1,
      createdAt: this.createdAt,
      updatedAt: at
    });
  }

  toSnapshot(): MerchantSettingsSnapshot {
    return Object.freeze({
      id: this.id,
      merchantName: this.merchantName,
      locationName: this.locationName,
      registerName: this.registerName,
      currency: this.currency,
      receiptHeader: this.receiptHeader,
      receiptFooter: this.receiptFooter,
      showSkuOnReceipt: this.showSkuOnReceipt,
      discountsEnabled: this.discountsEnabled,
      tipsEnabled: this.tipsEnabled,
      version: this.version,
      createdAt: new Date(this.createdAt),
      updatedAt: new Date(this.updatedAt)
    });
  }
}

function boundedText(value: string, field: string, maximum: number): string {
  const normalized = requireNonEmpty(value, field);
  if (normalized.length > maximum) {
    throw new DomainValidationError(`${field} must not exceed ${maximum} characters`, "TEXT_TOO_LONG");
  }
  return normalized;
}

function optionalBoundedText(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new DomainValidationError(`${field} must not exceed ${maximum} characters`, "TEXT_TOO_LONG");
  }
  return normalized;
}
