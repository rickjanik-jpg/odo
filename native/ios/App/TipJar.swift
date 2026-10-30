import Foundation
import StoreKit

/// Optional tips through Apple's in-app purchases. Tips don't unlock anything.
/// The three products are set up as Consumable in App Store Connect with these IDs.
final class TipJar {
    static let shared = TipJar()
    static let productIds = [
        "com.odomiles.app.tip.small",
        "com.odomiles.app.tip.medium",
        "com.odomiles.app.tip.large",
    ]

    enum Outcome: String { case thanked, cancelled, pending }
    enum TipError: Error { case notFound, unverified }

    private var products: [Product] = []
    private var listener: Task<Void, Never>?

    /// Number of tips this person has left (kept on the phone).
    var count: Int {
        get { UserDefaults.standard.integer(forKey: "odo.tips") }
        set { UserDefaults.standard.set(newValue, forKey: "odo.tips") }
    }

    /// Called at launch. Finishes tips that completed while Odo was closed (for example, approved later
    /// by a parent with Ask to Buy), so Apple doesn't keep re-sending them.
    func start() {
        guard listener == nil else { return }
        listener = Task.detached {
            for await result in Transaction.updates {
                if case .verified(let t) = result {
                    await t.finish()
                    TipJar.shared.count += 1
                }
            }
        }
        Task.detached {
            for await result in Transaction.unfinished {
                if case .verified(let t) = result { await t.finish() }
            }
        }
    }

    func load() async throws -> [Product] {
        if products.isEmpty {
            let found = try await Product.products(for: TipJar.productIds)
            products = found.sorted { $0.price < $1.price }
        }
        return products
    }

    func buy(_ id: String) async throws -> Outcome {
        guard let product = try await load().first(where: { $0.id == id }) else { throw TipError.notFound }
        let result = try await product.purchase()
        switch result {
        case .success(let verification):
            switch verification {
            case .verified(let t):
                await t.finish()
                count += 1
                return .thanked
            case .unverified(let t, _):
                await t.finish()
                throw TipError.unverified
            }
        case .userCancelled:
            return .cancelled
        case .pending:
            return .pending
        @unknown default:
            return .cancelled
        }
    }
}
