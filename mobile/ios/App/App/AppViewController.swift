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

    // The loading screen, over the web view until the first page is ready (see LaunchView.swift)
    private var launch: LaunchView?
    private var pageReady = false
    private var linkObservers: [NSObjectProtocol] = []

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // Signing in with Google or Apple, in iOS's sign-in sheet (see AuthSessionPlugin.swift)
        bridge?.registerPluginInstance(AuthSessionPlugin())
        // Whether the phone is playing its own music, for the game's to leave it be (see OtherAudioPlugin.swift)
        bridge?.registerPluginInstance(OtherAudioPlugin())
        // A page saying it's ready to be seen (see LaunchPlugin.swift)
        let launchPlugin = LaunchPlugin()
        launchPlugin.onReady = { [weak self] in self?.firstPageReady() }
        bridge?.registerPluginInstance(launchPlugin)

        guard let webView = webView else { return }
        if let capacitorDelegate = webView.navigationDelegate {
            let filter = NavigationFailureFilter(passingTo: capacitorDelegate, offlinePage: bridge?.config.errorPathURL)
            // A page that never says it's ready - the offline page, or one from before the site knew to - still gets
            // seen, a moment after it has loaded
            filter.onLoaded = { [weak self] in
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self?.firstPageReady() }
            }
            webView.navigationDelegate = filter
            navigationFilter = filter
        }
        webView.configuration.userContentController.addUserScript(
            WKUserScript(source: Self.reloadIfScriptsFail, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        // Links to the site that iOS hands to the app (see open(link:))
        for name in [Notification.Name.capacitorOpenUniversalLink, Notification.Name.capacitorOpenURL] {
            linkObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                guard let details = notification.object as? [String: Any], let url = details["url"] as? URL else { return }
                self?.open(link: url)
            })
        }
    }

    deinit {
        linkObservers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // The loading screen goes over the web view before anything is drawn, and plays from the app's first frame
        let launch = LaunchView(frame: view.bounds)
        view.addSubview(launch)
        self.launch = launch
        // Whatever happens to the page, the loading screen doesn't stay for good
        DispatchQueue.main.asyncAfter(deadline: .now() + 14) { [weak self] in self?.firstPageReady() }

        // A connection that's up but goes nowhere would leave a blank screen for a minute before the first page gives up.
        // If nothing has shown by 10 seconds, the offline page takes over - it keeps trying the site.
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self = self, let webView = self.webView, webView.backForwardList.currentItem == nil else { return }
            self.navigationFilter?.showOfflinePage(in: webView, for: nil)
        }
    }


    // ---------- The loading screen handing over to the first page ----------

    private func firstPageReady() {
        guard launch != nil, !pageReady else { return }
        pageReady = true
        handOver()
    }

    // Once the tiles have spelled the name out and the page is ready, whichever comes last. The page is asked where
    // its own title's tiles are, and hides them for the loading screen's to land on (window.launchTitle in the site's
    // /shared/app.js: the home page, at the top, gives ten boxes; any other page gives nothing, and gets a fade).
    private var handingOver = false
    private func handOver() {
        guard let launch = launch, pageReady, !handingOver else { return }
        launch.whenPlayed { [weak self] in
            guard let self = self, !self.handingOver else { return }
            self.handingOver = true
            let leave = { [weak self] (places: [CGRect]?) in
                launch.leave(onto: places, landed: { [weak self] in
                    self?.webView?.evaluateJavaScript("window.launchTitle && window.launchTitle('show')", completionHandler: nil)
                }, gone: { [weak self] in
                    launch.removeFromSuperview()
                    self?.launch = nil
                })
            }
            guard let webView = self.webView else {
                leave(nil)
                return
            }
            webView.evaluateJavaScript("window.launchTitle ? window.launchTitle('hide') : null") { result, _ in
                var places: [CGRect]?
                if let boxes = result as? [[NSNumber]], !boxes.isEmpty, boxes.allSatisfy({ $0.count == 4 }) {
                    // The page's coordinates are the web view's, which the loading screen covers exactly
                    places = boxes.map {
                        let box = CGRect(x: $0[0].doubleValue, y: $0[1].doubleValue, width: $0[2].doubleValue, height: $0[3].doubleValue)
                        return webView.convert(box, to: launch)
                    }
                }
                leave(places)
            }
        }
    }


    // ---------- Links ----------

    // A link to the site, opened on a phone that has the app: iOS gives it to the app instead of Safari (the site
    // vouches for the app in /.well-known/apple-app-site-association, index.js at the project root, and the app names
    // the site in App.entitlements). Safari's "Open" banner on a page of the site does the same. The app goes straight
    // to the link's page - a friend's room, mostly - whatever it was showing.
    //
    // Only the game's own pages, as that file lists them. A link to the site itself (or /app, the link people share
    // the app with) has nowhere in particular to go: the app has come to the front, and that's all it asked.
    private func open(link: URL) {
        guard let webView = webView, let site = bridge?.config.serverURL,
              link.scheme == "https", let host = link.host?.lowercased(),
              host == "www.anagramjam.com" || host == "anagramjam.com" else { return }
        let path = link.path
        let page = path.hasSuffix("/") ? path : path + "/"
        let known = page.hasPrefix("/game/") || ["/daily/", "/solo/", "/practice/"].contains(page)
        guard known else { return }
        // Already there (the room you're in, say): nothing to do
        if let current = webView.url, current.host == site.host {
            let here = current.path.hasSuffix("/") ? current.path : current.path + "/"
            if here.lowercased() == page.lowercased() { return }
        }
        // On the site the app is showing (which, in a test build, isn't the real one)
        guard var address = URLComponents(url: site, resolvingAgainstBaseURL: false) else { return }
        address.path = page
        address.query = nil
        address.fragment = nil
        if let url = address.url {
            CAPLog.print("⚡️  Opening a link: \(page)")
            webView.load(URLRequest(url: url))
        }
    }
}

// Decides when the offline page (server.errorPath) shows, in place of Capacitor, which shows it whenever any page load
// fails - including a load that was only cut short by another one, like a button tapped twice, where the newer load
// carries on and the offline page would replace it. Everything else goes to Capacitor's own delegate as before.
final class NavigationFailureFilter: NSObject, WKNavigationDelegate {
    private let capacitorDelegate: WKNavigationDelegate
    private let offlinePage: URL?
    // Called each time a page has finished loading
    var onLoaded: (() -> Void)?

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

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        capacitorDelegate.webView?(webView, didFinish: navigation)
        onLoaded?()
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
