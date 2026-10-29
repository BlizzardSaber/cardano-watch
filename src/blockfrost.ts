// Blockfrost 备用数据源：把 Blockfrost API 转换成 Koios 形状的中间行，
// 供 koios.ts 复用同一套校验与聚合逻辑。默认仍用 Koios，仅在 Koios 故障
// （网络错误 / 5xx / 429）且用户配置了对应网络的 project id 时自动切换。
// Blockfrost 免费档 50,000 请求/天：https://blockfrost.io（每网络一个 project）。

import type { Address, Descriptor, Network } from "./wallet";

export type BlockfrostKeys = { mainnet?: string; preprod?: string };
const KEYS_STORAGE = "cardano-watch-bf-v1";
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function getBlockfrostKeys(): BlockfrostKeys {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEYS_STORAGE) || "{}") as BlockfrostKeys;
    return {
      mainnet: KEY_PATTERN.test(parsed.mainnet ?? "") ? parsed.mainnet : undefined,
      preprod: KEY_PATTERN.test(parsed.preprod ?? "") ? parsed.preprod : undefined,
    };
  } catch { return {}; }
}

export function setBlockfrostKeys(keys: BlockfrostKeys): BlockfrostKeys {
  const clean = getBlockfrostKeys();
  if (KEY_PATTERN.test(keys.mainnet ?? "")) clean.mainnet = keys.mainnet;
  if (KEY_PATTERN.test(keys.preprod ?? "")) clean.preprod = keys.preprod;
  if (keys.mainnet === "" || keys.mainnet === undefined) clean.mainnet = keys.mainnet === "" ? undefined : clean.mainnet;
  if (keys.preprod === "" || keys.preprod === undefined) clean.preprod = keys.preprod === "" ? undefined : clean.preprod;
  try { localStorage.setItem(KEYS_STORAGE, JSON.stringify(clean)); } catch { /* 存储满时静默 */ }
  return clean;
}

export function blockfrostReady(network: Network): boolean {
  return !!getBlockfrostKeys()[network];
}

// ---------- 请求层 ----------

export class BlockfrostNotFound extends Error {
  constructor(message: string) { super(message); this.name = "BlockfrostNotFound"; }
}

async function bfRequest<T>(network: Network, path: string, signal?: AbortSignal): Promise<T> {
  const projectId = getBlockfrostKeys()[network];
  if (!projectId) throw new Error("Blockfrost 未配置");
  const host = network === "mainnet" ? "cardano-mainnet.blockfrost.io" : "cardano-preprod.blockfrost.io";
  const url = `https://${host}/api/v0${path}`;
  const native = window.webkit?.messageHandlers?.koios;
  let status = 0;
  let json: unknown;
  if (native) {
    // 原生壳：经 koios 桥白名单转发（provider=blockfrost 分支）
    const result = await native.postMessage({ provider: "blockfrost", network, path, projectId }) as
      { status?: number; body?: unknown } | { error?: string };
    if (result && "error" in result && typeof result.error === "string") throw new Error(result.error);
    status = (result as { status?: number })?.status ?? 0;
    json = (result as { body?: unknown })?.body;
  } else {
    const response = await fetch(url, { headers: { project_id: projectId }, signal });
    status = response.status;
    if (status !== 204) json = await response.json().catch(() => { throw new Error("Blockfrost 响应无效"); });
  }
  if (status === 404) throw new BlockfrostNotFound("Blockfrost 404");
  if (status === 402) throw new Error("Blockfrost 当日配额用尽");
  if (status === 429) throw new Error("Blockfrost 请求过于频繁，请稍后重试");
  if (status === 403) throw new Error("Blockfrost project id 无效或额度用尽");
  if (status === 418) throw new Error("Blockfrost 请求被暂时封禁，请稍后重试");
  if (status >= 400 || status === 0) throw new Error(`Blockfrost ${status}：同步失败`);
  return json as T;
}

// ---------- 转换成 Koios 形状 ----------

export type BfAmount = { unit?: string; quantity?: string };
export type BfUtxo = { tx_hash?: string; output_index?: number; address?: string; amount?: BfAmount[] };
export type BfAddressTx = { tx_hash?: string; block_time?: number; block_height?: number };
export type BfTx = { hash?: string; block_height?: number; block_time?: number; fees?: string; valid_contract?: boolean };
type BfTxSide = { address?: string; amount?: BfAmount[]; collateral?: boolean; reference?: boolean };
export type BfTxUtxo = { hash?: string; inputs?: BfTxSide[]; outputs?: BfTxSide[] };
export type BfAccount = { stake_address?: string; registered?: boolean; pool_id?: string | null;
  withdrawable_amount?: string; rewards_sum?: string; withdrawals_sum?: string };
