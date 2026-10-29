import { deriveAddress, rewardAddressOf, type Address, type Descriptor, type Network } from "./wallet";

import {
  blockfrostReady, collectBlockfrost, fetchAssetMetadataBlockfrost, fetchEpochBlockfrost,
  fetchStakingBlockfrost, fetchBlockfrostHistoryDetail, getBlockfrostKeys, setBlockfrostKeys,
} from "./blockfrost";

export { getBlockfrostKeys, setBlockfrostKeys, blockfrostReady };

// 数据源冗余：默认 Koios；Koios 故障（网络错误/5xx/429）且配置了 Blockfrost 时自动切换，
// 成功后记住偏好（localStorage，避免每次都先撞 Koios 超时）。业务性 4xx 不触发切换。
type ProviderName = "koios" | "blockfrost";
export type ProviderMode = "auto" | ProviderName;
const PREFERENCE_STORAGE = "cardano-watch-provider-v1";
const MODE_STORAGE = "cardano-watch-provider-mode-v1";

export function getProviderMode(): ProviderMode {
  try {
    const value = localStorage.getItem(MODE_STORAGE);
    return value === "koios" || value === "blockfrost" ? value : "auto";
  } catch { return "auto"; }
}
export function setProviderMode(mode: ProviderMode) {
  try { localStorage.setItem(MODE_STORAGE, mode); } catch { /* 忽略 */ }
}

function loadPreferences(): Record<string, ProviderName> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFERENCE_STORAGE) || "{}") as Record<string, ProviderName>;
    const clean: Record<string, ProviderName> = {};
    for (const key of ["mainnet", "preprod"]) clean[key] = parsed[key] === "blockfrost" ? "blockfrost" : "koios";
    return clean;
  } catch { return { mainnet: "koios", preprod: "koios" }; }
}
let providerPreference = loadPreferences();
function rememberProvider(network: Network, provider: ProviderName) {
  if (providerPreference[network] === provider) return;
  providerPreference[network] = provider;
  try { localStorage.setItem(PREFERENCE_STORAGE, JSON.stringify(providerPreference)); } catch { /* 忽略 */ }
}
export function activeProvider(network: Network): ProviderName {
  if (getProviderMode() === "koios") return "koios";
  if (getProviderMode() === "blockfrost") return "blockfrost";
  return providerPreference[network] === "blockfrost" && blockfrostReady(network) ? "blockfrost" : "koios";
}
function isOutage(error: unknown): boolean {
  return error instanceof TypeError || /^Koios (请求过于频繁|5\d\d|413|同步失败 \((?:0|413|5\d\d)\))|Koios 0：|Failed to fetch|NetworkError|network|timed out|已超时/i.test(
    error instanceof Error ? error.message : String(error));
}
async function withFallback<T>(network: Network, koiosFn: () => Promise<T>, blockfrostFn: () => Promise<T>): Promise<T> {
  const mode = getProviderMode();
  if (mode === "koios") return koiosFn();  // 手动锁定 Koios：不切换
  if (mode === "blockfrost") return blockfrostFn();
  if (activeProvider(network) === "blockfrost") {
    try {
      const result = await blockfrostFn();
      rememberProvider(network, "blockfrost");
      return result;
    } catch (error) {
      if (error instanceof Error && /Blockfrost (project id 无效|未配置)/.test(error.message)) {
        rememberProvider(network, "koios");
      } else {
        try { return await koiosFn(); } catch { throw error; }
      }
    }
  }
  try {
    const result = await koiosFn();
    rememberProvider(network, "koios");
    return result;
  } catch (error) {
    if (!isOutage(error) || !blockfrostReady(network)) throw error;
    const result = await blockfrostFn();
    rememberProvider(network, "blockfrost");
    return result;
  }
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: {
      koios?: { postMessage(payload: unknown): Promise<unknown> };
      price?: { postMessage(payload: unknown): Promise<unknown> };
      notifications?: { postMessage(payload: unknown): Promise<unknown> };
      navigation?: { postMessage(payload: unknown): void };
      modal?: { postMessage(payload: unknown): void };
      exportDescriptor?: { postMessage(payload: unknown): void };
      haptics?: { postMessage(payload: unknown): void };
    } };
    cardanoWatchSelectTab?: (selected: "home" | "receive" | "addresses" | "staking") => void;
    cardanoWatchRefresh?: (manual?: boolean) => boolean;
  }
}

