import UIKit
import UserNotifications
import Capacitor

/// The app's main screen. Makes sure Odo's native tracker is registered with Capacitor.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        // Capacitor may already have registered it from capacitor.config.json (packageClassList).
        if bridge?.plugin(withName: "OdoTracker") == nil {
            bridge?.registerPluginInstance(OdoTrackerPlugin())
        }
        // Make sure the Yes / No buttons on trip notifications come to Odo's tracker.
        UNUserNotificationCenter.current().delegate = Tracker.shared
    }
}
