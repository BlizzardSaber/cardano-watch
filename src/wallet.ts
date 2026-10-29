import * as C from "@emurgo/cardano-serialization-lib-browser";
import { bech32 } from "bech32";

export type Network = "mainnet" | "preprod";
// 单签派生路径：
//  cip1852  CIP-1852 标准（Ledger Live / Yoroi / Lace / Eternl）：m/1852'/1815'/account'/role/index
//           payment role 0（+找零 role 1），stake credential role 2/0，BaseAddress
//  legacy44 Ledger 旧版 Cardano App（AdaLite 时代）Byron 路径：m/44'/1815'/account'/0/index
//           仅 payment chain 0，EnterpriseAddress，没有质押凭证
export type SingleDerivation = "cip1852" | "legacy44";
export type MultisigDescriptor = {
  format: "cardano-hd-multisig";
  version: 1;
  network: Network;
  threshold: number;
  account: 0;
  gapLimit: number;
  cosigners: Array<{ name: string; accountXpub: string }>;
};
export type SingleDescriptor = {
  format: "cardano-hd-single";
  version: 1;
  network: Network;
  account: 0;
  gapLimit: number;
  accountXpub: string;
  derivation?: SingleDerivation;
};
export type Descriptor = MultisigDescriptor | SingleDescriptor;
export type Address = { index: number; address: string };

export function parseAccountXpubs(value: string): string[] {
  return value.split(/(?=acct_shared_xvk1)/).map((part) => part.trim()).filter(Boolean);
}

function accountKey(encoded: string, prefixes: string[]): C.Bip32PublicKey {
  const decoded = bech32.decode(encoded.trim(), 200);
  if (!prefixes.includes(decoded.prefix)) throw new Error(`需要 ${prefixes.join(" 或 ")} 公钥`);
  const bytes = Uint8Array.from(bech32.fromWords(decoded.words));
  if (bytes.length !== 64) throw new Error("账户公钥长度应为 64 字节");
  return C.Bip32PublicKey.from_bytes(bytes);
}

export function validateDescriptor(value: unknown): Descriptor {
  const d = value as Record<string, unknown> | null;
  if (!d || (d.format !== "cardano-hd-multisig" && d.format !== "cardano-hd-single") || d.version !== 1 ||
      (d.network !== "mainnet" && d.network !== "preprod") || d.account !== 0 ||
      !Number.isInteger(d.gapLimit) || (d.gapLimit as number) < 1 || (d.gapLimit as number) > 100) {
    throw new Error("不支持的 descriptor、网络或地址间隔");
  }
  if (d.format === "cardano-hd-single") {
    if (typeof d.accountXpub !== "string") throw new Error("单签账户公钥缺失");
    if (d.derivation !== undefined && d.derivation !== "cip1852" && d.derivation !== "legacy44")
      throw new Error("不支持的单签派生路径");
    accountKey(d.accountXpub, ["acct_xvk", "xpub"]);
    return d as SingleDescriptor;
  }
  if (!Array.isArray(d.cosigners) || d.cosigners.length < 1 || d.cosigners.length > 10 ||
      !Number.isInteger(d.threshold) || (d.threshold as number) < 1 || (d.threshold as number) > d.cosigners.length) {
    throw new Error("不支持的 descriptor、网络或 M-of-N 参数");
  }
  const seen = new Set<string>();
  for (const signer of d.cosigners) {
    if (typeof signer?.name !== "string" || !signer.name.trim() ||
        typeof signer.accountXpub !== "string") throw new Error("签名者资料不完整");
    accountKey(signer.accountXpub, ["acct_shared_xvk"]);
    if (seen.has(signer.accountXpub)) throw new Error("不能重复导入同一公钥");
    seen.add(signer.accountXpub);
  }
  return d as MultisigDescriptor;
}

