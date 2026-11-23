import UIKit
import CoreText

// The loading screen: what's on show from the moment the app opens until its first page is ready. Letter tiles drop in
// from the top in a jumble, then sort themselves into ANAGRAM JAM - a word being solved, as in the game. It always
// plays through (about a second and a half); if the page isn't ready by then, the tiles keep a little wave going until
// it is.
//
// Then it hands over to the page. On the home page its tiles glide up onto the page's own title, tile for tile, while
// the rest of the page fades in around them, so the two are one screen (AppViewController asks the page where its
// title is - /shared/app.js on the site). Anywhere else the app opened - a room from a link, a reminder's page, the
// offline page - it fades away.
//
// It's drawn by the app, not the site, so it's there before anything has loaded. iOS only lets the very first moment
// be a still picture (LaunchScreen.storyboard): that's the plain dark this starts from, so the tiles fall into an
// empty screen. The tiles are made to look like the site's (.tile in /shared/theme.css), with its font
// (Rubik-Black.ttf, in the app).
final class LaunchView: UIView {
    private static let words: [(letters: String, jam: Bool)] = [("ANAGRAM", false), ("JAM", true)]

    // The site's colours (/shared/theme.css)
    private static let dark = UIColor(red: 0x23 / 255, green: 0x25 / 255, blue: 0x26 / 255, alpha: 1)       // --bg-1
    private static let lighter = UIColor(red: 0x41 / 255, green: 0x43 / 255, blue: 0x45 / 255, alpha: 1)    // --bg-2
    fileprivate static let ink = UIColor(red: 0x11 / 255, green: 0x18 / 255, blue: 0x27 / 255, alpha: 1)    // --ink
    fileprivate static let jam = UIColor(red: 0xff / 255, green: 0x5f / 255, blue: 0xa8 / 255, alpha: 1)    // --jam

    // When each part happens, in seconds from the start
    private static let fallEach = 0.03       // between one tile starting to fall and the next
    private static let fallTime = 0.46
    private static let solveAt = 0.83        // every tile has landed, and a beat has passed
    private static let solveEach = 0.02
    private static let solveTime = 0.42
    private static let pulseAt = 1.3         // solved: a ripple along the word
    private static let pulseEach = 0.015
    private static let pulseTime = 0.26
    private static let playTime = 1.62       // all of it

    private let backdrop = UIView()
    private var tiles: [TileView] = []       // in reading order: A N A G R A M, J A M
    private var size: CGFloat = 0            // a tile's width
    private var began = false
    private var played = false               // the tiles have landed and sorted themselves
    private var wanted: (() -> Void)?        // what to do once they have (see whenPlayed)
    private var leaving = false

    private var stillMotion: Bool { UIAccessibility.isReduceMotionEnabled }

    override init(frame: CGRect) {
        super.init(frame: frame)
        autoresizingMask = [.flexibleWidth, .flexibleHeight]
        backdrop.frame = bounds
        backdrop.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        backdrop.backgroundColor = Self.dark
        addSubview(backdrop)
    }

    required init?(coder: NSCoder) {
        fatalError("LaunchView is made in code")
    }

    // Laid out and started once the screen's size is known
    override func layoutSubviews() {
        super.layoutSubviews()
        guard !began, bounds.width > 0, bounds.height > 0 else { return }
        began = true
        build()
        play()
    }

    // Calls back once the tiles have spelled the name out (straight away if they already have)
    func whenPlayed(_ callback: @escaping () -> Void) {
        if played {
            callback()
        } else {
            wanted = callback
        }
    }


    // ---------- What's on it ----------

    private func build() {
        // The home page's backdrop, fading in over the plain dark the app opened on
        let picture = UIImageView(image: backdropPicture())
        picture.frame = backdrop.bounds
        picture.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        picture.alpha = 0
        backdrop.addSubview(picture)
        UIView.animate(withDuration: 0.3) { picture.alpha = 1 }

        // Seven tiles across with room to spare, a little bigger than the home page's title
        let gapShare: CGFloat = 6.0 / 38.0 // the gap between tiles, as a share of a tile (the site's is 6px at 38px)
        size = min(46, floor((bounds.width - 56) / (7 + 6 * gapShare)))
        let gap = size * gapShare
        let height = size * 1.15
        let rowGap = size * 8 / 38
        let font = Self.tileFont(size: size * 0.56)
        let top = bounds.height * 0.44 - (height * 2 + rowGap) / 2

        for (row, word) in Self.words.enumerated() {
            let letters = Array(word.letters)
            let width = CGFloat(letters.count) * (size + gap) - gap
            let left = (bounds.width - width) / 2
            for (i, letter) in letters.enumerated() {
                let tile = TileView(letter: letter, jam: word.jam, size: size, font: font)
                tile.home = CGPoint(x: left + CGFloat(i) * (size + gap) + size / 2,
                                    y: top + CGFloat(row) * (height + rowGap) + height / 2)
                tile.row = row
                tile.center = tile.home
                addSubview(tile)
                tiles.append(tile)
            }
        }
    }

