import XCTest
@testable import Split

/// Calculation checks for the 0.5 design pass: receipt chips assign
/// `Purchase.memberIDs` in the composer, so the split must stay exact.
final class ReceiptClaimTests: XCTestCase {
    private func bill() -> ReceiptBill {
        ReceiptBill(
            items: [
                Purchase(title: "Pizza", amount: 3000, memberIDs: ["a", "b"]),
                Purchase(title: "Beer", amount: 1000),
                Purchase(title: "Salad", amount: 2001, memberIDs: ["a", "b", "c"]),
            ],
            tax: 600,
            tip: 0
        )
    }

    func testChipAssignmentsSplitExactlyWithTaxAndPayerFallback() throws {
        let receipt = bill()
        XCTAssertEqual(receipt.total, 6601)
        // Tax follows item price with largest-remainder rounding.
        XCTAssertEqual(try receipt.gross(), [3300, 1100, 2201])
        XCTAssertEqual(receipt.openCount, 1)
        XCTAssertEqual(receipt.openTotal, 1100)
        // The unassigned beer falls back to the payer, c.
        let split = try receipt.split(payer: "c")
        XCTAssertEqual(split, [
            Portion(memberID: "a", amount: 2384),
            Portion(memberID: "b", amount: 2384),
            Portion(memberID: "c", amount: 1833),
        ])
        XCTAssertEqual(split.map(\.amount).reduce(0, +), receipt.total)
    }

    func testAssigningEveryoneLeavesNothingOpenAndKeepsEveryCent() throws {
        var receipt = bill()
        for index in receipt.items.indices { receipt.items[index].memberIDs = ["a", "b", "c"] }
        XCTAssertEqual(receipt.openCount, 0)
        XCTAssertEqual(receipt.openTotal, 0)
        let split = try receipt.split(payer: "a")
        XCTAssertEqual(split.map(\.amount).reduce(0, +), receipt.total)
        XCTAssertLessThanOrEqual(split.map(\.amount).max()! - split.map(\.amount).min()!, 3)
    }

    func testClearingChipsReturnsItemsToThePayer() throws {
        var receipt = bill()
        for index in receipt.items.indices { receipt.items[index].memberIDs = [] }
        XCTAssertEqual(try receipt.split(payer: "b"), [Portion(memberID: "b", amount: 6601)])
    }

    func testReassignedItemDropsHistoricalRoundingSeats() throws {
        var receipt = ReceiptBill(items: [Purchase(title: "Wine", amount: 1001, memberIDs: ["a"], roundingSeats: ["a", "a", "b"])])
        XCTAssertEqual(try receipt.split(payer: "a"), [Portion(memberID: "a", amount: 668), Portion(memberID: "b", amount: 333)])
        // The composer chip toggle clears roundingSeats, as ExpenseStore.claim does.
        receipt.items[0].memberIDs = ["a", "b"]
        receipt.items[0].roundingSeats = nil
        XCTAssertEqual(try receipt.split(payer: "a"), [Portion(memberID: "a", amount: 501), Portion(memberID: "b", amount: 500)])
    }

    func testSharesAndPercentModesUseLargestRemainder() throws {
        XCTAssertEqual(try Ledger.split(total: 10001, people: ["a", "b", "c"], mode: .shares, values: ["a": "2", "b": "1", "c": "1"]).map(\.amount), [5001, 2500, 2500])
        XCTAssertEqual(try Ledger.split(total: 100, people: ["a", "b", "c"], mode: .percent, values: ["a": "33.33", "b": "33.33", "c": "33.34"]).map(\.amount), [33, 33, 34])
    }

    func testSuggestedPaymentsClearEveryBalance() {
        var balance: [String: Int64] = ["a": -1234, "b": -766, "c": 1500, "d": 500]
        let plan = Ledger.plan(balance, currency: "USD")
        XCTAssertLessThanOrEqual(plan.count, 3)
        for transfer in plan {
            XCTAssertGreaterThan(transfer.amount, 0)
            balance[transfer.from, default: 0] += transfer.amount
            balance[transfer.to, default: 0] -= transfer.amount
        }
        XCTAssertTrue(balance.values.allSatisfy { $0 == 0 }, "\(balance)")
    }

    func testDirectPlanClearsBalancesWhenSimplificationIsOff() {
        var balance: [String: Int64] = ["a": -1234, "b": -766, "c": 1500, "d": 500]
        let plan = Ledger.directPlan(balance, currency: "USD")
        XCTAssertEqual(plan.count, 3)
        for transfer in plan {
            XCTAssertGreaterThan(transfer.amount, 0)
            balance[transfer.from, default: 0] += transfer.amount
            balance[transfer.to, default: 0] -= transfer.amount
        }
        XCTAssertTrue(balance.values.allSatisfy { $0 == 0 }, "\(balance)")
    }

    func testInviteCodeDisplayGrouping() {
        XCTAssertEqual(InviteView.display("ABCDEFGH2345"), "ABCD-EFGH-2345")
        let personal = String(repeating: "a", count: 72)
        XCTAssertEqual(InviteView.display(personal), personal)
        XCTAssertNotNil(QRCodeView.image(for: "https://split-api.yoinklabs.dev/join/ABCDEFGH2345"))
    }
}
