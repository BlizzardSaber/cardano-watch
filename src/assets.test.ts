import { describe, expect, it } from "vitest";
import { isListedAsset, isUsdcx, USDCX_NAME, USDCX_POLICY } from "./assets";

describe("asset display identity", () => {
  const usdcx = { policyId: USDCX_POLICY, assetNameHex: USDCX_NAME };
  it("pins the exact USDCx asset ID", () => {
    expect(isUsdcx(usdcx)).toBe(true);
    expect(isListedAsset(usdcx)).toBe(true);
    expect(isUsdcx({ ...usdcx, policyId: "0" + USDCX_POLICY.slice(1) })).toBe(false);
    expect(isUsdcx({ ...usdcx, assetNameHex: "5553444379" })).toBe(false);
  });
  it("shows registered assets without treating lookalikes as USDCx", () => {
    const other = { policyId: "0".repeat(56), assetNameHex: USDCX_NAME };
    expect(isListedAsset(other)).toBe(false);
    expect(isListedAsset(other, { decimals: null, ticker: null, name: null, logo: null, registered: true })).toBe(true);
  });
});
