import XCTest
@testable import Split

/// The same cases as `worker/test/web-analytics.test.ts`, so iOS and the web
/// Analytics page agree to the cent.
final class SpendAnalyticsTests: XCTestCase {
    private func expense(_ id: String, _ day: String, _ amount: Int64, _ splits: [(String, Int64)],
                         category: String? = nil, currency: String = "USD", kind: String = "expense", groupID: String = "g") -> LedgerEntry {
        LedgerEntry(
            id: id, groupID: groupID, title: id, amount: amount, currency: currency, paidBy: splits[0].0,
            splits: splits.map { Portion(memberID: $0.0, amount: $0.1) }, category: category, kind: kind,
            splitMode: .exact, createdAt: day + "T12:00:00Z"
        )
    }

    /// A fixed 1 EUR = 1.10 USD conversion, allocated in whole cents like the web test's projection.
    private func project(_ entry: LedgerEntry) -> LedgerEntry? {
        if entry.currency == "USD" { return entry }
        guard entry.currency == "EUR" else { return nil }
        let amount = (entry.amount * 11 + 5) / 10
        var shares = entry.splits.map { $0.amount * amount / entry.amount }
        shares[0] += amount - shares.reduce(0, +)
        var copy = entry
        copy.amount = amount
        copy.currency = "USD"
        copy.splits = zip(entry.splits, shares).map { Portion(memberID: $0.memberID, amount: $1) }
        return copy
    }

    private var entries: [LedgerEntry] {
        [
            expense("dinner", "2026-03-02", 9001, [("a", 3001), ("b", 3000), ("c", 3000)], category: "Dining"),
            expense("rent", "2026-03-01", 300000, [("b", 150000), ("c", 150000)], category: "Rent & Utilities"),
            expense("hotel", "2026-04-15", 20000, [("a", 10000), ("c", 10000)], category: "Lodging", currency: "EUR"),
            expense("taxi", "2026-04-16", 5000, [("a", 2500), ("b", 2500)], category: "Transport", currency: "ARS"),
            expense("payback", "2026-04-20", 4000, [("b", 4000)], kind: "settlement"),
        ]
    }

    func testPercentagesAreWholeAndAddUpToExactly100() {
        XCTAssertEqual(SpendAnalytics.percents([1, 1, 1]), [34, 33, 33])
        XCTAssertEqual(SpendAnalytics.percents([9001, 300000, 22000]).reduce(0, +), 100)
        XCTAssertEqual(SpendAnalytics.percents([0, 0]), [0, 0])
    }

    func testBucketsDaysMondayWeeksAndMonthsAndFillsGaps() {
        XCTAssertEqual(SpendAnalytics.bucketKey("2026-04-16", .week), "2026-04-13")
        XCTAssertEqual(SpendAnalytics.bucketKey("2026-04-13", .week), "2026-04-13")
        XCTAssertEqual(SpendAnalytics.bucketKey("2026-04-19", .week), "2026-04-13")
        XCTAssertEqual(SpendAnalytics.bucketKey("2026-04-16", .month), "2026-04")
        XCTAssertEqual(SpendAnalytics.bucketRange(from: "2025-11-20", to: "2026-02-03", .month), ["2025-11", "2025-12", "2026-01", "2026-02"])
        XCTAssertEqual(SpendAnalytics.bucketRange(from: "2026-04-01", to: "2026-04-03", .day), ["2026-04-01", "2026-04-02", "2026-04-03"])
        XCTAssertEqual(SpendAnalytics.bucketRange(from: "2026-04-16", to: "2026-04-28", .week), ["2026-04-13", "2026-04-20", "2026-04-27"])
        XCTAssertEqual(SpendAnalytics.autoGranularity(from: "2026-04-01", to: "2026-04-30"), .day)
        XCTAssertEqual(SpendAnalytics.autoGranularity(from: "2026-01-01", to: "2026-04-30"), .week)
        XCTAssertEqual(SpendAnalytics.autoGranularity(from: "2025-01-01", to: "2026-04-30"), .month)
    }

