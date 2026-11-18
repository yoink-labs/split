import XCTest
@testable import Split

final class AnalyticsTests: XCTestCase {
    func testAdjustmentSplitKeepsTotal() throws {
        let portions = try Ledger.split(total: 10000, people: ["a", "b", "c"], mode: .adjustment, values: ["a": "5.00", "b": "-2.50", "c": "-2.50"])
        XCTAssertEqual(portions.map(\.amount).reduce(0, +), 10000)
        XCTAssertEqual(portions.map(\.amount), [3834, 3083, 3083])
        XCTAssertEqual(try Ledger.split(total: 100, people: ["a", "b"], mode: .adjustment, values: [:]).map(\.amount), [50, 50])
        XCTAssertThrowsError(try Ledger.split(total: 100, people: ["a", "b"], mode: .adjustment, values: ["a": "5.00", "b": "0"]))
        XCTAssertThrowsError(try Ledger.split(total: 100, people: ["a", "b"], mode: .adjustment, values: ["a": "200", "b": "-200"]))
    }

    func testMultiplePayersCreditEachPerson() {
        let entry = LedgerEntry(
            groupID: "g",
            title: "Airbnb",
            amount: 30000,
            currency: "USD",
            paidBy: "a",
            splits: [Portion(memberID: "a", amount: 10000), Portion(memberID: "b", amount: 10000), Portion(memberID: "c", amount: 10000)],
            payers: [Payer(memberID: "a", amount: 20000), Payer(memberID: "c", amount: 10000)]
        )
        let balances = Ledger.balances([entry], currency: "USD")
        XCTAssertEqual(balances["a"], 10000)
        XCTAssertEqual(balances["b"], -10000)
        XCTAssertEqual(balances["c"], 0)
        XCTAssertEqual(Ledger.paid(entry, by: "c"), 10000)
        XCTAssertEqual(Ledger.share(entry, of: "a"), 10000)
    }

    func testDashboardAggregatesPeopleAndTotals() {
        let snapshot = Fixtures.snapshot()
        let userId = "demo-user"
        let people = Analytics.personBalances(groups: snapshot.groups, entries: snapshot.entries, userID: userId)
        XCTAssertFalse(people.isEmpty)
        let totals = Analytics.totals(people)
        XCTAssertEqual(totals.net.map(\.amount).reduce(0, +), people.flatMap { $0.amounts.values }.reduce(0, +))
        XCTAssertTrue(totals.owed.allSatisfy { $0.amount > 0 })
        XCTAssertTrue(totals.owe.allSatisfy { $0.amount > 0 })
        let all = Analytics.allPeople(groups: snapshot.groups, entries: snapshot.entries, userID: userId)
        XCTAssertGreaterThanOrEqual(all.count, people.count)
    }

    func testGroupSummariesAndSearch() {
        let snapshot = Fixtures.snapshot()
        let summaries = Analytics.groupSummaries(groups: snapshot.groups, entries: snapshot.entries, userID: "demo-user")
        XCTAssertEqual(summaries.count, 5)
        let people = Analytics.allPeople(groups: snapshot.groups, entries: snapshot.entries, userID: "demo-user")
        let results = Search.run("harris", groups: snapshot.groups, entries: snapshot.entries, people: people)
        XCTAssertTrue(results.groups.contains { $0.name == "Spain" })
        XCTAssertTrue(results.people.contains { $0.name == "Harris" })
        XCTAssertFalse(results.entries.isEmpty)
        let none = Search.run("zzzz-no-match", groups: snapshot.groups, entries: snapshot.entries, people: people)
        XCTAssertTrue(none.isEmpty)
    }

    func testSignedMoneyInput() {
        XCTAssertEqual(Money.parseSigned("-12.34"), -1234)
        XCTAssertEqual(Money.parseSigned("7"), 700)
        XCTAssertNil(Money.parseSigned("1,000"))
        XCTAssertNil(Money.parseSigned("abc"))
        XCTAssertEqual(Money.text(1234, "USD", signed: true), "+USD 12.34")
        XCTAssertEqual(Money.text(-1234, "USD", signed: true), "−USD 12.34")
    }

    func testMonthlyAndCategoryInsights() {
        let snapshot = Fixtures.snapshot()
        let monthly = Analytics.monthly(snapshot.entries, currency: "ARS")
        XCTAssertFalse(monthly.isEmpty)
        XCTAssertEqual(monthly.map(\.amount).reduce(0, +), Analytics.monthlyTotal(snapshot.entries, currency: "ARS"))
        let categories = Analytics.categories(snapshot.entries, currency: "ARS")
        XCTAssertTrue(categories.contains { $0.category == "Dining" })
        XCTAssertEqual(categories.map(\.amount).reduce(0, +), Analytics.monthlyTotal(snapshot.entries, currency: "ARS"))
    }

    func testCommentsAndPayerDecoding() throws {
        let json = """
        {"id":"entry-12345678","groupID":"group-12345678","title":"Dinner","amount":100,"currency":"USD","paidBy":"a","splits":[{"memberID":"a","amount":50},{"memberID":"b","amount":50}],"kind":"expense","splitMode":"equal","createdAt":"2026-11-17T12:00:00Z","payers":[{"memberID":"a","amount":100}],"notes":"tip included","commentCount":2,"likeCount":1,"likedByMe":true}
        """
        let entry = try JSONDecoder().decode(LedgerEntry.self, from: Data(json.utf8))
        XCTAssertEqual(entry.notes, "tip included")
        XCTAssertEqual(entry.allPayers.first?.amount, 100)
        XCTAssertEqual(entry.commentCount, 2)
        XCTAssertTrue(entry.likedByMe == true)
    }
}
