import { beforeEach, describe, expect, test, vi } from "vitest";
import { bfTxDetailToKoios, bfUtxoToKoios, fetchEpochBlockfrost, fetchStakingBlockfrost, getBlockfrostKeys, setBlockfrostKeys } from "./blockfrost";
import { loadHistoryDetails, setProviderMode, syncWallet } from "./koios";
import { deriveAddress, rewardAddressOf, validateDescriptor } from "./wallet";

// vitest 是 node 环境：用内存 localStorage stub
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
});

beforeEach(() => store.clear());

describe("Blockfrost 备用数据源", () => {
  test("UTXO 行转换成 Koios 形状（含资产拆分）", () => {
    const row = bfUtxoToKoios({
      tx_hash: "ab".repeat(32), output_index: 1, address: "addr1q...",
      amount: [{ unit: "lovelace", quantity: "1500000" },
        { unit: "0".repeat(56) + "4e49474854", quantity: "42" }],
    });
    expect(row).toEqual({
      tx_hash: "ab".repeat(32), tx_index: 1, address: "addr1q...", value: "1500000",
      asset_list: [{ policy_id: "0".repeat(56), asset_name: "4e49474854", quantity: "42" }],
    });
  });
  test("畸形 UTXO 与金额被拒绝", () => {
    expect(() => bfUtxoToKoios({ tx_hash: "xx", output_index: 0, address: "a", amount: [{ unit: "lovelace", quantity: "1" }] })).toThrow();
    expect(() => bfUtxoToKoios({ tx_hash: "ab".repeat(32), output_index: -1, address: "a", amount: [{ unit: "lovelace", quantity: "1" }] })).toThrow();
    expect(() => bfUtxoToKoios({ tx_hash: "ab".repeat(32), output_index: 0, address: "a", amount: [{ unit: "zzz", quantity: "1" }] as never })).toThrow();
    expect(() => bfUtxoToKoios({ tx_hash: "ab".repeat(32), output_index: 0, address: "a", amount: [{ unit: "lovelace", quantity: "-3" }] })).toThrow();
  });
  test("交易详情转换成 Koios 输入输出", () => {
    const detail = bfTxDetailToKoios(
      { hash: "cd".repeat(32), block_time: 1_767_225_600, fees: "180000", block_height: 123 },
      { hash: "cd".repeat(32),
        inputs: [{ address: "addr_src", amount: [{ unit: "lovelace", quantity: "5" }] }],
        outputs: [{ address: "addr_dst", amount: [{ unit: "lovelace", quantity: "4" }] }] });
    expect(detail.tx_hash).toBe("cd".repeat(32));
    expect(detail.fee).toBe("180000");
    expect(detail.inputs[0].payment_addr.bech32).toBe("addr_src");
    expect(detail.outputs[0].value).toBe("4");
  });
  test("project id 键校验与清空", () => {
    expect(getBlockfrostKeys()).toEqual({});
    setBlockfrostKeys({ mainnet: "short", preprod: "validprojectid1234567890" });
    expect(getBlockfrostKeys()).toEqual({ mainnet: undefined, preprod: "validprojectid1234567890" });
    setBlockfrostKeys({ mainnet: "validprojectid1234567890" });
    expect(getBlockfrostKeys().mainnet).toBe("validprojectid1234567890");
    setBlockfrostKeys({ mainnet: "" });
    expect(getBlockfrostKeys().mainnet).toBeUndefined();
  });
});