    // The site's font for tiles, from the file in the app. (Made straight from the file, so nothing has to be
    // registered or named.) The phone's own heaviest if that ever fails.
    private static func tileFont(size: CGFloat) -> UIFont {
        if let url = Bundle.main.url(forResource: "Rubik-Black", withExtension: "ttf"),
           let provider = CGDataProvider(url: url as CFURL),
           let font = CGFont(provider) {
            return CTFontCreateWithGraphicsFont(font, size, nil, nil) as UIFont
        }
        return UIFont.systemFont(ofSize: size, weight: .black)
    }

    // The home page's backdrop as a picture (body and body::before in /shared/theme.css, with body.home's colours): the
    // dark gradient from the top left corner to the bottom right, and three soft glows on it. The page's glows drift,
    // slowly; these are where they start.
    private func backdropPicture() -> UIImage {
        let w = bounds.width, h = bounds.height
        let space = CGColorSpaceCreateDeviceRGB()
        return UIGraphicsImageRenderer(bounds: bounds).image { renderer in
            let context = renderer.cgContext
            // linear-gradient(135deg, ...): along the diagonal direction, its ends level with the two corners
            let reach = (w + h) / 4
            if let gradient = CGGradient(colorsSpace: space, colors: [Self.dark.cgColor, Self.lighter.cgColor] as CFArray, locations: [0, 1]) {
                context.drawLinearGradient(gradient, start: CGPoint(x: w / 2 - reach, y: h / 2 - reach),
                                           end: CGPoint(x: w / 2 + reach, y: h / 2 + reach),
                                           options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
            }
            // radial-gradient(circle at x y, colour, transparent 50%) on a box a fifth bigger than the screen each way
            let box = bounds.insetBy(dx: -w * 0.2, dy: -h * 0.2)
            let glows: [(x: CGFloat, y: CGFloat, colour: UIColor)] = [
                (0.2, 0.5, UIColor(red: 1, green: 95 / 255, blue: 168 / 255, alpha: 0.40)),
                (0.8, 0.2, UIColor(red: 1, green: 170 / 255, blue: 90 / 255, alpha: 0.30)),
                (0.4, 0.8, UIColor(red: 120 / 255, green: 119 / 255, blue: 198 / 255, alpha: 0.34)),
            ]
            for glow in glows {
                let centre = CGPoint(x: box.minX + box.width * glow.x, y: box.minY + box.height * glow.y)
                // A circle out to the farthest corner; the colour is gone halfway there
                let far = hypot(max(centre.x - box.minX, box.maxX - centre.x), max(centre.y - box.minY, box.maxY - centre.y))
                let colours = [glow.colour.cgColor, glow.colour.withAlphaComponent(0).cgColor] as CFArray
                if let gradient = CGGradient(colorsSpace: space, colors: colours, locations: [0, 1]) {
                    context.drawRadialGradient(gradient, startCenter: centre, startRadius: 0, endCenter: centre, endRadius: far / 2, options: [])
                }
            }
        }
    }


    // ---------- The tiles falling, then sorting themselves ----------

    private func play() {
        if stillMotion {
            // No falling or sliding for someone who's asked their phone for less movement: the name, in place
            tiles.forEach { $0.alpha = 0 }
            UIView.animate(withDuration: 0.25) { self.tiles.forEach { $0.alpha = 1 } }
            finishPlaying(after: 0.7)
            return
        }

        // Where each tile lands first: a place in its own row that isn't its own
        var landing: [CGPoint] = tiles.map { $0.home }
        for row in Self.words.indices {
            let own = tiles.indices.filter { tiles[$0].row == row }
            let mixed = Self.jumbled(own.count)
            for (i, index) in own.enumerated() {
                landing[index] = tiles[own[mixed[i]]].home
            }
        }

        let now = CACurrentMediaTime()
        let k = size / 38
        let height = size * 1.15
        let fallOrder = tiles.indices.shuffled()

        for (turn, index) in fallOrder.enumerated() {
            let tile = tiles[index]
            let land = landing[index]
            let tilt = CGFloat.random(in: -0.12...0.12)
            let fallAt = Double(turn) * Self.fallEach
            let solveAt = Self.solveAt + Double(index) * Self.solveEach
            let pulseAt = Self.pulseAt + Double(index) * Self.pulseEach

            // Down from above the screen, gathering speed, with a bounce on landing
            let drop = CAKeyframeAnimation(keyPath: "position.y")
            drop.values = [-height, land.y, land.y - 10 * k, land.y, land.y - 2.5 * k, land.y]
            drop.keyTimes = [0, 0.56, 0.72, 0.87, 0.94, 1]
            drop.timingFunctions = [
                CAMediaTimingFunction(controlPoints: 0.45, 0, 0.9, 0.6),
                CAMediaTimingFunction(name: .easeOut), CAMediaTimingFunction(name: .easeIn),
                CAMediaTimingFunction(name: .easeOut), CAMediaTimingFunction(name: .easeIn),
            ]
            let drift = CABasicAnimation(keyPath: "position.x")
            drift.fromValue = land.x + CGFloat.random(in: -26...26) * k
            drift.toValue = land.x
            drift.timingFunction = CAMediaTimingFunction(name: .easeOut)
            let tumble = CAKeyframeAnimation(keyPath: "transform.rotation.z")
            tumble.values = [CGFloat.random(in: -0.6...0.6), tilt * 1.6, tilt]
            tumble.keyTimes = [0, 0.56, 1]
            for part in [drop, drift, tumble] as [CAAnimation] {
                part.beginTime = fallAt
                part.duration = Self.fallTime
                part.fillMode = .both // above the screen until its turn, then where it landed until it's sorted
            }

            // Then across to its own place, a touch past it and back, as the home page's title sorts itself
            let past = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.25, 1.2)
            let slide = CABasicAnimation(keyPath: "position.x")
            slide.fromValue = land.x
            slide.toValue = tile.home.x
            let settle = CABasicAnimation(keyPath: "position.y")
            settle.fromValue = land.y
            settle.toValue = tile.home.y
            let straighten = CABasicAnimation(keyPath: "transform.rotation.z")
            straighten.fromValue = tilt
            straighten.toValue = 0
            for part in [slide, settle, straighten] {
                part.beginTime = solveAt
                part.duration = Self.solveTime
                part.timingFunction = past
                part.fillMode = .forwards
            }

            // And a ripple along the finished word
            let pulse = CAKeyframeAnimation(keyPath: "transform.scale")
            pulse.values = [1, 1.09, 1]
            pulse.keyTimes = [0, 0.4, 1]
            pulse.timingFunctions = [CAMediaTimingFunction(name: .easeOut), CAMediaTimingFunction(name: .easeInEaseOut)]
            pulse.beginTime = pulseAt
            pulse.duration = Self.pulseTime

            let all = CAAnimationGroup()
            all.animations = [drop, drift, tumble, slide, settle, straighten, pulse]
            all.beginTime = now
            all.duration = Self.playTime + 0.1
            tile.layer.add(all, forKey: "play")
        }
        finishPlaying(after: Self.playTime)
    }

