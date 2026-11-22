import StoreKit
import StoreKitTest
import XCTest
@testable import Split

/// Runs the real StoreKit 2 client against `Split.storekit` with StoreKit
/// Testing, so loading, buying, finishing and storefront checks go through
/// StoreKit itself rather than a fake.
final class StoreKitTipClientTests: XCTestCase {
    private var session: SKTestSession!

    override func setUpWithError() throws {
        executionTimeAllowance = 60
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "Split", withExtension: "storekit"))
        session = try SKTestSession(contentsOf: url)
        session.resetToDefaultState()
        session.disableDialogs = true
        session.clearTransactions()
        session.storefront = "USA"
    }

    override func tearDown() {
        session?.clearTransactions()
        session = nil
    }

    func testLoadsEveryTipByExactID() async throws {
        let products = TipJarStore.ordered(try await bounded { try await StoreKitTipClient().products(for: TipTier.productIDs) })

        XCTAssertEqual(products.map(\.tier), TipTier.allCases)
        XCTAssertEqual(products.map(\.displayPrice), ["$0.99", "$2.99", "$4.99", "$9.99", "$19.99", "$49.99", "$99.99"])
    }

    func testPurchaseSucceedsAndFinishesTheTransaction() async throws {
        let client = StoreKitTipClient()
        _ = try await bounded { try await client.products(for: TipTier.productIDs) }

        let result = try await bounded { try await client.purchase(productID: TipTier.xl.productID) }

        XCTAssertEqual(result, .success(productID: TipTier.xl.productID))
        let unfinished = try await bounded {
            var ids: [String] = []
            for await verification in Transaction.unfinished {
                ids.append(verification.unsafePayloadValue.productID)
            }
            return ids
        }
        XCTAssertEqual(unfinished, [], "Every tip transaction must be finished")
    }

    func testAskToBuyIsPending() async throws {
        session.askToBuyEnabled = true

        let result = try await bounded { try await StoreKitTipClient().purchase(productID: TipTier.small.productID) }

        XCTAssertEqual(result, .pending)
    }

    func testPurchaseErrorIsSurfaced() async throws {
        try await session.setSimulatedError(.generic(.networkError(URLError(.notConnectedToInternet))), forAPI: .purchase)

        do {
            _ = try await bounded { try await StoreKitTipClient().purchase(productID: TipTier.max.productID) }
            XCTFail("Expected the purchase to fail")
        } catch is StoreKitTimeout {
            XCTFail("StoreKit Testing didn't answer within 30 s")
        } catch {
            XCTAssertEqual(error as? TipJarError, .network)
        }
    }

    func testStorefrontGatesTheWebTipLink() async throws {
        let client = StoreKitTipClient()
        let store = await TipJarStore(client: client)

        for (code, shows) in [("USA", true), ("GBR", false), ("BRA", false)] {
            session.storefront = code
            // StoreKit applies a storefront change asynchronously.
            var reported = try await bounded { await client.storefrontCountryCode() }
            for _ in 0..<50 where reported != code {
                try await Task.sleep(nanoseconds: 100_000_000)
                reported = try await bounded { await client.storefrontCountryCode() }
            }
            XCTAssertEqual(reported, code)
            await store.refreshStorefront()
            let visible = await store.showsWebTipLink
            XCTAssertEqual(visible, shows, code)
        }
    }

    /// StoreKit Testing can stall on a cold CI simulator; fail the test with
    /// a clear message instead of hanging the whole suite. Unstructured
    /// tasks, so a call that ignores cancellation can't hold the test.
    private func bounded<T: Sendable>(
        seconds: Double = 30,
        _ operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        let once = ResumeOnce<T>()
        return try await withCheckedThrowingContinuation { continuation in
            once.set(continuation)
            Task {
                do { once.resume(.success(try await operation())) } catch { once.resume(.failure(error)) }
            }
            Task {
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                once.resume(.failure(StoreKitTimeout()))
            }
        }
    }
}

private final class ResumeOnce<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Error>?

    func set(_ continuation: CheckedContinuation<T, Error>) {
        lock.lock(); defer { lock.unlock() }
        self.continuation = continuation
    }

    func resume(_ result: Result<T, Error>) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(with: result)
    }
}

private struct StoreKitTimeout: Error, CustomStringConvertible {
    var description: String { "StoreKit Testing didn't answer within the time limit" }
}
