import PDFKit
import XCTest
@testable import Split

/// The Swift port of the Worker's `billConsumption` must agree to the cent. Expected values
/// below were produced by running `worker/src/items.ts` on the same bills.
final class ConsumptionTests: XCTestCase {
    private func part(_ id: String, _ amount: Int64, _ items: Int64, _ tax: Int64, _ tip: Int64) -> ConsumptionPart {
        ConsumptionPart(memberID: id, amount: amount, items: items, tax: tax, tip: tip)
    }

    /// Every column sums to the receipt and each person's parts sum to their split.
    private func assertExact(_ bill: ReceiptBill, payer: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let use = try Consumption.bill(bill, payer: payer)
        let split = try bill.split(payer: payer)
        XCTAssertEqual(use.people.map(\.memberID), split.map(\.memberID), file: file, line: line)
        XCTAssertEqual(use.people.map(\.amount), split.map(\.amount), file: file, line: line)
        XCTAssertEqual(use.people.reduce(0) { $0 + $1.items }, bill.items.reduce(0) { $0 + $1.amount }, file: file, line: line)
        XCTAssertEqual(use.people.reduce(0) { $0 + $1.tax }, bill.tax, file: file, line: line)
        XCTAssertEqual(use.people.reduce(0) { $0 + $1.tip }, bill.tip, file: file, line: line)
        for person in use.people {
            XCTAssertEqual(person.items + person.tax + person.tip, person.amount, file: file, line: line)
            XCTAssertTrue(person.items >= 0 && person.tax >= 0 && person.tip >= 0, file: file, line: line)
        }
        for item in use.items {
            XCTAssertEqual(item.amount + item.tax + item.tip, item.gross, file: file, line: line)
            XCTAssertEqual(item.portions.reduce(0) { $0 + $1.amount }, item.gross, file: file, line: line)
            XCTAssertEqual(item.portions.reduce(0) { $0 + $1.items }, item.amount, file: file, line: line)
            XCTAssertEqual(item.portions.reduce(0) { $0 + $1.tax }, item.tax, file: file, line: line)
            XCTAssertEqual(item.portions.reduce(0) { $0 + $1.tip }, item.tip, file: file, line: line)
        }
    }

    func testTaxFollowsItemsAndOpenItemsStayWithThePayer() throws {
        let bill = ReceiptBill(items: [
            Purchase(id: "p", title: "Pizza", amount: 3000, memberIDs: ["a", "b"]),
            Purchase(id: "b", title: "Beer", amount: 1000),
            Purchase(id: "s", title: "Salad", amount: 2001, memberIDs: ["a", "b", "c"])
        ], tax: 600)
        let use = try Consumption.bill(bill, payer: "c")
        XCTAssertEqual(use.items.map(\.gross), [3300, 1100, 2201])
        XCTAssertEqual(use.items.map(\.tax), [300, 100, 200])
        XCTAssertEqual(use.items.map(\.tip), [0, 0, 0])
        XCTAssertEqual(use.items.map(\.open), [false, true, false])
        XCTAssertEqual(use.items[1].portions, [part("c", 1100, 1000, 100, 0)])
        XCTAssertEqual(use.items[2].portions, [part("a", 734, 667, 67, 0), part("b", 734, 667, 67, 0), part("c", 733, 667, 66, 0)])
        XCTAssertEqual(use.people, [part("a", 2384, 2167, 217, 0), part("b", 2384, 2167, 217, 0), part("c", 1833, 1667, 166, 0)])
        try assertExact(bill, payer: "c")
    }