    // 0..<count in an order that leaves nothing where it started
    private static func jumbled(_ count: Int) -> [Int] {
        guard count > 1 else { return Array(0..<count) }
        while true {
            let order = Array(0..<count).shuffled()
            if !order.enumerated().contains(where: { $0.offset == $0.element }) { return order }
        }
    }

    private func finishPlaying(after seconds: Double) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self = self else { return }
            self.played = true
            if let wanted = self.wanted {
                self.wanted = nil
                wanted()
            } else {
                self.wave()
            }
        }
    }

    // Still waiting for the page: a little hop passing along the tiles, over and over
    private func wave() {
        guard !stillMotion, !leaving else { return }
        let now = CACurrentMediaTime()
        for (i, tile) in tiles.enumerated() {
            let hop = CAKeyframeAnimation(keyPath: "transform.translation.y")
            hop.values = [0, -7 * size / 38, 0, 0]
            hop.keyTimes = [0, 0.16, 0.32, 1]
            hop.timingFunctions = [CAMediaTimingFunction(name: .easeOut), CAMediaTimingFunction(name: .easeIn), CAMediaTimingFunction(name: .linear)]
            hop.duration = 1.5
            hop.repeatCount = .infinity
            hop.beginTime = now + 0.35 + Double(i) * 0.07
            tile.layer.add(hop, forKey: "wave")
        }
    }


    // ---------- Handing over to the page ----------

    // The page is ready underneath. places: where its own title's tiles are, one for each of these and in the same
    // order (in this view's coordinates, which are the page's) - the tiles glide onto them as the backdrop fades off the
    // page, and `landed` is called with them sitting exactly on the page's. Without places (not the home page), it all
    // fades. `landed` is where the page's own title is shown again; `gone` is called once this view can be taken away.
    func leave(onto places: [CGRect]?, landed: @escaping () -> Void, gone: @escaping () -> Void) {
        guard !leaving else { return }
        leaving = true

        guard let places = places, places.count == tiles.count, !stillMotion else {
            landed()
            UIView.animate(withDuration: 0.3, delay: 0, options: [.curveEaseOut, .beginFromCurrentState], animations: {
                self.alpha = 0
            }, completion: { _ in gone() })
            return
        }

        let glide = 0.5
        let each = 0.012
        let ease = CAMediaTimingFunction(controlPoints: 0.5, 0, 0.2, 1)
        let now = CACurrentMediaTime()
        for (i, tile) in tiles.enumerated() {
            let place = places[i]
            let scale = place.width / size
            // From wherever the wave has it
            let from = tile.layer.presentation()?.transform ?? tile.layer.transform
            tile.layer.removeAnimation(forKey: "wave")
            let to = CATransform3DMakeScale(scale, scale, 1)

            let move = CABasicAnimation(keyPath: "position")
            move.fromValue = tile.layer.position
            move.toValue = CGPoint(x: place.midX, y: place.midY)
            let shrink = CABasicAnimation(keyPath: "transform")
            shrink.fromValue = from
            shrink.toValue = to
            for part in [move, shrink] {
                part.beginTime = now + Double(i) * each
                part.duration = glide
                part.timingFunction = ease
                part.fillMode = .backwards
            }
            tile.layer.position = CGPoint(x: place.midX, y: place.midY)
            tile.layer.transform = to
            tile.layer.add(move, forKey: "glide")
            tile.layer.add(shrink, forKey: "shrink")
        }
        UIView.animate(withDuration: 0.38, delay: 0.04, options: [.curveEaseInOut], animations: {
            self.backdrop.alpha = 0
        })
        // The page shows its own title under these, and a moment later (once it has drawn it) these go
        DispatchQueue.main.asyncAfter(deadline: .now() + glide + Double(tiles.count) * each + 0.03) {
            landed()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { gone() }
        }
    }
}


