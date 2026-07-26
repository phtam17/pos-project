import { Money } from "@pos/domain";
import { describe, expect, it } from "vitest";

import { decodeAggregate, encodeAggregate } from "./codec.js";

describe("aggregate codec branding compatibility", () => {
  it("writes the VariPOS type key and reads legacy Open POS snapshots", () => {
    expect(encodeAggregate({
      toSnapshot: () => ({ total: Money.fromMinor(1250n, "USD") })
    })).toEqual({
      total: {
        __variPosType: "Money",
        minorUnits: "1250",
        currency: "USD"
      }
    });

    const decoded = decodeAggregate(
      {
        total: {
          __openPosType: "Money",
          minorUnits: "1250",
          currency: "USD"
        }
      },
      {
        rehydrate: (snapshot) => snapshot as unknown as { total: Money }
      }
    );

    expect(decoded.total).toBeInstanceOf(Money);
    expect(decoded.total.minorUnits).toBe(1250n);
  });
});
