import UIKit
import WebKit
import Capacitor

// The app's only screen: Capacitor's web view showing https://www.anagramjam.com (see capacitor.config.json)
class AppViewController: CAPBridgeViewController {
    // The web view holds its navigation delegate weakly, so the filter is kept alive here
    private var navigationFilter: NavigationFailureFilter?

    // A page whose scripts fail to load (the connection dropping halfway through it) looks right but does nothing, and
    // the app has no reload button. So each page of the site reloads itself once when that happens.
    private static let reloadIfScriptsFail = """
    (function () {
      if (location.protocol === 'capacitor:') return;
      var failed = false;
      document.addEventListener('error', function (event) {
        if (event.target && event.target.tagName === 'SCRIPT') failed = true;
      }, true);
      window.addEventListener('load', function () {
        if (!failed) return;
        try {
          var key = 'reloadedForScripts:' + location.href;
          if (Date.now() - Number(sessionStorage.getItem(key) || 0) < 60000) return;
          sessionStorage.setItem(key, String(Date.now()));
          location.reload();
        } catch (e) {}
      });
    })();
    """

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // Signing in with Google or Apple, in iOS's sign-in sheet (see AuthSessionPlugin.swift)
        bridge?.registerPluginInstance(AuthSessionPlugin())
        guard let webView = webView else { return }
        if let capacitorDelegate = webView.navigationDelegate {
            let filter = NavigationFailureFilter(passingTo: capacitorDelegate, offlinePage: bridge?.config.errorPathURL)
            webView.navigationDelegate = filter
            navigationFilter = filter
        }
        webView.configuration.userContentController.addUserScript(
            WKUserScript(source: Self.reloadIfScriptsFail, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // A connection that's up but goes nowhere would leave a blank screen for a minute before the first page gives up.
        // If nothing has shown by 10 seconds, the offline page takes over - it keeps trying the site.
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self = self, let webView = self.webView, webView.backForwardList.currentItem == nil else { return }
            self.navigationFilter?.showOfflinePage(in: webView, for: nil)
        }
    }
}

// Decides when the offline page (server.errorPath) shows, in place of Capacitor, which shows it whenever any page load
// fails - including a load that was only cut short by another one, like a button tapped twice, where the newer load
// carries on and the offline page would replace it. Everything else goes to Capacitor's own delegate as before.
final class NavigationFailureFilter: NSObject, WKNavigationDelegate {
    private let capacitorDelegate: WKNavigationDelegate
    private let offlinePage: URL?

    init(passingTo capacitorDelegate: WKNavigationDelegate, offlinePage: URL?) {
        self.capacitorDelegate = capacitorDelegate
        self.offlinePage = offlinePage
    }

    // Whatever this class doesn't handle itself goes straight to Capacitor's delegate
    override func responds(to aSelector: Selector!) -> Bool {
        return super.responds(to: aSelector) || capacitorDelegate.responds(to: aSelector)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        return capacitorDelegate.responds(to: aSelector) ? capacitorDelegate : super.forwardingTarget(for: aSelector)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(webView, error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(webView, error)
    }

    // The server answering with an error of its own (a broken deploy, Vercel having trouble): WebKit would show that
    // page, and the app has no reload button to get away from it
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame, let response = navigationResponse.response as? HTTPURLResponse,
           response.statusCode >= 500 {
            // The cancelled load is reported as WebKit's error 102, which failed() leaves alone
            decisionHandler(.cancel)
            CAPLog.print("⚡️  Server error \(response.statusCode) for \(response.url?.absoluteString ?? "a page")")
            showOfflinePage(in: webView, for: response.url, serverError: true)
            return
        }
        decisionHandler(.allow)
    }

    // The offline page is told what happened: the page that couldn't load goes after the # (so it can go back to it - a
    // room, say - rather than home), ?again means it was a load the offline page itself had just sent, and &server that
    // the site answered with an error rather than not at all
    func showOfflinePage(in webView: WKWebView, for failedURL: URL?, serverError: Bool = false) {
        guard let offlinePage = offlinePage else { return }
        var flags: [String] = []
        if webView.backForwardList.currentItem?.url.scheme == offlinePage.scheme { flags.append("again") }
        if serverError { flags.append("server") }
        var address = offlinePage.absoluteString
        if !flags.isEmpty { address += "?" + flags.joined(separator: "&") }
        if let failed = failedURL?.absoluteString.addingPercentEncoding(withAllowedCharacters: .alphanumerics) {
            address += "#" + failed
        }
        if let url = URL(string: address) {
            webView.load(URLRequest(url: url))
        }
    }

    private func failed(_ webView: WKWebView, _ error: Error) {
        let error = error as NSError
        // Cut short on purpose, so whatever replaced it carries on: NSURLErrorCancelled is another load taking over
        // (a second tap, or the offline page itself), and WebKit's 102 is a load stopped by a decision (the server
        // error above, or a link Capacitor sent to Safari)
        if (error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled)
            || (error.domain == "WebKitErrorDomain" && error.code == 102) {
            return
        }
        CAPLog.print("⚡️  WebView failed to load: \(error.localizedDescription)")
        showOfflinePage(in: webView, for: error.userInfo[NSURLErrorFailingURLErrorKey] as? URL)
    }
}
