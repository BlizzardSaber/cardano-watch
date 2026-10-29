# Cardano Watch — iOS 只读观察钱包（桌面版 Cardano Sparrow 的 iPhone 配套）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **安全提示：** 本项目只读，不应接收助记词或私钥。主网大额入金前，请在独立设备或独立实现中复算完整收款地址，并先进行小额测试。

## 发布身份与下载验证

本项目与 Cardano Sparrow 使用同一套 Ed25519 发布身份。可信公钥指纹为：

```text
7579b1ba72cb31cd893040deba3301e03de7c7e27bf2df763ab75c8bfece7ea7
```

Release 中的源码包会同时附带 `MANIFEST-*.sha256`、`.sig` 和
`RELEASE-PUBLIC-KEY.pem`。普通 SHA-256 只能发现文件变化；Ed25519 签名还会验证
清单确实由上述发布身份签发。首次使用前，应从另一可信位置独立保存并核对该指纹。

当前版本 **0.2.6**。只读的 Cardano 观察钱包：支持 CIP-1854 M-of-N 多签与单签（CIP-1852 / Ledger 遗留 Byron m/44'）两种钱包，查看余额、代币与法币估值、交易历史、收款地址二维码和质押观察。**没有签名、广播或导出私钥能力，任何时候都不在手机上输入助记词。**

多签派生与桌面端 0.3.4+ 完全一致（`m/1854'/1815'/account'/role/index`，Base Address = 支付脚本 role 0 + 质押脚本 role 2），已用固定向量 + Preprod 实测地址逐字节比对验证；单签 CIP-1852 为标准派生（`m/1852'/1815'/0'`，收款 role 0 + 找零 role 1 + 质押 role 2）。

## 功能总览

| 模块 | 说明 |
| --- | --- |
| 多签观察 | 仅通过桌面端导出的 descriptor 文件导入（含全部签名者公钥与阈值，顺序不会错） |
| 单签观察 | 导入 acct_xvk，可选派生路径：CIP-1852 标准（Ledger Live/Yoroi/Lace，Base 地址带质押）或 Ledger 遗留 Byron m/44'（AdaLite 旧版，企业地址 addr1v…，无质押凭证、无找零链） |
| 法币估值 | USD/CNY 切换。ADA/NIGHT 报价源冗余链：CoinGecko → OKX → Binance → Coinbase → Kraken；CNY 缺失时用 Frankfurter 换算。USDCx 优先使用 Minswap 官方资产指标并严格核对身份，DEX Screener 为回退；其他 CNT 仍需可信小数位及流动性/成交量达标才显示参考价 |
| 资产筛选 | 设置中可隐藏未登记资产；仅影响首页资产列表与对应估值，交易记录不隐藏。USDCx 使用固定资产 ID 与应用内置的 Token Registry 图标。Token Registry 登记不等于发行方身份认证。 |
| 打开即显示 | 价格与链上快照（余额/UTXO/交易）持久缓存：重开 App 首屏立即显示上次结果并标注"正在同步/上次价格"，后台刷新后原位替换；无数据时低调显示 "—"，不再弹"暂无可靠报价" |
| 数据源冗余 | 默认 Koios（api.koios.rest 官方负载均衡；2026 年各区域实例已收敛为单域名）。可在设置填 Blockfrost 备用源（免费注册，每网络一个 project id，5 万请求/天）：Koios 故障（网络错误/5xx/429）自动切换并记住偏好，两源数据走同一套校验聚合，口径一致 |
| 交易历史 | 最近 100 笔先显示 TXID 与时间，输入输出、资产变动与手续费后台逐批补齐；详情未加载时明确提示，提供 cardanoscan 核对链接 |
| 收款地址 | 二维码 + 完整地址；逐地址独立核对（另一设备算出的完整地址一致才启用一键复制）。地址页为缩写行 + 点击展开完整地址（自动换行，不横拖），展开内提供复制与二维码入口 |
| 质押观察 | 可领奖励、纪元进度弧、矿池信息、质押地址；参与质押的余额与桌面端同口径（钱包 UTXO 总额）。Ledger 遗留路径显示"无质押凭证" |
| 动账通知 | App 退后台后 iOS 低频唤醒（最早 15 分钟，系统调度不保证实时）批量检查 Koios，UTXO 指纹变化发本地通知；前台看到过的交易不重复提醒 |
| 界面 | 原生 Tab + 毛玻璃设计语言：顶栏钉住，下拉刷新指示器固定在顶栏下方；上滑时快捷操作收起、资产条与顶栏融合成液态玻璃（玻璃背景在独立合成层，规避 Safari backdrop-filter 文字消失 bug）；错误提示为顶部红色横幅；触感反馈可调；图标与桌面端同源（亮/暗/色调三变体，iOS 18+ 自动切换） |

