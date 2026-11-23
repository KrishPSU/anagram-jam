import AVFoundation
import Capacitor

// Whether the phone is already playing something of its own - a song, a podcast - for /shared/sfx.js. When it is, the
// game keeps its music off and lets that carry on, with only its sound effects over it, the way iPhone games do. (The
// game's sound is the 'ambient' kind, which plays alongside other apps' rather than stopping it - sfx.js sets that.)
//
// The page calls window.Capacitor.Plugins.OtherAudio.check() and gets { playing }, and listens for 'change' with the
// same, sent whenever the app comes back to the front (someone has been to their music app, or pressed play in Control
// Center) and when iOS says it has changed.
//
// iOS's own word for this is asked for (secondaryAudioShouldBeSilencedHint): it's true for another app's music, and
// not for sounds that mix in with everything else - which is what the game's own are, so it never hears itself.
@objc(OtherAudioPlugin)
public class OtherAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OtherAudioPlugin"
    public let jsName = "OtherAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "check", returnType: CAPPluginReturnPromise)
    ]

    private var observers: [NSObjectProtocol] = []

    private var playing: Bool {
        AVAudioSession.sharedInstance().secondaryAudioShouldBeSilencedHint
    }

    override public func load() {
        let center = NotificationCenter.default
        for name in [UIApplication.didBecomeActiveNotification, AVAudioSession.silenceSecondaryAudioHintNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                guard let self = self else { return }
                self.notifyListeners("change", data: ["playing": self.playing])
            })
        }
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    @objc func check(_ call: CAPPluginCall) {
        call.resolve(["playing": playing])
    }
}
