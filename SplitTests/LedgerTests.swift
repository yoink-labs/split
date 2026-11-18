import XCTest
@testable import Split
final class LedgerTests: XCTestCase {
    @MainActor func testInvitesAcceptBothGenerationsAndOnlySplitLinks() {
        let old=String(repeating:"a",count:72)
        for value in ["abcd-efgh-2345", "https://split-api.yoinklabs.dev/join/ABCDEFGH2345",
                      "com.yoinklabs.split://join/ABCDEFGH2345"] {
            XCTAssertEqual(ExpenseStore.inviteToken(value),"ABCDEFGH2345")
        }
        XCTAssertEqual(ExpenseStore.inviteToken("https://split-api.yoinklabs.dev/join/"+old),old)
        XCTAssertNil(ExpenseStore.inviteToken("https://example.com/join/ABCDEFGH2345"))
        XCTAssertNil(ExpenseStore.inviteToken("abcdef"))
    }
    func testRemaindersNeverLoseMoney() throws {
        for total in 1...1000 {
            for count in 1...12 {
                let parts=try Ledger.allocate(total:Int64(total),weights:Array(repeating:1,count:count))
                XCTAssertEqual(parts.reduce(0,+),Int64(total))
                XCTAssertLessThanOrEqual(parts.max()! - parts.min()!,1)
            }
        }
        XCTAssertEqual(try Ledger.allocate(total:100,weights:[1,1,1]),[34,33,33])
    }
    func testWeightedSplitsAndValidation() throws {
        XCTAssertEqual(try Ledger.allocate(total:10001,weights:[2,1,1]),[5001,2500,2500])
        XCTAssertEqual(try Ledger.split(total:100,people:["a","b"],mode:.percent,values:["a":"33.33","b":"66.67"]).map(\.amount),[33,67])
        XCTAssertThrowsError(try Ledger.split(total:100,people:["a","b"],mode:.percent,values:["a":"40","b":"40"]))
        XCTAssertThrowsError(try Ledger.split(total:100,people:["a","b"],mode:.exact,values:["a":"0.20","b":"0.20"]))
        XCTAssertThrowsError(try Ledger.allocate(total:100,weights:[0,0]))
        XCTAssertEqual(try Ledger.allocate(total:Money.maxAmount,weights:[Money.maxAmount,1]).reduce(0,+),Money.maxAmount)
    }
    func testDecimalInput() {
        XCTAssertEqual(Money.parse("1234,56"),123456)
        XCTAssertEqual(Money.parse("0.01"),1)
        XCTAssertNil(Money.parse("1.001"));XCTAssertNil(Money.parse("-2"));XCTAssertNil(Money.parse("1,000.00"));XCTAssertNil(Money.parse("NaN"))
    }
    func testSettlementReducesDebtAndCurrenciesStaySeparate() {
        let e=LedgerEntry(groupID:"g",title:"Dinner",amount:10000,currency:"ARS",paidBy:"a",splits:[Portion(memberID:"a",amount:5000),Portion(memberID:"b",amount:5000)])
        let usd=LedgerEntry(groupID:"g",title:"Stay",amount:20000,currency:"USD",paidBy:"b",splits:[Portion(memberID:"a",amount:10000),Portion(memberID:"b",amount:10000)])
        let before=Ledger.simplify([e,usd],currency:"ARS")
        XCTAssertEqual(before.count,1);XCTAssertEqual(before[0].from,"b");XCTAssertEqual(before[0].to,"a");XCTAssertEqual(before[0].amount,5000)
        let payment=LedgerEntry(groupID:"g",title:"Payment",amount:5000,currency:"ARS",paidBy:"b",splits:[Portion(memberID:"a",amount:5000)],kind:"settlement")
        XCTAssertTrue(Ledger.simplify([e,usd,payment],currency:"ARS").isEmpty)
        XCTAssertEqual(Ledger.balances([e,usd,payment],currency:"USD")["a"],-10000)
    }
    func testOfflineStateRoundTrip() throws {
        let state=DiskState(snapshot:Fixtures.snapshot(),outbox:[OutboxItem(id:"retry-id",path:"/v1/entries",body:Data("entry".utf8))])
        let loaded=try JSONDecoder().decode(DiskState.self,from:JSONEncoder().encode(state))
        XCTAssertEqual(loaded.snapshot.entries,state.snapshot.entries);XCTAssertEqual(loaded.outbox.first?.id,"retry-id")
    }
}