    func testTaxAndTipWithSharesAndMergedHistoricalSeats() throws {
        let bill = ReceiptBill(items: [
            // One account inherited two historical seats on this item; they merge into one portion.
            Purchase(id: "w", title: "Wine", amount: 1001, memberIDs: ["a", "b"], roundingSeats: ["a", "a", "b"]),
            Purchase(id: "f", title: "Fries", amount: 333, memberIDs: ["b", "c"], shares: ["b": 200]),
            Purchase(id: "d", title: "Dessert", amount: 999, memberIDs: ["c"])
        ], tax: 187, tip: 350)
        let use = try Consumption.bill(bill, payer: "c")
        XCTAssertEqual(use.items[0], ItemConsumption(id: "w", title: "Wine", amount: 1001, gross: 1231, tax: 80, tip: 150, open: false,
                                                     portions: [part("a", 821, 668, 53, 100), part("b", 410, 333, 27, 50)]))
        XCTAssertEqual(use.items[1].portions, [part("b", 273, 222, 18, 33), part("c", 137, 111, 9, 17)])
        XCTAssertEqual(use.items[2].portions, [part("c", 1229, 999, 80, 150)])
        XCTAssertEqual(use.people, [part("a", 821, 668, 53, 100), part("b", 683, 555, 45, 83), part("c", 1366, 1110, 89, 167)])
        try assertExact(bill, payer: "c")
    }

    func testRandomBillsStayExactToTheCent() throws {
        var generator = SystemRandomNumberGenerator()
        let people = ["a", "b", "c", "d", "e"]
        for _ in 0..<300 {
            let items = (0..<Int.random(in: 1...8, using: &generator)).map { index in
                Purchase(id: "i\(index)", title: "Item \(index)", amount: Int64.random(in: 1...9999, using: &generator),
                         memberIDs: Array(people.shuffled(using: &generator).prefix(Int.random(in: 0...4, using: &generator))))
            }
            let bill = ReceiptBill(items: items, tax: Int64.random(in: 0...999, using: &generator), tip: Int64.random(in: 0...1999, using: &generator))
            try assertExact(bill, payer: "a")
        }
    }

    func testNoTaxOrTipLeavesOnlyItems() throws {
        let bill = ReceiptBill(items: [Purchase(title: "Tea", amount: 301, memberIDs: ["a", "b"])])
        let use = try Consumption.bill(bill, payer: "a")
        XCTAssertEqual(use.people, [part("a", 151, 151, 0, 0), part("b", 150, 150, 0, 0)])
    }

    func testReportCoversItemizedAndPlainExpensesPerCurrency() throws {
        let bill = ReceiptBill(items: [
            Purchase(id: "p", title: "Pizza", amount: 1000, memberIDs: ["a", "b"]),
            Purchase(id: "s", title: "Soda", amount: 200, memberIDs: ["b"])
        ], tax: 120, tip: 0)
        let dinner = LedgerEntry(id: "dinner", groupID: "g", title: "Dinner", amount: 1320, currency: "USD", paidBy: "a",
                                 splits: try bill.split(payer: "a"), bill: bill)
        let cab = LedgerEntry(id: "cab", groupID: "g", title: "Cab", amount: 1001, currency: "USD", paidBy: "b",
                              splits: [Portion(memberID: "a", amount: 501), Portion(memberID: "b", amount: 500)])
        let museum = LedgerEntry(id: "museum", groupID: "g", title: "Museum", amount: 900, currency: "EUR", paidBy: "a",
                                 splits: [Portion(memberID: "a", amount: 900)])
        let payment = LedgerEntry(id: "pay", groupID: "g", title: "Payback", amount: 300, currency: "USD", paidBy: "b",
                                  splits: [Portion(memberID: "a", amount: 300)], kind: "settlement")

        XCTAssertEqual(try Consumption.lines(cab).map(\.part), [part("a", 501, 501, 0, 0), part("b", 500, 500, 0, 0)])
        XCTAssertEqual(try Consumption.lines(cab).map(\.title), ["Cab", "Cab"])
        XCTAssertEqual(try Consumption.lines(dinner).map(\.itemID), ["p", "p", "s"])

        let usd = try Consumption.report([dinner, cab, museum, payment], currency: "USD")
        XCTAssertEqual(usd.map(\.total.memberID), ["a", "b"])
        XCTAssertEqual(usd.map(\.total), [part("a", 1051, 1001, 50, 0), part("b", 1270, 1200, 70, 0)])
        XCTAssertEqual(usd.reduce(0) { $0 + $1.total.amount }, dinner.amount + cab.amount)
        XCTAssertEqual(usd[1].lines.map(\.title), ["Pizza", "Soda", "Cab"])
        let eur = try Consumption.report([dinner, cab, museum, payment], currency: "EUR")
        XCTAssertEqual(eur.map(\.total), [part("a", 900, 900, 0, 0)])
    }

