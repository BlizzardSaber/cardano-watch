import type { AssetBalance, AssetMeta } from "./koios";
import { isVerifiedNight } from "./prices";

export const USDCX_POLICY = "1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e34";
export const USDCX_NAME = "5553444378";

export function isUsdcx(asset: Pick<AssetBalance, "policyId" | "assetNameHex">): boolean {
  return asset.policyId === USDCX_POLICY && asset.assetNameHex === USDCX_NAME;
}

export function isListedAsset(asset: Pick<AssetBalance, "policyId" | "assetNameHex">, meta?: AssetMeta): boolean {
  return isVerifiedNight(asset.policyId, asset.assetNameHex) || isUsdcx(asset) || meta?.registered === true;
}
