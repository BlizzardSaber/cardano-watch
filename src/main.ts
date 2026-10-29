import QRCode from "qrcode";
import { deriveAddress, descriptorId, rewardAddressOf, validateDescriptor, verifyReceiveAddress, type Descriptor } from "./wallet";
import { fetchAssetMetadata, fetchEpoch, fetchStaking, syncWallet, loadHistoryDetails, activeProvider, blockfrostReady, setBlockfrostKeys, getBlockfrostKeys, getProviderMode, setProviderMode, type AssetBalance, type AssetMeta, type Snapshot, type StakingState, type TxSide } from "./koios";
import { cachedFiatPrice, estimateFiat, formatCny, formatUsd, isFresh, isVerifiedNight, loadDexQuotes, loadFiatPrice, PRICE_SOURCE_LABELS, type DexQuote, type FiatPrice } from "./prices";
import { isListedAsset, isUsdcx } from "./assets";
import "./style.css";

type SavedWallet = { id: string; name: string; descriptor: Descriptor };
type Tab = "home" | "receive" | "addresses" | "staking";
const STORAGE = "cardano-sparrow-watch-v1";
const app = document.querySelector<HTMLDivElement>("#app")!;
const nativeTabs = !!window.webkit?.messageHandlers?.navigation;
if (nativeTabs) document.documentElement.classList.add("native-tabs");
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const formatUnits = (quantity: bigint, decimals: number) => {
  const negative = quantity < 0n;
  const absolute = negative ? -quantity : quantity;
  const divisor = 10n ** BigInt(decimals);
  const whole = absolute / divisor;
  const fraction = decimals ? (absolute % divisor).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return `${negative ? "−" : ""}${whole.toLocaleString()}${fraction ? "." + fraction : ""}`;
};
const formatAda = (lovelace: bigint) => formatUnits(lovelace, 6);

function loadWallets(): SavedWallet[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE) || "[]") as SavedWallet[];
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      try {
        if (typeof item.id !== "string" || typeof item.name !== "string") return [];
        return [{ id: item.id, name: item.name, descriptor: validateDescriptor(item.descriptor) }];
      } catch { return []; }
    });
  } catch { return []; }
}

// 链上快照持久缓存：打开 App 先显示上次结果，后台刷新后替换（Vespr 式体验）。
// bigint 字段用 {__b:"…"} 编码往返。
const SNAPSHOT_STORAGE = "cardano-watch-snapshot-v1";
type PersistedSnapshot = { walletId: string; snapshot: Snapshot };
function persistSnapshot(walletId: string, state: Snapshot) {
  try {
    localStorage.setItem(SNAPSHOT_STORAGE, JSON.stringify({ walletId, snapshot: state }, (_k, v) =>
      typeof v === "bigint" ? { __b: v.toString() } : v));
  } catch { /* 存储满时静默降级 */ }
}
function readPersistedSnapshot(): PersistedSnapshot | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(SNAPSHOT_STORAGE) || "null") as PersistedSnapshot | null;
    if (!parsed || typeof parsed.walletId !== "string" || !parsed.snapshot) return null;
    const snapshot = JSON.parse(JSON.stringify(parsed.snapshot), (_k, v) =>
      v && typeof v === "object" && typeof (v as { __b?: string }).__b === "string" &&
      /^-?\d+$/.test((v as { __b: string }).__b) ? BigInt((v as { __b: string }).__b) : v) as Snapshot;
    if (!Array.isArray(snapshot.addresses) || typeof snapshot.balance !== "bigint" ||
        !Array.isArray(snapshot.transactions) || typeof snapshot.syncedAt !== "number") return null;
    return { walletId: parsed.walletId, snapshot };
  } catch { return null; }
}

let wallets = loadWallets();
let activeId = (() => {
  try {
    const saved = localStorage.getItem("cardano-watch-active-wallet-v1");
    if (saved && wallets.some((item) => item.id === saved)) return saved;
  } catch { /* 忽略 */ }
  return wallets[0]?.id ?? "";
})();
// 老数据兜底：没有记录时把当前生效钱包写进去，重开 App 即可记住
if (activeId) { try { localStorage.setItem("cardano-watch-active-wallet-v1", activeId); } catch { /* 忽略 */ } }
let tab: Tab = "home";
let lastRenderedTab: Tab = "home";
let historyOpen = false;
let selectedTxHash: string | null = null;
let snapshot: Snapshot | null = null;
let staking: StakingState | null = null;
let stakingError = "";
let stakingLoading = false;
let stakingRequestId = 0;
let loading = false;
let refreshQueued = false;
let pullRefreshing = false;
let syncRequestId = 0;
let syncAbort: AbortController | null = null;
let historyAbort: AbortController | null = null;
let syncError = false;
let message = "";
let messageKind: "info" | "error" = "info";
let price: FiatPrice | null = null;
let assetMetadata: Record<string, AssetMeta> = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem("cardano-watch-asset-meta-v1") || "null") as
      { walletId?: string; entries?: Record<string, AssetMeta> } | null;
    if (saved?.walletId !== activeId || !saved.entries || typeof saved.entries !== "object") return {};
    const clean: Record<string, AssetMeta> = {};
    for (const [key, raw] of Object.entries(saved.entries)) {
      if (!/^[0-9a-f]{56}\.(?:[0-9a-f]{2}){0,32}$/.test(key) || !raw || typeof raw !== "object") continue;
      clean[key] = {
        decimals: Number.isInteger(raw.decimals) && raw.decimals! >= 0 && raw.decimals! <= 19 ? raw.decimals : null,
        ticker: typeof raw.ticker === "string" ? raw.ticker.slice(0, 30) : null,
        name: typeof raw.name === "string" ? raw.name.slice(0, 80) : null,
        logo: typeof raw.logo === "string" && /^iVBORw0[A-Za-z0-9+/=]{8,130000}$/.test(raw.logo) ? raw.logo : null,
        registered: raw.registered === true,
      };
    }
    return clean;
  } catch { return {}; }
})();
let assetQuotes: Record<string, DexQuote> = {};
let fiatEnabled = localStorage.getItem("cardano-watch-fiat") !== "off";
let hideUnlistedAssets = localStorage.getItem("cardano-watch-hide-unlisted-assets") === "on";
let fiatCurrency: "usd" | "cny" = localStorage.getItem("cardano-watch-currency") === "cny" ? "cny" : "usd";
price = localStorage.getItem("cardano-watch-fiat") !== "off" ? cachedFiatPrice() : null;
let activityNotifyEnabled = localStorage.getItem("cardano-watch-notify") === "on";
let hapticsEnabled = localStorage.getItem("cardano-watch-haptics") !== "off";
let hapticStrength = Math.min(100, Math.max(10, Number(localStorage.getItem("cardano-watch-haptic-strength")) || 75));
const syncHaptics = (preview = false) => window.webkit?.messageHandlers?.haptics?.postMessage({
  enabled: hapticsEnabled, intensity: hapticStrength / 100, preview,
});
let receiveIndex = 0;
let expandedAddress: number | null = null;
let qrVersion = 0;
const persisted = readPersistedSnapshot();
if (persisted && persisted.walletId === activeId) {
  snapshot = persisted.snapshot;
  const nextUnused = snapshot.used.length ? Math.max(...snapshot.used) + 1 : 0;
  receiveIndex = Math.min(nextUnused, 100);
}
let verifiedReceive: { walletId: string; index: number; address: string } | null = null;
const active = () => wallets.find((item) => item.id === activeId);
const save = () => localStorage.setItem(STORAGE, JSON.stringify(wallets));
function invalidateSync() {
  syncRequestId++;
  syncAbort?.abort();
  historyAbort?.abort();
  historyAbort = null;
  syncAbort = null;
  loading = false;
  refreshQueued = false;
  assetMetadata = {};
  assetQuotes = {};
}

async function refreshAssetData(wallet: SavedWallet, state: Snapshot, requestId: number) {
  if (!state.assets.length) return;
  const latest: Record<string, AssetMeta> = await fetchAssetMetadata(wallet.descriptor.network, state.assets).catch(() => ({}));
  for (const [key, meta] of Object.entries(latest))
    if (!meta.logo && assetMetadata[key]?.logo) latest[key] = { ...meta, logo: assetMetadata[key].logo };
  const metadata = { ...assetMetadata, ...latest };
  const ids = state.assets.filter((asset) => isNight(asset) || typeof metadata[`${asset.policyId}.${asset.assetNameHex}`]?.decimals === "number")
    .map((asset) => `${asset.policyId}${asset.assetNameHex}`);
  const quotes = fiatEnabled && wallet.descriptor.network === "mainnet" ? await loadDexQuotes(ids) : {};
  if (requestId !== syncRequestId || wallet.id !== activeId) return;
  assetMetadata = metadata;
  assetQuotes = quotes;
  try {
    // 已校验的 PNG logo 限总量缓存；重开 App 不必每次重新从 Koios 下载。
    const compact: Record<string, AssetMeta> = {};
    let logoBytes = 0;
    for (const asset of state.assets) {
      const key = `${asset.policyId}.${asset.assetNameHex}`;
      const meta = metadata[key];
      if (!meta) continue;
      const logo = typeof meta.logo === "string" && /^iVBORw0[A-Za-z0-9+/=]{8,130000}$/.test(meta.logo) &&
        logoBytes + meta.logo.length <= 500_000 ? meta.logo : null;
      if (logo) logoBytes += logo.length;
      compact[key] = { ...meta, logo };
    }
    localStorage.setItem("cardano-watch-asset-meta-v1", JSON.stringify({ walletId: wallet.id, entries: compact }));
  } catch { /* 忽略 */ }
  render();
}
function notify(text: string, kind: "info" | "error" = "info") {
  message = text; messageKind = kind; render();
  window.setTimeout(() => { if (message === text) { message = ""; messageKind = "info"; render(); } }, 6000);
}

