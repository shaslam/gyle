import Foundation
import UserNotifications

/// Brew-day timer alerts. iOS stops the page when the phone is locked, so the page hands over
/// the list of alerts still to come and iOS shows each one at its time, as a notification.
///
/// The page raises the same alerts itself while it is open. Each alert has a key and a key is
/// shown one time only, so the person never gets the same alert twice.
///
/// The page calls set() and show() from the main thread only. The stored values are in
/// UserDefaults, which is safe to use from any thread, so the class can say it is Sendable.
final class Alerts: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    static let shared = Alerts()

    private static let planned = "alerts.planned" // key -> time in ms, for the alerts handed to iOS
    private static let shown = "alerts.shown"     // keys of alerts already shown
    private static let remember = 40

    private let center = UNUserNotificationCenter.current()
    private let saved = UserDefaults.standard

    func start() {
        center.delegate = self
    }

    /// Show an alert as a banner with a sound even when Gyle is the app in front.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    // MARK: - Permission

    /// "granted", "denied", or "default" when the person was not asked yet.
    func status() async -> String {
        switch await center.notificationSettings().authorizationStatus {
        case .notDetermined: return "default"
        case .denied: return "denied"
        default: return "granted"
        }
    }

    /// Show the iOS question about notifications. False when iOS will not ask (it asked before).
    func ask() async -> Bool {
        guard await center.notificationSettings().authorizationStatus == .notDetermined else { return false }
        _ = try? await center.requestAuthorization(options: [.alert, .sound])
        return true
    }

    // MARK: - The alerts

    /// Replace the list of alerts to come: [{ key, at (ms), title, body }]. An empty list cancels them all.
    func set(json: String) {
        let now = Date().timeIntervalSince1970 * 1000
        let before = plan()
        let list = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [[String: Any]] ?? []

        var after: [String: Double] = [:]
        for item in list {
            guard let key = item["key"] as? String, let at = (item["at"] as? NSNumber)?.doubleValue, at > now else { continue }
            after[key] = at
            if before[key] == at { continue } // iOS has this one already
            let wait = UNTimeIntervalNotificationTrigger(timeInterval: max(0.1, (at - now) / 1000), repeats: false)
            let words = Self.words(title: item["title"] as? String ?? "", body: item["body"] as? String ?? "")
            center.add(UNNotificationRequest(identifier: key, content: words, trigger: wait)) // replaces a waiting alert with the same key
        }

        // An earlier alert that is past its time was shown by iOS, or the page shows it now
        // (see show). Leave those alone. Cancel the others that are not in the new list.
        var gone: [String] = []
        for (key, at) in before where after[key] == nil {
            if at <= now { remember(key) } else { gone.append(key) }
        }
        if !gone.isEmpty { center.removePendingNotificationRequests(withIdentifiers: gone) }
        saved.set(after, forKey: Self.planned)
    }

    /// Show one alert now, unless an alert with this key was shown before.
    func show(key: String, title: String, body: String) {
        let now = Date().timeIntervalSince1970 * 1000
        if (saved.stringArray(forKey: Self.shown) ?? []).contains(key) { return }
        remember(key)
        // iOS had this alert and its time is past: iOS showed it, or is about to.
        let due = (plan()[key] ?? .infinity) <= now
        let center = self.center
        center.getPendingNotificationRequests { waiting in
            let stillWaiting = waiting.contains { $0.identifier == key }
            guard stillWaiting || !due else { return }
            // No trigger means now. This also replaces the alert that still waits.
            center.add(UNNotificationRequest(identifier: key, content: Self.words(title: title, body: body), trigger: nil))
        }
    }

    private func plan() -> [String: Double] {
        saved.dictionary(forKey: Self.planned) as? [String: Double] ?? [:]
    }

    private func remember(_ key: String) {
        var keys = saved.stringArray(forKey: Self.shown) ?? []
        if keys.contains(key) { return }
        keys.append(key)
        saved.set(Array(keys.suffix(Self.remember)), forKey: Self.shown)
    }

    private static func words(title: String, body: String) -> UNMutableNotificationContent {
        let words = UNMutableNotificationContent()
        words.title = title
        words.body = body
        words.sound = .default
        words.threadIdentifier = "timer"
        // Shown at once, also in a Focus that allows time-sensitive notifications. This needs the
        // "Time Sensitive Notifications" capability. Without it iOS treats the alert as a normal one.
        words.interruptionLevel = .timeSensitive
        return words
    }
}