async function post<T>(network: Network, path: string, body: object, signal?: AbortSignal): Promise<T> {
  const native = window.webkit?.messageHandlers?.koios;
  if (native) return native.postMessage({ network, path, body }) as Promise<T>;
  const route = network === "mainnet" ? "/koios-mainnet/api/v1" : "/koios-preprod/api/v1";
  const response = await fetch(route + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (response.status === 429) throw new Error("Koios 请求过于频繁，请稍后重试");
  if (!response.ok) throw new Error(`Koios ${response.status}：同步失败`);
  return response.json() as Promise<T>;
}

const PAGE_SIZE = 500;
const MAX_PAGES = 100;
// Koios rejects oversized _addresses request bodies with HTTP 413.
const ADDRESS_BATCH = 20;
const addressBatches = (addresses: string[]) => Array.from(
  { length: Math.ceil(addresses.length / ADDRESS_BATCH) }, (_, i) =>
    addresses.slice(i * ADDRESS_BATCH, (i + 1) * ADDRESS_BATCH));
const orderFor = (path: string) => path === "/address_txs"
  ? "block_height.desc,tx_hash.desc" : "tx_hash.asc,tx_index.asc";

async function postPage<T>(network: Network, path: string, body: object, start: number, size: number, signal?: AbortSignal) {
  const range = `${start}-${start + size - 1}`;
  const route = network === "mainnet" ? "/koios-mainnet/api/v1" : "/koios-preprod/api/v1";
  const orderedPath = `${path}?order=${orderFor(path)}`;
  const native = window.webkit?.messageHandlers?.koios;
  let rows: unknown;
  let contentRange: unknown;
  if (native) {
    const result = await native.postMessage({ network, path: orderedPath, body, range, prefer: "count=exact" }) as {
      rows?: unknown; contentRange?: unknown;
    };
    rows = result?.rows;
    contentRange = result?.contentRange;
  } else {
    const response = await fetch(route + orderedPath, {
      method: "POST",
      headers: { "Content-Type": "application/json", Range: range, Prefer: "count=exact" },
      body: JSON.stringify(body), signal,
    });
    if (response.status === 429) throw new Error("Koios 请求过于频繁，请稍后重试");
    if (!response.ok) throw new Error(`Koios ${response.status}：同步失败`);
    rows = await response.json();
    contentRange = response.headers.get("content-range");
  }
  if (!Array.isArray(rows)) throw new Error("Koios 分页数据无效，已停止同步");
  const bounds = typeof contentRange === "string" ? contentRange.match(/^(\d+)-(\d+)\/(\d+)$/) : null;
  if (rows.length) {
    if (!bounds || Number(bounds[1]) !== start || Number(bounds[2]) !== start + rows.length - 1 || rows.length > size)
      throw new Error("Koios 分页结果不完整，已停止同步");
  } else if (typeof contentRange !== "string" || !/^\*\/\d+$/.test(contentRange)) {
    throw new Error("Koios 分页结果不完整，已停止同步");
  }
  const total = Number(bounds?.[3] ?? (contentRange as string).slice(2));
  if (!Number.isSafeInteger(total) || total < start + rows.length)
    throw new Error("Koios 分页总数无效，已停止同步");
  if (rows.length && start + rows.length > total)
    throw new Error("Koios 分页总数无效，已停止同步");
  return { rows: rows as T[], total };
}

// count=planned 分页：服务端不做精确全量计数（Koios 对大钱包最慢的就是 exact count），
// 只需返回不超过请求量的行。用于交易列表——我们要的是"最近 100 笔"而非"精确总数"。
async function postPagePlanned<T>(network: Network, path: string, body: object, start: number, size: number, signal?: AbortSignal): Promise<T[]> {
  const orderedPath = `${path}?order=${orderFor(path)}`;
  const range = `${start}-${start + size - 1}`;
  const native = window.webkit?.messageHandlers?.koios;
  let rows: unknown;
  if (native) {
    const result = await native.postMessage({ network, path: orderedPath, body, range, prefer: "count=planned" }) as {
      rows?: unknown;
    };
    rows = result?.rows;
  } else {
    const route = network === "mainnet" ? "/koios-mainnet/api/v1" : "/koios-preprod/api/v1";
    const response = await fetch(route + orderedPath, {
      method: "POST",
      headers: { "Content-Type": "application/json", Range: range, Prefer: "count=planned" },
      body: JSON.stringify(body), signal,
    });
    if (response.status === 429) throw new Error("Koios 请求过于频繁，请稍后重试");
    if (!response.ok) throw new Error(`Koios ${response.status}：同步失败`);
    rows = await response.json();
  }
  if (!Array.isArray(rows) || rows.length > size) throw new Error("Koios 交易历史数据无效");
  return rows as T[];
}

async function postAll<T>(network: Network, path: string, body: object, signal?: AbortSignal): Promise<T[]> {
  const result: T[] = [];
  let expectedTotal: number | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { rows, total } = await postPage<T>(network, path, body, page * PAGE_SIZE, PAGE_SIZE, signal);
    if (expectedTotal !== null && total !== expectedTotal)
      throw new Error("Koios 分页总数在同步时发生变化，请重试");
    expectedTotal = total;
    result.push(...rows);
    if (result.length === total) return result;
    if (rows.length !== PAGE_SIZE) throw new Error("Koios 分页提前结束，已停止同步");
  }
  throw new Error("Koios 数据超过安全扫描上限，已停止同步");
}

