import Capacitor

// How a page tells the app it's ready to be seen, so the loading screen (LaunchView.swift) can hand over to it. Every
// page of the site calls window.Capacitor.Plugins.Launch.ready() once it has built itself and drawn (/shared/app.js);
// after the first page it does nothing.
@objc(LaunchPlugin)
public class LaunchPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LaunchPlugin"
    public let jsName = "Launch"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "ready", returnType: CAPPluginReturnPromise)
    ]

    // AppViewController's, which has the loading screen
    var onReady: (() -> Void)?

    @objc func ready(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.onReady?() }
        call.resolve()
    }
}