    func testInboxListDecodesTheWorkerShape() throws {
        let json = #"{"receipts":[{"id":"r1","groupID":"g","uploadedBy":"m1","createdAt":"2026-11-18T22:40:00.123Z","note":"Dinner","bytes":51234},{"id":"r2","groupID":"g","uploadedBy":"m2","createdAt":"2026-11-18T13:05:00Z","bytes":1}]}"#
        let list = try JSONDecoder().decode(InboxReceiptList.self, from: Data(json.utf8)).receipts
        XCTAssertEqual(list.map(\.id), ["r1", "r2"])
        XCTAssertEqual(list[0].note, "Dinner")
        XCTAssertNil(list[1].note)
        XCTAssertEqual(list[0].bytes, 51234)
        XCTAssertNotNil(list[0].date)
        XCTAssertNotNil(list[1].date)
    }

    @MainActor
    func testPDFBreaksDownConsumptionByItemAndPerson() throws {
        let group = ExpenseGroup(id: "g", name: "Dinner club", kind: "friend", currency: "USD", members: [
            Person(id: "a", groupID: "g", name: "Alex"),
            Person(id: "b", groupID: "g", name: "Sam")
        ])
        let bill = ReceiptBill(items: [
            Purchase(id: "p", title: "Pizza", amount: 1000, memberIDs: ["a", "b"]),
            Purchase(id: "s", title: "Soda", amount: 200, memberIDs: ["b"])
        ], tax: 120, tip: 60)
        let dinner = LedgerEntry(groupID: "g", title: "Dinner", amount: 1380, currency: "USD", paidBy: "a",
                                 splits: try bill.split(payer: "a"), bill: bill, createdAt: "2026-11-01T12:00:00Z")
        let cab = LedgerEntry(groupID: "g", title: "Cab home", amount: 1001, currency: "USD", paidBy: "b",
                              splits: [Portion(memberID: "a", amount: 501), Portion(memberID: "b", amount: 500)],
                              createdAt: "2026-11-01T23:00:00Z")
        let suite = UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let fx = FXStore(defaults: defaults, fileURL: nil)
        fx.home = "USD"
        let data = try GroupSummaryPDF.render(group: group, entries: [dinner, cab], fx: fx)
        let text = try XCTUnwrap(PDFDocument(data: data)?.string)
        let use = try Consumption.bill(bill, payer: "a")
        for label in ["Consumption by person", "Receipt by person (USD)", "Dinner: Pizza", "Dinner: Soda", "Cab home", "Items", "Tax", "Tip"] {
            XCTAssertTrue(text.contains(label), label)
        }
        // Pizza's own tax and tip, and each person's receipt tax.
        XCTAssertTrue(text.contains("Item \(Money.text(1000, "USD")) + tax \(Money.text(use.items[0].tax, "USD")) + tip \(Money.text(use.items[0].tip, "USD"))"))
        for person in use.people {
            XCTAssertTrue(text.contains(Money.text(person.tax, "USD")))
            XCTAssertTrue(text.contains(Money.text(person.amount, "USD")))
        }
        let report = try Consumption.report([dinner, cab], currency: "USD")
        for person in report { XCTAssertTrue(text.contains(Money.text(person.total.amount, "USD"))) }
    }
}