describe("Koios → Blockfrost 自动切换", () => {
  const keys = [
    "acct_shared_xvk1jqkjhusyaeknf8rcjc8ezshyh3zws5rayf78xe882auhkmnpzwcfnr6hegncszk2a6pfys8l30afp8m9zfl6tld66ap0rw4rqev6cpg04r2jw",
    "acct_shared_xvk1xqn9pc9ynt3rjryqc7jg7zkah280e0jazkwaw3c8nmmfvxcqx4xlhffaj4zszazd4sw8l0036qwuatk6wzthmfmdggmn67upxza5qaqck452z",
  ];
  const descriptor = validateDescriptor({
    format: "cardano-hd-multisig", version: 1, network: "mainnet", threshold: 2, account: 0, gapLimit: 20,
    cosigners: keys.map((accountXpub) => ({ name: "T", accountXpub })),
  });

  test("质押读取当前可领取余额而不是最近一次奖励，并解析数字时间的纪元进度", async () => {
    setBlockfrostKeys({ mainnet: "validprojectid1234567890" });
    const stakeAddress = rewardAddressOf(descriptor)!;
    const now = Math.floor(Date.now() / 1000);
    const postMessage = vi.fn(async (request: Record<string, unknown>) => {
      const path = String(request.path ?? "");
      if (path === `/accounts/${stakeAddress}`) return { status: 200, body: {
        stake_address: stakeAddress, registered: true, pool_id: null,
        withdrawable_amount: "5000000", rewards_sum: "90000000", withdrawals_sum: "85000000",
      } };
      if (path === "/epochs/latest/parameters") return { status: 200, body: { key_deposit: "2000000" } };
      if (path === "/blocks/latest") return { status: 200, body: { epoch: 660, epoch_slot: 180000, time: now } };
      throw new Error("unexpected " + path);
    });
    vi.stubGlobal("window", { webkit: { messageHandlers: { koios: { postMessage } } } });
    await expect(fetchStakingBlockfrost(descriptor, stakeAddress)).resolves.toMatchObject({
      rewardsLovelace: 5000000n, rewardsTotalLovelace: 90000000n, withdrawalsTotalLovelace: 85000000n,
    });
    await expect(fetchEpochBlockfrost("mainnet")).resolves.toEqual({ number: 660, slot: 180000, tipTime: now });
  });

  test("Koios 故障且配置了 project id 时切换并产出快照", async () => {
    setBlockfrostKeys({ mainnet: "validprojectid1234567890" });
    const addresses = Array.from({ length: 20 }, (_, i) => deriveAddress(descriptor, i).address);
    const bf = (path: string): unknown => {
      if (path.startsWith("/addresses/") && path.includes("/transactions")) return [];  // 未使用
      if (path.startsWith("/addresses/") && path.includes("/utxos")) return [];          // 无 UTXO
      throw new Error("unexpected " + path);
    };
    const postMessage = vi.fn(async (request: Record<string, unknown>) => {
      if (request.provider === "blockfrost") {
        const path = String(request.path ?? "");
        return { status: 200, body: bf(path) };
      }
      throw new Error("Koios 同步失败 (413)");  // 模拟过大的批量请求
    });
    vi.stubGlobal("window", { webkit: { messageHandlers: { koios: { postMessage } } } });
    const snapshot = await syncWallet(descriptor);
    expect(snapshot.addresses).toHaveLength(20);
    expect(snapshot.balance).toBe(0n);
    expect(snapshot.transactions).toEqual([]);
    expect(postMessage.mock.calls.some(([r]) => (r as Record<string, unknown>).provider === "blockfrost")).toBe(true);
    store.delete("cardano-watch-provider-v1");  // 复位偏好，避免影响其他用例
  });

  test("未配置 project id 时 Koios 故障直接抛错", async () => {
    const postMessage = vi.fn(async (request: Record<string, unknown>) => {
      if (request.provider === "blockfrost") throw new Error("unexpected blockfrost call");
      throw new Error("Koios 577：同步失败");
    });
    vi.stubGlobal("window", { webkit: { messageHandlers: { koios: { postMessage } } } });
    await expect(syncWallet(descriptor)).rejects.toThrow("Koios 577");
    store.delete("cardano-watch-provider-v1");
  });

  test("仅 Blockfrost 模式保留真正的 Blockfrost 错误，不回退成 Koios 错误", async () => {
    setProviderMode("blockfrost");
    setBlockfrostKeys({ mainnet: "validprojectid1234567890" });
    const postMessage = vi.fn(async (request: Record<string, unknown>) => {
      if (request.provider === "blockfrost") return { status: 403, body: { message: "invalid key" } };
      throw new Error("Koios 同步失败 (413)");
    });
    vi.stubGlobal("window", { webkit: { messageHandlers: { koios: { postMessage } } } });
    await expect(syncWallet(descriptor)).rejects.toThrow("Blockfrost project id 无效");
    expect(postMessage.mock.calls.some(([request]) => (request as Record<string, unknown>).provider !== "blockfrost")).toBe(false);
    setProviderMode("auto");
  });

  test("Blockfrost 先返回余额与交易列表，再后台加载详情", async () => {
    setProviderMode("blockfrost");
    setBlockfrostKeys({ mainnet: "validprojectid1234567890" });
    const address = deriveAddress(descriptor, 0).address;
    const hash = "a".repeat(64);
    const postMessage = vi.fn(async (request: Record<string, unknown>) => {
      if (request.provider !== "blockfrost") throw new Error("unexpected Koios request");
      const path = String(request.path ?? "");
      if (path === `/addresses/${address}/transactions?count=1` ||
          path === `/addresses/${address}/transactions?count=100&order=desc`)
        return { status: 200, body: [{ tx_hash: hash, block_time: 1_700_000_000, block_height: 123 }] };
      if (path.includes("/transactions")) return { status: 200, body: [] };
      if (path.includes("/utxos") && path.startsWith("/addresses/")) return { status: 200, body: [] };
      if (path === `/txs/${hash}`) return { status: 200, body: { hash, fees: "170000" } };
      if (path === `/txs/${hash}/utxos`) return { status: 200, body: {
        hash,
        inputs: [{ address: "addr_external", amount: [{ unit: "lovelace", quantity: "1000000" }] }],
        outputs: [{ address, amount: [{ unit: "lovelace", quantity: "1000000" }] }],
      } };
      throw new Error("unexpected " + path);
    });
    vi.stubGlobal("window", { webkit: { messageHandlers: { koios: { postMessage } } } });
    const state = await syncWallet(descriptor);
    expect(state.transactions[0]).toMatchObject({ hash, incomplete: true });
    expect(postMessage.mock.calls.some(([request]) => String((request as Record<string, unknown>).path).startsWith("/txs/"))).toBe(false);
    const completed: Array<{ net: bigint; incomplete?: boolean }> = [];
    await loadHistoryDetails(descriptor, state, (rows) => completed.push(...rows));
    expect(completed[0]).toMatchObject({ net: 1_000_000n, incomplete: false });
    setProviderMode("auto");
  });
});
