import BackgroundTasks
import CryptoKit
import Foundation
import UserNotifications

// 后台动账通知：App 退后台后由 BGTaskScheduler 低频唤醒，
// 对已登记的观察地址读取完整 UTXO 集合后比对指纹。
// 不做实时推送（那需要服务端 + APNs）。

enum ActivityWatchStore {
    struct Watch: Codable {
        let walletId: String
        let registrationId: String
        let network: String
        let addresses: [String]
        var baseline: String?
        var lastChecked: Date?
    }

    private static let key = "cardano.watch.activity"

    static func load() -> Watch? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(Watch.self, from: data)
    }

    static func save(_ watch: Watch) {
        if let data = try? JSONEncoder().encode(watch) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: ActivityChecker.refreshTaskId)
    }
}

enum ActivityChecker {
    static let refreshTaskId = "com.cardanosparrow.watch.refresh"
    private static let maxAddresses = 100
    private static let maxBodyBytes = 4 * 1024 * 1024
    private static let pageSize = 500
    private static let maxPages = 20

    static func fingerprint(ofRefs refs: [String]) -> String {
        let joined = refs.map { $0.lowercased() }.sorted().joined(separator: "\n")
        return SHA256.hash(data: Data(joined.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func fingerprint(ofRows rows: [[String: Any]]) -> String? {
        var entries: [String] = []
        for row in rows {
            guard let hash = row["tx_hash"] as? String, hash.range(
                of: #"^[0-9a-fA-F]{64}$"#, options: .regularExpression) != nil else { return nil }
            let index = row["tx_index"]
            if let index = index as? Int, index >= 0 {
                entries.append("\(hash)#\(index)")
            } else if let index = index as? String, index.range(
                of: #"^\d+$"#, options: .regularExpression) != nil {
                entries.append("\(hash)#\(index)")
            } else {
                return nil
            }
        }
        return fingerprint(ofRefs: entries)
    }

    static func checkAndNotify(completion: (() -> Void)? = nil) {
        guard let watch = ActivityWatchStore.load() else {
            completion?()
            return
        }
        let host = ["mainnet": "api.koios.rest", "preprod": "preprod.koios.rest"][watch.network]
            ?? "api.koios.rest"
        guard let url = URL(string: "https://\(host)/api/v1/address_utxos?order=tx_hash.asc,tx_index.asc") else {
            completion?()
            return
        }
        let addresses = Array(watch.addresses.prefix(maxAddresses))
        guard let body = try? JSONSerialization.data(withJSONObject: ["_addresses": addresses]),
              body.count <= maxBodyBytes else {
            completion?()
            return
        }
        fetchPage(url: url, body: body, page: 0, collected: [], expectedTotal: nil) { rows in
            let next = rows.flatMap { fingerprint(ofRows: $0) }
            DispatchQueue.main.async {
                defer { completion?() }
                guard let next, var current = ActivityWatchStore.load(),
                      current.registrationId == watch.registrationId else { return }
                let previous = current.baseline
                current.baseline = next
                current.lastChecked = Date()
                ActivityWatchStore.save(current)
                if let previous, previous != next { postNotification() }
            }
        }
    }

    private static func fetchPage(url: URL, body: Data, page: Int,
                                  collected: [[String: Any]], expectedTotal: Int?,
                                  completion: @escaping ([[String: Any]]?) -> Void) {
        guard page < maxPages else { completion(nil); return }
        let start = page * pageSize
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("\(start)-\(start + pageSize - 1)", forHTTPHeaderField: "Range")
        request.setValue("count=exact", forHTTPHeaderField: "Prefer")
        request.timeoutInterval = 25
        request.httpBody = body
        URLSession.shared.dataTask(with: request) { data, response, error in
            guard error == nil, let http = response as? HTTPURLResponse,
                  (200...299).contains(http.statusCode), let data,
                  data.count <= maxBodyBytes,
                  let rows = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]],
                  let range = http.value(forHTTPHeaderField: "Content-Range"),
                  let total = validateRange(range, start: start, count: rows.count),
                  expectedTotal == nil || expectedTotal == total else {
                completion(nil)
                return
            }
            let all = collected + rows
            if all.count == total { completion(all); return }
            guard rows.count == pageSize else { completion(nil); return }
            fetchPage(url: url, body: body, page: page + 1,
                      collected: all, expectedTotal: total, completion: completion)
        }.resume()
    }

    private static func validateRange(_ range: String, start: Int, count: Int) -> Int? {
        if count == 0 {
            guard range.hasPrefix("*/"), let total = Int(range.dropFirst(2)),
                  total >= start else { return nil }
            return total
        }
        let parts = range.split(separator: "/")
        guard parts.count == 2, let total = Int(parts[1]),
              total >= start + count else { return nil }
        let bounds = parts[0].split(separator: "-")
        guard bounds.count == 2, Int(bounds[0]) == start,
              Int(bounds[1]) == start + count - 1,
              count <= pageSize else { return nil }
        return total
    }

    static func postNotification() {
        let content = UNMutableNotificationContent()
        content.title = "Cardano Watch"
        content.body = "观察的钱包检测到链上动账，打开 App 查看最新余额与交易。"
        content.sound = .default
        let request = UNNotificationRequest(identifier: "cardano.watch.activity", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    static func scheduleRefresh() {
        guard ActivityWatchStore.load() != nil else { return }
        let request = BGAppRefreshTaskRequest(identifier: refreshTaskId)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }
}