## 三种使用方式

### 方式 A（推荐）：Xcode 原生壳

内置 `ios/CardanoWatch.xcodeproj`：WKWebView 经自定义 scheme `cardanowatch://app` 加载本地打包页面；Koios / Blockfrost / 价格源请求全部经原生白名单桥转发（只读端点与固定 URL 白名单，不接受任意地址），页面资源本地化，不外联（除 cardanoscan 链接）。

1. （仅新机器）`sudo xcodebuild -license` && `xcodebuild -runFirstLaunch`
2. `npm ci && npm run ios:prepare`
3. 双击打开 `ios/CardanoWatch.xcodeproj` → Signing 选择自己的 Apple ID，并按需设置唯一 Bundle Identifier（免费证书通常 7 天后需要重新 Run）
4. iPhone 连线（首次需在 设置→通用→VPN与设备管理 信任开发者），点 Run

### 方式 B：局域网开发调试

```bash
npm install && npm run dev:lan   # 0.0.0.0:5173，内置 Koios 白名单代理（默认 dev 只绑 127.0.0.1）
```

### 方式 C：PWA（可选）

`npm run build` 后把 `dist/` 部署到自己的 https 域名再"添加到主屏幕"。不要用第三方未知托管。

## 数据与隐私

- 公钥、descriptor、快照与价格缓存保存在手机 localStorage（未加密）；卸载 App 即清除。
- 报价查询只暴露公开资产 ID，不发送地址或余额；Koios/Blockfrost 可看到查询的地址。
- 多钱包可切换、可改名；后台动账观察仅对当前钱包生效。
- 估值仅供展示，可能延迟或失真，不代表可成交金额。

## 安全边界（务必阅读）

- **只读**：无任何签名/广播能力，泄露面仅为观察数据。
- **收款地址是"本机显示"**：Ledger 不校对观察端地址。大额入金前按桌面版安全报告独立复算地址并小额试转；不要拿手机端与同来源桌面端互为"验证"。
- Koios/Blockfrost 是公共数据源，余额与交易状态不能作为独立链上验证；出金前的真实余额以桌面端 + Ledger 屏幕为准。
- 不要把主网 descriptor 随意发给他人（只含公钥，但暴露余额与地址）。

## 开发与验证

- `npm test`：vitest 42 项——多签/单签派生向量、价格源、DEX 报价门槛、Koios UTXO 精确分页与交易历史渐进加载、Blockfrost 转换、质押奖励口径与自动切换。
- `npm run ios:prepare`：构建 + 生成 sw.js + 同步 `dist/ → ios/CardanoWatch/Web/`。
- iOS 原生壳 E2E（XCUITest，`ios/CardanoWatchUITests/`）：

  ```bash
  xcodebuild test -project ios/CardanoWatch.xcodeproj -scheme CardanoWatch \
    -destination 'platform=iOS Simulator,name=iPhone 17' \
    -only-testing:CardanoWatchUITests CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual
  ```

  用确定性单签向量走完整链路：导入 → 同步 → 收款地址逐字节一致 → 独立核对 → 历史页 → 地址页展开完整地址 → 质押页 → 设置/重命名/导出分享面板；含"清理残留钱包"兜底。
- 后台通知调试（lldb 强制触发一次）：
  `e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"com.cardanosparrow.watch.refresh"]`
