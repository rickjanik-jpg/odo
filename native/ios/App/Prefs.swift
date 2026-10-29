import Foundation

/// Small settings the tracker needs even when the app screen was never opened.
enum Prefs {
    /// Automatic trips shorter than this are dropped (parking lot shuffles, GPS noise).
    static let minAutoMiles = 0.25
    /// A dash ends by itself this long after it starts.
    static let dashLength: TimeInterval = 12 * 3600

    private static var d: UserDefaults { .standard }

    static var auto: Bool {
        get { d.bool(forKey: "odo.auto") }
        set { d.set(newValue, forKey: "odo.auto") }
    }

    static var prompt: String {
        get { d.string(forKey: "odo.prompt") ?? "Are you dashing?" }
        set { d.set(newValue, forKey: "odo.prompt") }
    }

    static var gigs: [String] {
        get { (d.array(forKey: "odo.gigs") as? [String]) ?? ["DoorDash"] }
        set { d.set(newValue, forKey: "odo.gigs") }
    }

    static var workLabel: String { gigs.first ?? "Work" }

    // MARK: Dash mode: every drive is logged as work until the dash ends.

    static var dashSince: Date? {
        get { date("odo.dashSince") }
        set { setDate(newValue, "odo.dashSince") }
    }

    static var dashUntil: Date? {
        get { date("odo.dashUntil") }
        set { setDate(newValue, "odo.dashUntil") }
    }

    static var isDashing: Bool {
        guard let until = dashUntil else { return false }
        return until > Date()
    }

    // MARK: Where the phone last parked (start point of the next automatic trip).

    static var park: (lat: Double, lng: Double, time: Date)? {
        get {
            guard let a = d.array(forKey: "odo.park") as? [Double], a.count == 3 else { return nil }
            return (a[0], a[1], Date(timeIntervalSince1970: a[2]))
        }
        set {
            if let p = newValue {
                d.set([p.lat, p.lng, p.time.timeIntervalSince1970], forKey: "odo.park")
            } else {
                d.removeObject(forKey: "odo.park")
            }
        }
    }

    private static func date(_ key: String) -> Date? {
        let t = d.double(forKey: key)
        return t > 0 ? Date(timeIntervalSince1970: t) : nil
    }

    private static func setDate(_ value: Date?, _ key: String) {
        d.set(value?.timeIntervalSince1970 ?? 0, forKey: key)
    }
}
