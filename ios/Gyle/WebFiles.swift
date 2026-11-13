import Foundation
import WebKit

/// Serves the web files packed into the app (the folder www/) to the page.
///
/// The page needs one fixed address so its saved data stays with it, and it cannot load
/// JavaScript modules straight from a file. So the app answers every request for
/// `gyle-app://local/...` itself, from the files in www/.
final class WebFiles: NSObject, WKURLSchemeHandler {
    private let folder = Bundle.main.resourceURL?.appendingPathComponent("www", isDirectory: true)

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let address = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        var path = address.path
        if path.isEmpty || path == "/" { path = "/index.html" }

        var found: Data?
        if let folder, !path.contains("..") {
            found = try? Data(contentsOf: folder.appendingPathComponent(String(path.dropFirst())))
        }
        guard var file = found else {
            answer(urlSchemeTask, address: address, status: 404, kind: "text/plain; charset=utf-8", body: Data())
            return
        }
        if path == "/index.html" { file = Self.forApp(file) }
        answer(urlSchemeTask, address: address, status: 200, kind: Self.kind(of: path), body: file)
    }

    /// Every answer is complete before start() returns, so there is nothing to stop.
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func answer(_ task: WKURLSchemeTask, address: URL, status: Int, kind: String, body: Data) {
        let headers = ["Content-Type": kind, "Content-Length": String(body.count), "Cache-Control": "no-store"]
        guard let response = HTTPURLResponse(url: address, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(URLError(.badServerResponse))
            return
        }
        task.didReceive(response)
        task.didReceive(body)
        task.didFinish()
    }

    /// index.html lets the page load files from 'self' only (its Content-Security-Policy line).
    /// Name the app's own address there too, in case iOS does not count it as 'self'.
    private static func forApp(_ page: Data) -> Data {
        let text = String(decoding: page, as: UTF8.self)
        return Data(text.replacingOccurrences(of: "'self'", with: "'self' \(WebScreen.scheme):").utf8)
    }

    private static func kind(of path: String) -> String {
        switch URL(fileURLWithPath: path).pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8" // modules do not load with any other type
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "woff2": return "font/woff2"
        case "png": return "image/png"
        case "jpg": return "image/jpeg"
        default: return "text/plain; charset=utf-8"
        }
    }
}
