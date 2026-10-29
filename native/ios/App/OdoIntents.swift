import Foundation
import AppIntents

/// "Start Shift" and "End Shift" actions for the Shortcuts app and Siri.
/// Set up a Shortcuts automation, "When Dasher is opened → Start Shift", and every drive during your
/// shift is logged as work. (Type names keep "Dash" so existing automations keep working.) These run in the background without opening Odo.

@available(iOS 16.0, *)
struct StartDashIntent: AppIntent {
    static let title: LocalizedStringResource = "Start Shift"
    static let openAppWhenRun: Bool = false

    @MainActor
    func perform() async throws -> some IntentResult {
        Tracker.shared.boot()
        Tracker.shared.startDash()
        return .result()
    }
}

@available(iOS 16.0, *)
struct EndDashIntent: AppIntent {
    static let title: LocalizedStringResource = "End Shift"
    static let openAppWhenRun: Bool = false

    @MainActor
    func perform() async throws -> some IntentResult {
        Tracker.shared.boot()
        Tracker.shared.endDash()
        return .result()
    }
}

@available(iOS 16.0, *)
struct OdoShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: StartDashIntent(), phrases: [
            "Start shift in \(.applicationName)",
            "Start dash in \(.applicationName)",
        ])
        AppShortcut(intent: EndDashIntent(), phrases: [
            "End shift in \(.applicationName)",
            "End dash in \(.applicationName)",
        ])
    }
}