async function refreshStaking(force = false) {
  const wallet = active();
  if (!wallet || stakingLoading || (!force && staking && Date.now() - staking.syncedAt < 120_000)) return;
  const requestId = ++stakingRequestId;
  stakingLoading = true; stakingError = ""; render();
  try {
    const [next, epoch] = await Promise.all([fetchStaking(wallet.descriptor),
      fetchEpoch(wallet.descriptor.network).catch(() => null)]);
    next.epoch = epoch;
    if (wallet.id === activeId && requestId === stakingRequestId) staking = next;
  } catch (error) {
    if (wallet.id === activeId && requestId === stakingRequestId)
      stakingError = error instanceof Error ? error.message : String(error || "质押信息同步失败");
  } finally { if (requestId === stakingRequestId) { stakingLoading = false; render(); } }
}

// 429/故障后自动轮询冷却 5 分钟，避免持续撞限频；手动刷新不受限
let autoRefreshCooldownUntil = 0;
const isRateLimited = (error: unknown) => /请求过于频繁|429/.test(error instanceof Error ? error.message : String(error));

async function refresh(manual = false) {
  const wallet = active();
  if (!wallet) return;
  if (!manual && Date.now() < autoRefreshCooldownUntil) return;
  if (loading) { refreshQueued = true; return; }
  const requestId = ++syncRequestId;
  historyAbort?.abort();
  const controller = new AbortController();
  syncAbort = controller;
  loading = true;
  render();
  try {
    const next = await syncWallet(wallet.descriptor, controller.signal);
    if (requestId !== syncRequestId || wallet.id !== activeId) return;
    const previous = snapshot?.transactions[0]?.hash;
    const latest = next.transactions[0]?.hash;
    const utxosChanged = !!snapshot && (snapshot.utxoRefs.length !== next.utxoRefs.length ||
      snapshot.utxoRefs.some((ref, index) => ref !== next.utxoRefs[index]));
    if (utxosChanged) { stakingRequestId++; stakingLoading = false; staking = null; }
    snapshot = next;
    syncError = false;
    persistSnapshot(wallet.id, next);
    if (next.transactions.some((item) => item.incomplete)) {
      const detailController = new AbortController();
      historyAbort = detailController;
      void loadHistoryDetails(wallet.descriptor, next, (completed) => {
        if (detailController.signal.aborted || requestId !== syncRequestId || wallet.id !== activeId || !snapshot) return;
        const byHash = new Map(completed.map((item) => [item.hash, item]));
        snapshot = { ...snapshot, transactions: snapshot.transactions.map((item) => byHash.get(item.hash) ?? item) };
        persistSnapshot(wallet.id, snapshot);
        render();
      }, detailController.signal).finally(() => { if (historyAbort === detailController) historyAbort = null; });
    }
    const nextUnused = next.used.length ? Math.max(...next.used) + 1 : 0;
    receiveIndex = Math.min(nextUnused, 100);
    if (previous && latest && previous !== latest) notify("检测到新交易，请核对详情");
    if (activityNotifyEnabled) void syncActivityWatch(next).catch(() => notify("后台动账观察登记失败，请检查网络后重试", "error"));
    if (fiatEnabled) void loadFiatPrice().then((loaded) => { price = loaded; render(); });
    void refreshAssetData(wallet, next, requestId);
    void refreshStaking(utxosChanged);
  } catch (error) {
    if (requestId === syncRequestId && wallet.id === activeId) {
      syncError = true;
      if (isRateLimited(error)) autoRefreshCooldownUntil = Date.now() + 5 * 60_000;
      // 自动轮询失败静默：继续显示上次快照，不打扰；手动刷新才提示（并引导备用源）
      if (manual) {
        const advice = getProviderMode() === "blockfrost" ? "请检查 Blockfrost Project ID、额度与网络" :
          blockfrostReady(wallet.descriptor.network) ? "可在设置中切换数据源重试" :
            "可在设置中配置 Blockfrost 备用源";
        notify(`${error instanceof Error ? error.message : String(error || "同步失败")}。${advice}`, "error");
      }
    }
  } finally {
    if (requestId === syncRequestId) {
      syncAbort = null;
      pullRefreshing = false;
      loading = false; render();
      if (refreshQueued) { refreshQueued = false; if (active()) void refresh(); }
    }
  }
}

function addWallet(name: string, descriptor: Descriptor) {
  const previousId = activeId;
  const id = descriptorId(descriptor);
  if (wallets.some((item) => item.id === id)) throw new Error("这个观察钱包已存在");
  wallets.push({ id, name: name.trim() || `观察钱包 ${wallets.length + 1}`, descriptor });
  invalidateSync();
  save(); activeId = id; localStorage.setItem("cardano-watch-active-wallet-v1", id); verifiedReceive = null; snapshot = null; syncError = false; staking = null; stakingError = "";
  if (previousId) void unregisterActivityWatch(previousId).catch(() => {});
  stakingRequestId++; stakingLoading = false; tab = "home"; historyOpen = false; render(); void refresh();
}

async function unregisterActivityWatch(walletId?: string) {
  const bridge = window.webkit?.messageHandlers?.notifications;
  if (bridge) await bridge.postMessage({ action: "unregister", walletId });
}

async function syncActivityWatch(state: Snapshot | null) {
  const bridge = window.webkit?.messageHandlers?.notifications;
  const wallet = active();
  if (!bridge || !wallet || !state || !activityNotifyEnabled) return;
  await bridge.postMessage({ action: "register", walletId: wallet.id,
    network: wallet.descriptor.network, addresses: state.ownedAddresses, baselineRefs: state.utxoRefs });
  if (wallet.id !== activeId) await unregisterActivityWatch(wallet.id);
}

// 代币图标：Token Registry 登记的 logo（base64 PNG，Koios asset_info 返回）优先，
// 官方 NIGHT 用内置图，其余未登记的显示 ◆ 占位——新 CNT 只要链上 registry 有登记就自动出图
function assetIconImg(asset: AssetBalance, night: boolean): string {
  if (night) return '<img src="./night.png" alt="" aria-hidden="true">';
  if (isUsdcx(asset)) return '<img src="./usdcx.png" alt="" aria-hidden="true">';
  const logo = assetMeta(asset)?.logo;
  return logo ? `<img src="data:image/png;base64,${logo}" alt="" aria-hidden="true">` : '<span aria-hidden="true">◆</span>';
}

function isNight(asset: AssetBalance) {
  return isVerifiedNight(asset.policyId, asset.assetNameHex);
}

function tokenName(asset: AssetBalance) {
  if (isNight(asset)) return "NIGHT";
  if (isUsdcx(asset)) return "USDCx";
  try {
    const bytes = asset.assetNameHex.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [];
    const name = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    return /^[\p{L}\p{N} _.-]{1,24}$/u.test(name)
      ? name === "NIGHT" ? "NIGHT（未验证）" : name === "ADA" ? "ADA（代币）" : name : `Token ${asset.policyId.slice(0, 8)}…`;
  } catch { return `Token ${asset.policyId.slice(0, 8)}…`; }
}

function fiatValue(value: number | null, approximate = true) {
  if (value === null || !Number.isFinite(value)) return "—";
  const formatted = fiatCurrency === "usd" ? formatUsd(value) : formatCny(value);
  return approximate ? formatted : formatted.replace(/^≈\s*/, "");
}

const assetId = (asset: AssetBalance) => `${asset.policyId}${asset.assetNameHex}`;
const assetMeta = (asset: AssetBalance) => assetMetadata[`${asset.policyId}.${asset.assetNameHex}`];
const assetDecimals = (asset: AssetBalance) => isNight(asset) || isUsdcx(asset) ? 6 : assetMeta(asset)?.decimals ?? null;
function unitRate(asset: AssetBalance | null, usablePrice: FiatPrice | null): number | null {
  if (!fiatEnabled) return null;
  const usd = !asset ? usablePrice?.adaUsd ?? null : isNight(asset) ? usablePrice?.nightUsd ?? assetQuotes[assetId(asset)]?.usd ?? null : assetQuotes[assetId(asset)]?.usd ?? null;
  if (fiatCurrency === "usd") return usd;
  if (!asset) return usablePrice?.adaCny ?? null;
  if (isNight(asset) && usablePrice?.nightCny != null) return usablePrice.nightCny;
  return usd !== null && usablePrice?.adaUsd && usablePrice.adaCny
    ? usd * usablePrice.adaCny / usablePrice.adaUsd : null;
}
function unitPriceLabel(rate: number | null) {
  if (rate === null || !Number.isFinite(rate)) return "—";
  if (rate > 0 && rate < 0.00000001) return `≈ <${fiatCurrency === "usd" ? "$" : "¥"}0.00000001`;
  const digits = rate < 0.01 ? 8 : rate < 1 ? 5 : 4;
  return `≈ ${fiatCurrency === "usd" ? "$" : "¥"}${rate.toLocaleString("en-US", { maximumFractionDigits: digits })}`;
}
function assetValue(asset: AssetBalance, usablePrice: FiatPrice | null) {
  const decimals = assetDecimals(asset);
  const rate = unitRate(asset, usablePrice);
  if (decimals === null || rate === null) return null;
  const quantity = Number(asset.quantity) / 10 ** decimals;
  return Number.isFinite(quantity) && Number.isFinite(quantity * rate) ? quantity * rate : null;
}

