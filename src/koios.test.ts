import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchAssetMetadata, fetchEpoch, fetchStaking, loadHistoryDetails, syncWallet } from "./koios";
import { deriveAddress, rewardAddressOf, validateDescriptor } from "./wallet";

const keys = [
  "acct_shared_xvk1jqkjhusyaeknf8rcjc8ezshyh3zws5rayf78xe882auhkmnpzwcfnr6hegncszk2a6pfys8l30afp8m9zfl6tld66ap0rw4rqev6cpg04r2jw",
  "acct_shared_xvk1xqn9pc9ynt3rjryqc7jg7zkah280e0jazkwaw3c8nmmfvxcqx4xlhffaj4zszazd4sw8l0036qwuatk6wzthmfmdggmn67upxza5qaqck452z",
  "acct_shared_xvk1k252ydysz4haezpsxvy378w6zstjcxm9jjvymn8442grr4dlxtk9gyzwz2z5ndrkne5ctewdeus02nktczmrnjzyq7nv80swfvqa8qc9knzms",
];
const descriptor = validateDescriptor({
  format: "cardano-hd-multisig", version: 1, network: "mainnet", threshold: 2,
  account: 0, gapLimit: 20,
  cosigners: keys.map((accountXpub, index) => ({ name: `Test ${index + 1}`, accountXpub })),
});
type Request = { path: string; range?: string; prefer?: string; body?: Record<string, unknown> };
const mockBridge = (reply: (request: Request) => unknown) => {
  const postMessage = vi.fn(async (request: Request) => {
    const result = reply(request);
    return request.path === "/address_info?select=address" && !Array.isArray(result) ? [] : result;
  });
  vi.stubGlobal("window", { webkit: { messageHandlers: { koios: { postMessage } } } });
  return postMessage;
};

afterEach(() => vi.unstubAllGlobals());

async function syncAndHydrate() {
  const state = await syncWallet(descriptor);
  await loadHistoryDetails(descriptor, state, (batch) => {
    const parsed = new Map(batch.map((item) => [item.hash, item]));
    state.transactions = state.transactions.map((item) => parsed.get(item.hash) ?? item);
  });
  return state;
}

