import BackgroundTasks
import SwiftUI
import UserNotifications

@main
struct CardanoWatchApp: App {
    private static let notificationDelegate = ForegroundNotificationDelegate()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // 必须在启动完成前注册后台任务处理器
        BGTaskScheduler.shared.register(forTaskWithIdentifier: ActivityChecker.refreshTaskId, using: nil) { task in
            ActivityChecker.checkAndNotify {
                ActivityChecker.scheduleRefresh()
                task.setTaskCompleted(success: true)
            }
        }
        UNUserNotificationCenter.current().delegate = Self.notificationDelegate
    }

    var body: some Scene {
        WindowGroup {
            WatchWebView()
                .background(Color(red: 245.0 / 255.0, green: 247.0 / 255.0, blue: 251.0 / 255.0).ignoresSafeArea())
                .preferredColorScheme(.light)
        }
        .onChange(of: scenePhase) { phase in
            if phase == .background {
                ActivityChecker.scheduleRefresh()
            }
        }
    }
}

// App 正在前台时也以横幅呈现动账提醒
final class ForegroundNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
