import { describe, expect, test } from "vitest";
import { estimateFiat, formatCny, formatUsd, isFresh, isVerifiedNight, parseBinance, parseCoinGecko, parseCoinbase, parseDexQuotes, parseFrankfurter, parseKraken, parseMinswapQuote, parseOkx, USDCX_ASSET_ID, type FiatPrice } from "./prices";

describe("法币估值", () => {
  test("同名假 NIGHT 不能被当成官方资产计价", () => {
    expect(isVerifiedNight("0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa", "4e49474854")).toBe(true);
    expect(isVerifiedNight("0".repeat(56), "4e49474854")).toBe(false);
  });
  test("解析 CoinGecko 与 OKX 行情", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(parseCoinGecko({ cardano: { usd: 0.35, cny: 2.51, last_updated_at: now },
      "midnight-3": { usd: 0.04, cny: 0.28, last_updated_at: now } })).toEqual({
      usd: 0.35, cny: 2.51, nightUsd: 0.04, nightCny: 0.28,
    });
    expect(parseCoinGecko({ cardano: { usd: 0.35, last_updated_at: now },
      "midnight-3": { usd: 0.04, last_updated_at: now - 86_401 } })?.nightUsd).toBeNull();
    expect(parseCoinGecko({ cardano: { usd: 0, last_updated_at: now } })).toBeNull();
    expect(parseCoinGecko({ cardano: null })).toBeNull();
    expect(parseCoinGecko({ bitcoin: { usd: 50000 } })).toBeNull();
    expect(parseOkx({ data: [{ last: "0.348" }] })).toBe(0.348);
    expect(parseOkx({ data: [{ last: "abc" }] })).toBeNull();
    expect(parseOkx({ data: [] })).toBeNull();
  });

  test("解析冗余价格源与汇率源", () => {
    expect(parseBinance({ price: "0.351" })).toBe(0.351);
    expect(parseBinance({ price: "x" })).toBeNull();
    expect(parseBinance({})).toBeNull();
    expect(parseCoinbase({ data: { amount: "0.349" } })).toBe(0.349);
    expect(parseCoinbase({ data: { amount: "" } })).toBeNull();
    expect(parseCoinbase({})).toBeNull();
    expect(parseKraken({ result: { ADAUSD: { c: ["0.352", "1.2", "100"] } } })).toBe(0.352);
    expect(parseKraken({ result: { ADAUSD: { c: [] } } })).toBeNull();
    expect(parseKraken({ error: "bad pair" })).toBeNull();
    expect(parseFrankfurter({ rates: { CNY: 7.12 } })).toBe(7.12);
    expect(parseFrankfurter({ rates: { CNY: 0 } })).toBeNull();
    expect(parseFrankfurter({ rates: {} })).toBeNull();
    expect(parseFrankfurter("ECONNRESET")).toBeNull();
  });

  test("缓存新鲜度判断", () => {
    const now = 1_000_000;
    const price: FiatPrice = { adaUsd: 0.35, adaCny: 2.5, nightUsd: 0.04, nightCny: 0.28,
      source: "coingecko", fetchedAt: now };
    expect(isFresh(price, now + 60_000)).toBe(true);
    expect(isFresh(price, now + 5 * 60_000 + 1)).toBe(false);
    expect(isFresh(price, now - 1)).toBe(false);
    expect(isFresh({ ...price, adaUsd: null, adaCny: null }, now)).toBe(false);
    expect(isFresh(null, now)).toBe(false);
  });

  test("lovelace → 法币金额与格式化", () => {
    expect(estimateFiat(1_500_000n, 0.5)).toBe(0.75);
    expect(estimateFiat(2_000_000_000_000n, 0.35)).toBeCloseTo(700_000);
    expect(estimateFiat(100n, null)).toBeNull();
    expect(formatUsd(1234.5)).toBe("≈ $1,234.5");
    expect(formatUsd(7.256)).toBe("≈ $7.26");
    expect(formatUsd(0.7255)).toBe("≈ $0.7255");
    expect(formatUsd(0)).toBe("≈ $0");
    expect(formatUsd(2.5)).toBe("≈ $2.5");
    expect(formatUsd(null)).toBe("");
    expect(formatCny(8873.2)).toBe("≈ ¥8,873.2");
    expect(formatCny(null)).toBe("");
  });
  test("DEX 报价必须匹配完整资产 ID 且达到流动性门槛", () => {
    const id = "a".repeat(56) + "4e49474854";
    const pair = (address: string, liquidity: number) => ({ chainId: "cardano", baseToken: { address },
      priceUsd: "0.04", liquidity: { usd: liquidity }, volume: { h24: 2000 } });
    expect(parseDexQuotes([pair(id, 40_000), pair(id, 60_000), pair("b".repeat(66), 100_000)], [id])[id]?.usd).toBe(0.04);
    expect(parseDexQuotes([pair(id, 40_000)], [id])).toEqual({});
    expect(parseDexQuotes([pair("b".repeat(66), 100_000)], [id])).toEqual({});
  });
  test("Minswap USDCx 报价必须是完整固定资产且已认证", () => {
    const valid = { asset: { currency_symbol: USDCX_ASSET_ID.slice(0, 56), token_name: USDCX_ASSET_ID.slice(56),
      is_verified: true, metadata: { decimals: 6 } }, price: 0.998, liquidity: 2_040_140.5, volume_24h: 384_400 };
    expect(parseMinswapQuote(valid)).toMatchObject({ usd: 0.998, source: "Minswap" });
    expect(parseMinswapQuote({ ...valid, asset: { ...valid.asset, currency_symbol: "0".repeat(56) } })).toBeNull();
    expect(parseMinswapQuote({ ...valid, asset: { ...valid.asset, metadata: { decimals: 5 } } })).toBeNull();
    expect(parseMinswapQuote({ ...valid, volume_24h: 0 })).toBeNull();
  });
});