    func testTotalsHomeSpendInCentsAndLeavesUnpricedExpensesOutOfHomeCharts() {
        let result = SpendAnalytics.analyze(entries, project: project, home: "USD", filter: .init(), people: ["a", "b", "c"])
        XCTAssertEqual(result.rows.count, 4)
        XCTAssertEqual(result.excluded, 1)
        XCTAssertEqual(result.total, 9001 + 300000 + 22000)
        XCTAssertEqual(result.buckets.reduce(0) { $0 + $1.amount }, result.total)
        XCTAssertEqual(result.categories.map(\.id), ["Rent & Utilities", "Lodging", "Dining"])
        XCTAssertEqual(result.categories.reduce(0) { $0 + $1.percent }, 100)
        let people = Dictionary(uniqueKeysWithValues: result.people.map { ($0.key, $0) })
        XCTAssertEqual(people["a"]?.paid, 9001 + 22000)
        XCTAssertEqual(people["a"]?.share, 3001 + 11000)
        XCTAssertEqual(people["b"]?.paid, 300000)
        XCTAssertEqual(people["b"]?.share, 3000 + 150000)
        XCTAssertEqual(result.people.reduce(0) { $0 + $1.net }, 0)
        let currencies = Dictionary(uniqueKeysWithValues: result.currencies.map { ($0.currency, $0) })
        XCTAssertEqual(currencies["EUR"]?.original, 20000)
        XCTAssertEqual(currencies["EUR"]?.home, 22000)
        XCTAssertEqual(currencies["EUR"]?.count, 1)
        XCTAssertEqual(currencies["ARS"]?.original, 5000)
        XCTAssertNil(currencies["ARS"]?.home ?? nil)
        XCTAssertEqual(result.currencies.last?.currency, "ARS")
        XCTAssertEqual(result.average, (9001 + 300000 + 22000 + 1) / 3)
        XCTAssertTrue(result.estimated)
    }

    func testFiltersByDateRangeAndMeasuresAMemberByTheirShare() {
        let april = SpendAnalytics.analyze(entries, project: project, home: "USD", filter: .init(from: "2026-04-01", to: "2026-04-30"), people: ["a", "b", "c"])
        XCTAssertEqual(april.rows.map(\.entry.id), ["hotel", "taxi"])
        XCTAssertEqual(april.granularity, .day)
        XCTAssertEqual(april.buckets.count, 30)

        let b = SpendAnalytics.analyze(entries, project: project, home: "USD", filter: .init(person: "b"), people: ["a", "b", "c"])
        XCTAssertEqual(b.rows.map(\.entry.id).sorted(), ["dinner", "rent", "taxi"])
        XCTAssertEqual(b.total, 3000 + 150000)
    }

    func testDrillsFromAChartSegmentToExactlyTheMatchingExpenses() {
        let result = SpendAnalytics.analyze(entries, project: project, home: "USD", filter: .init(), people: ["a", "b", "c"], granularity: .month)
        XCTAssertEqual(SpendAnalytics.drillRows(result, .bucket("2026-03")).map(\.entry.id).sorted(), ["dinner", "rent"])
        XCTAssertEqual(SpendAnalytics.drillRows(result, .category("Lodging")).map(\.entry.id), ["hotel"])
        XCTAssertEqual(SpendAnalytics.drillRows(result, .currency("ARS")).map(\.entry.id), ["taxi"])
        XCTAssertEqual(SpendAnalytics.drillRows(result, .person("a")).map(\.entry.id).sorted(), ["dinner", "hotel"])
        XCTAssertEqual(SpendAnalytics.drillRows(result, nil).count, 4)
    }

    func testCategoriesNormalizeLikeTheWeb() {
        XCTAssertEqual(SpendAnalytics.categoryID(nil), "Other")
        XCTAssertEqual(SpendAnalytics.categoryID(""), "Other")
        XCTAssertEqual(SpendAnalytics.categoryID("dining"), "Dining")
        XCTAssertEqual(SpendAnalytics.categoryID("Drinks & Coffee"), "Drinks")
        XCTAssertEqual(SpendAnalytics.categoryID("Street food"), "Dining")
        XCTAssertEqual(SpendAnalytics.categoryID("Utilities"), "Rent & Utilities")
        XCTAssertEqual(SpendAnalytics.categoryID("Uber"), "Transport")
        XCTAssertEqual(SpendAnalytics.categoryID("General"), "General")
    }

