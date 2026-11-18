import XCTest
@testable import Split

final class FXTests: XCTestCase {
    func testConversionRoundsHalfAwayFromZeroInIntegerMinorUnits() {
        // 12.00 USD at 1,200 ARS → 14,400.00 ARS exactly.
        XCTAssertEqual(FXMath.convert(1200, rateE8: 120_000_000_000), 1_440_000)
        // 1.01 USD at 1039.5 → 1049.895 → 1049.90 (half up), matching the Worker.
        XCTAssertEqual(FXMath.convert(101, rateE8: 103_950_000_000), 104_990)
        XCTAssertEqual(FXMath.convert(1, rateE8: 50_000_000), 1)       // 0.005 → 0.01
        XCTAssertEqual(FXMath.convert(1, rateE8: 49_999_999), 0)
        XCTAssertEqual(FXMath.convert(-1, rateE8: 50_000_000), -1)     // symmetric for debts
        XCTAssertEqual(FXMath.convert(-250, rateE8: 90_344_000), -226)
        // The largest amount at the largest rate doesn't overflow Int64 midway.
        XCTAssertEqual(FXMath.convert(Money.maxAmount, rateE8: 1_000_000_000_000_000), 1_000_000_000_000_000_000)
        XCTAssertNil(FXMath.convert(Int64.max / 2, rateE8: 1_000_000_000))
        XCTAssertEqual(FXMath.convert(Money.maxAmount, rateE8: 155_200_000_000), 155_200_000_000_000)
        XCTAssertNil(FXMath.convert(100, rateE8: 0))
    }

    func testRatesParseWithoutFloatingPoint() {
        XCTAssertEqual(FXMath.rateE8(Decimal(string: "1552.0")!), 155_200_000_000)
        XCTAssertEqual(FXMath.rateE8(Decimal(string: "0.00064433")!), 64_433)
        XCTAssertEqual(FXMath.rateE8(Decimal(string: "0.000000004")!), nil)
        XCTAssertEqual(FXMath.inverse(155_200_000_000), 64_433)
        XCTAssertEqual(FXMath.rateText(120_000_000_000), "1,200")
        XCTAssertEqual(FXMath.rateText(90_344_000), "0.90344")
        XCTAssertEqual(FXMath.rateText(103_950_000_000), "1,039.5")
        XCTAssertEqual(Exchange.units("1200,5"), 120_050_000_000)
    }

    func testWeekendRequestAcceptsThePreviousBusinessDay() throws {
        // Asking BCRA for Sunday 15 Nov returns Friday 13 Nov.
        let body = Data(#"{"date":"2026-11-13","base":"USD","quote":"ARS","rate":1543.5}"#.utf8)
        let quote = try XCTUnwrap(FXQuote.decode(body, base: "USD", quote: "ARS", requested: "2026-11-15", source: "BCRA"))
        XCTAssertEqual(quote.date, "2026-11-13")
        XCTAssertEqual(quote.rateE8, 154_350_000_000)
        XCTAssertEqual(quote.exchange, Exchange(target: "ARS", rateE8: 154_350_000_000, date: "2026-11-13", source: "BCRA"))
        // A rate dated after the expense is never accepted, nor a mismatched pair.
        XCTAssertNil(FXQuote.decode(body, base: "USD", quote: "ARS", requested: "2026-11-12", source: "BCRA"))
        XCTAssertNil(FXQuote.decode(body, base: "EUR", quote: "ARS", requested: nil, source: "BCRA"))
        XCTAssertNil(FXQuote.decode(Data(#"{"status":404,"message":"not found"}"#.utf8), base: "USD", quote: "ARS", requested: nil, source: "BCRA"))
        let url = FXQuote.url(base: "USD", quote: "ARS", date: "2026-11-15").absoluteString
        XCTAssertEqual(url, "https://api.frankfurter.dev/v2/rate/USD/ARS?date=2026-11-15&providers=bcra")
        XCTAssertEqual(FXQuote.url(base: "USD", quote: "EUR", date: nil).absoluteString, "https://api.frankfurter.dev/v2/rate/USD/EUR?providers=ecb")
    }

    func testCacheTotalsManualOverridesAndInverseRates() {
        var cache = FXCache()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        cache.quotes["USD>ARS"] = FXQuote(base: "USD", quote: "ARS", rateE8: 120_000_000_000, date: "2026-11-18", source: "BCRA", fetchedAt: now)
        cache.quotes["EUR>USD"] = FXQuote(base: "EUR", quote: "USD", rateE8: 110_000_000, date: "2026-11-18", source: "Frankfurter", fetchedAt: now)
        XCTAssertFalse(cache.needsRefresh("USD", "ARS", now: now.addingTimeInterval(3600)))
        XCTAssertTrue(cache.needsRefresh("USD", "ARS", now: now.addingTimeInterval(7 * 3600)))
        XCTAssertTrue(cache.needsRefresh("GBP", "ARS", now: now))
        // ARS 14,400 owed to me and USD 10 I owe, shown in USD.
        let total = cache.total(["ARS": 1_440_000, "USD": -1000], in: "USD")
        XCTAssertEqual(total.amount, 200)
        XCTAssertEqual(total.missing, [])
        XCTAssertEqual(cache.total(["EUR": 1000], in: "USD").amount, 1100)
        XCTAssertEqual(cache.total(["GBP": 1000], in: "USD").missing, ["GBP"])
        // A blue-dollar rate set by hand wins over BCRA, in both directions.
        cache.manual["USD>ARS"] = 145_000_000_000
        XCTAssertEqual(cache.rate("USD", "ARS")?.source, "Manual")
        XCTAssertEqual(cache.total(["ARS": 1_450_000], in: "USD").amount, 1000)
    }

    @MainActor
    func testStoreCachesRatesAndFallsBackWhenOffline() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".json")
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        var calls = 0, online = true
        var clock = Date(timeIntervalSince1970: 1_795_000_000) // 2026-11-18
        let fetch: (URL) async throws -> (Data, URLResponse) = { url in
            calls += 1
            guard online else { throw URLError(.notConnectedToInternet) }
            let body = Data(#"{"date":"2026-11-17","base":"USD","quote":"ARS","rate":1552.0}"#.utf8)
            return (body, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        let store = FXStore(defaults: defaults, fileURL: file, fetcher: { try await fetch($0) }, clock: { clock })
        await store.refresh(currencies: ["USD"], into: "ARS")
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(store.rate("USD", "ARS")?.rateE8, 155_200_000_000)
        await store.refresh(currencies: ["USD"], into: "ARS")
        XCTAssertEqual(calls, 1, "fresh rates are reused")
        // Offline later: a new store reads the saved rate from disk and keeps converting.
        online = false
        clock = clock.addingTimeInterval(24 * 3600)
        let restored = FXStore(defaults: defaults, fileURL: file, fetcher: { try await fetch($0) }, clock: { clock })
        await restored.refresh(currencies: ["USD"], into: "ARS")
        XCTAssertTrue(restored.offline)
        XCTAssertEqual(restored.total(["USD": 1000], in: "ARS").amount, 1_552_000)
        let quote = try await restored.quote(base: "USD", target: "ARS", date: "2026-11-19")
        XCTAssertEqual(quote.date, "2026-11-17")
        do {
            _ = try await restored.quote(base: "USD", target: "ARS", date: "2026-11-01")
            XCTFail("an older expense can't use a newer saved rate")
        } catch {}
        try? FileManager.default.removeItem(at: file)
    }
}