function portfolioHtml(wallet: SavedWallet) {
  const state = snapshot;
  const rewards = staking?.rewardsLovelace ?? 0n;
  const totalAda = state ? state.balance + rewards : null;
  const usablePrice = fiatEnabled && wallet.descriptor.network === "mainnet" &&
    (price?.adaUsd != null || price?.adaCny != null) ? price : null;
  const adaRate = unitRate(null, usablePrice);
  const adaValue = totalAda !== null && adaRate !== null ? estimateFiat(totalAda, adaRate) : null;
  let total = adaValue;
  let partial = !!state && adaRate === null;
  const rows = (state?.assets ?? []).filter((asset) => !hideUnlistedAssets || isListedAsset(asset, assetMeta(asset)));
  const assets = [...rows].sort((a, b) => Number(isNight(b)) - Number(isNight(a))).map((asset) => {
    const night = isNight(asset);
    const value = assetValue(asset, usablePrice);
    if (value !== null && Number.isFinite(value)) total = (total ?? 0) + value;
    else partial = true;
    const name = tokenName(asset);
    const decimals = assetDecimals(asset);
    const quantity = formatUnits(asset.quantity, decimals ?? 0);
    return `<button class="holding-row asset-button" data-asset="${assetId(asset)}" type="button"><span class="holding-icon${night ? " night" : ""}">${assetIconImg(asset, night)}</span><span class="holding-name"><strong>${escapeHtml(name)}</strong><small>${unitPriceLabel(unitRate(asset, usablePrice))}</small></span><span class="holding-numbers"><strong>${value === null ? "—" : fiatValue(value)}</strong><small>${quantity}</small></span></button>`;
  }).join("");
  if (totalAda === 0n && rows.every((asset) => asset.quantity === 0n)) total = 0;
  const note = !fiatEnabled ? "已关闭估值" : wallet.descriptor.network === "preprod" ? "测试网不显示法币估值" :
    !usablePrice ? "ADA 行情暂不可用；其他 DEX 报价仅供参考" : partial ? "仅有可靠报价的资产计入总额；DEX 报价仅供参考" :
    `${isFresh(usablePrice, Date.now()) ? PRICE_SOURCE_LABELS[usablePrice.source] + " 参考价格" : PRICE_SOURCE_LABELS[usablePrice.source] + " 上次价格 · 正在刷新"} · ${new Date(usablePrice.fetchedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  const hero = `<section class="home-balance"><span class="home-balance-label">账户总资产估值</span><div class="home-balance-value">${fiatValue(total, false)}</div><button id="currency-toggle" class="home-currency" aria-label="切换估值货币">${fiatCurrency === "usd" ? "USD · 美元" : "CNY · 人民币"} ⌄</button><p class="home-price-note">${note}${hideUnlistedAssets ? " · 已排除未登记资产" : ""}</p><small>${loading ? "正在同步 · " : ""}${state ? `${state.utxoCount} 个 UTXO · 更新于 ${new Date(state.syncedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "下拉刷新链上数据"}</small></section>
    <section class="home-shortcuts" aria-label="常用操作"><button id="open-history" class="home-shortcut"><span aria-hidden="true">↗</span><strong>交易历史</strong></button><button data-go-tab="receive" class="home-shortcut"><span aria-hidden="true">↓</span><strong>收款</strong></button><button data-go-tab="addresses" class="home-shortcut"><span aria-hidden="true">▤</span><strong>地址</strong></button></section>`;
  const assetsHtml = `<section class="home-assets"><div class="home-assets-head"><h2>代币</h2><span>${state ? `${1 + rows.length} 种资产` : "等待同步"}</span></div>
      <div class="holding-row"><span class="holding-icon ada"><img src="./ada.svg" alt="" aria-hidden="true"></span><span class="holding-name"><strong>ADA</strong><small>${unitPriceLabel(adaRate)}${rewards > 0n ? ` · 含 ${formatAda(rewards)} 可领取奖励` : state && !staking ? " · 奖励待同步" : ""}</small></span><span class="holding-numbers"><strong>${fiatValue(adaValue)}</strong><small>${totalAda !== null ? formatAda(totalAda) : "—"}</small></span></div>${assets}</section>
    `;
  return { hero, assetsHtml };
}

function notifyToggleHtml() {
  if (!window.webkit?.messageHandlers?.notifications)
    return `<strong class="fiat-muted">仅 iOS App 支持</strong>`;
  return `<button id="notify-toggle" class="link-button">${activityNotifyEnabled ? "已开启" : "已关闭"}</button>`;
}

function getReceiveAddress() {
  const wallet = active();
  if (!wallet || receiveIndex >= 100) return "";
  return deriveAddress(wallet.descriptor, receiveIndex).address;
}

function receiveQrReady() {
  const wallet = active();
  if (!wallet || !snapshot || syncError || loading || receiveIndex >= 100 || snapshot.used.includes(receiveIndex)) return false;
  const address = getReceiveAddress();
  return snapshot.addresses[receiveIndex]?.address === address;
}

function receiveCopyReady() {
  const wallet = active();
  const address = getReceiveAddress();
  return !!wallet && receiveQrReady() && verifiedReceive?.walletId === wallet.id &&
    verifiedReceive.index === receiveIndex && verifiedReceive.address === address;
}

function render() {
  const priorMain = app.querySelector<HTMLElement>("main");
  const priorScroll = priorMain?.scrollTop ?? 0;
  const currentQrVersion = ++qrVersion;
  const wallet = active();
  const tabChanged = !historyOpen && tab !== lastRenderedTab;
  lastRenderedTab = tab;
  const title = wallet ? escapeHtml(wallet.name) : "观察钱包";
  const network = wallet?.descriptor.network === "preprod" ? "Preprod 测试网" : "Mainnet 主网";
  const homeMode = !!wallet && !historyOpen && tab === "home";
  const portfolio = homeMode ? portfolioHtml(wallet) : null;
  app.classList.toggle("home-mode", homeMode);
  app.classList.toggle("scrolled", homeMode && priorScroll > 30);
  app.innerHTML = `
    <div class="pinned-shell"><div class="pinned-glass" aria-hidden="true"></div>
    ${historyOpen && wallet ? `<header class="topbar history-topbar"><button id="back-history" class="history-back" aria-label="${selectedTxHash ? "返回交易历史" : "返回总览"}">‹ 返回</button><strong>${selectedTxHash ? "交易详情" : "交易历史"}</strong><span></span></header>` :
      `<header class="topbar">${homeMode ? `<button id="wallet-picker" class="brand home-account"><span class="brand-mark"><img src="./app-icon.png" alt="" aria-hidden="true"></span><span><strong>${title}</strong><small>${network} · 只读钱包</small></span></button>` : `<div class="brand"><span class="brand-mark"><img src="./app-icon.png" alt="" aria-hidden="true"></span><div><strong>Cardano Watch</strong><small>只读多签钱包</small></div></div>`}
      <button id="${wallet ? "wallet-details" : "add-wallet"}" class="icon-button" aria-label="${wallet ? "钱包设置" : "添加钱包"}">${wallet ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2" fill="currentColor"/><circle cx="15" cy="17" r="2" fill="currentColor"/></svg>' : "＋"}</button></header>`}
    <div class="pull-indicator${pullRefreshing ? " refreshing" : ""}" aria-live="polite">${pullRefreshing ? "正在刷新链上数据…" : "下拉刷新"}</div>${portfolio?.hero ?? ""}</div>
    <main class="${tabChanged ? "tab-enter" : ""}">${historyOpen && wallet ? selectedTxHash ? transactionDetailHtml(wallet, selectedTxHash) : historyHtml() : `${homeMode ? "" : `<section class="wallet-strip"><button id="wallet-picker" class="wallet-picker"><span><small>当前钱包</small><strong>${title}</strong></span><span>⌄</span></button>
      ${wallet ? `<span class="network-badge">${network}</span>` : ""}</section>`}
      ${!wallet ? `<section class="empty"><div class="empty-icon">✦</div><h1>随时查看多签钱包</h1><p>导入桌面版 descriptor，或逐个输入 acct_shared_xvk。手机只保存公钥，不接触助记词。</p><button id="start-import" class="primary">添加观察钱包</button></section>` :
      tab === "home" ? portfolio!.assetsHtml : tab === "receive" ? receiveHtml(wallet) : tab === "addresses" ? addressesHtml(wallet) : stakingHtml(wallet)}
    `}</main>
    ${wallet && !nativeTabs && !historyOpen ? `<nav class="tabbar" aria-label="导航"><button data-tab="home" class="${tab === "home" ? "selected" : ""}"><span>◫</span>总览</button><button data-tab="receive" class="${tab === "receive" ? "selected" : ""}"><span>↓</span>收款</button><button data-tab="addresses" class="${tab === "addresses" ? "selected" : ""}"><span>▦</span>地址</button><button data-tab="staking" class="${tab === "staking" ? "selected" : ""}"><span>◈</span>质押</button></nav>` : ""}
    ${message ? `<div class="toast${messageKind === "error" ? " error" : ""}" role="status">${escapeHtml(message)}</div>` : ""}
  `;
  const main = app.querySelector<HTMLElement>("main")!;
  if (!tabChanged) main.scrollTop = priorScroll;
  updateCollapse();
  bindPull(main);
  bind();
  window.webkit?.messageHandlers?.navigation?.postMessage({ hasWallet: !!wallet, selectedTab: tab, subpage: historyOpen });
  if (wallet && tab === "receive" && receiveQrReady()) void drawQr(getReceiveAddress(), currentQrVersion);
}

function scrollMainTop() { app.querySelector("main")?.scrollTo(0, 0); }

// 跟手收拢：scrollTop 0→60px 映射为 --collapse 0→1，CSS 变量插值驱动头部收缩；
// 玻璃在收拢过半时出现。资产列表保底可滚 44px，即使内容不满一屏也能触发。
function updateCollapse() {
  const main = app.querySelector<HTMLElement>("main");
  if (!main) return;
  const scrolled = app.classList.contains("home-mode") && main.scrollTop > 30;
  if (app.classList.contains("scrolled") !== scrolled) app.classList.toggle("scrolled", scrolled);
}

function bindPull(main: HTMLElement) {
  main.addEventListener("scroll", updateCollapse, { passive: true });
  let startY: number | null = null;
  let distance = 0;
  main.addEventListener("touchstart", (event) => {
    // 下拉刷新只在总览页生效；其他页面正常滚动
    startY = !pullRefreshing && tab === "home" && !historyOpen && main.scrollTop <= 0 &&
      !document.querySelector("dialog[open]") ? event.touches[0]?.clientY ?? null : null;
    distance = 0;
  }, { passive: true });
  main.addEventListener("touchmove", (event) => {
    if (startY === null || main.scrollTop > 0) return;
    const delta = (event.touches[0]?.clientY ?? startY) - startY;
    if (delta <= 8) return;
    event.preventDefault();
    distance = Math.min(95, delta * .5);
    const indicator = app.querySelector<HTMLElement>(".pull-indicator");
    if (indicator) { indicator.style.height = `${distance}px`; indicator.textContent = distance > 60 ? "松开刷新" : "下拉刷新"; }
  }, { passive: false });
  main.addEventListener("touchend", () => {
    if (startY === null) return;
    startY = null;
    if (distance > 60 && active() && !loading) {
      pullRefreshing = true;
      window.cardanoWatchRefresh?.(true);
    } else {
      const indicator = app.querySelector<HTMLElement>(".pull-indicator");
      if (indicator) indicator.style.height = "0px";
    }
    distance = 0;
  }, { passive: true });
}

window.cardanoWatchRefresh = (manual = false) => {
  if (!active() || tab !== "home" || historyOpen) return false;
  if (!loading) void refresh(manual);
  return true;
};

window.cardanoWatchSelectTab = (selected: Tab) => {
  if (!["home", "receive", "addresses", "staking"].includes(selected)) return;
  historyOpen = false; expandedAddress = null;
  tab = selected;
  render();
  scrollMainTop();
  if (tab === "staking") { void refreshStaking(); if (!snapshot) void refresh(); }
};

function transactionRowsHtml() {
  const transactions = snapshot?.transactions ?? [];
  const assetIcon = (asset: AssetBalance) => assetIconImg(asset, isNight(asset));
  const adaIcon = '<img src="./ada.svg" alt="" aria-hidden="true">';
  return transactions.length ? transactions.map((tx) => {
    if (tx.incomplete) return `<button class="tx-row" data-tx="${tx.hash}" type="button"><span class="tx-icon">⋯</span><span class="tx-mid"><strong>交易明细待加载</strong><small>${new Date(tx.time * 1000).toLocaleString("zh-CN")} · ${tx.hash.slice(0, 9)}…</small></span><span class="tx-amounts">—</span></button>`;
    const label = tx.direction === "mixed" ? "资产变动" : tx.direction === "received" ? "收款" : "发送";
    const arrow = tx.direction === "mixed" ? "↔" : tx.direction === "received" ? "↓" : "↑";
    const icon = tx.assets.length ? assetIcon(tx.assets[0]) : adaIcon;
    const ada = tx.net !== 0n || tx.assets.length === 0
      ? `<strong class="tx-amount ${tx.net < 0n ? "sent" : "received"}"><span class="amount-icon">${adaIcon}</span>${tx.net >= 0n ? "+" : ""}${formatAda(tx.net)} ADA</strong>` : "";
    const assets = tx.assets.map((asset) => `<strong class="tx-amount asset ${asset.quantity < 0n ? "sent" : "received"}"><span class="amount-icon">${assetIcon(asset)}</span>${asset.quantity > 0n ? "+" : ""}${formatUnits(asset.quantity, isNight(asset) ? 6 : 0)} ${escapeHtml(tokenName(asset))}</strong>`).join("");
    return `<button class="tx-row" data-tx="${tx.hash}" type="button"><span class="tx-icon ${tx.direction}">${icon}<span class="tx-direction">${arrow}</span></span><span class="tx-mid"><strong>${label}</strong><small>${new Date(tx.time * 1000).toLocaleString("zh-CN")} · ${tx.hash.slice(0, 9)}…</small></span><span class="tx-amounts">${assets}${ada}</span></button>`;
  }).join("") : `<div class="muted-block">${snapshot ? "暂无交易记录" : "同步后显示交易记录"}</div>`;
}

function historyHtml() {
  return `<section class="page-head"><p>最近最多 100 笔 · 点击记录查看详情 · 其他代币显示链上最小单位</p></section>
    <section class="card history-page-list">${transactionRowsHtml()}</section>`;
}

function transactionDetailHtml(wallet: SavedWallet, hash: string) {
  const tx = snapshot?.transactions.find((item) => item.hash === hash);
  if (!tx) return `<section class="card tx-detail"><p>交易详情已失效，请返回历史并重新同步。</p></section>`;
  const explorer = wallet.descriptor.network === "mainnet" ? "https://cardanoscan.io" : "https://preprod.cardanoscan.io";
  if (tx.incomplete) return `<section class="card tx-detail"><h2>交易明细尚未加载</h2><p class="tx-detail-note">交易哈希已获取，但输入、输出、收发方向和金额尚未完成核对。后台会继续加载；请勿把空白当作零金额。</p><div class="tx-detail-id"><span>TXID · 可前往 Cardanoscan 独立核对</span><a href="${explorer}/transaction/${tx.hash}" target="_blank" rel="noopener noreferrer">${tx.hash} ↗</a></div></section>`;
  const changes = tx.assets.map((asset) => `<div class="tx-detail-change"><span>${assetIconImg(asset, isNight(asset))} ${escapeHtml(tokenName(asset))}</span><strong class="${asset.quantity < 0n ? "sent" : "received"}">${asset.quantity > 0n ? "+" : ""}${formatUnits(asset.quantity, isNight(asset) ? 6 : 0)}</strong></div>`).join("");
  const adaChange = `<div class="tx-detail-change"><span><img src="./ada.svg" alt=""> ADA</span><strong class="${tx.net < 0n ? "sent" : "received"}">${tx.net >= 0n ? "+" : ""}${formatAda(tx.net)}</strong></div>`;
  const sides = (items: TxSide[], kind: "inputs" | "outputs") => items.map((side, index) => {
    const tokens = side.assets.map((asset) => `<small>${formatUnits(asset.quantity, isNight(asset) ? 6 : 0)} ${escapeHtml(tokenName(asset))}</small>`).join("");
    return `<div class="tx-detail-side"><div><strong>${kind === "inputs" ? "输入" : "输出"} #${index + 1}</strong><span>${side.owned ? "本钱包" : "其他地址"}</span></div><code>${side.address ? escapeHtml(side.address) : "地址不可用"}</code><p>${formatAda(side.lovelace)} ADA ${tokens}</p></div>`;
  }).join("");
  return `<section class="card tx-detail"><div class="tx-detail-header"><span class="receive-status">已上链 · Koios</span><h1>${tx.direction === "mixed" ? "资产变动" : tx.direction === "received" ? "收款" : "发送"}</h1><p>${new Date(tx.time * 1000).toLocaleString("zh-CN")}</p></div><div class="tx-detail-changes">${changes}${tx.net !== 0n || !changes ? adaChange : ""}</div></section>
    <section class="card tx-detail"><h2>交易信息</h2><div class="detail"><span>网络</span><strong>${wallet.descriptor.network === "mainnet" ? "Cardano 主网" : "Preprod 测试网"}</strong></div><div class="detail"><span>区块高度</span><strong>${tx.blockHeight ?? "—"}</strong></div><div class="detail"><span>整笔交易手续费</span><strong>${tx.fee === null ? "—" : `${formatAda(tx.fee)} ADA`}</strong></div><div class="tx-detail-id"><span>TXID · 点按打开浏览器核对</span><a href="${explorer}/transaction/${tx.hash}" target="_blank" rel="noopener noreferrer">${tx.hash} ↗</a></div></section>
    <section class="card tx-detail"><h2>链上输入与输出</h2><p class="tx-detail-note">Cardano 一笔交易可有多个地址；“本钱包”仅表示属于此观察钱包，不推断对手方。</p><h3>输出地址</h3>${sides(tx.outputs, "outputs")}<h3>输入地址</h3>${sides(tx.inputs, "inputs")}</section>`;
}