type OutputRow = { address?: string };
type UtxoRow = { tx_hash?: string; tx_index?: number; address?: string; value?: string; asset_list?: unknown[] | null };
type TxRow = { tx_hash?: string; block_time?: number; block_height?: number };
type TxIo = { value?: string; payment_addr?: { bech32?: string | null } | null; asset_list?: unknown[] | null };
type TxDetail = { tx_hash?: string; fee?: string; inputs?: TxIo[] | null; outputs?: TxIo[] | null; incomplete?: boolean };

export type AssetBalance = { policyId: string; assetNameHex: string; quantity: bigint };
export type TxSide = { address: string | null; owned: boolean; lovelace: bigint; assets: AssetBalance[] };
export type Tx = { hash: string; time: number; blockHeight: number | null; fee: bigint | null;
  net: bigint; assets: AssetBalance[]; inputs: TxSide[]; outputs: TxSide[]; direction: "sent" | "received" | "mixed"; incomplete?: boolean };
export type EpochProgress = { number: number; slot: number; tipTime: number };
export type Snapshot = {
  addresses: Address[];
  ownedAddresses: string[];
  used: number[];
  balance: bigint;
  assets: AssetBalance[];
  utxoCount: number;
  utxoRefs: string[];
  transactions: Tx[];
  syncedAt: number;
};

export type StakingState = {
  stakeAddress: string;
  registered: boolean;
  delegatedPool: string | null;
  poolName: string | null;
  poolTicker: string | null;
  rewardsLovelace: bigint;
  rewardsTotalLovelace: bigint | null;
  withdrawalsTotalLovelace: bigint | null;
  depositLovelace: bigint | null;
  epoch: EpochProgress | null;
  syncedAt: number;
  noStakeCredential?: true;
};

export type AssetMeta = { decimals: number | null; ticker: string | null; name: string | null; logo: string | null; registered: boolean };
const ASSET_INFO_PATH = "/asset_info?select=policy_id,asset_name,token_registry_metadata->>decimals,token_registry_metadata->>ticker,token_registry_metadata->>name,token_registry_metadata->>logo";

