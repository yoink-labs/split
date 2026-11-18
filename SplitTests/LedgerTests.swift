import XCTest
@testable import Split
final class LedgerTests: XCTestCase {
    func testSettlementOptimizationAndFrozenRate() throws {
        let balance:[String:Int64]=["a":-8,"b":-7,"c":-5,"d":5,"e":7,"f":8]
        XCTAssertEqual(Ledger.plan(balance,currency:"ARS").count,3)
        let fx=Exchange(target:"ARS",rateE8:103950000000,date:"2025-01-10",source:"BCRA")
        let e=LedgerEntry(groupID:"g",title:"Food",amount:101,currency:"USD",paidBy:"a",splits:[Portion(memberID:"a",amount:51),Portion(memberID:"b",amount:50)],exchange:fx)
        XCTAssertEqual(try fx.converting(e).amount,104990)
        XCTAssertEqual(e.settling.splits.map(\.amount).reduce(0,+),104990)
        XCTAssertEqual(e.settling.settling,e.settling)
    }
    func testCSVImportAndExport() throws {
        let csv="Date,Description,Category,Cost,Currency,Alex,Maya\r\n2025-01-10,\"Lunch, downtown\",Dining,10.00,USD,3.00,-3.00"
        let row=try XCTUnwrap(LedgerCSV.parse(csv,defaultCurrency:"ARS").first)
        XCTAssertEqual(row.title,"Lunch, downtown");XCTAssertEqual(row.payer,"Alex");XCTAssertEqual(row.splits.map(\.amount),[700,300])
        XCTAssertThrowsError(try LedgerCSV.parse(csv.replacingOccurrences(of:"-3.00",with:"2.00"),defaultCurrency:"ARS"))
        let group=Fixtures.snapshot().groups[0]
        let exported=LedgerCSV.export(Fixtures.snapshot().entries,group:group)
        XCTAssertEqual(try LedgerCSV.parse(exported,defaultCurrency:"ARS").count,3)
        let splid="Date;Description;Amount;Paid by;Participants\n2025-02-01;Ride;10.01;Alex;Alex,Maya"
        XCTAssertEqual(try LedgerCSV.parse(splid,defaultCurrency:"USD")[0].splits.map(\.amount),[501,500])
    }
    func testReceiptSuggestionsAndGrossClaims() throws {
        let bill=ReceiptReader.suggest(["Coffee 5.01","Toast 9.99","SUBTOTAL 15.00","Tax 1.01","Tip 2.00","Total 18.01"])
        XCTAssertEqual(bill.items.map(\.title),["Coffee","Toast"])
        XCTAssertEqual(bill.openTotal,1801)
        var shared=bill; shared.items[0].memberIDs=["Alex","Maya"]
        XCTAssertEqual(try shared.gross(),[602,1199])
        XCTAssertEqual(shared.openTotal,1199)
        XCTAssertEqual(try shared.split(payer:"Alex"),[Portion(memberID:"Alex",amount:1500),Portion(memberID:"Maya",amount:301)])
    }
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
    func testMemberActivityUsesCanonicalSeatsAcrossSharedGroups() {
        var snapshot = Fixtures.snapshot()
        let group = snapshot.groups[0]
        let me = group.members[0]
        let guest = group.members[1]
        snapshot.groups[1].members[1].name = guest.name
        XCTAssertEqual(snapshot.memberships(user: me.userID, groupID: group.id, seatID: me.id).count, 2)
        XCTAssertEqual(snapshot.memberships(user: nil, groupID: group.id, seatID: guest.id).map { $0.0.id }, [group.id])
        let payerOnly = LedgerEntry(groupID: group.id, title: "Gift", amount: 800, currency: "USD",
                                    paidBy: guest.id, splits: [Portion(memberID: me.id, amount: 800)])
        snapshot.entries.append(payerOnly)
        let charges = snapshot.charges(group: group.id, seat: guest.id)
        XCTAssertTrue(charges.contains(payerOnly))
        XCTAssertTrue(charges.contains { $0.bill != nil })
        XCTAssertTrue(snapshot.charges(group: snapshot.groups[1].id, seat: guest.id).isEmpty)
    }

    func testOfflineStateRoundTrip() throws {
        let state=DiskState(snapshot:Fixtures.snapshot(),outbox:[OutboxItem(id:"retry-id",path:"/v1/entries",body:Data("entry".utf8))])
        let loaded=try JSONDecoder().decode(DiskState.self,from:JSONEncoder().encode(state))
        XCTAssertEqual(loaded.snapshot.entries,state.snapshot.entries);XCTAssertEqual(loaded.outbox.first?.id,"retry-id")
    }
}