function navigateHistory(update: () => void, direction: "forward" | "back") {
  if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update(); return;
  }
  document.documentElement.dataset.navDirection = direction;
  const transition = document.startViewTransition(update);
  void transition.finished.finally(() => { delete document.documentElement.dataset.navDirection; }).catch(() => {});
}

function backFromHistory() {
  navigateHistory(() => { if (selectedTxHash) selectedTxHash = null; else { historyOpen = false; tab = "home"; } render(); scrollMainTop(); }, "back");
}

function openHistory() {
  if (!active()) return;
  navigateHistory(() => { historyOpen = true; selectedTxHash = null; render(); scrollMainTop(); }, "forward");
}

function openAssetDetail(id: string) {
  const wallet = active();
  const asset = snapshot?.assets.find((item) => assetId(item) === id);
  if (!wallet || !asset) return;
  const meta = assetMeta(asset);
  const decimals = assetDecimals(asset);
  const usablePrice = fiatEnabled && wallet.descriptor.network === "mainnet" &&
    (price?.adaUsd != null || price?.adaCny != null) ? price : null;
  const quote = assetQuotes[id];
  const value = assetValue(asset, usablePrice);
  const officialNight = isNight(asset);
  showSheet(`<div class="sheet-head"><h2>资产详情</h2><button class="sheet-close">返回</button></div>
    <div class="asset-detail-hero"><span class="holding-icon${officialNight ? " night" : ""}">${assetIconImg(asset, officialNight)}</span><h1>${escapeHtml(tokenName(asset))}</h1><p>${decimals === null ? `${asset.quantity.toLocaleString("en-US")} 个最小单位` : formatUnits(asset.quantity, decimals)}</p><strong>${value === null ? "—" : fiatValue(value)}</strong></div>
    <section class="card settings-card"><div class="detail"><span>当前参考单价</span><strong>${unitPriceLabel(unitRate(asset, usablePrice))}</strong></div><div class="detail"><span>报价来源</span><strong>${value === null ? "—" : officialNight && (usablePrice?.nightUsd != null || usablePrice?.nightCny != null) ? "CoinGecko / Midnight" : quote ? `${quote.source}${quote.source === "DEX Screener" ? " · 最大流动性池" : " · 官方资产指标"}` : "—"}</strong></div><div class="detail"><span>身份核对</span><strong>${officialNight ? "官方 NIGHT 资产 ID" : isUsdcx(asset) ? "USDCx 固定资产 ID · Registry 图标" : meta?.registered ? "Token Registry 有登记" : "未找到登记资料"}</strong></div><div class="detail"><span>小数位</span><strong>${decimals === null ? "未知 · 保持链上原始单位" : decimals}</strong></div>${quote && value !== null ? `<div class="detail"><span>报价池流动性</span><strong>约 $${quote.liquidityUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}</strong></div>` : ""}</section>
    <section class="card settings-card asset-identity"><h2>链上身份</h2><div class="staking-long"><span>Policy ID</span><code>${escapeHtml(asset.policyId)}</code></div><div class="staking-long"><span>Asset name（hex）</span><code>${escapeHtml(asset.assetNameHex || "空名称")}</code></div><div class="staking-long"><span>完整资产 ID</span><code>${escapeHtml(id)}</code></div></section>
    <p class="privacy-note">${officialNight ? "此资产与内置官方 NIGHT Policy ID 完全一致。" : "Token Registry 登记不等于项目官方背书；请自行核对完整 Policy ID。"} DEX/Minswap 报价仅作展示，不代表可成交价格；未取得可信小数位时不进行估值。</p>`,
    (dialog) => dialog.classList.add("settings-sheet", "asset-detail-sheet"));
}

