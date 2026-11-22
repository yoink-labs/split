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
        let products = TipJarStore.ordered(try await StoreKitTipClient().products(for: TipTier.productIDs))

        XCTAssertEqual(products.map(\.tier), TipTier.allCases)
        XCTAssertEqual(products.map(\.displayPrice), ["$0.99", "$2.99", "$4.99", "$9.99", "$19.99", "$49.99", "$99.99"])
    }

    func testPurchaseSucceedsAndFinishesTheTransaction() async throws {
        let client = StoreKitTipClient()
        _ = try await client.products(for: TipTier.productIDs)

        let result = try await client.purchase(productID: TipTier.xl.productID)

        XCTAssertEqual(result, .success(productID: TipTier.xl.productID))
        var unfinished: [String] = []
        for await verification in Transaction.unfinished {
            unfinished.append(verification.unsafePayloadValue.productID)
        }
        XCTAssertEqual(unfinished, [], "Every tip transaction must be finished")
    }

    func testAskToBuyIsPending() async throws {
        session.askToBuyEnabled = true

        let result = try await StoreKitTipClient().purchase(productID: TipTier.small.productID)

        XCTAssertEqual(result, .pending)
    }

    func testPurchaseErrorIsSurfaced() async throws {
        try await session.setSimulatedError(.generic(.networkError(URLError(.notConnectedToInternet))), forAPI: .purchase)

        do {
            _ = try await StoreKitTipClient().purchase(productID: TipTier.max.productID)
            XCTFail("Expected the purchase to fail")
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
            var reported = await client.storefrontCountryCode()
            for _ in 0..<50 where reported != code {
                try await Task.sleep(nanoseconds: 100_000_000)
                reported = await client.storefrontCountryCode()
            }
            XCTAssertEqual(reported, code)
            await store.refreshStorefront()
            let visible = await store.showsWebTipLink
            XCTAssertEqual(visible, shows, code)
        }
    }
}
