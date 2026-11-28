import PDFKit
import XCTest
@testable import Split

final class GroupSummaryPDFTests: XCTestCase {
    @MainActor
    func testCustomReportSeparatesCurrenciesAndExcludesPaymentsFromSpending() throws {
        let group = ExpenseGroup(id: "trip", name: "Group trip", kind: "trip", currency: "USD", members: [
            Person(id: "one", groupID: "trip", name: "Alex"),
            Person(id: "two", groupID: "trip", name: "Sam")
        ])
        let dinner = LedgerEntry(
            groupID: group.id, title: "Dinner receipt", amount: 1011, currency: "USD", paidBy: "one",
            splits: [Portion(memberID: "one", amount: 505), Portion(memberID: "two", amount: 506)],
            category: "Dining", createdAt: "2026-08-01T12:00:00Z",
            payers: [Payer(memberID: "one", amount: 711), Payer(memberID: "two", amount: 300)]
        )
        let lunch = LedgerEntry(
            groupID: group.id, title: "Lunch receipt", amount: 101, currency: "EUR", paidBy: "two",
            splits: [Portion(memberID: "one", amount: 101)], category: "Dining", createdAt: "2026-09-01T12:00:00Z"
        )
        let payment = LedgerEntry(
            groupID: group.id, title: "Payback", amount: 211, currency: "USD", paidBy: "two",
            splits: [Portion(memberID: "one", amount: 211)], category: "Dining", kind: "settlement"
        )
        let sections = GroupSummaryPDF.Sections(totals: false, balances: false, history: false,
                                                categories: true, months: true, people: true, consumption: false)
        let data = try GroupSummaryPDF.render(group: group, entries: [dinner, lunch, payment],
                                              fx: FXStore(fileURL: nil), sections: sections)
        let text = try XCTUnwrap(PDFDocument(data: data)?.string)
        for label in ["Spending by category", "Spending by month", "Spending by person", "Dining", "2026-08", "2026-09"] {
            XCTAssertTrue(text.contains(label))
        }
        for (amount, currency) in [(1011, "USD"), (101, "EUR"), (711, "USD"), (300, "USD"), (505, "USD"), (506, "USD")] {
            XCTAssertTrue(text.contains(Money.text(Int64(amount), currency)))
        }
        for omitted in ["Total expenses", "Outstanding balances", "Expense and payment history", dinner.title,
                        payment.title, Money.text(211, "USD")] {
            XCTAssertFalse(text.contains(omitted))
        }
    }

    @MainActor
    func testPDFKeepsOriginalAmountsAndAllocatedSharesAcrossPages() throws {
        let suite = UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let fx = FXStore(defaults: defaults, fileURL: nil)
        fx.home = "USD"
        let group = ExpenseGroup(id: "trip", name: "Weekend trip", kind: "trip", currency: "USD", members: [
            Person(id: "one", groupID: "trip", name: "Alex"),
            Person(id: "two", groupID: "trip", name: "Sam"),
            Person(id: "three", groupID: "trip", name: "Nina")
        ], description: "Dinner and museum with friends.", startDate: "2026-08-01", endDate: "2026-08-29")
        let shares = group.members.map { Portion(memberID: $0.id, amount: 1001) }
        let bill = ReceiptBill(items: [
            Purchase(title: "Market dumplings", amount: 1000, memberIDs: ["one", "two"]),
            Purchase(title: "Summer rolls", amount: 1500)
        ], tax: 303, tip: 200)
        let expense = LedgerEntry(
            groupID: group.id, title: "Dinner at the market", amount: 3003, currency: "CAD", paidBy: "one",
            splits: shares, exchange: Exchange(target: "USD", rateE8: 75_000_000, date: "2026-08-01", source: "Manual"),
            createdAt: "2026-08-01T12:00:00Z"
        )
        let meal = LedgerEntry(
            groupID: group.id, title: "Market lunch", amount: 3003, currency: "CAD", paidBy: "one",
            splits: try bill.split(payer: "one"), exchange: expense.exchange, bill: bill, createdAt: "2026-08-01T13:00:00Z"
        )
        let unrated = LedgerEntry(
            groupID: group.id, title: "Museum tickets", amount: 1001, currency: "EUR", paidBy: "two",
            splits: [Portion(memberID: "one", amount: 1001)], createdAt: "2026-08-02T12:00:00Z", handled: true
        )
        let more = (10...29).map { day in
            LedgerEntry(groupID: group.id, title: "Trip expense \(day)", amount: 3003, currency: "USD", paidBy: "one",
                        splits: shares, createdAt: "2026-08-\(day)T12:00:00Z")
        }
        let data = try GroupSummaryPDF.render(group: group, entries: [expense, meal, unrated] + more, fx: fx)
        let pdf = try XCTUnwrap(PDFDocument(data: data))
        let text = try XCTUnwrap(pdf.string)
        XCTAssertGreaterThan(pdf.pageCount, 1)
        XCTAssertTrue(text.contains("Recorded \(Money.text(3003, "CAD"))"))
        XCTAssertTrue(text.contains(Money.text(2252, "USD")))
        XCTAssertTrue(text.contains(Money.text(751, "USD")))
        XCTAssertTrue(text.contains(Money.text(750, "USD")))
        XCTAssertTrue(text.contains("USD rate unavailable"))
        XCTAssertTrue(text.contains(Money.text(1001, "EUR")))
        XCTAssertTrue(text.contains("Already handled"))
        XCTAssertTrue(text.contains("Trip expense 29"))
        XCTAssertTrue(text.contains("Dinner and museum with friends."))
        XCTAssertTrue(text.contains("Market dumplings"))
        XCTAssertTrue(text.contains("Unclaimed · Alex"))
        XCTAssertTrue(text.contains("Share incl. tax & tip"))
        XCTAssertTrue(text.contains(Money.text(601, "CAD")))

        let detailed = try GroupSummaryPDF.render(group: group, entries: [meal], fx: fx, layout: .expenses,
                                                  sections: GroupSummaryPDF.Sections(consumption: false))
        let details = try XCTUnwrap(PDFDocument(data: detailed)?.string)
        XCTAssertTrue(details.contains(meal.title))
        XCTAssertTrue(details.contains("Market dumplings"))

        let summary = try GroupSummaryPDF.render(group: group, entries: [meal], fx: fx, layout: .summary,
                                                  sections: GroupSummaryPDF.Sections(consumption: false))
        let summaryText = try XCTUnwrap(PDFDocument(data: summary)?.string)
        XCTAssertTrue(summaryText.contains("Suggested payments"))
        XCTAssertTrue(summaryText.contains(meal.title))
        XCTAssertTrue(summaryText.contains("Market dumplings"))

        let personal = try GroupSummaryPDF.render(group: group, entries: [meal, unrated], fx: fx, layout: .summary,
                                                   sections: GroupSummaryPDF.Sections(totals: false, balances: false, consumption: false),
                                                   memberID: "one")
        let personalText = try XCTUnwrap(PDFDocument(data: personal)?.string)
        for label in ["Personal report for Alex", "Alex (you)", "Your item payment", "Your item share", "Item · Museum tickets"] {
            XCTAssertTrue(personalText.contains(label), label)
        }
        let item = try XCTUnwrap(Consumption.items(unrated).first)
        XCTAssertEqual(item.gross, unrated.amount)
        XCTAssertEqual(item.portions.map(\.amount), unrated.splits.map(\.amount))
    }
}