function epochHtml(state: StakingState) {
  const epoch = state.epoch;
  if (!epoch) return `<p class="epoch-note">纪元时间暂不可用，无法估算下一次奖励结算。</p>`;
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - epoch.tipTime);
  if (elapsed > 3_600) return `<p class="epoch-note">链上纪元数据已过期，请重新同步。</p>`;
  const absoluteSlot = epoch.slot + elapsed;
  const number = epoch.number + Math.floor(absoluteSlot / 432_000);
  const slot = absoluteSlot % 432_000;
  const hours = Math.ceil((432_000 - slot) / 3600);
  return `<div class="epoch-progress"><div class="epoch-heading"><strong>第 ${number} 纪元</strong><span>距下一纪元约 ${Math.floor(hours / 24)} 天 ${hours % 24} 小时</span></div><div class="epoch-track"><span style="width:${(slot / 432_000 * 100).toFixed(1)}%"></span></div><p class="epoch-note">下一纪元边界仅是预计结算时间；首次委托通常还需 15–20 天，不保证每轮有奖励。</p></div>`;
}

function receiveHtml(wallet: SavedWallet) {
  const address = getReceiveAddress();
  if (!address) return `<section class="page-head"><h1>收款</h1><p>已达到当前 100 个地址的扫描上限。</p></section>
    <section class="card receive-card"><p class="staking-error">无法确认下一个未用地址，已停止显示收款二维码。请在桌面端核对并扩展扫描范围。</p></section>`;
  const used = snapshot?.used.includes(receiveIndex) ?? false;
  const synced = !!snapshot && !syncError && !loading && snapshot.addresses[receiveIndex]?.address === address;
  const qrReady = receiveQrReady();
  const copyReady = receiveCopyReady();
  return `<section class="page-head"><h1>收款</h1><p>二维码可用于收款；大额入金前请在另一台可信设备上独立核对完整地址。</p></section>
    <section class="card receive-card"><span class="eyebrow">${wallet.descriptor.network === "mainnet" ? "主网" : "测试网"} · 收款地址 #${receiveIndex}</span>
      <div class="qr-frame">${qrReady ? `<canvas id="qr" role="img" aria-label="收款二维码"></canvas>` : `<span class="hint">${used ? "地址已使用，不再显示二维码" : "同步并校验地址后显示二维码"}</span>`}</div>
      <div class="address-text${copyReady ? "" : " unverified"}">${escapeHtml(address)}</div><div class="receive-status ${used ? "used" : copyReady ? "" : "pending"}">${used ? "此地址已使用" : copyReady ? "已独立核对 · 未发现链上使用记录" : !synced ? "同步或地址校验未完成" : "二维码已显示 · 地址尚未独立核对"}</div>
      ${synced && !used && !copyReady ? `<p class="receive-warning">二维码可扫描，但这台手机无法独立证明地址正确；大额入金前请先核对。</p><button id="verify-address" class="secondary full">独立核对地址以启用复制</button>` : ""}
      <div class="actions"><button id="copy-address" class="primary" ${!copyReady ? "disabled" : ""}>复制地址</button><button id="next-address" class="secondary">下一个</button></div></section>`;
}

function addressesHtml(wallet: SavedWallet) {
  const items = snapshot?.addresses ?? Array.from({ length: wallet.descriptor.gapLimit }, (_, index) => deriveAddress(wallet.descriptor, index));
  const shorten = (address: string) => `${address.slice(0, 11)}…${address.slice(-10)}`;
  return `<section class="page-head address-page-head"><h1>收款地址</h1><p>点击行展开完整地址；二维码入口在展开后的操作里。</p></section>
    <section class="card address-list">${items.map((item) => {
      const used = snapshot?.used.includes(item.index) ?? false;
      const open = expandedAddress === item.index;
      return `<div class="address-row${open ? " expanded" : ""}" data-address-index="${item.index}">
        <button class="address-row-main" data-toggle="${item.index}" type="button" aria-expanded="${open}">
          <span class="index">#${item.index}</span>
          <code class="addr-short">${escapeHtml(shorten(item.address))}</code>
          <span class="status ${used ? "used" : ""}">${syncError ? "同步失败" : snapshot ? (used ? "已用" : "未用") : "未同步"}</span>
          <span class="address-chevron" aria-hidden="true">${open ? "⌃" : "⌄"}</span>
        </button>
        ${open ? `<div class="address-expanded"><code class="addr-full">${escapeHtml(item.address)}</code>
          <div class="address-expanded-actions"><button class="link-button" data-copy="${item.index}" type="button">复制完整地址</button><button class="link-button" data-index="${item.index}" type="button">收款二维码 ›</button></div></div>` : ""}
      </div>`;
    }).join("")}</section>`;
}

function stakingHtml(wallet: SavedWallet) {
  const state = staking;
  const address = state?.stakeAddress ?? rewardAddressOf(wallet.descriptor) ?? "此路径没有质押凭证";
  const pool = state?.delegatedPool;
  const epoch = state?.epoch;
  const elapsed = epoch ? Math.max(0, Math.floor(Date.now() / 1000) - epoch.tipTime) : 0;
  const absoluteSlot = epoch ? epoch.slot + elapsed : 0;
  const epochNumber = epoch ? epoch.number + Math.floor(absoluteSlot / 432_000) : 0;
  const slot = absoluteSlot % 432_000;
  const epochValid = !!epoch && elapsed <= 3_600;
  const progress = epochValid ? slot / 432_000 : 0;
  const secondsLeft = 432_000 - slot;
  const countdown = `${Math.floor(secondsLeft / 86400)} 天 ${Math.floor(secondsLeft % 86400 / 3600)} 小时`;
  const lifetimeRewards = state ? state.rewardsTotalLovelace : null;
  const lifetimeWithdrawals = state ? state.withdrawalsTotalLovelace : null;
  const withdrawalState = !state ? "—" : lifetimeWithdrawals === null ? "数据源未提供" : lifetimeWithdrawals > 0n
    ? `历史已提取 ${formatAda(lifetimeWithdrawals)} ADA` : "尚无奖励提取记录";
  return `<section class="staking-page"><div class="staking-title"><div><span class="eyebrow">WATCH ONLY · CARDANO</span><h1>质押奖励</h1></div><span class="staking-live">${stakingLoading ? "同步中…" : state ? "链上资料" : "尚未同步"}</span></div>
    ${state?.noStakeCredential ? `<section class="reward-hero" aria-label="无质押凭证"><div class="reward-center"><span class="reward-symbol">✦</span><span>此钱包没有质押凭证</span><strong>—</strong></div><p class="reward-epoch">Ledger 遗留 Byron 路径（m/44'）在 Shelley 之前，地址不带质押部分；这类钱包无法参与质押，也没有奖励可观察。</p></section>
      <p class="privacy-note">如需质押功能，请用 CIP-1852 标准路径创建新的单签观察钱包，或在桌面端使用多签钱包。</p></section>`
    : `${stakingError ? `<div class="staking-error" role="status">${escapeHtml(stakingError)}${state ? " · 以下是上次成功同步的数据" : ""}</div>` : ""}
    <section class="reward-hero" aria-label="质押奖励与纪元进度">
      <svg class="reward-arc" viewBox="0 0 320 190" role="img" aria-label="${epochValid ? `第 ${epochNumber} 纪元已过 ${(progress * 100).toFixed(0)}%` : "纪元进度暂不可用"}"><defs><linearGradient id="reward-gradient"><stop stop-color="#9a75f2"/><stop offset=".55" stop-color="#67b4ef"/><stop offset="1" stop-color="#5bd2cf"/></linearGradient></defs><path d="M 25 165 A 135 135 0 0 1 295 165" fill="none" stroke="#e9eef4" stroke-width="21" stroke-linecap="round"/><path d="M 25 165 A 135 135 0 0 1 295 165" fill="none" stroke="url(#reward-gradient)" stroke-width="21" stroke-linecap="round" stroke-dasharray="${(progress * 424).toFixed(1)} 424"/></svg>
      <div class="reward-center"><span class="reward-symbol">✦</span><span>可领取奖励</span><strong>${state ? formatAda(state.rewardsLovelace) : "—"}<small> ADA</small></strong></div>
      <p class="reward-epoch">${epochValid ? `第 ${epochNumber} 纪元 · 已过 ${(progress * 100).toFixed(1)}% · 距下个纪元约 ${countdown}` : "纪元进度暂不可用，下拉刷新"}</p>
    </section>
    <section class="staking-metrics"><div><span>钱包 ADA 余额</span><strong>${snapshot ? formatAda(snapshot.balance) : "—"}</strong><small>ADA · 并非链上 active stake</small></div><div><span>当前矿池</span><strong>${pool ? escapeHtml(state?.poolTicker || "已委托") : state ? "未委托" : "—"}</strong><small>${pool ? escapeHtml(state?.poolName || "矿池名称未提供") : "只读观察"}</small></div></section>
    <section class="staking-section"><div class="staking-section-head"><h2>下一纪元</h2><span>${epochValid ? `约 ${countdown} 后` : "—"}</span></div><div class="staking-event"><span class="staking-event-dot"></span><div><strong>纪元边界</strong><small>不等于奖励到账；奖励金额无法可靠预知</small></div><span class="staking-event-end">${epochValid ? `#${epochNumber + 1}` : "—"}</span></div></section>
    <section class="staking-section staking-details"><h2>链上详情</h2><div class="detail"><span>质押账户</span><strong>${state ? state.registered ? "已注册" : "未注册" : "尚未同步"}</strong></div><div class="detail"><span>历史累计奖励</span><strong>${lifetimeRewards === null || lifetimeRewards === undefined ? "数据源未提供" : `${formatAda(lifetimeRewards)} ADA`}</strong></div><div class="detail"><span>奖励提取状态</span><strong>${withdrawalState}</strong></div>${pool ? `<div class="staking-long"><span>矿池 ID</span><code>${escapeHtml(pool)}</code></div>` : ""}<div class="staking-long"><span>质押地址</span><code>${escapeHtml(address)}</code></div><p class="staking-updated">${state ? `更新于 ${new Date(state.syncedAt).toLocaleString("zh-CN")}` : "打开此页后自动同步"}</p></section>
    <p class="privacy-note">手机只读，不能委托或提取奖励。首次委托通常需要多个纪元才可能收到奖励，也不保证每轮都有。余额是钱包 UTXO 总额，不等于链上 active stake；质押操作仍须在桌面端经 M-of-N 签名。</p></section>`}`;
}

