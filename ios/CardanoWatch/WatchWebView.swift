import SwiftUI
import UserNotifications
import WebKit

struct WatchWebView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UITabBarController {
        let controller = UITabBarController()
        let canvasColor = UIColor(red: 245.0 / 255.0, green: 247.0 / 255.0, blue: 251.0 / 255.0, alpha: 1)
        controller.overrideUserInterfaceStyle = .light
        controller.view.backgroundColor = canvasColor
        let titles = ["总览", "收款", "地址", "质押"]
        let symbols = ["square.grid.2x2", "arrow.down", "list.bullet.rectangle"]
        controller.viewControllers = titles.enumerated().map { index, title in
            let page = UIViewController()
            page.view.backgroundColor = canvasColor
            page.tabBarItem = UITabBarItem(title: title,
                image: index == 3 ? stakingImage() : UIImage(systemName: symbols[index]), tag: index)
            return page
        }
        controller.delegate = context.coordinator
        controller.tabBar.isHidden = true
        context.coordinator.tabController = controller

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.setURLSchemeHandler(BundlePageHandler(), forURLScheme: "cardanowatch")
        configuration.userContentController.addScriptMessageHandler(context.coordinator,
            contentWorld: .page, name: "koios")
        configuration.userContentController.addScriptMessageHandler(context.coordinator,
            contentWorld: .page, name: "price")
        configuration.userContentController.addScriptMessageHandler(context.coordinator,
            contentWorld: .page, name: "notifications")
        configuration.userContentController.add(context.coordinator, name: "navigation")
        configuration.userContentController.add(context.coordinator, name: "modal")
        configuration.userContentController.add(context.coordinator, name: "exportDescriptor")
        configuration.userContentController.add(context.coordinator, name: "haptics")
        let webView = WKWebView(frame: .zero, configuration: configuration)
        context.coordinator.webView = webView
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.minimumZoomScale = 1
        webView.scrollView.maximumZoomScale = 1
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.bounces = false
        webView.scrollView.showsVerticalScrollIndicator = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.isOpaque = false
        webView.backgroundColor = canvasColor
        webView.scrollView.backgroundColor = canvasColor
        context.coordinator.attachWebView(to: controller.viewControllers![0])
        webView.load(URLRequest(url: URL(string: "cardanowatch://app/index.html")!))
        return controller
    }

    func updateUIViewController(_ uiViewController: UITabBarController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator() }

    private func stakingImage() -> UIImage {
        let size = CGSize(width: 25, height: 25)
        return UIGraphicsImageRenderer(size: size).image { _ in
            let glyph = "◈" as NSString
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 22, weight: .medium),
                .foregroundColor: UIColor.black
            ]
            let measured = glyph.size(withAttributes: attributes)
            glyph.draw(at: CGPoint(x: (size.width - measured.width) / 2,
                                   y: (size.height - measured.height) / 2), withAttributes: attributes)
        }.withRenderingMode(.alwaysTemplate)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandlerWithReply,
                             WKScriptMessageHandler, WKUIDelegate, UITabBarControllerDelegate {
        weak var webView: WKWebView?
        weak var tabController: UITabBarController?
        var hasWallet = false
        var modalOpen = false
        var subpageOpen = false
        private var hapticsEnabled = true
        private var hapticIntensity: CGFloat = 0.75

        private func playTabHaptic() {
            guard hapticsEnabled else { return }
            let style: UIImpactFeedbackGenerator.FeedbackStyle = hapticIntensity < 0.34 ? .light :
                hapticIntensity < 0.67 ? .medium : .heavy
            let feedback = UIImpactFeedbackGenerator(style: style)
            feedback.prepare()
            feedback.impactOccurred(intensity: hapticIntensity)
        }

        func updateTabBarVisibility() {
            guard let controller = tabController else { return }
            let shouldHide = !hasWallet || modalOpen || subpageOpen
            if controller.tabBar.isHidden != shouldHide {
                controller.tabBar.isHidden = shouldHide
                controller.view.setNeedsLayout()
            }
        }

        func attachWebView(to page: UIViewController) {
            guard let webView else { return }
            webView.removeFromSuperview()
            page.view.addSubview(webView)
            webView.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                webView.topAnchor.constraint(equalTo: page.view.safeAreaLayoutGuide.topAnchor),
                webView.leadingAnchor.constraint(equalTo: page.view.leadingAnchor),
                webView.trailingAnchor.constraint(equalTo: page.view.trailingAnchor),
                webView.bottomAnchor.constraint(equalTo: page.view.bottomAnchor)
            ])
        }

        func tabBarController(_ tabBarController: UITabBarController,
                              shouldSelect viewController: UIViewController) -> Bool {
            guard let index = tabBarController.viewControllers?.firstIndex(of: viewController) else { return false }
            if tabBarController.selectedIndex != index { playTabHaptic() }
            attachWebView(to: viewController)
            let tabs = ["home", "receive", "addresses", "staking"]
            webView?.evaluateJavaScript("window.cardanoWatchSelectTab('\(tabs[index])')")
            return true
        }

        func userContentController(_ userContentController: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame else { return }
            if message.name == "modal" {
                guard let state = message.body as? [String: Any],
                      let open = state["open"] as? Bool else { return }
                modalOpen = open
                updateTabBarVisibility()
                return
            }
            if message.name == "haptics" {
                guard let state = message.body as? [String: Any] else { return }
                if let enabled = state["enabled"] as? Bool { hapticsEnabled = enabled }
                if let intensity = state["intensity"] as? Double, intensity.isFinite {
                    hapticIntensity = CGFloat(min(1, max(0.1, intensity)))
                }
                if state["preview"] as? Bool == true { playTabHaptic() }
                return
            }
            if message.name == "exportDescriptor" {
                guard let state = message.body as? [String: Any],
                      let contents = state["contents"] as? String,
                      contents.utf8.count <= 100_000,
                      let data = contents.data(using: .utf8),
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      ["cardano-hd-multisig", "cardano-hd-single"].contains(json["format"] as? String ?? ""),
                      let controller = tabController else { return }
                let file = FileManager.default.temporaryDirectory
                    .appendingPathComponent("cardano-watch-\(UUID().uuidString).json")
                do {
                    try data.write(to: file, options: .atomic)
                    let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
                    share.completionWithItemsHandler = { _, _, _, _ in
                        try? FileManager.default.removeItem(at: file)
                    }
                    controller.present(share, animated: true)
                } catch { return }
                return
            }
            guard message.name == "navigation", let state = message.body as? [String: Any],
                  let hasWallet = state["hasWallet"] as? Bool,
                  let selectedTab = state["selectedTab"] as? String,
                  let controller = tabController else { return }
            let tabs = ["home", "receive", "addresses", "staking"]
            guard let index = tabs.firstIndex(of: selectedTab),
                  let page = controller.viewControllers?[index] else { return }
            self.hasWallet = hasWallet
            self.subpageOpen = state["subpage"] as? Bool ?? false
            updateTabBarVisibility()
            if controller.selectedIndex != index {
                attachWebView(to: page)
                controller.selectedIndex = index
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            if url.scheme == "cardanowatch" {
                decisionHandler(.allow)
            } else if url.scheme == "https",
                      ["cardanoscan.io", "preprod.cardanoscan.io"].contains(url.host ?? "") {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            } else {
                decisionHandler(.cancel)
            }
        }

        // 不实现这些面板时，页面里的 alert()/confirm() 会被静默丢弃
        //（confirm 恒为 false），错误提示和“移除钱包”双确认都会失效。
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            guard let presenter = topPresenter() else { completionHandler(); return }
            let alert = UIAlertController(title: "Cardano Watch", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler() })
            presenter.present(alert, animated: true)
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            guard let presenter = topPresenter() else { completionHandler(false); return }
            let alert = UIAlertController(title: "请确认", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "确认", style: .default) { _ in completionHandler(true) })
            presenter.present(alert, animated: true)
        }

        private func topPresenter() -> UIViewController? {
            var presenter: UIViewController? = tabController
            while let presented = presenter?.presentedViewController { presenter = presented }
            if presenter is UIAlertController { return nil }
            return presenter
        }

        func userContentController(_ userContentController: WKUserContentController,
                                   didReceive message: WKScriptMessage,
                                   replyHandler: @escaping (Any?, String?) -> Void) {
            guard message.frameInfo.isMainFrame,
                  let request = message.body as? [String: Any] else {
                replyHandler(nil, "Invalid request")
                return
            }
            switch message.name {
            case "koios": handleKoios(request, replyHandler: replyHandler)
            case "price": handlePrice(request, replyHandler: replyHandler)
            case "notifications": handleNotifications(request, replyHandler: replyHandler)
            default: replyHandler(nil, "Unknown handler")
            }
        }

        private func handleKoios(_ request: [String: Any], replyHandler: @escaping (Any?, String?) -> Void) {
            if request["provider"] as? String == "blockfrost" {
                handleBlockfrost(request, replyHandler: replyHandler)
                return
            }
            let pagedPaths: Set<String> = [
                "/address_outputs?order=tx_hash.asc,tx_index.asc",
                "/address_utxos?order=tx_hash.asc,tx_index.asc",
                "/address_txs?order=block_height.desc,tx_hash.desc",
            ]
            guard let network = request["network"] as? String,
                  let path = request["path"] as? String,
                  let body = request["body"] as? [String: Any],
                  let host = ["mainnet": "api.koios.rest", "preprod": "preprod.koios.rest"][network],
                  pagedPaths.contains(path) || ["/tx_info", "/account_info", "/pool_info", "/tip", "/address_info?select=address",
                    "/asset_info?select=policy_id,asset_name,token_registry_metadata->>decimals,token_registry_metadata->>ticker,token_registry_metadata->>name,token_registry_metadata->>logo"].contains(path),
                  let url = URL(string: "https://\(host)/api/v1\(path)"),
                  let encoded = try? JSONSerialization.data(withJSONObject: body) else {
                replyHandler(nil, "Invalid Koios request")
                return
            }
            let paged = pagedPaths.contains(path)
            if path == "/address_info?select=address" || path.hasPrefix("/address_utxos?") || path.hasPrefix("/address_txs?") {
                guard let addresses = body["_addresses"] as? [String], !addresses.isEmpty,
                      addresses.count <= 20,
                      addresses.allSatisfy({ $0.hasPrefix(network == "mainnet" ? "addr1" : "addr_test1") && $0.count <= 200 }) else {
                    replyHandler(nil, "Invalid address discovery request")
                    return
                }
            }
            if path.hasPrefix("/asset_info") {
                guard let assets = body["_asset_list"] as? [[String]], !assets.isEmpty,
                      assets.count <= 30,
                      assets.allSatisfy({ item in
                          item.count == 2 &&
                          item[0].range(of: #"^[0-9a-f]{56}$"#, options: .regularExpression) != nil &&
                          item[1].range(of: #"^([0-9a-f]{2}){0,32}$"#, options: .regularExpression) != nil
                      }) else {
                    replyHandler(nil, "Invalid asset metadata request")
                    return
                }
            }
            if paged {
                guard let range = request["range"] as? String,
                      range.range(of: #"^\d{1,7}-\d{1,7}$"#, options: .regularExpression) != nil,
                      ((request["prefer"] as? String) == "count=exact" ||
                       (path == "/address_txs?order=block_height.desc,tx_hash.desc" &&
                        (request["prefer"] as? String) == "count=planned")) else {
                    replyHandler(nil, "Invalid Koios page")
                    return
                }
            }
            var urlRequest = URLRequest(url: url)
            urlRequest.cachePolicy = .reloadIgnoringLocalCacheData
            urlRequest.httpMethod = path == "/tip" ? "GET" : "POST"
            if path != "/tip" { urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type") }
            if paged {
                urlRequest.setValue(request["range"] as? String, forHTTPHeaderField: "Range")
                urlRequest.setValue(request["prefer"] as? String, forHTTPHeaderField: "Prefer")
            }
            if path != "/tip" { urlRequest.httpBody = encoded }
            URLSession.shared.dataTask(with: urlRequest) { data, response, error in
                // WebKit 要求 replyHandler 在主线程调用
                DispatchQueue.main.async {
                    if let error = error {
                        replyHandler(nil, error.localizedDescription)
                        return
                    }
                    guard let response = response as? HTTPURLResponse,
                          (200...299).contains(response.statusCode), let data = data,
                          let json = try? JSONSerialization.jsonObject(with: data) else {
                        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                        replyHandler(nil, status == 429 ? "Koios 请求过于频繁，请稍后重试" : "Koios 同步失败 (\(status))")
                        return
                    }
                    if paged {
                        replyHandler(["rows": json, "contentRange": response.value(forHTTPHeaderField: "Content-Range") ?? ""], nil)
                    } else {
                        replyHandler(json, nil)
                    }
                }
            }.resume()
        }

        // Blockfrost 备用数据源：只读 GET、路径字符集白名单、project_id 透传
        private func handleBlockfrost(_ request: [String: Any], replyHandler: @escaping (Any?, String?) -> Void) {
            guard let network = request["network"] as? String,
                  let host = ["mainnet": "cardano-mainnet.blockfrost.io",
                              "preprod": "cardano-preprod.blockfrost.io"][network],
                  let path = request["path"] as? String,
                  path.count <= 220,
                  let projectId = request["projectId"] as? String,
                  projectId.range(of: #"^[A-Za-z0-9_-]{16,64}$"#, options: .regularExpression) != nil,
                  let url = URL(string: "https://\(host)/api/v0\(path)") else {
                replyHandler(["error": "Invalid Blockfrost request"], nil)
                return
            }
            // 路径白名单：/段只允许 bech32/hex/单词，query 只允许 count/page/order 及安全值
            let parts = path.split(separator: "?", maxSplits: 1).map(String.init)
            let pathPart = parts[0]
            let segments = pathPart.split(separator: "/").map(String.init)
            guard !pathPart.contains(".."),
                  segments.allSatisfy({ $0.range(of: #"^[A-Za-z0-9._-]{1,120}$"#, options: .regularExpression) != nil }),
                  ["addresses", "txs", "accounts", "pools", "blocks", "epochs", "assets", "network"].contains(segments.first ?? "") else {
                replyHandler(["error": "Invalid Blockfrost request"], nil)
                return
            }
            if parts.count > 1 {
                let allowedKeys: Set<String> = ["count", "page", "order"]
                let params = parts[1].split(separator: "&").map(String.init)
                guard params.allSatisfy({ param in
                    let kv = param.split(separator: "=", maxSplits: 1).map(String.init)
                    guard kv.count == 2, allowedKeys.contains(kv[0]),
                          kv[1].range(of: #"^[A-Za-z0-9._-]{1,30}$"#, options: .regularExpression) != nil else { return false }
                    return true
                }) else {
                    replyHandler(["error": "Invalid Blockfrost request"], nil)
                    return
                }
            }
            var urlRequest = URLRequest(url: url)
            urlRequest.timeoutInterval = 60
            urlRequest.setValue(projectId, forHTTPHeaderField: "project_id")
            URLSession.shared.dataTask(with: urlRequest) { data, response, error in
                DispatchQueue.main.async {
                    if let error = error {
                        replyHandler(["error": error.localizedDescription], nil)
                        return
                    }
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    guard let data = data, data.count <= 8_388_608 else {
                        replyHandler(["error": "Blockfrost 响应无效 (\(status))"], nil)
                        return
                    }
                    // 404 是合法业务结果（未使用地址等），连同状态码一起交回 JS 层判定
                    let json = (try? JSONSerialization.jsonObject(with: data)) ?? nil
                    replyHandler(["status": status, "body": json as Any], nil)
                }
            }.resume()
        }

        // 价格源走固定 URL 白名单（GET，不接受任意 URL）
        private func handlePrice(_ request: [String: Any], replyHandler: @escaping (Any?, String?) -> Void) {
            let allowed = [
                "coingecko": "https://api.coingecko.com/api/v3/simple/price?ids=cardano,midnight-3&vs_currencies=usd,cny&include_last_updated_at=true",
                "okx": "https://www.okx.com/api/v5/market/ticker?instId=ADA-USDT",
                "binance": "https://api.binance.com/api/v3/ticker/price?symbol=ADAUSDT",
                "coinbase": "https://api.coinbase.com/v2/prices/ADA-USD/spot",
                "kraken": "https://api.kraken.com/0/public/Ticker?pair=ADAUSD",
                "frankfurter": "https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY",
            ]
            guard let source = request["source"] as? String else {
                replyHandler(nil, "Invalid price source")
                return
            }
            var urlString = allowed[source]
            if source == "dexscreener", let ids = request["assetIds"] as? [String],
               !ids.isEmpty, ids.count <= 30,
               ids.allSatisfy({ $0.range(of: #"^[0-9a-f]{56,120}$"#, options: .regularExpression) != nil }) {
                urlString = "https://api.dexscreener.com/tokens/v1/cardano/\(ids.joined(separator: ","))"
            }
            if source == "minswap" {
                urlString = "https://api-mainnet-prod.minswap.org/v1/assets/1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e345553444378/metrics?currency=usd"
            }
            guard let urlString,
                  let url = URL(string: urlString) else {
                replyHandler(nil, "Invalid price source")
                return
            }
            var urlRequest = URLRequest(url: url)
            urlRequest.timeoutInterval = 15
            urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
            URLSession.shared.dataTask(with: urlRequest) { data, response, error in
                DispatchQueue.main.async {
                    if let error = error {
                        replyHandler(nil, error.localizedDescription)
                        return
                    }
                    guard let response = response as? HTTPURLResponse,
                          (200...299).contains(response.statusCode), let data = data,
                          data.count <= 1_048_576,
                          let json = try? JSONSerialization.jsonObject(with: data) else {
                        replyHandler(nil, "价格源不可用 (\((response as? HTTPURLResponse)?.statusCode ?? 0))")
                        return
                    }
                    replyHandler(json, nil)
                }
            }.resume()
        }

        private func handleNotifications(_ request: [String: Any], replyHandler: @escaping (Any?, String?) -> Void) {
            guard let action = request["action"] as? String else {
                replyHandler(nil, "Invalid notification request")
                return
            }
            if action == "requestPermission" {
                UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
                    DispatchQueue.main.async { replyHandler(granted, nil) }
                }
                return
            }
            if action == "unregister" {
                if let walletId = request["walletId"] as? String {
                    if ActivityWatchStore.load()?.walletId == walletId { ActivityWatchStore.clear() }
                } else {
                    ActivityWatchStore.clear()
                }
                replyHandler(true, nil)
                return
            }
            guard action == "register",
                  let walletId = request["walletId"] as? String,
                  !walletId.isEmpty, walletId.count <= 10_000,
                  let network = request["network"] as? String,
                  ["mainnet", "preprod"].contains(network),
                  let addresses = request["addresses"] as? [String],
                  (1...200).contains(addresses.count),
                  addresses.allSatisfy({ $0.hasPrefix(network == "mainnet" ? "addr1" : "addr_test1") && $0.count <= 200 }),
                  let refs = request["baselineRefs"] as? [String],
                  refs.count <= 10_000,
                  refs.allSatisfy({ $0.range(of: "^[0-9a-fA-F]{64}#[0-9]+$", options: .regularExpression) != nil }),
                  Set(refs).count == refs.count else {
                replyHandler(nil, "Invalid watch registration")
                return
            }
            let baseline = ActivityChecker.fingerprint(ofRefs: refs)
            ActivityWatchStore.save(ActivityWatchStore.Watch(walletId: walletId,
                registrationId: UUID().uuidString, network: network, addresses: addresses,
                baseline: baseline, lastChecked: Date()))
            ActivityChecker.scheduleRefresh()
            replyHandler(true, nil)
        }
    }
}

private final class BundlePageHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url,
              url.host == "app",
              let root = Bundle.main.resourceURL?.appendingPathComponent("Web", isDirectory: true) else {
            urlSchemeTask.didFailWithError(NSError(domain: "CardanoWatch", code: 404))
            return
        }
        let relative = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let file = root.appendingPathComponent(relative.isEmpty ? "index.html" : relative).standardizedFileURL
        guard file.path.hasPrefix(root.standardizedFileURL.path + "/"),
              let data = try? Data(contentsOf: file) else {
            urlSchemeTask.didFailWithError(NSError(domain: "CardanoWatch", code: 404))
            return
        }
        let mime: String
        switch file.pathExtension {
        case "html": mime = "text/html"
        case "js": mime = "text/javascript"
        case "css": mime = "text/css"
        case "wasm": mime = "application/wasm"
        case "svg": mime = "image/svg+xml"
        case "png": mime = "image/png"
        case "json", "webmanifest": mime = "application/json"
        default: mime = "application/octet-stream"
        }
        urlSchemeTask.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count,
                                             textEncodingName: mime.hasPrefix("text/") ? "utf-8" : nil))
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}
