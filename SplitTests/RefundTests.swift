import XCTest
@testable import Split

final class RefundTests: XCTestCase {
    private func expense(_ amount: Int64 = 10_000, pending: Bool = false) -> LedgerEntry {
        var e = LedgerEntry(id: "orig-12345678", groupID: "g", title: "Excursion", amount: amount, currency: "USD", paidBy: "a",
                            splits: [Portion(memberID: "a", amount: 3334), Portion(memberID: "b", amount: 3333), Portion(memberID: "c", amount: 3333)])
        e.pending = pending ? true : nil
        return e
    }

    func testRefundIsTheMirrorOfAnExpense() {
        let original = expense()
        let refund = Refunds.make(id: "refund-1234567", original: original, title: "Refund", credits: [Portion(memberID: "c", amount: 3333)], receiver: "a")
        let before = Ledger.balances([original], currency: "USD")
        XCTAssertEqual(before, ["a": 6666, "b": -3333, "c": -3333])
        let after = Ledger.balances([original, refund], currency: "USD")
        XCTAssertEqual(after, ["a": 3333, "b": -3333, "c": 0])
        XCTAssertEqual(after.values.reduce(0, +), 0)
        XCTAssertEqual(Ledger.net(refund, for: "a"), -3333)
        XCTAssertEqual(Ledger.net(refund, for: "c"), 3333)
        XCTAssertEqual(Ledger.share(refund, of: "c"), -3333)
        XCTAssertEqual(refund.signedAmount, -3333)
        XCTAssertEqual(Analytics.monthlyTotal([original, refund], currency: "USD"), 10_000 - 3333)
        let group = ExpenseGroup(id: "g", name: "Trip", kind: "trip", currency: "USD", members: ["a", "b", "c"].map { Person(id: $0, groupID: "g", name: $0) })
        let spend = Analytics.personSpend(group, entries: [original, refund], currency: "USD", people: group.members)
        XCTAssertEqual(spend.first { $0.person.id == "c" }?.share, 0)
        XCTAssertEqual(spend.first { $0.person.id == "a" }?.paid, 10_000 - 3333)
    }

    func testConfirmedOnlyBalancesLeavePendingOut() {
        let pending = expense(pending: true)
        let other = LedgerEntry(groupID: "g", title: "Lunch", amount: 2000, currency: "USD", paidBy: "b",
                                splits: [Portion(memberID: "a", amount: 1000), Portion(memberID: "b", amount: 1000)])
        XCTAssertEqual(Ledger.balances([pending, other], currency: "USD"), ["a": 5666, "b": -2333, "c": -3333])
        XCTAssertEqual(Ledger.balances([pending, other], currency: "USD", includePending: false), ["a": -1000, "b": 1000])
        XCTAssertEqual(Ledger.pendingEntries([pending, other], currency: "USD").map(\.id), [pending.id])
        XCTAssertTrue(Ledger.pendingEntries([pending, other], currency: "EUR").isEmpty)
    }

    func testProportionalRefundIsExactToTheCent() throws {
        let original = expense()
        let credits = try Refunds.proportional(1000, original: original, refunds: [], people: ["a", "b", "c"])
        XCTAssertEqual(credits.map(\.amount), [334, 333, 333])
        XCTAssertEqual(credits.reduce(0) { $0 + $1.amount }, 1000)
        let odd = try Refunds.proportional(1, original: original, refunds: [], people: ["a", "b", "c"])
        XCTAssertEqual(odd.reduce(0) { $0 + $1.amount }, 1)
        // A later refund only reaches what each person has left.
        let first = Refunds.make(id: "refund-1111111", original: original, title: "R1", credits: [Portion(memberID: "b", amount: 3333)], receiver: "a")
        let rest = try Refunds.proportional(Refunds.remaining(of: original, refunds: [first]), original: original, refunds: [first], people: ["a", "b", "c"])
        XCTAssertEqual(rest, [Portion(memberID: "a", amount: 3334), Portion(memberID: "c", amount: 3333)])
        XCTAssertThrowsError(try Refunds.proportional(9000, original: original, refunds: [first], people: ["a", "b", "c"]))
    }