function scriptFor(descriptor: MultisigDescriptor, role: 0 | 2, index: number): C.NativeScript {
  const scripts = C.NativeScripts.new();
  for (const signer of descriptor.cosigners) {
    const hash = accountKey(signer.accountXpub, ["acct_shared_xvk"]).derive(role).derive(index).to_raw_key().hash();
    scripts.add(C.NativeScript.new_script_pubkey(C.ScriptPubkey.new(hash)));
  }
  return C.NativeScript.new_script_n_of_k(C.ScriptNOfK.new(descriptor.threshold, scripts));
}

export function deriveAddress(descriptor: Descriptor, index: number, role: 0 | 1 = 0): Address {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new Error("地址序号无效");
  const networkId = descriptor.network === "mainnet" ? 1 : 0;
  if (descriptor.format === "cardano-hd-multisig" && role !== 0) throw new Error("多签钱包不派生找零链");
  if (descriptor.format === "cardano-hd-single" && descriptor.derivation === "legacy44" && role !== 0)
    throw new Error("Ledger 遗留路径没有找零链");
  const payment = descriptor.format === "cardano-hd-single"
    ? C.Credential.from_keyhash(accountKey(descriptor.accountXpub, ["acct_xvk", "xpub"]).derive(role).derive(index).to_raw_key().hash())
    : C.Credential.from_scripthash(scriptFor(descriptor, 0, index).hash());
  // Ledger 遗留 Byron 地址：只有支付凭证，企业地址（addr1v… / addr_test1v…），无质押部分
  if (descriptor.format === "cardano-hd-single" && descriptor.derivation === "legacy44")
    return { index, address: C.EnterpriseAddress.new(networkId, payment).to_address().to_bech32() };
  const stake = descriptor.format === "cardano-hd-single"
    ? C.Credential.from_keyhash(accountKey(descriptor.accountXpub, ["acct_xvk", "xpub"]).derive(2).derive(0).to_raw_key().hash())
    : C.Credential.from_scripthash(scriptFor(descriptor, 2, 0).hash());
  return { index, address: C.BaseAddress.new(networkId, payment, stake).to_address().to_bech32() };
}

export function verifyReceiveAddress(descriptor: Descriptor, index: number, expected: string): string {
  const derived = deriveAddress(descriptor, index).address;
  if (expected !== expected.trim() || expected !== derived)
    throw new Error("地址不一致：请停止入金，并核对网络、M-of-N、公钥顺序和地址序号");
  return derived;
}

// Ledger 遗留路径没有质押凭证，返回 null，由调用方显示“无质押数据”
export function rewardAddressOf(descriptor: Descriptor): string | null {
  if (descriptor.format === "cardano-hd-single" && descriptor.derivation === "legacy44") return null;
  const networkId = descriptor.network === "mainnet" ? 1 : 0;
  const stake = descriptor.format === "cardano-hd-single"
    ? C.Credential.from_keyhash(accountKey(descriptor.accountXpub, ["acct_xvk", "xpub"]).derive(2).derive(0).to_raw_key().hash())
    : C.Credential.from_scripthash(scriptFor(descriptor, 2, 0).hash());
  return C.RewardAddress.new(networkId, stake).to_address().to_bech32();
}

// xpub 与 acct_xvk 只是同一把钥匙的两种 bech32 前缀（校验和绑定前缀，需重编码归一），
// 避免同一账户公钥用两种前缀导入时出现两个内容相同的钱包
const normalizeSingleXpub = (encoded: string): string => {
  const decoded = bech32.decode(encoded.trim(), 200);
  return decoded.prefix === "xpub" ? bech32.encode("acct_xvk", decoded.words, 200) : encoded.trim();
};

export function descriptorId(d: Descriptor): string {
  return d.format === "cardano-hd-single"
    ? [d.format, d.network, normalizeSingleXpub(d.accountXpub), d.derivation ?? "cip1852"].join("|")
    : [d.network, d.threshold, ...d.cosigners.map((s) => s.accountXpub)].join("|");
}