async function fetchAssetMetadataKoios(network: Network, assets: AssetBalance[]): Promise<Record<string, AssetMeta>> {
  const unique = [...new Map(assets.map((asset) => [`${asset.policyId}.${asset.assetNameHex}`, asset])).values()].slice(0, 30);
  if (!unique.length) return {};
  const rows = await post<Array<Record<string, unknown>>>(network, ASSET_INFO_PATH, {
    _asset_list: unique.map((asset) => [asset.policyId, asset.assetNameHex]),
  });
  if (!Array.isArray(rows)) throw new Error("Koios 资产资料无效");
  const requested = new Set(unique.map((asset) => `${asset.policyId}.${asset.assetNameHex}`));
  const result: Record<string, AssetMeta> = {};
  for (const row of rows) {
    if (typeof row.policy_id !== "string" || typeof row.asset_name !== "string") continue;
    const key = `${row.policy_id.toLowerCase()}.${row.asset_name.toLowerCase()}`;
    if (!requested.has(key)) continue;
    const decimals = typeof row.decimals === "string" && /^(0|[1-9]\d?)$/.test(row.decimals)
      ? Number(row.decimals) : null;
    // registry logo 是 base64 PNG（iVBORw0 开头），限制 96KB 防异常大图
    const logo = typeof row.logo === "string" && /^iVBORw0[A-Za-z0-9+/=]{8,130000}$/.test(row.logo)
      ? row.logo : null;
    result[key] = { decimals: decimals !== null && decimals <= 19 ? decimals : null,
      ticker: typeof row.ticker === "string" ? row.ticker.slice(0, 30) : null,
      name: typeof row.name === "string" ? row.name.slice(0, 80) : null,
      logo,
      registered: row.decimals != null || row.ticker != null || row.name != null };
  }
  return result;
}

export async function fetchAssetMetadata(network: Network, assets: AssetBalance[]): Promise<Record<string, AssetMeta>> {
  return withFallback(network,
    () => fetchAssetMetadataKoios(network, assets),
    () => fetchAssetMetadataBlockfrost(network, assets.map((asset) => ({ policyId: asset.policyId, assetNameHex: asset.assetNameHex }))) as Promise<Record<string, AssetMeta>>);
}

async function fetchEpochKoios(network: Network): Promise<EpochProgress | null> {
  const native = window.webkit?.messageHandlers?.koios;
  const route = network === "mainnet" ? "/koios-mainnet/api/v1/tip" : "/koios-preprod/api/v1/tip";
  const rows = native ? await native.postMessage({ network, path: "/tip", body: {} }) :
    await fetch(route).then((response) => {
      if (!response.ok) throw new Error(`Koios ${response.status}`);
      return response.json() as Promise<unknown>;
    });
  const tip = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined;
  const number = Number(tip?.epoch_no);
  const slot = Number(tip?.epoch_slot);
  const tipTime = Number(tip?.block_time);
  const age = Math.floor(Date.now() / 1000) - tipTime;
  if (!Number.isSafeInteger(number) || number < 0 || !Number.isSafeInteger(slot) || slot < 0 || slot >= 432_000 ||
      !Number.isSafeInteger(tipTime) || tipTime <= 0 || age < -300 || age > 3_600) return null;
  return { number, slot, tipTime };
}

export async function fetchEpoch(network: Network): Promise<EpochProgress | null> {
  try {
    return await withFallback(network,
      () => fetchEpochKoios(network),
      () => fetchEpochBlockfrost(network));
  } catch { return null; }
}

