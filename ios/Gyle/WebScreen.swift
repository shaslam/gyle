import UIKit
import WebKit

/// The whole app is one screen: a web view that shows the Gyle web files packed into the app.
///
/// The files are served to the page from a made-up address, `gyle-app://local/` (see WebFiles).
/// Requests to that address never leave the phone. Everything else the page asks for goes to
/// the network. The page talks to the app through the `GyleNative` object that bridge.js builds.
final class WebScreen: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    static let scheme = "gyle-app"
    static let start = "gyle-app://local/index.html"

    /// The same colours as the tokens at the top of css/app.css.
    static let wall = UIColor(red: 220 / 255, green: 201 / 255, blue: 160 / 255, alpha: 1)
    static let green = UIColor(red: 15 / 255, green: 58 / 255, blue: 43 / 255, alpha: 1)

    private(set) var web: WKWebView!
    private lazy var bridge = Bridge(screen: self)
    private let firstLink: URL?
    /// True while the person is in the Settings app to allow notifications.
    private var awayToSettings = false

    init(link: URL?) {
        firstLink = link
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("WebScreen is made in code only")
    }

    /// White clock and battery symbols, because the band behind them is dark green.
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.wall

        let setup = WKWebViewConfiguration()
        setup.setURLSchemeHandler(WebFiles(), forURLScheme: Self.scheme)
        setup.userContentController.add(self, name: "gyle")
        if let file = Bundle.main.url(forResource: "bridge", withExtension: "js"), let script = try? String(contentsOf: file, encoding: .utf8) {
            setup.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }

        web = WKWebView(frame: .zero, configuration: setup)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.isOpaque = false
        web.backgroundColor = Self.wall
        web.scrollView.backgroundColor = Self.wall
        web.scrollView.contentInsetAdjustmentBehavior = .never // the page keeps clear of the home bar itself
        web.scrollView.bounces = false // the header and the tab bar stay where they are
        web.allowsBackForwardNavigationGestures = true // a swipe from the left edge goes back
        web.allowsLinkPreview = false
        #if DEBUG
        web.isInspectable = true // Safari on a Mac can then inspect the page
        #endif

        // Green behind the clock and battery symbols, then the page down to the bottom edge.
        let band = UIView()
        band.backgroundColor = Self.green
        let parts: [UIView] = [band, web]
        for part in parts {
            part.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(part)
        }
        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            band.topAnchor.constraint(equalTo: view.topAnchor),
            band.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            band.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            band.bottomAnchor.constraint(equalTo: safe.topAnchor),
            web.topAnchor.constraint(equalTo: safe.topAnchor),
            web.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        let first = firstLink.flatMap(Self.session(in:)).flatMap { URL(string: Self.start + "#" + $0) }
        if let address = first ?? URL(string: Self.start) { web.load(URLRequest(url: address)) }
    }

    // MARK: - Sign-in links

    /// The part of a gyle://auth link that holds the session, still percent-encoded.
    private static func session(in link: URL) -> String? {
        guard link.scheme == "gyle", let parts = URLComponents(url: link, resolvingAgainstBaseURL: false) else { return nil }
        // Some errors arrive after a ? and not after a #.
        return [parts.percentEncodedFragment, parts.percentEncodedQuery].compactMap { $0 }.first { !$0.isEmpty }
    }

    /// Hand a sign-in link to the page. An open page sees its address change and signs in.
    func open(link: URL) {
        guard isViewLoaded, let rest = Self.session(in: link) else { return }
        if web.url?.scheme == Self.scheme, !web.isLoading {
            web.evaluateJavaScript("location.hash = \(Self.quoted(rest))", completionHandler: nil)
        } else if let address = URL(string: Self.start + "#" + rest) {
            web.load(URLRequest(url: address))
        }
    }

    /// Text as a JavaScript string, with quotes around it.
    private static func quoted(_ text: String) -> String {
        guard let json = try? JSONSerialization.data(withJSONObject: [text]) else { return "''" }
        return String(String(decoding: json, as: UTF8.self).dropFirst().dropLast())
    }

    // MARK: - Messages to the page and to other apps

    /// Send an event to the page, for example after the answer about notifications.
    func tellPage(_ event: String) {
        web.evaluateJavaScript("window.dispatchEvent(new Event(\(Self.quoted(event))))", completionHandler: nil)
    }

    /// The app is in front again.
    func cameBack() {
        guard awayToSettings else { return }
        awayToSettings = false
        tellPage("gyle-notify")
    }

    /// Open the page in the Settings app where the person can allow notifications for Gyle.
    func openNotificationSettings() {
        guard let address = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        awayToSettings = true
        UIApplication.shared.open(address, options: [:], completionHandler: nil)
    }

    /// Open a web or mail address in Safari or the Mail app.
    func openOutside(_ address: URL) {
        guard let kind = address.scheme?.lowercased(), ["https", "http", "mailto"].contains(kind) else { return }
        UIApplication.shared.open(address, options: [:], completionHandler: nil)
    }

    // MARK: - The page

    /// The page stays in the app. Any other address opens in Safari.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let address = navigationAction.request.url else { return .cancel }
        if address.scheme == Self.scheme { return .allow }
        openOutside(address)
        return .cancel
    }

    /// A link that asks for a new window opens in Safari.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let address = navigationAction.request.url { openOutside(address) }
        return nil
    }

    /// iOS can stop the page's process to free memory. Start the page again. The working copy is saved.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if let address = URL(string: Self.start) { webView.load(URLRequest(url: address)) }
    }

    // MARK: - The bridge (see bridge.js)

    /// A GyleNative method that needs no answer.
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let call = Call(message.body) else { return }
        bridge.run(call)
    }

    /// A GyleNative method that needs an answer at once. It arrives as a prompt(): nothing is
    /// shown, and the text returned here is what prompt() gives back to the page.
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
        guard prompt == "gyle-native", frame.isMainFrame, let call = Call(json: defaultText) else { return nil }
        return await bridge.answer(call)
    }
}

/// One request from the page: the name of a GyleNative method and the values the page passed.
struct Call {
    let name: String
    let values: [Any]

    init?(_ message: Any) {
        guard let message = message as? [String: Any], let name = message["name"] as? String else { return nil }
        self.name = name
        values = message["args"] as? [Any] ?? []
    }

    init?(json: String?) {
        guard let json, let message = try? JSONSerialization.jsonObject(with: Data(json.utf8)) else { return nil }
        self.init(message)
    }

    func text(_ place: Int) -> String {
        guard place < values.count, let text = values[place] as? String else { return "" }
        return text
    }

    func flag(_ place: Int) -> Bool {
        guard place < values.count, let flag = values[place] as? Bool else { return false }
        return flag
    }
}
