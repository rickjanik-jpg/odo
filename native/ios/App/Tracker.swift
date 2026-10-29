import Foundation
import CoreLocation
import CoreMotion
import UserNotifications
import UIKit

extension Notification.Name {
    static let odoTripsChanged = Notification.Name("odo.tripsChanged")
    static let odoStateChanged = Notification.Name("odo.stateChanged")
}

/// Records drives. One instance for the whole app; every call happens on the main thread.
///
/// How automatic tracking works on iPhone:
/// - While Odo is closed, iPhone wakes it when the phone moves a good distance (significant location change)
///   or leaves the spot where the last drive ended (a 150 m geofence). Both cost almost no battery.
/// - On waking, Odo checks for up to 3 minutes whether you're driving (motion sensors, or GPS speed).
/// - If so, it records the trip with GPS, starting from where you parked so the first stretch counts.
/// - The trip ends once the motion sensors say you've stopped driving and you've been still for 2 minutes
///   (or after 5 minutes without movement). Then Odo asks "Was this drive for work?".
final class Tracker: NSObject, CLLocationManagerDelegate, UNUserNotificationCenterDelegate {
    static let shared = Tracker()

    enum Mode { case idle, probing, tracking }

    let manager = CLLocationManager()
    private let motion = CMMotionActivityManager()
    private var motionOn = false
    private var booted = false

    private(set) var mode: Mode = .idle
    private(set) var manual = false

    // Trip being recorded
    private var tripId = ""
    private var startTime = Date()
    private var lastMove = Date()
    private var meters: Double = 0
    private var anchor: CLLocation?
    private var path: [[Double]] = []
    private var sinceSave = 0
    private var stillSince: Date?
    private var lastShownMiles: Double = -1

    // Wake-up check
    private var probeStart: Date?
    private var probeFirst: CLLocation?
    private var probeFast = 0

    private var lastFix: CLLocation?
    private var timer: Timer?
    private var authWaiters: [() -> Void] = []
    private(set) var notificationsAllowed = false

    private static let parkId = "odo.park"
    private static let parkRadius: CLLocationDistance = 150
    private static let checkEvery: TimeInterval = 15
    private static let stillAfterStop: TimeInterval = 120
    private static let idleMax: TimeInterval = 300
    private static let probeMax: TimeInterval = 180
    private static let resumeWindow: TimeInterval = 15 * 60
    private static let maxStoredPoints = 300

    // MARK: - Status

    var auth: CLAuthorizationStatus { manager.authorizationStatus }
    var hasAlways: Bool { auth == .authorizedAlways }
    var hasLocation: Bool { auth == .authorizedAlways || auth == .authorizedWhenInUse }
    var precise: Bool { manager.accuracyAuthorization == .fullAccuracy }
    var motionAllowed: Bool {
        CMMotionActivityManager.isActivityAvailable() && CMMotionActivityManager.authorizationStatus() == .authorized
    }
    var miles: Double { mode == .tracking ? meters / 1609.344 : 0 }
    var tripStartMs: Double { mode == .tracking ? startTime.timeIntervalSince1970 * 1000 : 0 }

    // MARK: - Setup

    /// Called from AppDelegate at every launch, including when iPhone launches Odo in the background.
    func boot() {
        guard !booted else { return }
        booted = true
        manager.delegate = self
        manager.activityType = .automotiveNavigation
        manager.pausesLocationUpdatesAutomatically = false
        UNUserNotificationCenter.current().delegate = self
        refreshCategories()
        refreshNotificationStatus(nil)
        resumeSaved()
        arm()
    }

    /// Turns the low-power wake-ups on or off to match the settings.
    func arm() {
        guard booted else { return }
        if mode != .idle {
            startMotion()
        } else if Prefs.auto && hasAlways {
            manager.startMonitoringSignificantLocationChanges()
            startMotion()
            if !isParkMonitored, let p = Prefs.park {
                setPark(CLLocation(latitude: p.lat, longitude: p.lng))
            }
        } else {
            manager.stopMonitoringSignificantLocationChanges()
            removePark()
            stopMotion()
        }
        postState()
    }

    // MARK: - Permissions

