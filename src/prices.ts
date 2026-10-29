// ADA 法币估值：多免费源冗余链 CoinGecko(USD+CNY) → OKX → Binance → Coinbase → Kraken(USD)。
// USD 源命中但缺 CNY 时，用 Frankfurter（欧洲央行日频汇率）换算人民币。
// 只做展示用途；价格与汇率不参与任何交易逻辑。全部 fail-soft，拿不到就显示占位。

export type PriceSource = "coingecko" | "okx" | "binance" | "coinbase" | "kraken";
export type FiatPrice = {
  adaUsd: number | null;
  adaCny: number | null;
  nightUsd: number | null;
  nightCny: number | null;
  source: PriceSource;
  fetchedAt: number;
};

export type DexQuote = { usd: number; liquidityUsd: number; volume24hUsd: number; fetchedAt: number;
  source: "DEX Screener" | "Minswap" };

export const USDCX_ASSET_ID = "1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e345553444378";

export function parseDexQuotes(json: unknown, assetIds: string[]): Record<string, DexQuote> {
  if (!Array.isArray(json)) return {};
  const requested = new Set(assetIds);
  const result: Record<string, DexQuote> = {};
  for (const raw of json.slice(0, 300)) {
    if (!raw || typeof raw !== "object") continue;
    const pair = raw as Record<string, unknown>;
    const base = pair.baseToken as Record<string, unknown> | undefined;
    const id = typeof base?.address === "string" ? base.address.toLowerCase() : "";
    const liquidity = (pair.liquidity as Record<string, unknown> | undefined)?.usd;
    const volume = (pair.volume as Record<string, unknown> | undefined)?.h24;
    const usd = typeof pair.priceUsd === "string" && /^\d+(\.\d+)?$/.test(pair.priceUsd)
      ? Number(pair.priceUsd) : null;
    if (pair.chainId !== "cardano" || !requested.has(id) || !usd || !Number.isFinite(usd) || usd <= 0 ||
        typeof liquidity !== "number" || !Number.isFinite(liquidity) || liquidity < 50_000 ||
        typeof volume !== "number" || !Number.isFinite(volume) || volume < 1_000) continue;
    if (!result[id] || result[id].liquidityUsd < liquidity)
      result[id] = { usd, liquidityUsd: liquidity, volume24hUsd: volume, fetchedAt: Date.now(), source: "DEX Screener" };
  }
  return result;
}

export function parseMinswapQuote(json: unknown): DexQuote | null {
  if (!json || typeof json !== "object") return null;
  const row = json as Record<string, unknown>;
  const asset = row.asset as Record<string, unknown> | undefined;
  const metadata = asset?.metadata as Record<string, unknown> | undefined;
  const id = typeof asset?.currency_symbol === "string" && typeof asset.token_name === "string"
    ? `${asset.currency_symbol}${asset.token_name}`.toLowerCase() : "";
  const usd = typeof row.price === "number" ? row.price : null;
  const liquidity = typeof row.liquidity === "number" ? row.liquidity : null;
  const volume = typeof row.volume_24h === "number" ? row.volume_24h : null;
  if (id !== USDCX_ASSET_ID || asset?.is_verified !== true || metadata?.decimals !== 6 ||
      usd === null || !Number.isFinite(usd) || usd <= 0 ||
      liquidity === null || !Number.isFinite(liquidity) || liquidity < 50_000 ||
      volume === null || !Number.isFinite(volume) || volume < 1_000) return null;
  return { usd, liquidityUsd: liquidity, volume24hUsd: volume, fetchedAt: Date.now(), source: "Minswap" };
}

const dexCache = new Map<string, { quotes: Record<string, DexQuote>; fetchedAt: number }>();

