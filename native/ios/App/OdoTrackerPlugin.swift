import Foundation
import UIKit
import Capacitor

/// Bridge between the app screens (JavaScript) and the native tracker.
/// Same method names as the Android plugin, so one set of screens works on both phones.
@objc(OdoTrackerPlugin)
public class OdoTrackerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OdoTrackerPlugin"
    public let jsName = "OdoTracker"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPerm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAppSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openBatterySettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setAuto", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setDash", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startManual", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopTrip", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getTrips", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateTrip", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteTrip", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPrefs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPrefs", returnType: CAPPluginReturnPromise),
    ]

    private var observers: [NSObjectProtocol] = []

    override public func load() {
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: .odoTripsChanged, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("tripsChanged", data: [:])
        })
        observers.append(nc.addObserver(forName: .odoStateChanged, object: nil, queue: .main) { [weak self] _ in
            guard let self = self else { return }
            self.notifyListeners("trackingChanged", data: self.status())
        })
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    /// Must be called on the main thread.
    private func status() -> [String: Any] {
        let t = Tracker.shared
        return [
            "platform": "ios",
            "location": t.hasLocation,
            "background": t.hasAlways,
            "precise": t.precise,
            "activity": t.motionAllowed,
            "notifications": t.notificationsAllowed,
            "batteryUnrestricted": true,
            "auto": Prefs.auto,
            "tracking": t.mode == .tracking,
            "manual": t.mode == .tracking && t.manual,
            "miles": t.miles,
            "tripStart": t.tripStartMs,
            "dashSupported": true,
            "dashing": Prefs.isDashing,
            "dashSince": (Prefs.dashSince?.timeIntervalSince1970 ?? 0) * 1000,
        ]
    }

    private func resolveStatus(_ call: CAPPluginCall) {
        Tracker.shared.refreshNotificationStatus { [weak self] in
            guard let self = self else { return }
            call.resolve(self.status())
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.resolveStatus(call) }
    }

    @objc func requestPerm(_ call: CAPPluginCall) {
        let alias = call.getString("alias") ?? ""
        DispatchQueue.main.async {
            let t = Tracker.shared
            let done: () -> Void = {
                t.arm()
                self.resolveStatus(call)
            }
            switch alias {
            case "location": t.requestLocation(always: false, done: done)
            case "background": t.requestLocation(always: true, done: done)
            case "activity": t.requestMotion(done: done)
            case "notifications": t.requestNotifications(done: done)
            default: done()
            }
        }
    }

    @objc func openAppSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
            call.resolve()
        }
    }

    /// Android only. iPhone has no per-app battery restriction to turn off.
    @objc func openBatterySettings(_ call: CAPPluginCall) {
        call.resolve()
    }

    @objc func setAuto(_ call: CAPPluginCall) {
        let on = call.getBool("enabled", false)
        DispatchQueue.main.async {
            Prefs.auto = on
            Tracker.shared.arm()
            self.resolveStatus(call)
        }
    }

    @objc func setDash(_ call: CAPPluginCall) {
        let on = call.getBool("enabled", false)
        DispatchQueue.main.async {
            if on { Tracker.shared.startDash() } else { Tracker.shared.endDash() }
            self.resolveStatus(call)
        }
    }

    @objc func startManual(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard Tracker.shared.hasLocation else {
                call.reject("Location permission is needed first", "NO_LOCATION")
                return
            }
            Tracker.shared.startManual()
            self.resolveStatus(call)
        }
    }

    @objc func stopTrip(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            Tracker.shared.stopTrip()
            call.resolve()
        }
    }

    /// Trips come back as a JSON string; the screens parse it.
    @objc func getTrips(_ call: CAPPluginCall) {
        call.resolve(["json": TripStore.json()])
    }

    @objc func updateTrip(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("id is required"); return }
        let type = call.getString("type")
        let purpose = call.getString("purpose")
        let ok = TripStore.update(id, type: type, purpose: purpose)
        if let type = type, type != "pending" {
            DispatchQueue.main.async { Tracker.shared.clearNotification(id) }
        }
        call.resolve(["ok": ok])
    }

    @objc func deleteTrip(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("id is required"); return }
        let ok = TripStore.delete(id)
        DispatchQueue.main.async { Tracker.shared.clearNotification(id) }
        call.resolve(["ok": ok])
    }

    @objc func getPrefs(_ call: CAPPluginCall) {
        call.resolve(["prompt": Prefs.prompt, "gigs": Prefs.gigs])
    }

    @objc func setPrefs(_ call: CAPPluginCall) {
        if let prompt = call.getString("prompt")?.trimmingCharacters(in: .whitespaces), !prompt.isEmpty {
            Prefs.prompt = prompt
        }
        if let gigs = call.getArray("gigs", String.self) {
            Prefs.gigs = gigs
        }
        DispatchQueue.main.async {
            Tracker.shared.refreshCategories()
            call.resolve()
        }
    }
}