async function fetchStakingKoios(descriptor: Descriptor): Promise<StakingState> {
  const stakeAddress = rewardAddressOf(descriptor);
  if (stakeAddress === null) {
    // Ledger 遗留 Byron 路径没有质押凭证，链上无质押账户可查
    return { stakeAddress: "", registered: false, delegatedPool: null, poolName: null, poolTicker: null,
      rewardsLovelace: 0n, rewardsTotalLovelace: 0n, withdrawalsTotalLovelace: 0n,
      depositLovelace: null, epoch: null, syncedAt: Date.now(), noStakeCredential: true };
  }
  const rows = await post<Array<Record<string, unknown>>>(descriptor.network, "/account_info", {
    _stake_addresses: [stakeAddress],
  });
  if (!Array.isArray(rows)) throw new Error("Koios 质押账户数据无效");
  const row = rows.find((item) => item.stake_address === stakeAddress);
  const amount = (value: unknown, label: string) => {
    if (value == null) return null;
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`Koios ${label}数据无效`);
    return BigInt(value);
  };
  if (row && row.status !== "registered" && row.status !== "not registered" && row.status !== "not_registered")
    throw new Error("Koios 质押账户状态无效");
  if (row && row.rewards_available == null) throw new Error("Koios 缺少当前可领取奖励");
  const delegatedPool = typeof row?.delegated_pool === "string" && row.delegated_pool.startsWith("pool1")
    ? row.delegated_pool : null;
  let poolName: string | null = null;
  let poolTicker: string | null = null;
  if (delegatedPool) {
    try {
      const poolRows = await post<Array<Record<string, unknown>>>(descriptor.network, "/pool_info", {
        _pool_bech32_ids: [delegatedPool],
      });
      if (Array.isArray(poolRows)) {
        const pool = poolRows.find((item) => item.pool_id_bech32 === delegatedPool);
        const meta = pool?.meta_json && typeof pool.meta_json === "object"
          ? pool.meta_json as Record<string, unknown> : {};
        poolName = typeof meta.name === "string" ? meta.name.slice(0, 80) : null;
        poolTicker = typeof meta.ticker === "string" ? meta.ticker.slice(0, 20) : null;
      }
    } catch { /* Pool ID remains visible when optional metadata is unavailable. */ }
  }
  return {
    stakeAddress,
    registered: row?.status === "registered",
    delegatedPool,
    poolName,
    poolTicker,
    rewardsLovelace: amount(row?.rewards_available, "奖励") ?? 0n,
    rewardsTotalLovelace: amount(row?.rewards ?? row?.rewards_sum, "累计奖励"),
    withdrawalsTotalLovelace: amount(row?.withdrawals ?? row?.withdrawals_sum, "累计提取"),
    depositLovelace: amount(row?.deposit, "押金"),
    epoch: null,
    syncedAt: Date.now(),
  };
}

export async function fetchStaking(descriptor: Descriptor): Promise<StakingState> {
  const stakeAddress = rewardAddressOf(descriptor);
  if (stakeAddress === null) {
    // Ledger 遗留 Byron 路径没有质押凭证，链上无质押账户可查
    return { stakeAddress: "", registered: false, delegatedPool: null, poolName: null, poolTicker: null,
      rewardsLovelace: 0n, rewardsTotalLovelace: 0n, withdrawalsTotalLovelace: 0n,
      depositLovelace: null, epoch: null, syncedAt: Date.now(), noStakeCredential: true };
  }
  const base = await withFallback(descriptor.network,
    () => fetchStakingKoios(descriptor),
    async () => {
      const bf = await fetchStakingBlockfrost(descriptor, stakeAddress);
      return {
        stakeAddress, registered: bf.registered, delegatedPool: bf.delegatedPool,
        poolName: bf.poolName, poolTicker: bf.poolTicker, rewardsLovelace: bf.rewardsLovelace,
        rewardsTotalLovelace: bf.rewardsTotalLovelace, withdrawalsTotalLovelace: bf.withdrawalsTotalLovelace,
        depositLovelace: bf.depositLovelace, epoch: null, syncedAt: Date.now(),
      } satisfies StakingState;
    });
  return base;
}

type Collected = {
  external: { addresses: Address[]; used: Set<number> };
  internal: { addresses: Address[]; used: Set<number> } | null;
  utxoRows: UtxoRow[];
  txRows: TxRow[];
  details: TxDetail[];
};

