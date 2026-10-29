import Foundation

/// One saved drive. Times are milliseconds since 1970, the same shape the app screens and Android use.
struct Trip: Codable {
    var id: String
    var start: Double
    var end: Double
    var miles: Double
    var type: String      // "pending", "work" or "personal"
    var purpose: String
    var manual: Bool
    var dash: Bool?
    var path: [[Double]]  // [lat, lng] points
}

/// A drive in progress, saved often so it survives iPhone closing the app.
struct CurrentTrip: Codable {
    var id: String
    var start: Double
    var manual: Bool
    var meters: Double
    var lastMove: Double
    var savedAt: Double
    var path: [[Double]]
    var aLat: Double?
    var aLng: Double?
    var aTime: Double?
}

/// Trips live in a JSON file on the phone. Nothing leaves the device.
enum TripStore {
    private static let lock = NSLock()

    static var dir: URL {
        let u = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    static var tripsURL: URL { dir.appendingPathComponent("trips.json") }
    static var currentURL: URL { dir.appendingPathComponent("current_trip.json") }

    static func all() -> [Trip] {
        lock.lock(); defer { lock.unlock() }
        return read()
    }

    static func json() -> String {
        lock.lock(); defer { lock.unlock() }
        guard let data = try? Data(contentsOf: tripsURL), !data.isEmpty else { return "[]" }
        return String(data: data, encoding: .utf8) ?? "[]"
    }

    static func add(_ trip: Trip) {
        lock.lock(); defer { lock.unlock() }
        var trips = read()
        trips.append(trip)
        write(trips)
    }

    /// Pass nil for a field to leave it unchanged.
    @discardableResult
    static func update(_ id: String, type: String?, purpose: String?) -> Bool {
        lock.lock(); defer { lock.unlock() }
        var trips = read()
        guard let i = trips.firstIndex(where: { $0.id == id }) else { return false }
        if let type = type { trips[i].type = type }
        if let purpose = purpose { trips[i].purpose = purpose }
        write(trips)
        return true
    }

    @discardableResult
    static func delete(_ id: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        var trips = read()
        let before = trips.count
        trips.removeAll { $0.id == id }
        if trips.count != before { write(trips) }
        return trips.count != before
    }

    private static func read() -> [Trip] {
        guard let data = try? Data(contentsOf: tripsURL), !data.isEmpty else { return [] }
        if let trips = try? JSONDecoder().decode([Trip].self, from: data) { return trips }
        // Never overwrite a file we couldn't read: set it aside first.
        let aside = dir.appendingPathComponent("trips-unreadable-\(Int(Date().timeIntervalSince1970)).json")
        try? FileManager.default.moveItem(at: tripsURL, to: aside)
        return []
    }

    private static func write(_ trips: [Trip]) {
        guard let data = try? JSONEncoder().encode(trips) else { return }
        try? data.write(to: tripsURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