export async function loadDexQuotes(assetIds: string[]): Promise<Record<string, DexQuote>> {
  const ids = [...new Set(assetIds.filter((id) => /^[0-9a-f]{56,120}$/.test(id)))].sort().slice(0, 30);
  if (!ids.length) return {};
  const key = ids.join(",");
  const cached = dexCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < 5 * 60_000) return cached.quotes;
  const result: Record<string, DexQuote> = {};
  try {
    const bridge = window.webkit?.messageHandlers?.price;
    if (ids.includes(USDCX_ASSET_ID)) {
      try {
        const response = bridge ? await bridge.postMessage({ source: "minswap" }) :
          await fetch(`https://api-mainnet-prod.minswap.org/v1/assets/${USDCX_ASSET_ID}/metrics?currency=usd`,
            { headers: { accept: "application/json" } })
            .then((value) => { if (!value.ok) throw new Error("Minswap 报价不可用"); return value.json() as Promise<unknown>; });
        const quote = parseMinswapQuote(response);
        if (quote) result[USDCX_ASSET_ID] = quote;
      } catch { /* Fall through to DEX Screener. */ }
    }
    const remaining = ids.filter((id) => id !== USDCX_ASSET_ID || !result[id]);
    if (remaining.length) {
      const response = bridge ? await bridge.postMessage({ source: "dexscreener", assetIds: remaining }) :
        await fetch(`https://api.dexscreener.com/tokens/v1/cardano/${remaining.join(",")}`, { headers: { accept: "application/json" } })
        .then((value) => { if (!value.ok) throw new Error("DEX 报价不可用"); return value.json() as Promise<unknown>; });
      Object.assign(result, parseDexQuotes(response, remaining));
    }
  } catch { /* Quotes are display-only. */ }
  if (Object.keys(result).length) dexCache.set(key, { quotes: result, fetchedAt: Date.now() });
  return result;
}

export function isVerifiedNight(policyId: string, assetNameHex: string): boolean {
  return policyId.toLowerCase() === "0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa" &&
    assetNameHex.toLowerCase() === "4e49474854";
}

export const PRICE_TTL_MS = 5 * 60_000;
const CACHE_KEY = "cardano-watch-price-v1";
const FX_CACHE_KEY = "cardano-watch-usdcny-v1";
const SOURCES = {
  coingecko: "https://api.coingecko.com/api/v3/simple/price?ids=cardano,midnight-3&vs_currencies=usd,cny&include_last_updated_at=true",
  okx: "https://www.okx.com/api/v5/market/ticker?instId=ADA-USDT",
  binance: "https://api.binance.com/api/v3/ticker/price?symbol=ADAUSDT",
  coinbase: "https://api.coinbase.com/v2/prices/ADA-USD/spot",
  kraken: "https://api.kraken.com/0/public/Ticker?pair=ADAUSD",
  frankfurter: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY",
} as const;
export const PRICE_SOURCE_LABELS: Record<PriceSource, string> = {
  coingecko: "CoinGecko", okx: "OKX", binance: "Binance", coinbase: "Coinbase", kraken: "Kraken",
};
// window.webkit 的类型统一在 koios.ts 的全局声明里维护（price / notifications 处理器）。

const positiveNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

export function parseCoinGecko(json: unknown): { usd: number | null; cny: number | null; nightUsd: number | null; nightCny: number | null } | null {
  const data = json as { cardano?: Record<string, unknown>; "midnight-3"?: Record<string, unknown> } | null;
  const cardano = data?.cardano;
  if (!cardano || typeof cardano !== "object") return null;
  const fresh = (row: Record<string, unknown> | undefined) => Number.isSafeInteger(row?.last_updated_at) &&
    Math.abs(Date.now() / 1000 - Number(row?.last_updated_at)) < 86_400;
  if (!fresh(cardano)) return null;
  const usd = positiveNumber(cardano.usd);
  const cny = positiveNumber(cardano.cny);
  if (usd === null && cny === null) return null;
  const night = data?.["midnight-3"];
  return { usd, cny, nightUsd: fresh(night) ? positiveNumber(night?.usd) : null,
    nightCny: fresh(night) ? positiveNumber(night?.cny) : null };
}

export function parseOkx(json: unknown): number | null {
  const last = (json as { data?: Array<{ last?: unknown }> } | null)?.data?.[0]?.last;
  if (typeof last !== "string" || !/^\d+(\.\d+)?$/.test(last)) return null;
  return positiveNumber(Number(last));
}

export function parseBinance(json: unknown): number | null {
  const price = (json as { price?: unknown } | null)?.price;
  if (typeof price !== "string" || !/^\d+(\.\d+)?$/.test(price)) return null;
  return positiveNumber(Number(price));
}

export function parseCoinbase(json: unknown): number | null {
  const amount = (json as { data?: { amount?: unknown } } | null)?.data?.amount;
  if (typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount)) return null;
  return positiveNumber(Number(amount));
}

export function parseKraken(json: unknown): number | null {
  const result = (json as { result?: Record<string, { c?: unknown[] }> } | null)?.result;
  const row = result ? Object.values(result)[0] : undefined;
  const last = Array.isArray(row?.c) ? row.c[0] : undefined;
  if (typeof last !== "string" || !/^\d+(\.\d+)?$/.test(last)) return null;
  return positiveNumber(Number(last));
}

export function parseFrankfurter(json: unknown): number | null {
  const cny = (json as { rates?: { CNY?: unknown } } | null)?.rates?.CNY;
  if (typeof cny !== "number" || !Number.isFinite(cny) || cny <= 0) return null;
  return cny;
}

