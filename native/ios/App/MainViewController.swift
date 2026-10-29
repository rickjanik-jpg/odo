import UIKit
import UserNotifications
import Capacitor

/// The app's main screen. Registers Odo's native tracker with Capacitor.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(OdoTrackerPlugin())
        // Make sure the Yes / No buttons on trip notifications come to Odo's tracker.
        UNUserNotificationCenter.current().delegate = Tracker.shared
    }
}