    func testRoundsLikeMathRound() {
        XCTAssertEqual(SpendAnalytics.roundedDivision(5, 2), 3)
        XCTAssertEqual(SpendAnalytics.roundedDivision(7, 3), 2)
        XCTAssertEqual(SpendAnalytics.roundedDivision(-5, 2), -2)
        XCTAssertEqual(SpendAnalytics.roundedDivision(-8, 3), -3)
        XCTAssertEqual(SpendAnalytics.roundedDivision(10, 0), 0)
    }

    func testRangesMatchTheWebBounds() {
        let now = SpendAnalytics.date("2026-11-27")!.addingTimeInterval(3600)
        XCTAssertEqual(SpendAnalytics.bounds(.days30, group: nil, custom: ("", ""), now: now).from, "2026-10-29")
        XCTAssertEqual(SpendAnalytics.bounds(.days30, group: nil, custom: ("", ""), now: now).to, "2026-11-27")
        XCTAssertEqual(SpendAnalytics.bounds(.months12, group: nil, custom: ("", ""), now: now).from, "2025-11-28")
        let swapped = SpendAnalytics.bounds(.custom, group: nil, custom: ("2026-05-01", "2026-04-01"), now: now)
        XCTAssertEqual(swapped.from, "2026-04-01")
        XCTAssertEqual(swapped.to, "2026-05-01")
    }

    /// Across groups, one person's seats merge into one row and one filter.
    func testMergesOnePersonAcrossGroups() {
        let trip = ExpenseGroup(id: "t", name: "Trip", kind: "trip", currency: "USD", members: [
            Person(id: "t-me", groupID: "t", userID: "u1", name: "Harris"),
            Person(id: "t-sam", groupID: "t", userID: "u2", name: "Sam"),
        ])
        let home = ExpenseGroup(id: "h", name: "Home", kind: "home", currency: "USD", members: [
            Person(id: "h-me", groupID: "h", userID: "u1", name: "Harris"),
            Person(id: "h-sam", groupID: "h", userID: "u2", name: "Sam"),
        ])
        let ledger = [
            expense("a", "2026-01-02", 1000, [("t-me", 500), ("t-sam", 500)], groupID: "t"),
            expense("b", "2026-01-03", 3001, [("h-sam", 1500), ("h-me", 1501)], groupID: "h"),
        ]
        let scope = AnalyticsScope(group: nil, allGroups: [trip, home], allEntries: ledger, currentUserID: "u1")
        XCTAssertEqual(scope.members.map(\.name), ["You", "Sam"])
        let report = SpendAnalytics.analyze(scope.entries, project: { $0 }, home: "USD", filter: .init(),
                                            people: scope.allKeys, key: scope.personKey)
        let sam = report.people.first { scope.name($0.key) == "Sam" }
        XCTAssertEqual(sam?.paid, 3001)
        XCTAssertEqual(sam?.share, 2000)
        let mine = SpendAnalytics.analyze(scope.entries, project: { $0 }, home: "USD", filter: .init(person: "u:u1"),
                                          people: scope.allKeys, key: scope.personKey)
        XCTAssertEqual(mine.total, 500 + 1501)
    }
}

final class LedgerPositionTests: XCTestCase {
    func testMatchesTheWebLedgerPosition() {
        var entry = LedgerEntry(groupID: "g", title: "Dinner", amount: 9000, currency: "USD", paidBy: "a",
                                splits: [Portion(memberID: "a", amount: 3000), Portion(memberID: "b", amount: 6000)])
        XCTAssertEqual(LedgerPosition(entry, memberID: "a").net, 6000)
        XCTAssertEqual(LedgerPosition(entry, memberID: "b").net, -6000)
        XCTAssertFalse(LedgerPosition(entry, memberID: "c").involved)
        XCTAssertFalse(LedgerPosition(entry, memberID: nil).involved)
        entry.handled = true
        XCTAssertTrue(LedgerPosition(entry, memberID: "b").involved)
        XCTAssertEqual(LedgerPosition(entry, memberID: "b").net, 0)
        entry.handled = nil
        entry.kind = "settlement"
        XCTAssertEqual(LedgerPosition(entry, memberID: "b").net, 0)
    }
}