- 图标：`swift scripts/generate-ios-icons.swift [可选桌面端 icns 路径]`（内置 1024px 快照，生成亮/暗/色调三变体）。
- 真机测试需在 Xcode 连机 Run；通知频率受系统调度影响，只能在真机长期观察。

## 版本记录

- **0.2.6**：修复质押观察数据口径。Blockfrost 不再把最近一个纪元奖励误当作当前可领取奖励，改用账户的 `withdrawable_amount`；Koios/Blockfrost 均分别显示当前可领取、历史累计奖励和历史已提取奖励。修复 Blockfrost 最新区块 Unix 数字时间被按字符串解析导致纪元进度不可用；纪元边界跨越时进度会滚动到下一纪元，超过一小时未刷新则停止外推并提示刷新。无地址派生、私钥或签名功能变更。
- **0.2.5**：修复 DEX Screener 不再返回 USDCx Cardano 池后估值消失。精确 USDCx 资产优先使用 Minswap 官方资产指标接口，严格核对完整资产 ID、认证标记、小数位、流动性和成交量；DEX Screener 保留为回退。只缓存有效报价五分钟，空结果不缓存；原生桥仅允许固定 Minswap URL。无地址派生、余额同步或签名相关变更。
- **0.2.4**：主页 ADA 数量和总资产估值计入已同步的可领取质押奖励，ADA 行标出奖励数量。奖励尚未同步时明确提示；UTXO 变化会强制重查奖励，避免提款后短暂重复计入。提款前奖励仍不属于 UTXO。无地址派生和签名相关变更。
- **0.2.3**：增加隐藏未登记资产选项，开关只影响首页资产列表和估值，不影响交易历史和链上同步。将精确资产 ID 对应的 USDCx Token Registry PNG 打包在本地，启动时即可显示；同名代币不会借用图标。PWA 离线缓存同时包含币种图标。无地址派生和签名相关变更。
- **0.2.2**：修复 Koios 批量地址请求超过约 5 KB 后返回 413：地址发现、UTXO 和历史列表一律每 20 个地址分批；各批 UTXO 完整校验后合并，交易历史按时间合并去重取最近 100 笔。修复“仅 Blockfrost”失败却回退 Koios、报错误导的问题；切换数据源会中止旧结果并立即重试。Blockfrost 核心同步不再等待最多 100 笔交易详情，其 `/txs/{hash}/utxos` 按官方对象结构解析，明细后台加载。余额不足完整性校验时仍拒绝显示。此次变动不涉及地址派生或私钥。
- **0.2.1**：修复原生桥忽略 `count=planned` 导致大历史钱包仍做昂贵精确计数；已用地址改用 `/address_info?select=address`，不再遍历全部历史输出；余额与最近 100 条交易先显示，交易详情在后台逐批补齐，失败项保留“待加载”而不伪报金额。Blockfrost 地址探测限并发，UTXO 超出扫描上限时拒绝显示不完整余额。缓存已校验的 Token Registry PNG 图标，USDCx 重开即显示；读取缓存时重新校验格式。
- **0.2.0**（基线为 0.1.22，未再升号）
  - 大钱包同步优化初版：交易列表拟改 `count=planned`，但原生桥当时仍强制 `count=exact`，已于 0.2.1 修复。
  - 数据源三态：设置里可选 自动（默认，Koios 故障切 Blockfrost）/ 仅 Koios / 仅 Blockfrost（失败回落 Koios），选择持久化
  - 记住上次查看的钱包：重开 App 不再回到第一个钱包（含老数据兜底）
  - 缓存补全：资产元数据（decimals/ticker/name）持久化——重开 App 币种数量与格式立即可用，价格与快照此前已缓存；logo 从 0.2.1 起一并缓存。
  - 单签钱包可在设置里手动切换派生路径（CIP-1852 ↔ Ledger 遗留 44'，确认后清快照重新同步）；原生 Koios 桥超时 20s→60s（大账户慢查询此前被误报为超时；Ledger Live 导出 xpub 的正确路径即 CIP-1852 默认值）
  - 总览默认态上下一体：顶栏透明融入整页渐变（去白玻璃横幅与底边线）、快捷操作去卡底，未上滑时整页浑然一块；上滑后玻璃浮条才显现并覆盖顶栏+资产区
  - 限频治理：自动轮询失败静默（继续显示上次快照，不再弹红条）；429 后自动冷却 5 分钟不再撞限频；手动下拉失败才提示，并引导配置 Blockfrost 备用源（配置后 429 自动切换渠道）
  - 主页视觉统一：代币区去卡片化（透明融入整页渐变背景，与总览区底色一致，行间细线分隔）；上滑收拢回到纯 CSS transition（真机 WKWebView scroll 事件节流导致 JS 插值跳变）；底部为悬浮标签栏恢复 84px 让位（此前 12px 导致内容/按钮被标签栏遮挡）
  - 头部收拢改为 Vespr 式跟手插值：scrollTop 0→60px 连续映射收缩（快捷操作高度、资产条内边距与字号、透明度），滚动本身即动画；玻璃在收拢过半淡入。资产列表保底可滚 44px——空钱包也能上推触发收拢（修复"推不了/无玻璃"：此前底部留白收紧后空内容不满一屏导致不可滚）
  - 代币图标自动化：读取 Cardano Token Registry 登记的 logo（Koios asset_info 同端点返回 base64 PNG，校验 PNG 魔数并限 96KB），USDCx 等已登记 CNT 自动显示官方图标，无需逐个内置；未登记代币仍显示 ◆ 占位
  - 去"网页感"：全局禁用点击灰色高亮、长按拷贝菜单/链接预览卡片、文本选择（地址与输入框单独放行）；底部留白收紧（内容紧贴悬浮标签栏）。注：内容延伸到悬浮标签栏之下的全屏方案与 iOS 26 floating tab bar 的触摸命中冲突（标签点击失效），已回退为系统标准内容区布局
  - 真机两修：液态玻璃改为真实 DOM 层（Safari/WKWebView 不渲染伪元素 backdrop-filter，此前真机无玻璃且该层常驻参与布局导致下拉逐帧模糊重算而卡顿；现未滚动时 display:none 零渲染，淡入用 keyframes）；下拉指示器改绝对定位浮层（高度变化不再推挤主布局）。单签账户公钥接受 xpub / acct_xvk 双前缀（Ledger Live 导出多为 xpub1…；bech32 校验和绑定前缀，钱包标识按重编码归一，同钥双前缀视为同一钱包）
  - 界面四修：上滑收拢全部改为可过渡属性（快捷操作高度/透明度、资产条尺寸、玻璃淡入，无跳变）；下拉刷新仅在总览页生效（其他页面正常滚动，质押页文案同步移除）；底部通透（iOS 原生壳清除 102px 隐形底衬，main 仅留 14px+安全区呼吸位）；移除资产列表 56px 超高（滚到底不再有多余空间，浏览器模式底衬改挂 main 尾部）
  - 移除"多签公钥"手输，多签仅 descriptor 文件导入；地址页 Vespr 式重构（缩写行 + 展开完整地址）；移除"暂无可靠报价"，价格/快照持久缓存、打开即显示上次结果并后台刷新
  - 单签派生路径可选（CIP-1852 标准 / Ledger 遗留 Byron m/44'，企业地址、无质押凭证、无找零链）
  - 报价源冗余（CoinGecko→OKX→Binance→Coinbase→Kraken + Frankfurter 汇率，原生白名单同步扩展）
  - 数据源冗余（Koios 默认，Blockfrost 备用自动切换，同套校验聚合）
  - 液态玻璃修复与增强（玻璃分层修 Safari 文字消失；上滑收拢融合）；XCUITest 对齐 0.1.22 控件改名并加残留清理兜底
- **0.1.7–0.1.9**：法币估值（CoinGecko/OKX）与动账本地通知；质押页口径对齐桌面（"参与质押的余额"）；提示移到顶部 + 错误红色；WKUIDelegate 补全（alert/confirm 修复）；图标与桌面端同源 + 亮/暗/色调三变体及生成脚本。
- **0.1.0–0.1.6**：初始版本（派生验证、原生壳、Koios 白名单桥、质押观察、原生 Tab、单签 CIP-1852、总资产估值与 DEX 参考价雏形）。