export type BfEpochParams = { key_deposit?: string };
export type BfBlockLatest = { epoch?: number; epoch_slot?: number; time?: number };
export type BfAsset = { metadata?: { decimals?: number; ticker?: string; name?: string } | null };
export type BfPoolMeta = { ticker?: string; name?: string };

const splitUnit = (unit: string): { policyId: string; assetNameHex: string } => {
  if (!/^[0-9a-f]{56,120}$/i.test(unit)) throw new Error("Blockfrost 资产单位无效");
  return { policyId: unit.slice(0, 56).toLowerCase(), assetNameHex: unit.slice(56).toLowerCase() };
};

const amountsToKoios = (amounts: BfAmount[] | undefined): { value: string; asset_list: Array<{ policy_id: string; asset_name: string; quantity: string }> } => {
  if (!Array.isArray(amounts)) throw new Error("Blockfrost 金额数据无效");
  let lovelace: string | null = null;
  const asset_list: Array<{ policy_id: string; asset_name: string; quantity: string }> = [];
  for (const item of amounts) {
    if (typeof item?.unit !== "string" || typeof item.quantity !== "string" || !/^\d+$/.test(item.quantity))
      throw new Error("Blockfrost 金额数据无效");
    if (item.unit === "lovelace") { lovelace = item.quantity; continue; }
    const { policyId, assetNameHex } = splitUnit(item.unit);
    asset_list.push({ policy_id: policyId, asset_name: assetNameHex, quantity: item.quantity });
  }
  if (lovelace === null) throw new Error("Blockfrost 缺少 ADA 金额");
  return { value: lovelace, asset_list };
};

export function bfUtxoToKoios(row: BfUtxo): { tx_hash: string; tx_index: number; address: string; value: string; asset_list: Array<{ policy_id: string; asset_name: string; quantity: string }> } {
  if (typeof row.tx_hash !== "string" || !/^[0-9a-f]{64}$/i.test(row.tx_hash) ||
      !Number.isSafeInteger(row.output_index) || row.output_index! < 0 || typeof row.address !== "string")
    throw new Error("Blockfrost UTXO 数据无效");
  const { value, asset_list } = amountsToKoios(row.amount);
  return { tx_hash: row.tx_hash, tx_index: row.output_index!, address: row.address, value, asset_list };
}

export function bfTxDetailToKoios(tx: BfTx, utxos: BfTxUtxo): {
  tx_hash: string; fee: string;
  inputs: Array<{ value: string; payment_addr: { bech32: string | null }; asset_list: unknown[] }>;
  outputs: Array<{ value: string; payment_addr: { bech32: string | null }; asset_list: unknown[] }>;
} {
  if (typeof tx.hash !== "string" || !/^[0-9a-f]{64}$/i.test(tx.hash) ||
      typeof tx.fees !== "string" || !/^\d+$/.test(tx.fees) || utxos?.hash !== tx.hash ||
      !Array.isArray(utxos.inputs) || !Array.isArray(utxos.outputs))
    throw new Error("Blockfrost 交易详情无效");
  const side = (entry: BfTxSide) => {
    if (!entry || typeof entry.address !== "string") throw new Error("Blockfrost 交易输入输出不完整");
    const { value, asset_list } = amountsToKoios(entry.amount);
    return { value, payment_addr: { bech32: entry.address }, asset_list };
  };
  return { tx_hash: tx.hash, fee: tx.fees,
    inputs: utxos.inputs.filter((item) => !item.reference && (!item.collateral || tx.valid_contract === false)).map(side),
    outputs: utxos.outputs.filter((item) => !item.collateral || tx.valid_contract === false).map(side) };
}

// ---------- 高层收集（输出 Koios 形状，供 koios.ts 聚合） ----------

const DISCOVERY_STEP = 20;

async function discoverUsed(network: Network, addresses: Address[], signal?: AbortSignal): Promise<Set<number>> {
  // Blockfrost 无批量端点；限制并发，避免大钱包逐地址串行等待。
  const used = new Set<number>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, addresses.length) }, async () => {
    while (next < addresses.length) {
      const i = next++;
      try {
        const rows = await bfRequest<unknown>(network, `/addresses/${addresses[i].address}/transactions?count=1`, signal);
        if (!Array.isArray(rows)) throw new Error("Blockfrost 交易历史无效");
        if (rows.length > 0) used.add(i);
      } catch (error) {
        if (!(error instanceof BlockfrostNotFound)) throw error;
      }
    }
  }));
  return used;
}