async function collectKoios(descriptor: Descriptor, signal?: AbortSignal): Promise<Collected> {
  // 地址存在性、完整 UTXO、最近交易分别查询；详情随后按批填充。
  const gap = descriptor.gapLimit;
  const scanRole = async (role: 0 | 1) => {
    const byAddress = new Map<string, number>();
    const used = new Set<number>();
    let addressCount = Math.min(gap, 100);
    const addresses: Address[] = [];
    let scanned = 0;
    while (true) {
      for (let i = addresses.length; i < addressCount; i++) {
        const item = deriveAddress(descriptor, i, role);
        addresses.push(item);
        byAddress.set(item.address, i);
      }
      for (const batch of addressBatches(addresses.slice(scanned).map((item) => item.address))) {
        const outputs = await post<OutputRow[]>(descriptor.network, "/address_info?select=address", {
          _addresses: batch,
        }, signal);
        if (!Array.isArray(outputs) || outputs.length > batch.length)
          throw new Error("Koios 已用地址结果无效");
        for (const row of outputs) {
          const index = byAddress.get(row.address ?? "");
          if (index === undefined || !batch.includes(row.address!))
            throw new Error("Koios 返回了不属于本钱包的地址记录");
          used.add(index);
        }
      }
      scanned = addresses.length;
      const highest = used.size ? Math.max(...used) : -1;
      const required = Math.min(highest + 1 + gap, 100);
      if (required <= addressCount) return { addresses, used };
      addressCount = required;
    }
  };
  const external = await scanRole(0);
  const internal = descriptor.format === "cardano-hd-single" && descriptor.derivation !== "legacy44"
    ? await scanRole(1) : null;
  const addresses = external.addresses;
  const allAddresses = [...addresses, ...(internal?.addresses ?? [])].map((item) => item.address);
  const utxos: UtxoRow[] = [];
  const recent = new Map<string, TxRow>();
  for (const batch of addressBatches(allAddresses)) {
    utxos.push(...await postAll<UtxoRow>(descriptor.network, "/address_utxos", {
      _addresses: batch, _extended: true,
    }, signal));
    const rows = await postPagePlanned<TxRow>(descriptor.network, "/address_txs", {
      _addresses: batch,
    }, 0, 100, signal);
    for (const row of rows) {
      if (typeof row.tx_hash !== "string") throw new Error("Koios 交易历史数据无效");
      recent.set(row.tx_hash, row);
    }
  }
  const txRows = [...recent.values()].sort((a, b) =>
    (b.block_time ?? 0) - (a.block_time ?? 0) || (b.tx_hash ?? "").localeCompare(a.tx_hash ?? "")).slice(0, 100);

  return {
    external, internal,
    utxoRows: utxos as UtxoRow[],
    txRows: txRows as TxRow[],
    details: txRows.map((row) => ({ tx_hash: row.tx_hash, inputs: [], outputs: [], incomplete: true })),
  };
}