// One letter tile, as the site draws them (.tile in /shared/theme.css): a rounded card with a hard edge along the
// bottom and a soft shadow under it. Everything is in proportion to its width, the site's being 38 points wide.
private final class TileView: UIView {
    var home = CGPoint.zero // its centre, in its place in the word
    var row = 0

    init(letter: Character, jam: Bool, size: CGFloat, font: UIFont) {
        let k = size / 38
        super.init(frame: CGRect(x: 0, y: 0, width: size, height: size * 1.15))
        isUserInteractionEnabled = false
        let radius = 10 * k
        let shape = UIBezierPath(roundedRect: bounds, cornerRadius: radius)

        // box-shadow: 0 10px 18px -6px rgba(0, 0, 0, 0.45)
        let soft = CALayer()
        soft.frame = bounds
        soft.shadowPath = UIBezierPath(roundedRect: bounds.insetBy(dx: 6 * k, dy: 6 * k), cornerRadius: max(radius - 6 * k, 1)).cgPath
        soft.shadowColor = UIColor.black.cgColor
        soft.shadowOpacity = 0.45
        soft.shadowRadius = 9 * k
        soft.shadowOffset = CGSize(width: 0, height: 10 * k)
        layer.addSublayer(soft)

        // box-shadow: 0 3px 0 rgba(0, 0, 0, 0.28) - only what shows below the tile, as a shadow under it would
        let edge = CAShapeLayer()
        let below = UIBezierPath(roundedRect: bounds.offsetBy(dx: 0, dy: 3 * k), cornerRadius: radius)
        below.append(shape)
        edge.path = below.cgPath
        edge.fillRule = .evenOdd
        edge.fillColor = UIColor(white: 0, alpha: 0.28).cgColor
        layer.addSublayer(edge)

        let face = CAShapeLayer()
        face.path = shape.cgPath
        face.fillColor = (jam ? LaunchView.jam : UIColor.white).cgColor
        layer.addSublayer(face)

        let label = UILabel(frame: bounds)
        label.text = String(letter)
        label.font = font
        label.textColor = jam ? .white : LaunchView.ink
        label.textAlignment = .center
        addSubview(label)

        layer.allowsEdgeAntialiasing = true
    }

    required init?(coder: NSCoder) {
        fatalError("TileView is made in code")
    }
}