export async function collectBlockfrost(descriptor: Descriptor, derive: (descriptor: Descriptor, index: number, role: 0 | 1) => Address, signal?: AbortSignal): Promise<{
  external: { addresses: Address[]; used: Set<number> };
  internal: { addresses: Address[]; used: Set<number> } | null;
  utxoRows: Array<{ tx_hash: string; tx_index: number; address: string; value: string; asset_list: Array<{ policy_id: string; asset_name: string; quantity: string }> }>;
  txRows: Array<{ tx_hash: string; block_time: number; block_height: number | null }>;
  details: Array<{ tx_hash: string; inputs: []; outputs: []; incomplete: true }>;
}> {
  const network = descriptor.network;
  const scanRole = async (role: 0 | 1) => {
    const addresses: Address[] = [];
    let count = Math.min(descriptor.gapLimit, 100);
    while (true) {
      for (let i = addresses.length; i < count; i++) addresses.push(derive(descriptor, i, role));
      const used = await discoverUsed(network, addresses, signal);
      const highest = used.size ? Math.max(...used) : -1;
      const required = Math.min(highest + 1 + descriptor.gapLimit, 100);
      if (required <= count) return { addresses, used };
      count = required;
    }
  };
  const external = await scanRole(0);
  const internal = descriptor.format === "cardano-hd-single" && descriptor.derivation !== "legacy44" ? await scanRole(1) : null;
  const all = [...external.addresses, ...(internal?.addresses ?? [])];

  // UTXO：逐地址分页
  const utxoRows: Array<ReturnType<typeof bfUtxoToKoios>> = [];
  const seenRef = new Set<string>();
  const usedAddresses = new Set([...external.used].map((index) => external.addresses[index].address));
  for (const index of internal?.used ?? []) usedAddresses.add(internal!.addresses[index].address);
  for (const address of all.filter((item) => usedAddresses.has(item.address))) {
    for (let page = 1; page <= 10; page++) {
      let rows: BfUtxo[];
      try {
        rows = await bfRequest<BfUtxo[]>(network, `/addresses/${address.address}/utxos?count=100&page=${page}`, signal);
      } catch (error) {
        if (error instanceof BlockfrostNotFound) break;
        throw error;
      }
      if (!Array.isArray(rows)) throw new Error("Blockfrost UTXO 数据无效");
      for (const row of rows) {
        const converted = bfUtxoToKoios(row);
        const ref = `${converted.tx_hash}#${converted.tx_index}`;
        if (seenRef.has(ref)) throw new Error("Blockfrost 返回了重复 UTXO");
        seenRef.add(ref);
        utxoRows.push(converted);
      }
      if (rows.length < 100) break;
      if (page === 10) throw new Error("Blockfrost UTXO 超过安全扫描上限，已停止同步");
    }
  }

  // 交易历史：逐地址取最新交易，合并去重，按时间取最新 100
  const txMap = new Map<string, { tx_hash: string; block_time: number; block_height: number }>();
  for (const address of all.filter((item) => usedAddresses.has(item.address))) {
    try {
      const rows = await bfRequest<BfAddressTx[]>(network, `/addresses/${address.address}/transactions?count=100&order=desc`, signal);
      if (!Array.isArray(rows)) throw new Error("Blockfrost 交易历史无效");
      for (const row of rows) {
        if (typeof row.tx_hash !== "string" || !/^[0-9a-f]{64}$/i.test(row.tx_hash) ||
            !Number.isSafeInteger(row.block_time) || row.block_time! <= 0 ||
            !Number.isSafeInteger(row.block_height) || row.block_height! < 0)
          throw new Error("Blockfrost 交易历史无效");
        txMap.set(row.tx_hash, { tx_hash: row.tx_hash, block_time: row.block_time!, block_height: row.block_height! });
      }
    } catch (error) {
      if (!(error instanceof BlockfrostNotFound)) throw error;
    }
  }
  const txRows = [...txMap.values()].sort((a, b) =>
    b.block_time - a.block_time || b.tx_hash.localeCompare(a.tx_hash)).slice(0, 100);
  const details = txRows.map((row) => ({ tx_hash: row.tx_hash, inputs: [] as [], outputs: [] as [], incomplete: true as const }));

  return { external, internal, utxoRows, txRows, details };
}

export async function fetchBlockfrostHistoryDetail(network: Network, hash: string, signal?: AbortSignal) {
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error("Blockfrost 交易 ID 无效");
  const [tx, utxos] = await Promise.all([
    bfRequest<BfTx>(network, `/txs/${hash}`, signal),
    bfRequest<BfTxUtxo>(network, `/txs/${hash}/utxos`, signal),
  ]);
  if (tx.hash !== hash) throw new Error("Blockfrost 交易详情不完整");
  return bfTxDetailToKoios(tx, utxos);
}