export function isFresh(price: FiatPrice | null, now: number): boolean {
  return !!price && now >= price.fetchedAt && now - price.fetchedAt < PRICE_TTL_MS &&
    (price.adaUsd !== null || price.adaCny !== null);
}

function readCache(): FiatPrice | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || "null") as FiatPrice | null;
    if (!parsed || typeof parsed.fetchedAt !== "number") return null;
    if (!Object.prototype.hasOwnProperty.call(PRICE_SOURCE_LABELS, parsed.source)) return null;
    return { adaUsd: positiveNumber(parsed.adaUsd), adaCny: positiveNumber(parsed.adaCny),
      nightUsd: positiveNumber(parsed.nightUsd), nightCny: positiveNumber(parsed.nightCny),
      source: parsed.source, fetchedAt: parsed.fetchedAt };
  } catch { return null; }
}

function writeCache(price: FiatPrice) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(price)); } catch { /* 存储满时静默降级 */ }
}

async function fetchJson(source: keyof typeof SOURCES): Promise<unknown> {
  const bridge = window.webkit?.messageHandlers?.price;
  if (bridge) {
    // 原生壳：由 Swift 侧按固定 URL 白名单转发（免 CORS，也避免自定义 scheme 的跨域限制）
    return await bridge.postMessage({ source });
  }
  const response = await fetch(SOURCES[source], { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`价格源 HTTP ${response.status}`);
  return await response.json();
}

// USD→CNY 汇率（Frankfurter，欧洲央行日频），带 12 小时缓存；失败返回 null（CNY 显示降级）
async function usdCnyRate(): Promise<number | null> {
  try {
    const cached = JSON.parse(localStorage.getItem(FX_CACHE_KEY) || "null") as { rate: number; at: number } | null;
    if (cached && Number.isFinite(cached.rate) && cached.rate > 0 && Date.now() - cached.at < 12 * 3_600_000) {
      return cached.rate;
    }
    const rate = parseFrankfurter(await fetchJson("frankfurter"));
    if (rate !== null) {
      try { localStorage.setItem(FX_CACHE_KEY, JSON.stringify({ rate, at: Date.now() })); } catch { /* 忽略 */ }
    }
    return rate;
  } catch { return null; }
}

let inflight: Promise<FiatPrice | null> | null = null;

// 展示用的持久缓存（不管新鲜度）：打开 App 立即显示上次结果，刷新在后台进行
export function cachedFiatPrice(): FiatPrice | null {
  return readCache();
}

export async function loadFiatPrice(force = false): Promise<FiatPrice | null> {
  const cached = readCache();
  if (!force && isFresh(cached, Date.now())) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const fallbacks: Array<{ source: PriceSource; parse: (json: unknown) => number | null }> = [
      { source: "okx", parse: parseOkx },
      { source: "binance", parse: parseBinance },
      { source: "coinbase", parse: parseCoinbase },
      { source: "kraken", parse: parseKraken },
    ];
    try {
      const parsed = parseCoinGecko(await fetchJson("coingecko"));
      if (parsed) {
        const price: FiatPrice = { adaUsd: parsed.usd, adaCny: parsed.cny,
          nightUsd: parsed.nightUsd, nightCny: parsed.nightCny, source: "coingecko", fetchedAt: Date.now() };
        writeCache(price);
        return price;
      }
    } catch { /* 换兜底源 */ }
    for (const candidate of fallbacks) {
      try {
        const usd = candidate.parse(await fetchJson(candidate.source));
        if (usd === null) continue;
        const cny = await usdCnyRate();
        const price: FiatPrice = { adaUsd: usd, adaCny: cny !== null ? usd * cny : null,
          nightUsd: null, nightCny: null, source: candidate.source, fetchedAt: Date.now() };
        writeCache(price);
        return price;
      } catch { /* 试下一个源 */ }
    }
    return cached ?? null;
  })();
  try { return await inflight; } finally { inflight = null; }
}

export function estimateFiat(lovelace: bigint, rate: number | null): number | null {
  if (rate === null) return null;
  const ada = Number(lovelace) / 1_000_000;
  if (!Number.isFinite(ada) || ada < 0) return null;
  return ada * rate;
}

function fiatNumber(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: value >= 1 ? 2 : 4 });
}

export function formatUsd(value: number | null): string {
  return value === null ? "" : `≈ $${fiatNumber(value)}`;
}

export function formatCny(value: number | null): string {
  return value === null ? "" : `≈ ¥${fiatNumber(value)}`;
}