    func testValidationMirrorsTheWorker() throws {
        let original = expense()
        let ok = Refunds.make(id: "refund-2222222", original: original, title: "R", credits: [Portion(memberID: "b", amount: 3333)], receiver: "a")
        XCTAssertNoThrow(try Refunds.validate(ok, original: original, others: []))
        // More than a person's share.
        let tooMuch = Refunds.make(id: "refund-3333333", original: original, title: "R", credits: [Portion(memberID: "b", amount: 3334)], receiver: "a")
        XCTAssertThrowsError(try Refunds.validate(tooMuch, original: original, others: []))
        // Over the original amount across refunds.
        let all = Refunds.make(id: "refund-4444444", original: original, title: "R", credits: original.splits, receiver: "a")
        XCTAssertNoThrow(try Refunds.validate(all, original: original, others: []))
        XCTAssertThrowsError(try Refunds.validate(ok, original: original, others: [all]))
        // Someone who didn't share it.
        let outsider = Refunds.make(id: "refund-5555555", original: original, title: "R", credits: [Portion(memberID: "z", amount: 10)], receiver: "a")
        XCTAssertThrowsError(try Refunds.validate(outsider, original: original, others: []))
        // Only the receiver.
        let selfCredit = Refunds.make(id: "refund-6666666", original: original, title: "R", credits: [Portion(memberID: "a", amount: 10)], receiver: "a")
        XCTAssertThrowsError(try Refunds.validate(selfCredit, original: original, others: []))
        var wrongCurrency = ok; wrongCurrency.currency = "EUR"
        XCTAssertThrowsError(try Refunds.validate(wrongCurrency, original: original, others: []))
    }

    func testAdjustRescalesAndConfirms() throws {
        var original = expense(pending: true)
        original.pendingNote = "Waiting on the agency"
        original.payers = [Payer(memberID: "a", amount: 6000), Payer(memberID: "b", amount: 4000)]
        let adjusted = try Refunds.adjusted(original, to: 7501)
        XCTAssertEqual(adjusted.amount, 7501)
        XCTAssertEqual(adjusted.splits.reduce(0) { $0 + $1.amount }, 7501)
        XCTAssertEqual(adjusted.payers?.reduce(0) { $0 + $1.amount }, 7501)
        XCTAssertNil(adjusted.pending)
        XCTAssertNil(adjusted.pendingNote)
    }

    func testWireFormatDecodesRefundAndPending() throws {
        let json = """
        {"id":"refund-12345678","groupID":"g","title":"Refund","amount":500,"currency":"USD","paidBy":"a","splits":[{"memberID":"b","amount":500}],"kind":"refund","splitMode":"exact","createdAt":"2026-11-27T12:00:00Z","refundOf":"orig-12345678","pending":true,"pendingNote":"Card may reverse it"}
        """
        let entry = try JSONDecoder().decode(LedgerEntry.self, from: Data(json.utf8))
        XCTAssertTrue(entry.isRefund)
        XCTAssertTrue(entry.isPending)
        XCTAssertEqual(entry.refundOf, "orig-12345678")
        XCTAssertEqual(entry.pendingNote, "Card may reverse it")
        let encoded = try XCTUnwrap(String(data: JSONEncoder().encode(entry), encoding: .utf8))
        XCTAssertTrue(encoded.contains("\"refundOf\":\"orig-12345678\""))
    }

    func testSplitwiseNegativeCostRowImportsAsRefund() throws {
        let csv = """
        Date,Description,Category,Cost,Currency,Alex,Maya,Sam
        2026-11-10,Excursion,Entertainment,90.00,USD,60.00,-30.00,-30.00
        2026-11-12,Excursion refund,Entertainment,-30.00,USD,-20.00,10.00,10.00
        2026-11-12,Total balance, , ,USD,40.00,-20.00,-20.00
        """
        let group = try SplitwiseCSV.parse(csv, fileName: "trip.csv")
        XCTAssertEqual(group.rows.count, 2)
        XCTAssertEqual(group.refundCount, 1)
        XCTAssertEqual(group.expenseCount, 1)
        let refund = group.rows[1]
        XCTAssertEqual(refund.refund, true)
        XCTAssertEqual(refund.payer, "Alex")
        XCTAssertEqual(refund.amount, 3000)
        XCTAssertEqual(refund.splits, [CSVShare(name: "Alex", amount: 1000), CSVShare(name: "Maya", amount: 1000), CSVShare(name: "Sam", amount: 1000)])
        XCTAssertEqual(group.importedBalances["USD"], ["Alex": 4000, "Maya": -2000, "Sam": -2000])
        XCTAssertTrue(group.reconciled)
    }