// ---------- 质押 / 纪元 / 资产资料 ----------

export async function fetchStakingBlockfrost(descriptor: Descriptor, stakeAddress: string, signal?: AbortSignal): Promise<{
  registered: boolean; delegatedPool: string | null; poolName: string | null; poolTicker: string | null;
  rewardsLovelace: bigint; rewardsTotalLovelace: bigint | null; withdrawalsTotalLovelace: bigint | null;
  depositLovelace: bigint | null; epoch: { number: number; slot: number; tipTime: number } | null;
}> {
  const network = descriptor.network;
  let registered = false;
  let delegatedPool: string | null = null;
  let rewardsLovelace = 0n;
  let rewardsTotalLovelace: bigint | null = 0n;
  let withdrawalsTotalLovelace: bigint | null = 0n;
  try {
    const account = await bfRequest<BfAccount>(network, `/accounts/${stakeAddress}`, signal);
    if (account.stake_address !== stakeAddress || typeof account.registered !== "boolean")
      throw new Error("Blockfrost 质押账户数据无效");
    registered = account.registered;
    delegatedPool = typeof account.pool_id === "string" && account.pool_id.startsWith("pool1") ? account.pool_id : null;
    const amount = (value: unknown, label: string) => {
      if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`Blockfrost ${label}数据无效`);
      return BigInt(value);
    };
    rewardsLovelace = amount(account.withdrawable_amount, "可领取奖励");
    rewardsTotalLovelace = amount(account.rewards_sum, "累计奖励");
    withdrawalsTotalLovelace = amount(account.withdrawals_sum, "累计提取");
  } catch (error) {
    if (!(error instanceof BlockfrostNotFound)) throw error;
  }
  let depositLovelace: bigint | null = null;
  try {
    const params = await bfRequest<BfEpochParams>(network, "/epochs/latest/parameters", signal);
    if (typeof params.key_deposit === "string" && /^\d+$/.test(params.key_deposit)) depositLovelace = BigInt(params.key_deposit);
  } catch { /* 参数可选 */ }
  let poolName: string | null = null;
  let poolTicker: string | null = null;
  if (delegatedPool) {
    try {
      const meta = await bfRequest<BfPoolMeta>(network, `/pools/${delegatedPool}/metadata`, signal);
      poolName = typeof meta.name === "string" ? meta.name.slice(0, 80) : null;
      poolTicker = typeof meta.ticker === "string" ? meta.ticker.slice(0, 20) : null;
    } catch { /* 元数据可选 */ }
  }
  return { registered, delegatedPool, poolName, poolTicker, rewardsLovelace,
    rewardsTotalLovelace, withdrawalsTotalLovelace, depositLovelace, epoch: null };
}

export async function fetchEpochBlockfrost(network: Network, signal?: AbortSignal): Promise<{ number: number; slot: number; tipTime: number } | null> {
  const block = await bfRequest<BfBlockLatest>(network, "/blocks/latest", signal);
  const number = Number(block.epoch);
  const slot = Number(block.epoch_slot);
  const tipTime = Number(block.time);
  const age = Math.floor(Date.now() / 1000) - tipTime;
  if (!Number.isSafeInteger(number) || number < 0 || !Number.isSafeInteger(slot) || slot < 0 || slot >= 432_000 ||
      !Number.isSafeInteger(tipTime) || tipTime <= 0 || age < -300 || age > 3_600) return null;
  return { number, slot, tipTime };
}

export async function fetchAssetMetadataBlockfrost(network: Network, assets: Array<{ policyId: string; assetNameHex: string }>, signal?: AbortSignal): Promise<Record<string, { decimals: number | null; ticker: string | null; name: string | null; registered: boolean }>> {
  const result: Record<string, { decimals: number | null; ticker: string | null; name: string | null; registered: boolean }> = {};
  for (const asset of assets.slice(0, 30)) {
    try {
      const info = await bfRequest<BfAsset>(network, `/assets/${asset.policyId}${asset.assetNameHex}`, signal);
      const meta = info?.metadata && typeof info.metadata === "object" ? info.metadata : null;
      const decimals = typeof meta?.decimals === "number" && Number.isInteger(meta.decimals) && meta.decimals >= 0 && meta.decimals <= 19
        ? meta.decimals : null;
      result[`${asset.policyId}.${asset.assetNameHex}`] = {
        decimals,
        ticker: typeof meta?.ticker === "string" ? meta.ticker.slice(0, 30) : null,
        name: typeof meta?.name === "string" ? meta.name.slice(0, 80) : null,
        registered: meta != null,
      };
    } catch (error) {
      if (!(error instanceof BlockfrostNotFound)) throw error;
    }
  }
  return result;
}
