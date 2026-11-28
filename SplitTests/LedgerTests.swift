import XCTest
@testable import Split
final class LedgerTests: XCTestCase {
    func testLegacyGroupClassificationAndTripPhases() throws {
        func decode(_ fields: String) throws -> ExpenseGroup {
            try JSONDecoder().decode(ExpenseGroup.self, from: Data("""
            {"id":"trip","name":"Trip","currency":"USD","members":[],"createdAt":"2026-11-01T12:00:00Z"\(fields)}
            """.utf8))
        }
        XCTAssertEqual(try decode("").kind, "home")
        XCTAssertEqual(try decode(#","kind":"friend""#).kind, "friend")
        var group = try decode(#","startDate":"2026-11-12","endDate":"2026-11-21""#)
        XCTAssertEqual(group.kind, "trip")
        XCTAssertEqual(group.defaultPhase(on: "2026-11-11"), .pre)
        XCTAssertEqual(group.defaultPhase(on: "2026-11-12"), .during)
        XCTAssertEqual(group.defaultPhase(on: "2026-11-21"), .during)
        XCTAssertEqual(group.defaultPhase(on: "2026-11-22"), .post)
        var entry = LedgerEntry(groupID: group.id, title: "Flight", amount: 100, currency: "USD",
                                paidBy: "alex", splits: [], createdAt: "2026-11-12T12:00:00Z")
        XCTAssertEqual(group.phase(for: entry), .during)
        entry.phase = .pre
        XCTAssertEqual(group.phase(for: entry), .pre)
        group.kind = "home"
        XCTAssertNil(group.phase(for: entry))
    }

    func testPaymentLinksAndLegacyHandles() throws {
        let legacy = try JSONDecoder().decode(Person.self, from: Data("""
        {"id":"seat","groupID":"group","name":"Alex","payment":{"venmo":"alex"}}
        """.utf8))
        XCTAssertEqual(legacy.availablePaymentMethods.first?.url()?.absoluteString, "https://venmo.com/u/alex")
        XCTAssertEqual(PaymentMethod(platform: "paypal", handle: "Alex").url(amount: 1005, currency: "USD")?.absoluteString,
                       "https://paypal.me/Alex/10.05USD")
        XCTAssertNil(PaymentMethod(platform: "paypal", handle: "https://paypal.me.example.com/Alex").url())
        XCTAssertNil(PaymentMethod(platform: "zelle", handle: "alex@example.com").url())
        XCTAssertNil(PaymentMethod(platform: "Other", handle: "javascript:alert(1)").url())
    }

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
        let snapshot=Fixtures.snapshot()
        let group=snapshot.groups[0]
        let groupEntries=snapshot.entries.filter{$0.groupID==group.id}
        let exported=LedgerCSV.export(groupEntries,group:group)
        XCTAssertEqual(try LedgerCSV.parse(exported,defaultCurrency:"ARS").count,groupEntries.count)
        let payer=try XCTUnwrap(group.members.first)
        let posted=Exchange(target:"ARS",rateE8:175_000_000,date:"2025-01-10",source:"Statement",statementAmount:1_750)
        let charge=LedgerEntry(groupID:group.id,title:"Card charge",amount:1_000,currency:"USD",paidBy:payer.id,
            splits:[Portion(memberID:payer.id,amount:1_000)],exchange:posted,createdAt:"2025-01-10T12:00:00Z")
        let postedCSV=LedgerCSV.export([charge],group:group)
        XCTAssertEqual(try LedgerCSV.parse(postedCSV,defaultCurrency:"ARS").first?.exchange,posted)
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
    func testNightsSplitAndDailyCosts() throws {
        let people = ["alex", "maya", "harris", "sam"]
        let values = ["alex": "3", "maya": "3", "harris": "3", "sam": "4"]
        let splits = try Ledger.split(total: 109_462, people: people, mode: .nights, values: values)
        XCTAssertEqual(splits.map(\.amount), [25_261, 25_260, 25_260, 33_681])
        let stay = LedgerEntry(groupID: "trip", title: "Airbnb", amount: 109_462, currency: "USD",
                               paidBy: "alex", splits: splits, splitMode: .shares,
                               spread: ExpenseSpread(start: "2026-11-12", end: "2026-11-16"))
        let dinner = LedgerEntry(groupID: "trip", title: "Dinner", amount: 3_100, currency: "USD",
                                 paidBy: "alex", splits: [Portion(memberID: "alex", amount: 3_100)],
                                 createdAt: "2026-11-12T20:00:00Z")
        let restored = try JSONDecoder().decode(LedgerEntry.self, from: JSONEncoder().encode(stay))
        XCTAssertEqual(restored, stay)
        let alex = DailyCost.report([restored, dinner], person: "alex") { _, member in member }
        let sam = DailyCost.report([restored, dinner], person: "sam") { _, member in member }
        XCTAssertEqual(alex.map(\.day), ["2026-11-14", "2026-11-13", "2026-11-12"])
        XCTAssertEqual(alex.map(\.amount), [8_420, 8_420, 11_521])
        XCTAssertEqual(sam.first?.day, "2026-11-15")
        XCTAssertEqual(sam.reduce(0) { $0 + $1.amount }, 33_681)
    }

    func testDatedStayUsesOnlyOccupiedNightsAfterStatementConversion() throws {
        let nights = ExpenseSpread(start: "2026-11-13", end: "2026-11-16")
        let entry = LedgerEntry(groupID: "trip", title: "Airbnb", amount: 10_000, currency: "EUR",
                                paidBy: "alex", splits: [Portion(memberID: "alex", amount: 10_000, nights: 3, stay: nights)],
                                exchange: Exchange(target: "USD", rateE8: 110_000_000, date: "2026-11-12",
                                                   source: "Statement", statementAmount: 11_002),
                                splitMode: .shares, spread: ExpenseSpread(start: "2026-11-12", end: "2026-11-16"))
        let converted = try XCTUnwrap(entry.exchange).converting(entry)
        let days = DailyCost.report([converted], person: "alex") { _, member in member }
        XCTAssertEqual(days.map(\.day), ["2026-11-15", "2026-11-14", "2026-11-13"])
        XCTAssertEqual(days.map(\.amount), [3_667, 3_667, 3_668])
        XCTAssertTrue(days.allSatisfy { $0.currency == "USD" })
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
        XCTAssertEqual(snapshot.memberships(user: me.userID, groupID: group.id, seatID: me.id).count, snapshot.groups.count)
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