    func testFixturesIncludeRefundAndPending() {
        let snapshot = Fixtures.snapshot()
        XCTAssertTrue(snapshot.entries.contains { $0.isRefund && $0.refundOf == "demo-boat" })
        XCTAssertTrue(snapshot.entries.contains { $0.isPending && $0.pendingNote != nil })
        for entry in snapshot.entries where entry.isRefund {
            let original = snapshot.entries.first { $0.id == entry.refundOf }
            XCTAssertNoThrow(try Refunds.validate(entry, original: original, others: []))
        }
    }

    // MARK: - Shared fixture (worker/src/refundMath.ts is the source of truth)

    private struct SharedCase: Decodable {
        struct Member: Decodable { var id: String; var name: String }
        struct Op: Decodable { var original: String?; var entry: String?; var amount: Int64 }
        struct Breakdown: Decodable { var id: String; var paid: Int64; var share: Int64; var net: Int64 }
        struct Room: Decodable { var total: Int64; var members: [String: Int64] }
        struct Expected: Decodable {
            var balances: [String: Int64]; var confirmedBalances: [String: Int64]; var total: Int64
            var categories: [String: Int64]; var months: [String: Int64]; var members: [Breakdown]
            var room: Room; var proportionalCredits: [Portion]; var adjustedSplits: [Portion]
        }
        var currency: String; var members: [Member]; var entries: [LedgerEntry]
        var proportional: Op; var adjust: Op; var expected: Expected
    }

    func testSharedRefundFixtureMatchesTheWorker() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("fixtures/refunds/cases.json")
        let c = try JSONDecoder().decode(SharedCase.self, from: Data(contentsOf: url))
        let x = c.expected
        func nonzero(_ d: [String: Int64]) -> [String: Int64] { d.filter { $0.value != 0 } }
        XCTAssertEqual(nonzero(Ledger.balances(c.entries, currency: c.currency)), nonzero(x.balances))
        XCTAssertEqual(nonzero(Ledger.balances(c.entries, currency: c.currency, includePending: false)), nonzero(x.confirmedBalances))
        XCTAssertEqual(Analytics.monthlyTotal(c.entries, currency: c.currency), x.total)
        // iOS labels the no-category bucket "General"; the Worker calls it "Uncategorized".
        let categories = Dictionary(uniqueKeysWithValues: Analytics.categories(c.entries, currency: c.currency).map { ($0.category == "General" ? "Uncategorized" : $0.category, $0.amount) })
        XCTAssertEqual(categories, x.categories)
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: Analytics.monthly(c.entries, currency: c.currency).map { ($0.month, $0.amount) }), x.months)
        let group = ExpenseGroup(id: "g", name: "Fixture", kind: "trip", currency: c.currency,
                                 members: c.members.map { Person(id: $0.id, groupID: "g", name: $0.name) })
        let spend = Analytics.personSpend(group, entries: c.entries, currency: c.currency, people: group.members)
        for member in x.members {
            let row = try XCTUnwrap(spend.first { $0.person.id == member.id })
            XCTAssertEqual([row.paid, row.share, row.net], [member.paid, member.share, member.net], member.id)
        }
        let original = try XCTUnwrap(c.entries.first { $0.id == c.proportional.original })
        let refunds = Refunds.linked(to: original, in: c.entries)
        XCTAssertEqual(Refunds.remaining(of: original, refunds: refunds), x.room.total)
        let room = Dictionary(uniqueKeysWithValues: Refunds.remainingShares(of: original, refunds: refunds).map { ($0.memberID, $0.amount) })
        for (id, amount) in x.room.members { XCTAssertEqual(room[id] ?? 0, amount, id) }
        let credits = try Refunds.proportional(c.proportional.amount, original: original, refunds: refunds, people: original.splits.map(\.memberID))
        XCTAssertEqual(credits, x.proportionalCredits)
        let adjustable = try XCTUnwrap(c.entries.first { $0.id == c.adjust.entry })
        XCTAssertEqual(try Refunds.adjusted(adjustable, to: c.adjust.amount).splits, x.adjustedSplits)
    }
}
