import Foundation
import AppIntents

/// "Start Dash" and "End Dash" actions for the Shortcuts app and Siri.
/// Set up a Shortcuts automation, "When Dasher is opened → Start Dash", and every drive during your
/// shift is logged as work. These run in the background without opening Odo.

@available(iOS 16.0, *)
struct StartDashIntent: AppIntent {
    static let title: LocalizedStringResource = "Start Dash"
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
    static let title: LocalizedStringResource = "End Dash"
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
            "Start dash in \(.applicationName)",
            "Start dashing with \(.applicationName)",
        ])
        AppShortcut(intent: EndDashIntent(), phrases: [
            "End dash in \(.applicationName)",
            "Stop dashing with \(.applicationName)",
        ])
    }
}