describe("Koios exact pagination", () => {
  test("finds used addresses without traversing every historical output", async () => {
    const first = deriveAddress(descriptor, 0).address;
    const post = mockBridge(({ path, body }) => {
      if (path === "/address_info?select=address")
        return (body?._addresses as string[]).includes(first) ? [{ address: first }] : [];
      return { rows: [], contentRange: "*/0" };
    });
    const result = await syncWallet(descriptor);
    expect(result.used).toEqual([0]);
    expect(post.mock.calls.some(([request]) => request.path.startsWith("/address_outputs"))).toBe(false);
  });

  test("rejects missing exact count instead of showing a partial balance", async () => {
    mockBridge(({ path }) => path.startsWith("/address_utxos")
      ? { rows: [], contentRange: "" } : { rows: [], contentRange: "*/0" });
    await expect(syncWallet(descriptor)).rejects.toThrow("分页结果不完整");
  });

  test("failed tx_info batches degrade to skeleton rows instead of failing the sync", async () => {
    const hash = "f".repeat(64);
    mockBridge(({ path }) => {
      if (path.startsWith("/address_txs")) return { rows: [{ tx_hash: hash, block_time: 100, block_height: 1 }], contentRange: "0-0/1" };
      if (path === "/tx_info") throw new Error("boom");
      return { rows: [], contentRange: "*/0" };
    });
    const result = await syncAndHydrate();
    expect(result.transactions).toMatchObject([{ hash, time: 100, incomplete: true, inputs: [], outputs: [] }]);
  });

  test("returns a balance before loading history details, with planned history count", async () => {
    const hash = "f".repeat(64);
    const post = mockBridge(({ path }) => path.startsWith("/address_txs")
      ? { rows: [{ tx_hash: hash, block_time: 100, block_height: 1 }], contentRange: "0-0/100000" }
      : { rows: [], contentRange: "*/0" });
    const state = await syncWallet(descriptor);
    expect(state.transactions[0].incomplete).toBe(true);
    expect(post.mock.calls.some(([request]) => request.path === "/tx_info")).toBe(false);
    expect(post.mock.calls.find(([request]) => request.path.startsWith("/address_txs"))?.[0].prefer).toBe("count=planned");
  });

  test("splits a 100-address wallet into requests that fit Koios limits", async () => {
    const post = mockBridge(({ path, body }) => {
      const addresses = body?._addresses as string[] | undefined;
      if (addresses && addresses.length > 20) throw new Error("Koios 同步失败 (413)");
      return path === "/address_info?select=address" ? [] : { rows: [], contentRange: "*/0" };
    });
    const state = await syncWallet({ ...descriptor, gapLimit: 100 });
    expect(state.addresses).toHaveLength(100);
    expect(state.balance).toBe(0n);
    for (const [request] of post.mock.calls) {
      const addresses = request.body?._addresses as string[] | undefined;
      if (addresses) expect(addresses.length).toBeLessThanOrEqual(20);
    }
  });

  test("merges the newest transactions across address batches", async () => {
    const older = "a".repeat(64), newer = "b".repeat(64);
    const post = mockBridge(({ path, body }) => {
      if (path.startsWith("/address_txs")) {
        const address = (body?._addresses as string[])[0];
        const secondBatch = address === deriveAddress(descriptor, 20).address;
        const row = secondBatch
          ? { tx_hash: newer, block_time: 200, block_height: 2 }
          : { tx_hash: older, block_time: 100, block_height: 1 };
        return { rows: [row], contentRange: "0-0/1" };
      }
      return { rows: [], contentRange: "*/0" };
    });
    const state = await syncWallet({ ...descriptor, gapLimit: 40 });
    expect(state.transactions.map((tx) => tx.hash)).toEqual([newer, older]);
    expect(post.mock.calls.filter(([request]) => request.path.startsWith("/address_txs"))).toHaveLength(2);
  });

  test("one malformed detail does not hide another transaction in the batch", async () => {
    const address = deriveAddress(descriptor, 0).address;
    const bad = "a".repeat(64), good = "b".repeat(64);
    mockBridge(({ path }) => {
      if (path.startsWith("/address_txs")) return { rows: [
        { tx_hash: bad, block_time: 101, block_height: 1 },
        { tx_hash: good, block_time: 100, block_height: 1 },
      ], contentRange: "0-1/2" };
      if (path === "/tx_info") return [
        { tx_hash: bad, inputs: [], outputs: [{ payment_addr: { bech32: address }, value: "bad", asset_list: [] }] },
        { tx_hash: good, inputs: [], outputs: [{ payment_addr: { bech32: address }, value: "1000000", asset_list: [] }] },
      ];
      return { rows: [], contentRange: "*/0" };
    });
    const state = await syncAndHydrate();
    expect(state.transactions.find((tx) => tx.hash === bad)?.incomplete).toBe(true);
    expect(state.transactions.find((tx) => tx.hash === good)).toMatchObject({ incomplete: false, net: 1_000_000n });
  });

  test("aggregates native assets from owned UTXOs without trusting a ticker", async () => {
    const address = deriveAddress(descriptor, 0).address;
    mockBridge(({ path }) => path.startsWith("/address_utxos") ? { rows: [{
      tx_hash: "a".repeat(64), tx_index: 0, address, value: "2000000",
      asset_list: [{ policy_id: "0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa",
        asset_name: "4e49474854", quantity: "2500000" }],
    }], contentRange: "0-0/1" } : { rows: [], contentRange: "*/0" });
    const result = await syncAndHydrate();
    expect(result.balance).toBe(2_000_000n);
    expect(result.assets).toEqual([{ policyId: "0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa",
      assetNameHex: "4e49474854", quantity: 2_500_000n }]);
  });

  test("rejects malformed asset quantities", async () => {
    const address = deriveAddress(descriptor, 0).address;
    mockBridge(({ path }) => path.startsWith("/address_utxos") ? { rows: [{
      tx_hash: "a".repeat(64), tx_index: 0, address, value: "2000000",
      asset_list: [{ policy_id: "0".repeat(56), asset_name: "4e49474854", quantity: "2x" }],
    }], contentRange: "0-0/1" } : { rows: [], contentRange: "*/0" });
    await expect(syncWallet(descriptor)).rejects.toThrow("原生资产数据无效");
  });

  test("includes received CNT and outgoing CNT after change in transaction history", async () => {
    const address = deriveAddress(descriptor, 0).address;
    const policy = "a".repeat(56);
    const token = (quantity: string) => ({ policy_id: policy, asset_name: "434e54", quantity });
    const received = "b".repeat(64);
    const sent = "c".repeat(64);
    const post = mockBridge(({ path }) => {
      if (path.startsWith("/address_txs")) return { rows: [
        { tx_hash: received, block_time: 100, block_height: 1 },
        { tx_hash: sent, block_time: 90, block_height: 1 },
      ], contentRange: "0-1/2" };
      if (path === "/tx_info") return [
        { tx_hash: received, fee: "170000", inputs: [], outputs: [{ payment_addr: { bech32: address }, value: "2000000", asset_list: [token("10")] }] },
        { tx_hash: sent, inputs: [{ payment_addr: { bech32: address }, value: "5000000", asset_list: [token("10")] }],
          outputs: [{ payment_addr: { bech32: address }, value: "3000000", asset_list: [token("3")] }] },
      ];
      return { rows: [], contentRange: "*/0" };
    });
    const result = await syncAndHydrate();
    expect(result.transactions).toMatchObject([
      { hash: received, time: 100, net: 2_000_000n, assets: [{ policyId: policy, assetNameHex: "434e54", quantity: 10n }], direction: "received" },
      { hash: sent, time: 90, net: -2_000_000n, assets: [{ policyId: policy, assetNameHex: "434e54", quantity: -7n }], direction: "sent" },
    ]);
    expect(result.transactions[0]).toMatchObject({ blockHeight: 1, fee: 170_000n,
      outputs: [{ address, owned: true, lovelace: 2_000_000n,
        assets: [{ assetNameHex: "434e54", quantity: 10n }] }] });
    expect(result.transactions[1]).toMatchObject({ inputs: [{ address, owned: true }],
      outputs: [{ address, owned: true }] });
    expect(post.mock.calls.find(([request]) => request.path === "/tx_info")?.[0].body?._assets).toBe(true);
  });

  test("shows a token-only movement when ADA net change is zero", async () => {
    const address = deriveAddress(descriptor, 0).address;
    const hash = "d".repeat(64);
    mockBridge(({ path }) => {
      if (path.startsWith("/address_txs")) return { rows: [{ tx_hash: hash, block_time: 100, block_height: 1 }], contentRange: "0-0/1" };
      if (path === "/tx_info") return [{ tx_hash: hash,
        inputs: [{ payment_addr: { bech32: address }, value: "2000000", asset_list: [] }],
        outputs: [{ payment_addr: { bech32: address }, value: "2000000",
          asset_list: [{ policy_id: "a".repeat(56), asset_name: "434e54", quantity: "1" }] }],
      }];
      return { rows: [], contentRange: "*/0" };
    });
    const result = await syncAndHydrate();
    expect(result.transactions[0]).toMatchObject({ net: 0n, direction: "received",
      assets: [{ assetNameHex: "434e54", quantity: 1n }] });
  });

  test("rejects incomplete asset data in an owned transaction output", async () => {
    const address = deriveAddress(descriptor, 0).address;
    const hash = "e".repeat(64);
    mockBridge(({ path }) => {
      if (path.startsWith("/address_txs")) return { rows: [{ tx_hash: hash, block_time: 100, block_height: 1 }], contentRange: "0-0/1" };
      if (path === "/tx_info") return [{ tx_hash: hash, inputs: [],
        outputs: [{ payment_addr: { bech32: address }, value: "2000000" }] }];
      return { rows: [], contentRange: "*/0" };
    });
    const result = await syncAndHydrate();
    expect(result.transactions[0].incomplete).toBe(true);
  });

  test("reads and validates the network epoch without a wallet address", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockBridge(({ path }) => path === "/tip" ? [{ epoch_no: 660, epoch_slot: 180_000, block_time: now }] : []);
    await expect(fetchEpoch("mainnet")).resolves.toEqual({ number: 660, slot: 180_000, tipTime: now });
  });
  test("separates current, lifetime and withdrawn staking rewards", async () => {
    const stakeAddress = rewardAddressOf(descriptor)!;
    mockBridge(({ path }) => path === "/account_info" ? [{
      stake_address: stakeAddress, status: "registered", delegated_pool: null, deposit: "2000000",
      rewards_available: "5000000", rewards: "90000000", withdrawals: "85000000",
    }] : []);
    await expect(fetchStaking(descriptor)).resolves.toMatchObject({
      rewardsLovelace: 5000000n, rewardsTotalLovelace: 90000000n, withdrawalsTotalLovelace: 85000000n,
    });
  });
  test("uses registry decimals only for the exact requested asset ID", async () => {
    const policyId = "a".repeat(56);
    mockBridge(() => [
      { policy_id: policyId, asset_name: "414243", decimals: "6", ticker: "ABC", name: "ABC" },
      { policy_id: "b".repeat(56), asset_name: "414243", decimals: "6", ticker: "FAKE" },
    ]);
    await expect(fetchAssetMetadata("mainnet", [{ policyId, assetNameHex: "414243", quantity: 10n }]))
      .resolves.toEqual({ [`${policyId}.414243`]: { decimals: 6, ticker: "ABC", name: "ABC", logo: null, registered: true } });
  });
  test("registry logo（合法 base64 PNG）进入资产资料，畸形 logo 被拒绝", async () => {
    const good = "iVBORw0KGgoAAAANSUhEUg";
    const post = mockBridge(({ path, body }) => {
      if (!path.startsWith("/asset_info")) throw new Error("unexpected " + path);
      const list = (body as { _asset_list: string[][] })._asset_list;
      return list.map(([pid, name], i) => ({ policy_id: pid, asset_name: name,
        logo: i === 0 ? good : "not-base64!!" }));
    });
    const meta = await fetchAssetMetadata("mainnet", [
      { policyId: "a".repeat(56), assetNameHex: "414243", quantity: 1n },
      { policyId: "b".repeat(56), assetNameHex: "444546", quantity: 1n },
    ]);
    expect(meta[`a${"a".repeat(55)}.414243`].logo).toBe(good);
    expect(meta[`b${"b".repeat(55)}.444546`].logo).toBeNull();
  });
});
