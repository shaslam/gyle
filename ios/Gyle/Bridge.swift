import QuickLook
import UIKit

/// What the page can ask the app to do. The page sees these as the methods of `GyleNative`
/// (bridge.js builds that object, js/native.js lists the methods). The Android app has the
/// same methods in Bridge.java. Keep them in step.
@MainActor
final class Bridge: NSObject, QLPreviewControllerDataSource, UIPrintInteractionControllerDelegate {
    private unowned let screen: WebScreen
    private var preview: URL?

    init(screen: WebScreen) {
        self.screen = screen
    }

    /// The methods that give no answer.
    func run(_ call: Call) {
        switch call.name {
        case "print": printPage(title: call.text(0))
        case "setAlarms": Alerts.shared.set(json: call.text(0))
        case "showAlert": Alerts.shared.show(key: call.text(0), title: call.text(1), body: call.text(2))
        case "askToNotify": askToNotify()
        case "keepAwake": UIApplication.shared.isIdleTimerDisabled = call.flag(0) // the screen stays on while the timer runs
        case "openExternal": openExternal(call.text(0))
        default: break
        }
    }

    /// The methods that answer at once.
    func answer(_ call: Call) async -> String {
        switch call.name {
        case "saveFile": return saveFile(name: call.text(0), mime: call.text(1), base64: call.text(2))
        case "notifyStatus": return await Alerts.shared.status()
        default: return ""
        }
    }

    // MARK: - Files

    /// iOS has no shared Downloads folder. A brew sheet (PDF) opens in a viewer that can also
    /// print and share it. Any other file opens the share sheet, where "Save to Files" keeps it.
    /// Returns "" when that worked, or what went wrong.
    private func saveFile(name: String, mime: String, base64: String) -> String {
        guard let bytes = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else {
            return "Could not save the file: it did not arrive whole"
        }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("export", isDirectory: true)
        let safe = name.replacingOccurrences(of: "/", with: "-")
        let file = folder.appendingPathComponent(safe.isEmpty ? "gyle-export" : safe)
        do {
            try? FileManager.default.removeItem(at: folder) // the file from last time
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try bytes.write(to: file, options: .atomic)
        } catch {
            return "Could not save the file: \(error.localizedDescription)"
        }
        // Answer the page first, then show the viewer or the share sheet.
        DispatchQueue.main.async {
            if mime == "application/pdf" { self.show(file) } else { self.share(file) }
        }
        return ""
    }

    private func share(_ file: URL) {
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        if let bubble = sheet.popoverPresentationController { // an iPad shows the sheet as a bubble
            bubble.sourceView = screen.view
            bubble.sourceRect = CGRect(x: screen.view.bounds.midX, y: screen.view.bounds.midY, width: 0, height: 0)
            bubble.permittedArrowDirections = []
        }
        present(sheet)
    }

    private func show(_ file: URL) {
        preview = file
        let viewer = QLPreviewController()
        viewer.dataSource = self
        present(viewer)
    }

    private func present(_ next: UIViewController) {
        var top: UIViewController = screen
        while let above = top.presentedViewController { top = above }
        top.present(next, animated: true)
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
        preview == nil ? 0 : 1
    }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        NSURL(fileURLWithPath: (preview ?? FileManager.default.temporaryDirectory).path)
    }

    // MARK: - Print

    /// Print the page that is open (the brew sheet).
    private func printPage(title: String) {
        let job = UIPrintInfo.printInfo()
        job.jobName = title.isEmpty ? "Gyle" : title
        job.outputType = .general
        let printer = UIPrintInteractionController.shared
        printer.printInfo = job
        printer.printFormatter = screen.web.viewPrintFormatter()
        printer.delegate = self
        printer.present(animated: true, completionHandler: nil)
    }

    /// The brew sheet is laid out for A4 (595 by 842 points).
    func printInteractionController(_ printInteractionController: UIPrintInteractionController, choosePaper paperList: [UIPrintPaper]) -> UIPrintPaper {
        UIPrintPaper.bestPaper(forPageSize: CGSize(width: 595.2, height: 841.8), withPapersFrom: paperList)
    }

    // MARK: - Notifications and links

    /// Ask to show notifications. iOS shows its question one time only. After that the only
    /// way is the Settings app, so open that. The page gets a "gyle-notify" event when there
    /// is an answer.
    private func askToNotify() {
        Task {
            if await Alerts.shared.ask() {
                screen.tellPage("gyle-notify")
            } else {
                screen.openNotificationSettings()
            }
        }
    }

    /// Open a web address in Safari (sign-in with GitHub or Google).
    private func openExternal(_ text: String) {
        guard let address = URL(string: text), address.scheme == "https" else { return }
        screen.openOutside(address)
    }
}