function walletDetailsHtml(wallet: SavedWallet) {
  const d = wallet.descriptor;
  const single = d.format === "cardano-hd-single";
  return `<div class="details-scroll"><p class="details-intro">只读模式 · 无私钥 · 无签名能力</p>
    <section class="card settings-card"><div class="detail wallet-name-row"><span>钱包名称</span><strong>${escapeHtml(wallet.name)}</strong><button id="rename-wallet" class="link-button" type="button">修改</button></div>
      <form id="rename-wallet-form" class="rename-wallet-form" hidden><label>新名称<input name="name" value="${escapeHtml(wallet.name)}" maxlength="50" autocomplete="off" required></label>
        <div class="actions"><button class="primary" type="submit">保存名称</button><button id="cancel-rename" class="secondary" type="button">取消</button></div></form>
      <div class="detail"><span>网络</span><strong>${d.network === "mainnet" ? "Mainnet" : "Preprod"}</strong></div><div class="detail"><span>策略</span><strong>${single ? (d.derivation === "legacy44" ? "单签 · Ledger 遗留 Byron" : "单签 · CIP-1852") : `${d.threshold} of ${d.cosigners.length}`}</strong></div><div class="detail"><span>账户路径</span><strong>${single ? (d.derivation === "legacy44" ? "m/44'/1815'/0'" : "m/1852'/1815'/0'") : "m/1854'/1815'/0'"}</strong></div><div class="detail"><span>地址间隔</span><strong>${d.gapLimit}</strong></div></section>
    <section class="card settings-card"><div class="section-title"><h2>${single ? "账户公钥" : "签名者公钥"}</h2></div>${single ? `<div class="cosigner"><strong>${d.derivation === "legacy44" ? "Ledger 遗留 m/44'" : "CIP-1852"}</strong><small>${escapeHtml(d.accountXpub)}</small></div>` : d.cosigners.map((s, i) => `<div class="cosigner"><strong>${i + 1}. ${escapeHtml(s.name)}</strong><small>${escapeHtml(s.accountXpub)}</small></div>`).join("")}</section>
    <section class="card settings-card"><div class="settings-group-title">应用偏好</div>
      <div class="detail"><span>法币估值（USD / CNY）</span><button id="fiat-toggle" class="link-button">${fiatEnabled ? "已开启" : "已关闭"}</button></div>
      <div class="detail"><span>隐藏未登记资产</span><button id="hide-unlisted-toggle" class="link-button" role="switch" aria-checked="${hideUnlistedAssets}">${hideUnlistedAssets ? "已开启" : "已关闭"}</button></div>
      <p class="privacy-note">仅影响首页资产列表和估值；交易记录仍完整。Token Registry 登记不代表发行方身份已获认证。</p>
      <div class="detail"><span>当前钱包后台动账通知</span>${notifyToggleHtml()}</div>
      <div class="detail"><span>切换标签时震动</span><button id="haptic-toggle" class="link-button" role="switch" aria-checked="${hapticsEnabled}">${hapticsEnabled ? "已开启" : "已关闭"}</button></div>
      <div class="haptic-control"><div><label for="haptic-strength">触感力度</label><strong id="haptic-value">${hapticStrength}%</strong></div><input id="haptic-strength" type="range" min="10" max="100" step="5" value="${hapticStrength}" ${hapticsEnabled ? "" : "disabled"}><button id="haptic-test" class="link-button" ${hapticsEnabled ? "" : "disabled"}>试一下</button></div>
      <div class="detail"><span>数据源</span><strong>${activeProvider(d.network) === "blockfrost" ? "Blockfrost" : "Koios"}</strong></div>
      <div class="provider-mode-row">
        <button class="link-button provider-mode${getProviderMode() === "auto" ? " selected" : ""}" data-provider-mode="auto" type="button">自动</button>
        <button class="link-button provider-mode${getProviderMode() === "koios" ? " selected" : ""}" data-provider-mode="koios" type="button">仅 Koios</button>
        <button class="link-button provider-mode${getProviderMode() === "blockfrost" ? " selected" : ""}" data-provider-mode="blockfrost" type="button">仅 Blockfrost</button>
      </div>${single ? `
      <div class="detail"><span>派生路径</span><strong>${d.derivation === "legacy44" ? "Ledger 遗留 Byron m/44'" : "CIP-1852 标准"}</strong><button id="derivation-switch" class="link-button" type="button">切换</button></div>` : ""}
      <form id="bf-form" class="bf-form"><label>备用数据源 Blockfrost（选填，Koios 故障时自动切换）<div class="form-grid">
        <span>主网 Project ID<input name="mainnet" autocapitalize="off" spellcheck="false" placeholder="mainnet…"></span>
        <span>测试网 Project ID<input name="preprod" autocapitalize="off" spellcheck="false" placeholder="preprod…"></span></div></label>
        <button class="link-button" type="submit">保存备用源</button><a class="hint" href="https://blockfrost.io" target="_blank" rel="noopener noreferrer">blockfrost.io 免费注册（每网络一个 project，5 万请求/天）↗</a></form>
    </section>
    <section class="settings-actions"><button id="export-descriptor" class="secondary">导出 descriptor</button><button id="remove-wallet" class="danger">移除手机中的钱包</button></section>
    <p class="privacy-note">估值来自 CoinGecko/OKX/Binance/Coinbase/Kraken 公开行情（多源自动切换），人民币用欧洲央行汇率换算；USDCx 优先使用 Minswap 官方资产指标，其他主网 CNT 使用 DEX Screener。两者均要求完整资产 ID、可信小数位以及流动性和成交量达到门槛。价格可能延迟或失真，不代表可成交金额；关闭估值后不请求价格。报价查询会暴露公开资产 ID，不发送地址或余额。仅当前钱包会被后台观察；iOS 低频唤醒检查 Koios，不保证实时，也不能作为资金安全告警。公钥和 descriptor 保存在本机浏览器存储中，未加密。Koios 可看到查询的地址与资产 ID；余额与交易状态依赖 Koios，不能作为独立链上验证。</p></div>`;
}

async function drawQr(value: string, version: number) {
  const canvas = document.querySelector<HTMLCanvasElement>("#qr");
  if (!canvas) return;
  try {
    await QRCode.toCanvas(canvas, value, { width: 244, margin: 1, errorCorrectionLevel: "M",
      color: { dark: "#132b53", light: "#ffffff" } });
    if (version !== qrVersion || !receiveQrReady() || getReceiveAddress() !== value) { canvas.width = 0; canvas.height = 0; }
  } catch { notify("二维码生成失败", "error"); }
}

function bind() {
  document.querySelector("#back-history")?.addEventListener("click", backFromHistory);
  document.querySelectorAll<HTMLButtonElement>("[data-tx]").forEach((button) => button.addEventListener("click", () => {
    const hash = button.dataset.tx;
    if (!hash || !snapshot?.transactions.some((tx) => tx.hash === hash)) return;
    navigateHistory(() => { selectedTxHash = hash; render(); scrollMainTop(); }, "forward");
  }));
  document.querySelector("#add-wallet")?.addEventListener("click", openImport);
  document.querySelector("#wallet-details")?.addEventListener("click", openWalletDetails);
  document.querySelector("#start-import")?.addEventListener("click", openImport);
  document.querySelector("#wallet-picker")?.addEventListener("click", openPicker);
  document.querySelectorAll<HTMLButtonElement>("[data-go-tab]").forEach((button) => button.addEventListener("click", () => {
    tab = button.dataset.goTab as Tab; render(); scrollMainTop();
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => button.addEventListener("click", () => {
    tab = button.dataset.tab as Tab; render(); scrollMainTop();
    if (tab === "staking") { void refreshStaking(); if (!snapshot) void refresh(); }
  }));
  document.querySelector("#currency-toggle")?.addEventListener("click", () => {
    fiatCurrency = fiatCurrency === "usd" ? "cny" : "usd";
    localStorage.setItem("cardano-watch-currency", fiatCurrency);
    render();
  });
  document.querySelector("#open-history")?.addEventListener("click", openHistory);
  document.querySelectorAll<HTMLButtonElement>("[data-asset]").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.asset) openAssetDetail(button.dataset.asset);
  }));
  document.querySelector("#open-staking")?.addEventListener("click", () => {
    tab = "staking"; render(); scrollMainTop(); void refreshStaking();
  });
  document.querySelector("#refresh-staking")?.addEventListener("click", () => void refreshStaking(true));
  document.querySelector("#verify-address")?.addEventListener("click", openReceiveVerification);
  document.querySelector("#copy-address")?.addEventListener("click", async () => {
    if (!receiveCopyReady()) return notify("请先同步并独立核对这个完整地址");
    try { await navigator.clipboard.writeText(getReceiveAddress()); notify("地址已复制，请再次核对目标地址"); }
    catch { notify("复制失败，请长按地址手动复制", "error"); }
  });
  document.querySelector("#next-address")?.addEventListener("click", () => {
    if (receiveIndex >= 99) return notify("已达到当前最多 100 个地址的扫描上限");
    receiveIndex++; render();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-toggle]").forEach((button) => button.addEventListener("click", () => {
    const index = Number(button.dataset.toggle);
    expandedAddress = expandedAddress === index ? null : index;
    render();
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((button) => button.addEventListener("click", () => {
    const item = snapshot?.addresses.find((row) => row.index === Number(button.dataset.copy)) ??
      active()?.descriptor ? deriveAddress(active()!.descriptor, Number(button.dataset.copy)) : null;
    if (!item) return notify("地址已失效，请重新同步", "error");
    void navigator.clipboard.writeText(item.address)
      .then(() => notify("完整地址已复制，请再次核对"))
      .catch(() => notify("复制失败，请长按地址手动复制", "error"));
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-index]").forEach((button) => button.addEventListener("click", () => {
    receiveIndex = Number(button.dataset.index); tab = "receive"; render();
  }));
}

