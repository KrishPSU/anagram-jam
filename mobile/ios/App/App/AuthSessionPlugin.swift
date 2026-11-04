import AuthenticationServices
import Capacitor

// Signing in with Google or Apple, for /shared/account.js. Google never signs anyone in inside an app's own web view,
// and in it Apple's page is a plain form, where Safari shows its sheet with the iPhone's Apple ID. So the sign-in runs
// in iOS's sign-in sheet (ASWebAuthenticationSession, Safari's engine) instead. It starts at Supabase's sign-in page
// and ends when that comes back to /account/callback, which hands the code on to this app's own scheme (see
// /account/callback.js); that address is what the page gets, and it finishes the sign-in in the web view, where the
// verifier is kept.
//
// The page calls window.Capacitor.Plugins.AuthSession.start({ url, ephemeral }) and gets { url }, or an error with
// the code 'cancelled' if the sheet was closed. ephemeral keeps the sheet's cookies apart from Safari's, so iOS
// doesn't first ask whether the app may use the site to sign in.
@objc(AuthSessionPlugin)
public class AuthSessionPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "AuthSessionPlugin"
    public let jsName = "AuthSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise)
    ]

    // The way back, fixed here rather than taken from the page
    static let callbackScheme = "com.krishchavan.anagramjam"

    // The sheet that's open; iOS doesn't keep it alive by itself
    private var session: ASWebAuthenticationSession?

    @objc func start(_ call: CAPPluginCall) {
        guard let address = call.getString("url"), let url = URL(string: address),
              url.scheme == "https" || url.scheme == "http" else {
            call.reject("A sign-in page's address is needed", "bad")
            return
        }
        let ephemeral = call.getBool("ephemeral") ?? false
        DispatchQueue.main.async {
            if self.session != nil {
                call.reject("A sign-in is already open", "busy")
                return
            }
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: Self.callbackScheme) { [weak self] callbackURL, error in
                self?.session = nil
                if let callbackURL = callbackURL {
                    call.resolve(["url": callbackURL.absoluteString])
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    call.reject("The sign-in was cancelled", "cancelled")
                } else {
                    call.reject(error?.localizedDescription ?? "The sign-in didn't finish", "failed")
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = ephemeral
            self.session = session
            if !session.start() {
                self.session = nil
                call.reject("The sign-in couldn't start", "failed")
            }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}