    func requestLocation(always: Bool, done: @escaping () -> Void) {
        let s = auth
        if s == .denied || s == .restricted || (always && s == .authorizedAlways) || (!always && hasLocation) {
            done()
            return
        }
        // When the answer is still "not asked", iPhone always shows the prompt: wait for the answer itself.
        // Upgrading to Always may show no prompt (iPhone only asks once), so that case also finishes on its own.
        waitForAuth(done, promptCertain: s == .notDetermined)
        if always { manager.requestAlwaysAuthorization() } else { manager.requestWhenInUseAuthorization() }
    }

    /// Finishes when the permission answer comes in, or right away if iPhone decided not to show a prompt.
    private final class AuthWait {
        var resigned = false
        var finished = false
        var tokens: [NSObjectProtocol] = []
    }

    private func waitForAuth(_ done: @escaping () -> Void, promptCertain: Bool) {
        authWaiters.append(done)
        if promptCertain {
            // locationManagerDidChangeAuthorization finishes this when the person answers.
            DispatchQueue.main.asyncAfter(deadline: .now() + 120) { [weak self] in self?.flushAuthWaiters() }
            return
        }
        let w = AuthWait()
        let nc = NotificationCenter.default
        let finish: () -> Void = { [weak self] in
            guard !w.finished else { return }
            w.finished = true
            w.tokens.forEach { nc.removeObserver($0) }
            w.tokens.removeAll()
            self?.flushAuthWaiters()
        }
        // A permission prompt makes the app inactive; it becomes active again when the prompt closes.
        w.tokens.append(nc.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
            w.resigned = true
        })
        w.tokens.append(nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            if w.resigned { finish() }
        })
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { if !w.resigned { finish() } }
        DispatchQueue.main.asyncAfter(deadline: .now() + 90) { finish() }
    }

    private func flushAuthWaiters() {
        let waiters = authWaiters
        authWaiters.removeAll()
        waiters.forEach { $0() }
    }

    func requestMotion(done: @escaping () -> Void) {
        guard CMMotionActivityManager.isActivityAvailable(),
              CMMotionActivityManager.authorizationStatus() == .notDetermined else { done(); return }
        let now = Date()
        // Asking for recent activity is what makes iPhone show the Motion & Fitness prompt.
        motion.queryActivityStarting(from: now.addingTimeInterval(-60), to: now, to: .main) { [weak self] _, _ in
            self?.arm()
            done()
        }
    }

    func requestNotifications(done: @escaping () -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            DispatchQueue.main.async {
                self.notificationsAllowed = granted
                done()
            }
        }
    }

    func refreshNotificationStatus(_ done: (() -> Void)?) {
        UNUserNotificationCenter.current().getNotificationSettings { s in
            DispatchQueue.main.async {
                self.notificationsAllowed = s.authorizationStatus == .authorized || s.authorizationStatus == .provisional
                done?()
            }
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        // iPhone also calls this once at startup; only a real answer should finish a waiting request.
        if manager.authorizationStatus != .notDetermined { flushAuthWaiters() }
        arm()
    }

    // MARK: - Dash mode

    func startDash() {
        Prefs.dashSince = Date()
        Prefs.dashUntil = Date().addingTimeInterval(Prefs.dashLength)
        // Odo is awake right now (the Dasher shortcut just ran), so check for driving straight away.
        if mode == .idle && Prefs.auto && hasAlways { startProbe() }
        postState()
    }

    func endDash() {
        Prefs.dashSince = nil
        Prefs.dashUntil = nil
        postState()
    }

    // MARK: - Manual control

    func startManual() {
        beginTrip(manual: true)
    }

    func stopTrip() {
        if mode == .tracking {
            finish(manualStop: true)
        } else if mode == .probing {
            endProbe()
        }
    }

    // MARK: - Motion sensors

    private func startMotion() {
        guard !motionOn, motionAllowed else { return }
        motionOn = true
        motion.startActivityUpdates(to: .main) { [weak self] activity in
            if let a = activity { self?.onActivity(a) }
        }
    }

    private func stopMotion() {
        guard motionOn else { return }
        motion.stopActivityUpdates()
        motionOn = false
    }

    private func onActivity(_ a: CMMotionActivity) {
        let sure = a.confidence != .low
        switch mode {
        case .idle, .probing:
            if a.automotive && sure && Prefs.auto && hasLocation { beginTrip(manual: false) }
        case .tracking:
            if manual { return }
            if a.automotive {
                stillSince = nil // stopped at a light still counts as driving
            } else if sure && (a.stationary || a.walking || a.running) {
                if stillSince == nil { stillSince = Date() }
            }
        }
    }

    // MARK: - Wake-up check

    private func startProbe() {
        guard mode == .idle, Prefs.auto, hasAlways else { return }
        mode = .probing
        probeStart = Date()
        probeFirst = nil
        probeFast = 0
        startGPS(distanceFilter: 10)
        startTimer()
        if motionAllowed {
            let now = Date()
            motion.queryActivityStarting(from: now.addingTimeInterval(-180), to: now, to: .main) { [weak self] acts, _ in
                guard let self = self, self.mode == .probing else { return }
                if let last = acts?.last, last.automotive, last.confidence != .low {
                    self.beginTrip(manual: false)
                }
            }
        }
        postState()
    }

    private func endProbe() {
        guard mode == .probing else { return }
        stopTimer()
        stopGPS()
        mode = .idle
        if let l = lastFix ?? manager.location { setPark(l) }
        arm()
    }

    // MARK: - Recording

    private func beginTrip(manual byHand: Bool) {
        if mode == .tracking {
            if byHand { manual = true; postState() }
            return
        }
        let seed = seedLocation(manual: byHand)
        mode = .tracking
        manual = byHand
        tripId = UUID().uuidString
        startTime = byHand ? Date() : (probeStart ?? Date())
        lastMove = Date()
        meters = 0
        path = []
        anchor = nil
        stillSince = nil
        sinceSave = 0
        lastShownMiles = -1
        if let s = seed {
            anchor = s
            path.append(point(s))
        }
        removePark()
        startGPS(distanceFilter: 5)
        startMotion()
        startTimer()
        saveCurrent()
        postState()
    }

    /// Where the drive really started: the spot where Odo saw you park, the first fix of the wake-up check,
    /// or the phone's last known location. This keeps the stretch before detection from being lost.
    private func seedLocation(manual byHand: Bool) -> CLLocation? {
        var candidates: [CLLocation] = []
        if !byHand {
            if let p = Prefs.park {
                candidates.append(CLLocation(coordinate: CLLocationCoordinate2D(latitude: p.lat, longitude: p.lng),
                                             altitude: 0, horizontalAccuracy: 20, verticalAccuracy: -1, timestamp: p.time))
            }
            if let f = probeFirst { candidates.append(f) }
        }
        if let l = manager.location, -l.timestamp.timeIntervalSinceNow < 300, l.horizontalAccuracy >= 0, l.horizontalAccuracy <= 100 {
            candidates.append(l)
        }
        let here = lastFix ?? manager.location
        for c in candidates {
            guard let h = here else { return c }
            if c.distance(from: h) < 5000 { return c }
        }
        return nil
    }

    private func startGPS(distanceFilter: CLLocationDistance) {
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = distanceFilter
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        manager.startUpdatingLocation()
    }

    private func stopGPS() {
        manager.stopUpdatingLocation()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        for l in locations { onFix(l) }
    }

    func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        if region.identifier == Tracker.parkId && mode == .idle { startProbe() }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Temporary GPS errors are normal (tunnels, parking garages). Keep going.
    }

    private func onFix(_ l: CLLocation) {
        guard l.horizontalAccuracy >= 0 else { return }
        lastFix = l
        switch mode {
        case .idle:
            // A significant-location wake-up. Ignore it if we're still where we parked.
            guard Prefs.auto, hasAlways else { return }
            if let p = Prefs.park, l.distance(from: CLLocation(latitude: p.lat, longitude: p.lng)) < 250 { return }
            startProbe()
        case .probing:
            if probeFirst == nil && l.horizontalAccuracy <= 100 { probeFirst = l }
            if l.speed >= 6 && l.horizontalAccuracy <= 65 { probeFast += 1 } // about 13 mph or faster
            if probeFast >= 2 { beginTrip(manual: false) }
        case .tracking:
            trackFix(l)
        }
    }

    private func trackFix(_ l: CLLocation) {
        let acc = l.horizontalAccuracy
        guard let a = anchor else {
            if acc <= 100 {
                anchor = l
                path.append(point(l))
                lastMove = Date()
            }
            return
        }
        if acc > 40 { return } // too fuzzy to count
        let d = a.distance(from: l)
        if d < max(20, acc) { return } // GPS jitter while parked
        let dt = max(1, l.timestamp.timeIntervalSince(a.timestamp))
        if d / dt > 70 && dt < 60 { return } // impossible jump (~155 mph)

        meters += d
        anchor = l
        path.append(point(l))
        lastMove = Date()

        sinceSave += 1
        if sinceSave >= 10 {
            sinceSave = 0
            saveCurrent()
        }
        if miles - lastShownMiles >= 0.1 {
            lastShownMiles = miles
            postState()
        }
    }

    private func startTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: Tracker.checkEvery, repeats: true) { [weak self] _ in
            self?.check()
        }
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    private func check() {
        let now = Date()
        switch mode {
        case .probing:
            if let s = probeStart, now.timeIntervalSince(s) >= Tracker.probeMax { endProbe() }
        case .tracking:
            if manual { return }
            let idle = now.timeIntervalSince(lastMove)
            let still = stillSince.map { now.timeIntervalSince($0) } ?? 0
            if (still >= Tracker.stillAfterStop && idle >= Tracker.stillAfterStop) || idle >= Tracker.idleMax {
                finish(manualStop: false)
            }
        case .idle:
            stopTimer()
        }
    }

    /// Ends the current trip, saves it if it's long enough, and asks work or personal.
    private func finish(manualStop: Bool, endAt: Date? = nil) {
        guard mode == .tracking else { return }
        if manualStop { manual = true }
        stopTimer()
        stopGPS()
        mode = .idle
        try? FileManager.default.removeItem(at: TripStore.currentURL)

        let mi = meters / 1609.344
        let keep = manual ? mi >= 0.05 : mi >= Prefs.minAutoMiles
        if keep {
            let end = endAt ?? (manual ? Date() : lastMove)
            let trip = makeTrip(miles: mi, end: end)
            TripStore.add(trip)
            notify(trip)
            NotificationCenter.default.post(name: .odoTripsChanged, object: nil)
        }
        if let l = anchor ?? lastFix { setPark(l) }
        manual = false
        arm()
    }

    private func makeTrip(miles mi: Double, end: Date) -> Trip {
        let dashing = Prefs.isDashing
        let step = max(1, Int((Double(path.count) / Double(Tracker.maxStoredPoints)).rounded(.up)))
        var pts: [[Double]] = []
        var i = 0
        while i < path.count { pts.append(path[i]); i += step }
        if let last = path.last, (path.count - 1) % step != 0 { pts.append(last) }
        return Trip(
            id: tripId,
            start: startTime.timeIntervalSince1970 * 1000,
            end: max(end, startTime).timeIntervalSince1970 * 1000,
            miles: (mi * 100).rounded() / 100,
            type: dashing ? "work" : "pending",
            purpose: dashing ? Prefs.workLabel : "",
            manual: manual,
            dash: dashing ? true : nil,
            path: pts
        )
    }

    private func point(_ l: CLLocation) -> [Double] {
        [(l.coordinate.latitude * 1e5).rounded() / 1e5, (l.coordinate.longitude * 1e5).rounded() / 1e5]
    }

    // MARK: - Park geofence

    private var isParkMonitored: Bool {
        manager.monitoredRegions.contains { $0.identifier == Tracker.parkId }
    }

    private func setPark(_ l: CLLocation) {
        Prefs.park = (l.coordinate.latitude, l.coordinate.longitude, Date())
        guard Prefs.auto, hasAlways, CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else { return }
        let region = CLCircularRegion(center: l.coordinate, radius: Tracker.parkRadius, identifier: Tracker.parkId)
        region.notifyOnEntry = false
        region.notifyOnExit = true
        manager.startMonitoring(for: region)
    }

    private func removePark() {
        for r in manager.monitoredRegions where r.identifier == Tracker.parkId {
            manager.stopMonitoring(for: r)
        }
    }

    // MARK: - Survive iPhone closing Odo mid-drive

    private func saveCurrent() {
        let c = CurrentTrip(
            id: tripId,
            start: startTime.timeIntervalSince1970 * 1000,
            manual: manual,
            meters: meters,
            lastMove: lastMove.timeIntervalSince1970 * 1000,
            savedAt: Date().timeIntervalSince1970 * 1000,
            path: path,
            aLat: anchor?.coordinate.latitude,
            aLng: anchor?.coordinate.longitude,
            aTime: anchor.map { $0.timestamp.timeIntervalSince1970 * 1000 }
        )
        if let data = try? JSONEncoder().encode(c) {
            try? data.write(to: TripStore.currentURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }

    private func resumeSaved() {
        guard let data = try? Data(contentsOf: TripStore.currentURL),
              let c = try? JSONDecoder().decode(CurrentTrip.self, from: data) else { return }
        tripId = c.id
        startTime = Date(timeIntervalSince1970: c.start / 1000)
        manual = c.manual
        meters = c.meters
        lastMove = Date(timeIntervalSince1970: c.lastMove / 1000)
        path = c.path
        stillSince = nil
        sinceSave = 0
        lastShownMiles = -1
        anchor = nil
        if let lat = c.aLat, let lng = c.aLng {
            anchor = CLLocation(coordinate: CLLocationCoordinate2D(latitude: lat, longitude: lng), altitude: 0,
                                horizontalAccuracy: 20, verticalAccuracy: -1,
                                timestamp: Date(timeIntervalSince1970: (c.aTime ?? c.lastMove) / 1000))
        }
        mode = .tracking
        let age = Date().timeIntervalSince1970 - c.savedAt / 1000
        if age <= Tracker.resumeWindow {
            startGPS(distanceFilter: 5)
            startMotion()
            startTimer()
            postState()
        } else {
            // Too old to continue: save what we have as its own trip.
            finish(manualStop: false, endAt: lastMove)
        }
    }

    // MARK: - Notifications

    func refreshCategories() {
        let gigs = Array(Prefs.gigs.prefix(3))
        var actions: [UNNotificationAction] = []
        if gigs.count <= 1 {
            actions.append(UNNotificationAction(identifier: "work.0", title: gigs.first ?? "Work", options: []))
        } else {
            for (i, g) in gigs.enumerated() {
                actions.append(UNNotificationAction(identifier: "work.\(i)", title: g, options: []))
            }
        }
        actions.append(UNNotificationAction(identifier: "personal", title: "Personal", options: []))
        let ask = UNNotificationCategory(identifier: "odo.ask", actions: actions, intentIdentifiers: [], options: [])
        let dash = UNNotificationCategory(
            identifier: "odo.dash",
            actions: [UNNotificationAction(identifier: "personal", title: "That was personal", options: [])],
            intentIdentifiers: [], options: [])
        UNUserNotificationCenter.current().setNotificationCategories([ask, dash])
    }

    private func notify(_ t: Trip) {
        let f = DateFormatter()
        f.dateStyle = .none
        f.timeStyle = .short
        let times = "\(f.string(from: Date(timeIntervalSince1970: t.start / 1000))) – \(f.string(from: Date(timeIntervalSince1970: t.end / 1000)))"
        let c = UNMutableNotificationContent()
        if t.type == "work" {
            c.title = String(format: "%.1f mi logged as %@", t.miles, t.purpose)
            c.body = times
            c.categoryIdentifier = "odo.dash"
        } else {
            c.title = Prefs.prompt
            c.body = String(format: "%.1f mi · %@", t.miles, times)
            c.categoryIdentifier = "odo.ask"
        }
        c.sound = .default
        let gigs = Prefs.gigs.isEmpty ? ["Work"] : Array(Prefs.gigs.prefix(3))
        c.userInfo = ["tripId": t.id, "gigs": gigs]
        let req = UNNotificationRequest(identifier: "trip.\(t.id)", content: c, trigger: nil)
        UNUserNotificationCenter.current().add(req, withCompletionHandler: nil)
    }

    func clearNotification(_ tripId: String) {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["trip.\(tripId)"])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        if let id = info["tripId"] as? String {
            let gigs = (info["gigs"] as? [String]) ?? [Prefs.workLabel]
            let action = response.actionIdentifier
            if action == "personal" {
                TripStore.update(id, type: "personal", purpose: "")
            } else if action.hasPrefix("work.") {
                let i = Int(action.dropFirst(5)) ?? 0
                TripStore.update(id, type: "work", purpose: i < gigs.count ? gigs[i] : Prefs.workLabel)
            }
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .odoTripsChanged, object: nil)
            }
        }
        completionHandler()
    }

    private func postState() {
        NotificationCenter.default.post(name: .odoStateChanged, object: nil)
    }
}