function aggregateCollected(collected: Collected): Snapshot {
  const external = collected.external;
  const addresses = external.addresses;
  const allAddresses = [...addresses, ...(collected.internal?.addresses ?? [])].map((item) => item.address);
  const owned = new Set(allAddresses);
  const utxos = collected.utxoRows;
  const txRows = collected.txRows;
  if (!Array.isArray(utxos) || !Array.isArray(txRows)) throw new Error("Koios 返回的数据格式无效");
  let balance = 0n;
  const assetTotals = new Map<string, bigint>();
  const seen = new Set<string>();
  for (const row of utxos) {
    if (!owned.has(row.address ?? "")) throw new Error("Koios 返回了不属于本钱包的 UTXO");
    if (!/^[0-9a-f]{64}$/i.test(row.tx_hash ?? "") ||
        !Number.isSafeInteger(row.tx_index) || row.tx_index! < 0 || !/^\d+$/.test(row.value ?? "")) {
      throw new Error("Koios UTXO 数据无效");
    }
    const ref = `${row.tx_hash}#${row.tx_index}`;
    if (seen.has(ref)) throw new Error("Koios 返回了重复 UTXO");
    seen.add(ref);
    balance += BigInt(row.value!);
    if (row.asset_list != null && !Array.isArray(row.asset_list)) throw new Error("Koios 原生资产数据无效");
    for (const item of row.asset_list ?? []) {
      if (!item || typeof item !== "object") throw new Error("Koios 原生资产数据无效");
      const asset = item as Record<string, unknown>;
      if (typeof asset.policy_id !== "string" || !/^[0-9a-f]{56}$/i.test(asset.policy_id) ||
          typeof asset.asset_name !== "string" || !/^(?:[0-9a-f]{2}){0,32}$/i.test(asset.asset_name) ||
          typeof asset.quantity !== "string" || !/^\d+$/.test(asset.quantity))
        throw new Error("Koios 原生资产数据无效");
      const key = `${asset.policy_id.toLowerCase()}.${asset.asset_name.toLowerCase()}`;
      assetTotals.set(key, (assetTotals.get(key) ?? 0n) + BigInt(asset.quantity));
    }
  }
  if (txRows.some((row) => !/^[0-9a-f]{64}$/i.test(row.tx_hash ?? "") ||
    !Number.isSafeInteger(row.block_time) || row.block_time! < 0)) {
    throw new Error("Koios 交易历史数据无效");
  }
  const validRows = txRows;
  const detailByHash = new Map(collected.details.map((row) => [row.tx_hash, row]));
  if (validRows.some((row) => !detailByHash.has(row.tx_hash))) throw new Error("Koios 交易详情不完整，请稍后重试");
  const transactions = validRows.map((row): Tx => {
    const detail = detailByHash.get(row.tx_hash);
    const parseSides = (items: TxIo[] | null | undefined): TxSide[] => {
      if (!Array.isArray(items)) throw new Error("Koios 交易输入输出不完整");
      return items.map((item) => {
        if (!item || !/^\d+$/.test(item.value ?? "") || !Array.isArray(item.asset_list))
          throw new Error("Koios 交易资产数据无效");
        const address = typeof item.payment_addr?.bech32 === "string" ? item.payment_addr.bech32 : null;
        const assets = item.asset_list.map((raw): AssetBalance => {
          if (!raw || typeof raw !== "object") throw new Error("Koios 交易资产数据无效");
          const asset = raw as Record<string, unknown>;
          if (typeof asset.policy_id !== "string" || !/^[0-9a-f]{56}$/i.test(asset.policy_id) ||
              typeof asset.asset_name !== "string" || !/^(?:[0-9a-f]{2}){0,32}$/i.test(asset.asset_name) ||
              typeof asset.quantity !== "string" || !/^\d+$/.test(asset.quantity))
            throw new Error("Koios 交易资产数据无效");
          return { policyId: asset.policy_id.toLowerCase(), assetNameHex: asset.asset_name.toLowerCase(), quantity: BigInt(asset.quantity) };
        });
        return { address, owned: owned.has(address ?? ""), lovelace: BigInt(item.value!), assets };
      });
    };
    const inputs = parseSides(detail?.inputs);
    const outputs = parseSides(detail?.outputs);
    const assetNet = new Map<string, bigint>();
    const sumOwned = (items: TxSide[], sign: bigint) => items.reduce((sum, item) => {
      if (!item.owned) return sum;
      for (const asset of item.assets) {
        const key = `${asset.policyId}.${asset.assetNameHex}`;
        assetNet.set(key, (assetNet.get(key) ?? 0n) + sign * BigInt(asset.quantity));
      }
      return sum + sign * item.lovelace;
    }, 0n);
    const net = sumOwned(outputs, 1n) + sumOwned(inputs, -1n);
    const assets = [...assetNet].filter(([, quantity]) => quantity !== 0n).map(([key, quantity]) => {
      const [policyId, assetNameHex] = key.split(".");
      return { policyId, assetNameHex, quantity };
    });
    const quantities = [net, ...assets.map((asset) => asset.quantity)];
    const direction = quantities.some((quantity) => quantity > 0n) && quantities.some((quantity) => quantity < 0n)
      ? "mixed" : quantities.some((quantity) => quantity < 0n) ? "sent" : "received";
    const blockHeight = Number.isSafeInteger(row.block_height) && row.block_height! >= 0 ? row.block_height! : null;
    const fee = /^\d+$/.test(detail?.fee ?? "") ? BigInt(detail!.fee!) : null;
    return { hash: row.tx_hash!, time: row.block_time!, blockHeight, fee, net, assets, inputs, outputs, direction,
      incomplete: detail?.incomplete === true };
  }).sort((a, b) => b.time - a.time);
  const assets = [...assetTotals].map(([key, quantity]) => {
    const [policyId, assetNameHex] = key.split(".");
    return { policyId, assetNameHex, quantity };
  });
  return { addresses, ownedAddresses: allAddresses, used: [...external.used].sort((a, b) => a - b), balance, assets,
    utxoCount: seen.size, utxoRefs: [...seen], transactions, syncedAt: Date.now() };
}

