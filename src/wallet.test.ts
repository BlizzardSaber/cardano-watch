import { describe, expect, test } from "vitest";
import * as C from "@emurgo/cardano-serialization-lib-browser";
import { bech32 } from "bech32";
import { deriveAddress, descriptorId, parseAccountXpubs, rewardAddressOf, validateDescriptor, verifyReceiveAddress } from "./wallet";

const keys = [
  "acct_shared_xvk1jqkjhusyaeknf8rcjc8ezshyh3zws5rayf78xe882auhkmnpzwcfnr6hegncszk2a6pfys8l30afp8m9zfl6tld66ap0rw4rqev6cpg04r2jw",
  "acct_shared_xvk1xqn9pc9ynt3rjryqc7jg7zkah280e0jazkwaw3c8nmmfvxcqx4xlhffaj4zszazd4sw8l0036qwuatk6wzthmfmdggmn67upxza5qaqck452z",
  "acct_shared_xvk1k252ydysz4haezpsxvy378w6zstjcxm9jjvymn8442grr4dlxtk9gyzwz2z5ndrkne5ctewdeus02nktczmrnjzyq7nv80swfvqa8qc9knzms",
];
const fixture = validateDescriptor({
  format: "cardano-hd-multisig", version: 1, network: "mainnet", threshold: 2,
  account: 0, gapLimit: 20,
  cosigners: keys.map((accountXpub, index) => ({ name: `Test ${index + 1}`, accountXpub })),
});

describe("desktop 0.3.4 address compatibility", () => {
  test("parses both newline-separated and concatenated account keys", () => {
    expect(parseAccountXpubs(keys.join("\n"))).toEqual(keys);
    expect(parseAccountXpubs(keys.join(""))).toEqual(keys);
  });
  test("matches independent Rust mainnet vector", () => {
    expect(deriveAddress(fixture, 0).address).toBe(
      "addr1xxr4ssh8ywhgcjxte73tx7820hsgpycp92d2mz950jet2vucnhzlt0ljpk0vctr5ja3ypcjk0fk4498uyfjzr878f34s9gufw3");
  });
  test("matches Preprod index 1 and 3-of-3 index 7", () => {
    expect(deriveAddress({ ...fixture, network: "preprod" }, 1).address).toBe(
      "addr_test1xq34m5l700rrdfahqhc85zc0zlcehs69uc6hhgevwd49qaycnhzlt0ljpk0vctr5ja3ypcjk0fk4498uyfjzr878f34smh03f4");
    expect(deriveAddress({ ...fixture, threshold: 3 }, 7).address).toBe(
      "addr1xytky0azqvnaew3s85y90ua62awtl5m3r47w6uxc67q0850gpcqvq2qxe7dlgtfrlqzdpj7xmtxklfq98d3fmm4ph5gs07stk7");
  });
  test("requires an exact independently supplied address for each network and index", () => {
    const correct = deriveAddress(fixture, 0).address;
    expect(verifyReceiveAddress(fixture, 0, correct)).toBe(correct);
    expect(() => verifyReceiveAddress(fixture, 1, correct)).toThrow("地址不一致");
    expect(() => verifyReceiveAddress({ ...fixture, network: "preprod" }, 0, correct)).toThrow("地址不一致");
    expect(() => verifyReceiveAddress({ ...fixture, threshold: 3 }, 0, correct)).toThrow("地址不一致");
    expect(() => verifyReceiveAddress(fixture, 0, correct + " ")).toThrow("地址不一致");
  });
});

describe("单签派生路径", () => {
  // 固定熵确定性生成账户公钥（仅测试数据，无资金）
  const HARDENED = 0x80000000;
  const accountXpub = (entropyHex: string) => {
    const entropy = Uint8Array.from((entropyHex.match(/.{2}/g) ?? []).map((b) => Number.parseInt(b, 16)));
    const root = C.Bip32PrivateKey.from_bip39_entropy(entropy, new Uint8Array());
    const raw = root.derive(HARDENED + 1852).derive(HARDENED + 1815).derive(HARDENED).to_public().as_bytes();
    root.free();
    // CSL 17 的 to_bech32() 输出 xpub 前缀，手动编码成钱包使用的 acct_xvk
    return bech32.encode("acct_xvk", bech32.toWords(Array.from(raw)), 200);
  };
  const singleKey = accountXpub("5".repeat(64));
  const base = { format: "cardano-hd-single", version: 1, account: 0, gapLimit: 20 } as const;
  const cip1852 = validateDescriptor({ ...base, network: "mainnet", accountXpub: singleKey });
  const legacy44 = validateDescriptor({ ...base, network: "mainnet", accountXpub: singleKey, derivation: "legacy44" });

  test("CIP-1852 是 BaseAddress（addr1q…，vkey 凭证），带质押凭证", () => {
    expect(deriveAddress(cip1852, 0).address).toMatch(/^addr1q/);
    expect(rewardAddressOf(cip1852)).toMatch(/^stake1u/);
    expect(deriveAddress(cip1852, 0, 1).address).toMatch(/^addr1q/);
  });
  test("Ledger 遗留 44' 是 EnterpriseAddress（addr1v…），无质押凭证、无找零链", () => {
    expect(deriveAddress(legacy44, 0).address).toMatch(/^addr1v/);
    expect(deriveAddress({ ...legacy44, network: "preprod" }, 3).address).toMatch(/^addr_test1v/);
    expect(rewardAddressOf(legacy44)).toBeNull();
    expect(() => deriveAddress(legacy44, 0, 1)).toThrow("找零");
    // 两种路径同一把钥匙必须得到不同地址，且 descriptor id 不同
    expect(deriveAddress(legacy44, 0).address).not.toBe(deriveAddress(cip1852, 0).address);
    expect(descriptorId(legacy44)).not.toBe(descriptorId(cip1852));
  });
  test("xpub 与 acct_xvk 是同一把钥匙的两种前缀", () => {
    const asXpub = bech32.encode("xpub", bech32.decode(singleKey, 200).words, 200);
    const fromXpub = validateDescriptor({ ...base, network: "mainnet", accountXpub: asXpub });
    expect(asXpub.startsWith("xpub1")).toBe(true);
    expect(deriveAddress(fromXpub, 0).address).toBe(deriveAddress(cip1852, 0).address);
    expect(descriptorId(fromXpub)).toBe(descriptorId(cip1852));
    expect(() => validateDescriptor({ ...base, network: "mainnet",
      accountXpub: bech32.encode("root_xvk", bech32.decode(singleKey, 200).words, 200) })).toThrow("公钥");
  });

  test("无效派生路径被拒绝，缺省视为 CIP-1852", () => {
    expect(() => validateDescriptor({ ...base, network: "mainnet", accountXpub: singleKey, derivation: "byron44" })).toThrow("派生路径");
    expect(validateDescriptor({ ...base, network: "mainnet", accountXpub: singleKey }).derivation).toBeUndefined();
  });
});