function openReceiveVerification() {
  const wallet = active();
  if (!wallet || !snapshot || syncError || loading || snapshot.used.includes(receiveIndex)) return;
  const index = receiveIndex;
  const address = getReceiveAddress();
  if (snapshot.addresses[index]?.address !== address) return notify("地址校验失败，已停止显示二维码", "error");
  showSheet(`<div class="sheet-head"><h2>独立核对收款地址</h2><button class="sheet-close">取消</button></div>
    <p class="verify-warning">在另一台可信设备上，独立计算 #${index} 的完整地址。${wallet.descriptor.format === "cardano-hd-single" ? "核对 Ledger 上的 CIP-1852 公钥与路径；不要把同一 App 的显示结果当作独立核验。" : "使用独立地址核对器、已核实的三个 Ledger 公钥和相同 descriptor。"}不要从本页复制地址再粘贴回来冒充核对。</p>
    <p class="hint">网络：${wallet.descriptor.network === "mainnet" ? "Mainnet" : "Preprod"} · 策略：${wallet.descriptor.format === "cardano-hd-single" ? (wallet.descriptor.derivation === "legacy44" ? "单签 · Ledger 遗留" : "单签") : `${wallet.descriptor.threshold} of ${wallet.descriptor.cosigners.length}`} · 路径：m/${wallet.descriptor.format === "cardano-hd-single" ? (wallet.descriptor.derivation === "legacy44" ? "44'" : "1852'") : "1854'"}/1815'/0'/0/${index}</p>
    <form id="verify-form"><label>输入另一设备算出的完整地址<textarea name="expected" rows="4" autocapitalize="off" autocomplete="off" spellcheck="false" required></textarea></label>
      <button class="primary full" type="submit">完整地址一致，启用复制</button></form>`, (dialog) => {
    dialog.querySelector<HTMLFormElement>("#verify-form")!.onsubmit = (event) => {
      event.preventDefault();
      try {
        if (activeId !== wallet.id || receiveIndex !== index || !snapshot || syncError || loading || snapshot.used.includes(index) || snapshot.addresses[index]?.address !== address)
          throw new Error("钱包、地址或同步状态已变化，请重新核对");
        const expected = String(new FormData(event.currentTarget as HTMLFormElement).get("expected") ?? "");
        verifyReceiveAddress(wallet.descriptor, index, expected);
        verifiedReceive = { walletId: wallet.id, index, address };
        closeSheet(dialog); render();
      } catch (error) { alert(error instanceof Error ? error.message : "核对失败，请勿入金"); }
    };
  });
}

function showSheet(content: string, onReady: (dialog: HTMLDialogElement) => void) {
  const dialog = document.createElement("dialog"); dialog.className = "sheet";
  dialog.innerHTML = content;
  document.body.append(dialog);
  dialog.addEventListener("close", () => {
    window.webkit?.messageHandlers?.modal?.postMessage({ open: false });
    dialog.remove();
  }, { once: true });
  dialog.querySelector(".sheet-close")?.addEventListener("click", () => closeSheet(dialog));
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeSheet(dialog); });
  onReady(dialog); dialog.showModal();
  const heading = dialog.querySelector<HTMLElement>(".sheet-head h2");
  if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  window.webkit?.messageHandlers?.modal?.postMessage({ open: true });
}

function closeSheet(dialog: HTMLDialogElement) {
  if (!dialog.open || dialog.classList.contains("sheet-leaving")) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { dialog.close(); return; }
  dialog.classList.add("sheet-leaving");
  window.setTimeout(() => { if (dialog.open) dialog.close(); }, 210);
}