export async function syncWallet(descriptor: Descriptor, signal?: AbortSignal): Promise<Snapshot> {
  const collected = await withFallback(descriptor.network,
    () => collectKoios(descriptor, signal),
    () => collectBlockfrost(descriptor, deriveAddress, signal) as unknown as Promise<Collected>);
  return aggregateCollected(collected);
}

export async function loadHistoryDetails(descriptor: Descriptor, state: Snapshot,
  onBatch: (transactions: Tx[]) => void, signal?: AbortSignal): Promise<void> {
  const blockfrost = activeProvider(descriptor.network) === "blockfrost";
  const external = { addresses: state.addresses, used: new Set(state.used) };
  const externalSet = new Set(state.addresses.map((item) => item.address));
  const internalAddresses = state.ownedAddresses.filter((address) => !externalSet.has(address))
    .map((address, index) => ({ address, index }));
  const internal = internalAddresses.length ? { addresses: internalAddresses, used: new Set<number>() } : null;
  const batchSize = blockfrost ? 3 : 25;
  for (let i = 0; i < state.transactions.length; i += batchSize) {
    if (signal?.aborted) return;
    const pending = state.transactions.slice(i, i + batchSize).filter((item) => item.incomplete);
    if (!pending.length) continue;
    const hashes = pending.map((item) => item.hash);
    const body = { _tx_hashes: hashes, _inputs: true, _metadata: false, _assets: true,
      _withdrawals: false, _certs: false, _scripts: false, _bytecode: false, _governance: false };
    try {
      const details = blockfrost
        ? (await Promise.allSettled(hashes.map((hash) => fetchBlockfrostHistoryDetail(descriptor.network, hash, signal))))
          .flatMap((item) => item.status === "fulfilled" ? [item.value] : [])
        : await post<TxDetail[]>(descriptor.network, "/tx_info", body, signal);
      if (!Array.isArray(details)) continue;
      const byHash = new Map(details.map((item) => [item.tx_hash, item]));
      const rows: TxRow[] = pending.filter((item) => byHash.has(item.hash)).map((item) => ({
        tx_hash: item.hash, block_time: item.time, block_height: item.blockHeight ?? undefined,
      }));
      if (!rows.length) continue;
      const parsed: Tx[] = [];
      for (const row of rows) {
        try {
          parsed.push(...aggregateCollected({ external, internal, utxoRows: [], txRows: [row],
            details: [byHash.get(row.tx_hash!)!] }).transactions);
        } catch { /* 保留这一条为待加载，其余有效交易仍可显示。 */ }
      }
      if (signal?.aborted) return;
      onBatch(parsed);
    } catch {
      if (signal?.aborted) return;
      // One bad batch must not erase a validated balance or the transaction hashes.
    }
  }
}