function openWalletDetails() {
  const wallet = active(); if (!wallet) return;
  showSheet(`<div class="sheet-head"><h2>设置</h2><button class="sheet-close">完成</button></div>${walletDetailsHtml(wallet)}`, (dialog) => {
    dialog.classList.add("settings-sheet");
    const renameButton = dialog.querySelector<HTMLButtonElement>("#rename-wallet")!;
    const renameForm = dialog.querySelector<HTMLFormElement>("#rename-wallet-form")!;
    const nameInput = renameForm.elements.namedItem("name") as HTMLInputElement;
    renameButton.onclick = () => { renameButton.hidden = true; renameForm.hidden = false; nameInput.focus(); nameInput.select(); };
    dialog.querySelector("#cancel-rename")?.addEventListener("click", () => {
      nameInput.value = wallet.name; renameForm.hidden = true; renameButton.hidden = false;
    });
    renameForm.onsubmit = (event) => {
      event.preventDefault();
      if (activeId !== wallet.id) return alert("当前钱包已变化，请重新打开钱包详情");
      const name = nameInput.value.trim();
      if (!name || name.length > 50) return alert("钱包名称须为 1–50 个字符");
      const previous = wallet.name;
      wallet.name = name;
      try { save(); }
      catch { wallet.name = previous; return alert("钱包名称保存失败，请重试"); }
      closeSheet(dialog); notify("钱包名称已更新");
    };
    dialog.querySelector("#fiat-toggle")?.addEventListener("click", () => {
      fiatEnabled = !fiatEnabled;
      localStorage.setItem("cardano-watch-fiat", fiatEnabled ? "on" : "off");
      if (fiatEnabled) void loadFiatPrice().then((loaded) => { price = loaded; render(); });
      if (fiatEnabled && snapshot) void refreshAssetData(wallet, snapshot, syncRequestId);
      (dialog.querySelector("#fiat-toggle") as HTMLButtonElement).textContent = fiatEnabled ? "已开启" : "已关闭";
      render();
    });
    dialog.querySelector<HTMLButtonElement>("#hide-unlisted-toggle")?.addEventListener("click", (event) => {
      hideUnlistedAssets = !hideUnlistedAssets;
      localStorage.setItem("cardano-watch-hide-unlisted-assets", hideUnlistedAssets ? "on" : "off");
      const button = event.currentTarget as HTMLButtonElement;
      button.textContent = hideUnlistedAssets ? "已开启" : "已关闭";
      button.setAttribute("aria-checked", String(hideUnlistedAssets));
      render();
    });
    const hapticToggle = dialog.querySelector<HTMLButtonElement>("#haptic-toggle")!;
    const hapticSlider = dialog.querySelector<HTMLInputElement>("#haptic-strength")!;
    const hapticTest = dialog.querySelector<HTMLButtonElement>("#haptic-test")!;
    hapticToggle.onclick = () => {
      hapticsEnabled = !hapticsEnabled;
      localStorage.setItem("cardano-watch-haptics", hapticsEnabled ? "on" : "off");
      hapticToggle.textContent = hapticsEnabled ? "已开启" : "已关闭";
      hapticToggle.setAttribute("aria-checked", String(hapticsEnabled));
      hapticSlider.disabled = hapticTest.disabled = !hapticsEnabled;
      syncHaptics();
    };
    hapticSlider.oninput = () => {
      hapticStrength = Number(hapticSlider.value);
      localStorage.setItem("cardano-watch-haptic-strength", String(hapticStrength));
      dialog.querySelector("#haptic-value")!.textContent = `${hapticStrength}%`;
      syncHaptics();
    };
    hapticTest.onclick = () => syncHaptics(true);
    dialog.querySelectorAll<HTMLButtonElement>("[data-provider-mode]").forEach((button) => button.addEventListener("click", () => {
      setProviderMode(button.dataset.providerMode as "auto" | "koios" | "blockfrost");
      invalidateSync();
      dialog.querySelectorAll<HTMLButtonElement>("[data-provider-mode]").forEach((b) =>
        b.classList.toggle("selected", b.dataset.providerMode === button.dataset.providerMode));
      notify(button.dataset.providerMode === "auto" ? "数据源：自动（Koios 故障时切换 Blockfrost）"
        : button.dataset.providerMode === "koios" ? "数据源：仅 Koios" : "数据源：仅 Blockfrost");
      render();
      void refresh(true);
    }));
    dialog.querySelector("#derivation-switch")?.addEventListener("click", () => {
      const descriptor = wallet.descriptor;
      if (descriptor.format !== "cardano-hd-single") return;
      const next = descriptor.derivation === "legacy44" ? "cip1852" : "legacy44";
      if (!confirm(`把此钱包的派生路径切换为 ${next === "legacy44" ? "Ledger 遗留 Byron m/44'" : "CIP-1852 标准"}？将清空本地快照并重新同步；地址会完全变化。`)) return;
      descriptor.derivation = next;
      wallet.id = descriptorId(descriptor);
      activeId = wallet.id;
      localStorage.setItem("cardano-watch-active-wallet-v1", activeId);
      invalidateSync();
      save(); verifiedReceive = null; snapshot = null; syncError = false; staking = null; stakingError = "";
      closeSheet(dialog); render(); void refresh();
      notify("派生路径已切换，正在按新路径重新同步");
    });
    dialog.querySelector<HTMLFormElement>("#bf-form")!.onsubmit = (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget as HTMLFormElement);
      const saved = setBlockfrostKeys({ mainnet: String(data.get("mainnet") ?? ""), preprod: String(data.get("preprod") ?? "") });
      const inputs = event.currentTarget as HTMLFormElement;
      inputs.mainnet.value = saved.mainnet ?? "";
      inputs.preprod.value = saved.preprod ?? "";
      notify(saved.mainnet || saved.preprod ? "备用数据源已保存，Koios 故障时自动切换" : "已清空备用数据源");
      render();
    };
    const bfInputs = dialog.querySelector<HTMLFormElement>("#bf-form");
    if (bfInputs) {
      const keys = getBlockfrostKeys();
      bfInputs.mainnet.value = keys.mainnet ?? "";
      bfInputs.preprod.value = keys.preprod ?? "";
    }
    dialog.querySelector("#notify-toggle")?.addEventListener("click", async () => {
      const bridge = window.webkit?.messageHandlers?.notifications;
      const button = dialog.querySelector<HTMLButtonElement>("#notify-toggle");
      if (!bridge || !button) return;
      button.disabled = true;
      try {
        if (!activityNotifyEnabled) {
          if (!snapshot || syncError || loading) { notify("请先成功同步当前钱包，再开启后台动账通知", "error"); return; }
          const granted = await bridge.postMessage({ action: "requestPermission" });
          if (granted !== true) { notify("未获得通知权限；请在系统设置里允许 Cardano Watch 通知", "error"); return; }
          activityNotifyEnabled = true;
          try { await syncActivityWatch(snapshot); }
          catch (error) { activityNotifyEnabled = false; throw error; }
        } else {
          await unregisterActivityWatch();
          activityNotifyEnabled = false;
        }
        localStorage.setItem("cardano-watch-notify", activityNotifyEnabled ? "on" : "off");
        button.textContent = activityNotifyEnabled ? "已开启" : "已关闭";
        render();
        notify(activityNotifyEnabled ? "动账通知已开启：系统会低频后台检查，不保证实时" : "动账通知已关闭");
      } catch {
        notify("通知设置失败，请重试", "error");
      } finally { button.disabled = false; }
    });
    dialog.querySelector("#export-descriptor")?.addEventListener("click", () => {
      const contents = JSON.stringify(wallet.descriptor, null, 2);
      if (window.webkit?.messageHandlers?.exportDescriptor) {
        window.webkit.messageHandlers.exportDescriptor.postMessage({ contents });
        return;
      }
      const blob = new Blob([contents], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = "cardano-watch-descriptor.json"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    dialog.querySelector("#remove-wallet")?.addEventListener("click", () => {
      if (!confirm(`从这台手机移除“${wallet.name}”？不会影响链上资金。`)) return;
      if (!confirm("请再次确认：移除本机保存的公钥和钱包记录？")) return;
      invalidateSync();
      wallets = wallets.filter((item) => item.id !== wallet.id); save(); activeId = wallets[0]?.id ?? ""; localStorage.setItem("cardano-watch-active-wallet-v1", activeId); verifiedReceive = null;
      void unregisterActivityWatch(wallet.id).catch(() => {});
      snapshot = null; syncError = false; staking = null; stakingError = ""; stakingRequestId++; stakingLoading = false;
      tab = "home"; historyOpen = false; closeSheet(dialog); render();
      if (activeId) void refresh();
    });
  });
}

function openPicker() {
  showSheet(`<div class="sheet-head"><h2>切换钱包</h2><button class="sheet-close">完成</button></div><div class="picker-list">${wallets.map((item) => `<button data-wallet="${escapeHtml(item.id)}"><strong>${escapeHtml(item.name)}</strong><small>${item.descriptor.format === "cardano-hd-single" ? (item.descriptor.derivation === "legacy44" ? "单签 · Ledger 遗留" : "单签 · CIP-1852") : `${item.descriptor.threshold} of ${item.descriptor.cosigners.length}`} · ${item.descriptor.network}</small></button>`).join("")}</div><button id="picker-add" class="primary full">＋ 添加观察钱包</button>`, (dialog) => {
    dialog.querySelectorAll<HTMLButtonElement>("[data-wallet]").forEach((button) => button.addEventListener("click", () => {
      const previousId = activeId;
      invalidateSync();
      activeId = button.dataset.wallet!; localStorage.setItem("cardano-watch-active-wallet-v1", activeId); verifiedReceive = null; snapshot = null; syncError = false; staking = null; stakingError = "";
      if (previousId !== activeId) void unregisterActivityWatch(previousId).catch(() => {});
      stakingRequestId++; stakingLoading = false; tab = "home"; historyOpen = false;
      closeSheet(dialog); render(); void refresh();
    }));
    dialog.querySelector("#picker-add")?.addEventListener("click", () => { closeSheet(dialog); window.setTimeout(openImport, 220); });
  });
}

function openImport() {
  showSheet(`<div class="sheet-head"><h2>添加观察钱包</h2><button class="sheet-close">取消</button></div>
    <div class="mode-row"><button id="mode-file" class="active">导入 descriptor</button><button id="mode-single">单签 xpub</button></div>
    <div id="file-mode"><label class="file-target">选择桌面版导出的 descriptor JSON<input id="descriptor-file" type="file" accept=".json,application/json"></label>
      <p class="hint">多签钱包只能通过桌面端导出的 descriptor 文件导入——文件里包含全部签名者公钥与阈值，顺序不会错。</p></div>
    <form id="single-mode" hidden><label>钱包名称<input name="name" value="Cardano 单签" required maxlength="50"></label>
      <label>网络<select name="network"><option value="mainnet">Mainnet</option><option value="preprod">Preprod</option></select></label>
      <label>派生路径<select name="derivation">
        <option value="cip1852">CIP-1852 标准（Ledger Live / Yoroi / Lace）</option>
        <option value="legacy44">Ledger 遗留 Byron（AdaLite 旧版）m/44'</option>
      </select></label>
      <label>扩展账户公钥（xpub / acct_xvk 开头）<textarea name="xpub" rows="5" autocapitalize="off" spellcheck="false" placeholder="xpub1…" required></textarea></label>
      <p class="hint">标准路径 m/1852'/1815'/0'：扫描收款 role 0 与找零 role 1，质押公钥 role 2；遗留路径 m/44'/1815'/0'：仅收款链，企业地址（addr1v…），无质押凭证。Ledger Live 等导出的账户公钥通常为 xpub1… 开头，acct_xvk1… 同样接受；不是 acct_shared_xvk，也不支持自定义账户序号。</p>
      <button class="primary full" type="submit">创建单签观察钱包</button></form>`, (dialog) => {
    const fileMode = dialog.querySelector<HTMLElement>("#file-mode")!;
    const singleMode = dialog.querySelector<HTMLFormElement>("#single-mode")!;
    const fileButton = dialog.querySelector<HTMLButtonElement>("#mode-file")!;
    const singleButton = dialog.querySelector<HTMLButtonElement>("#mode-single")!;
    const toggle = (mode: "file" | "single") => {
      fileMode.hidden = mode !== "file"; singleMode.hidden = mode !== "single";
      fileButton.classList.toggle("active", mode === "file"); singleButton.classList.toggle("active", mode === "single");
    };
    fileButton.onclick = () => toggle("file"); singleButton.onclick = () => toggle("single");
    dialog.querySelector<HTMLInputElement>("#descriptor-file")!.onchange = async (event) => {
      const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
      try {
        if (file.size > 100_000) throw new Error("descriptor 文件过大");
        const descriptor = validateDescriptor(JSON.parse(await file.text()));
        addWallet(file.name.replace(/\.json$/i, ""), descriptor); closeSheet(dialog);
      } catch (error) { alert(error instanceof Error ? error.message : "导入失败"); }
    };
    singleMode.onsubmit = (event) => {
      event.preventDefault();
      const data = new FormData(singleMode);
      try {
        const descriptor = validateDescriptor({ format: "cardano-hd-single", version: 1,
          network: data.get("network"), account: 0, gapLimit: 20,
          derivation: data.get("derivation") === "legacy44" ? "legacy44" : "cip1852",
          accountXpub: String(data.get("xpub") ?? "").trim() });
        addWallet(String(data.get("name") ?? "单签观察钱包"), descriptor); closeSheet(dialog);
      } catch (error) { alert(error instanceof Error ? error.message : "创建失败"); }
    };
  });
}

render();
syncHaptics();
let edgeStart: { x: number; y: number } | null = null;
window.addEventListener("touchstart", (event) => {
  const touch = event.touches[0];
  edgeStart = touch && touch.clientX <= 28 && !(event.target as Element).closest(".address-scroll,input,textarea")
    ? { x: touch.clientX, y: touch.clientY } : null;
}, { passive: true });
window.addEventListener("touchend", (event) => {
  if (!edgeStart) return;
  const touch = event.changedTouches[0];
  const start = edgeStart; edgeStart = null;
  if (!touch || touch.clientX - start.x < 75 || Math.abs(touch.clientY - start.y) > 55) return;
  const dialog = document.querySelector<HTMLDialogElement>("dialog.sheet[open]");
  if (dialog) closeSheet(dialog);
  else if (historyOpen) backFromHistory();
}, { passive: true });
if (active()) void refresh();
setInterval(() => { if (!document.hidden && active()) void refresh(); }, 120_000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && active() && (!snapshot || Date.now() - snapshot.syncedAt > 120_000)) void refresh();
});
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
