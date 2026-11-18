import XCTest
@testable import Split

final class SplitwiseImportTests: XCTestCase {
    private func fixture(_ name: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("fixtures/splitwise").appendingPathComponent(name)
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testMultiCurrencyGroupReconcilesToTheCent() throws {
        let group = try SplitwiseCSV.parse(try fixture("buenos-aires-trip_2026-11-18_export.csv"), fileName: "buenos-aires-trip_2026-11-18_export.csv")
        XCTAssertEqual(group.name, "Buenos Aires Trip")
        XCTAssertEqual(group.members, ["Harris", "Maya", "Alex", "Sam"])
        XCTAssertEqual(group.rows.count, 7)
        XCTAssertEqual(group.expenseCount, 5)
        XCTAssertEqual(group.paymentCount, 2)
        XCTAssertEqual(group.currencies, ["ARS", "USD"])
        XCTAssertEqual(group.mainCurrency, "ARS")
        XCTAssertEqual(group.skipped, ["Souvenirs (Maya only) (no effect on balances)"])
        let dinner = group.rows[1]
        XCTAssertEqual(dinner.title, "Parrilla dinner, Don Julio")
        XCTAssertEqual(dinner.amount, 18_400_050)
        XCTAssertEqual(dinner.category, "Dining")
        XCTAssertEqual(dinner.splits.map(\.amount), [4_600_013, 4_600_012, 4_600_013, 4_600_012])
        XCTAssertEqual(group.rows[3].title, "Wine tasting \"Malbec flight\"")
        let asado = group.rows[4]
        XCTAssertEqual(asado.allPayers.map(\.name), ["Harris", "Alex"])
        XCTAssertEqual(asado.allPayers.reduce(0) { $0 + $1.amount }, 4_125_000)
        XCTAssertEqual(asado.splits.reduce(0) { $0 + $1.amount }, 4_125_000)
        XCTAssertTrue(group.reconciled)
        XCTAssertEqual(group.importedBalances["USD"], ["Harris": -2000, "Maya": -12000, "Alex": 26000, "Sam": -12000])
        XCTAssertEqual(group.totals["ARS"]?["Maya"], 11_285_455)
    }

    func testTranslatedNonASCIIFriendAndResavedFiles() throws {
        let piso = try SplitwiseCSV.parse(try fixture("piso-compartido_2026-11-18_export.csv"), fileName: "piso-compartido_2026-11-18_export.csv")
        XCTAssertEqual(piso.members, ["José Núñez", "Zoë Brontë", "Ana-María", "Søren"])
        XCTAssertEqual(piso.rows[1].title, "\"Big\" shop at Mercadoña, Calle Mayor")
        XCTAssertTrue(piso.reconciled)
        let german = try SplitwiseCSV.parse(try fixture("wg-kasse_2026-11-18_export.csv"), fileName: "wg-kasse_2026-11-18_export.csv")
        XCTAssertEqual(german.rows.map(\.payment), [false, false, false, true])
        XCTAssertNil(german.rows[1].category)
        XCTAssertTrue(german.reconciled)
        let friend = try SplitwiseCSV.parse(try fixture("friend-maya_2026-11-18_export.csv"), fileName: "friend-maya_2026-11-18_export.csv")
        XCTAssertEqual(friend.members, ["Alex", "Maya"])
        XCTAssertTrue(friend.reconciled)
        let excel = try SplitwiseCSV.parse(try fixture("excel-resaved.csv"), fileName: "excel-resaved.csv")
        XCTAssertEqual(excel.rows.map(\.day), ["2026-03-22", "2026-03-23"])
        XCTAssertTrue(excel.reconciled)
        XCTAssertTrue(SplitwiseCSV.detect(try fixture("wg-kasse_2026-11-18_export.csv")))
    }

    func testMismatchAndRejectedFiles() throws {
        let edited = try SplitwiseCSV.parse(try fixture("edited-totals_export.csv"), fileName: "edited-totals_export.csv")
        XCTAssertFalse(edited.reconciled)
        XCTAssertEqual(edited.mismatches, [
            SplitwiseGroup.Mismatch(currency: "USD", member: "Alex", expected: 25000, imported: 26000),
            SplitwiseGroup.Mismatch(currency: "USD", member: "Sam", expected: -11000, imported: -12000),
        ])
        XCTAssertThrowsError(try SplitwiseCSV.parse("Date,Title,Amount\n2026-01-01,x,1", fileName: "other.csv"))
        XCTAssertThrowsError(try SplitwiseCSV.parse("Date,Description,Category,Cost,Currency,A,B\n2026-01-01,x,General,1.00,USD,1.00,-0.50\n", fileName: "bad.csv"))
    }

    func testRequestMappingAndStableGroupID() throws {
        let group = try SplitwiseCSV.parse(try fixture("buenos-aires-trip_2026-11-18_export.csv"), fileName: "trip.csv")
        XCTAssertThrowsError(try SplitwiseImportRequest.make(group, name: "Trip", currency: "ARS", kind: "trip", target: nil, mapping: [:], userID: "u"))
        let request = try SplitwiseImportRequest.make(group, name: "Trip", currency: "ARS", kind: "trip", target: nil,
                                                      mapping: ["Harris": .me, "Maya": .placeholder], userID: "u")
        XCTAssertEqual(request.people.first { $0.name == "Harris" }?.me, true)
        XCTAssertEqual(request.group?.id, SplitwiseImportRequest.groupID(fingerprint: group.fingerprint, userID: "u"))
        XCTAssertNotEqual(request.group?.id, SplitwiseImportRequest.groupID(fingerprint: group.fingerprint, userID: "other"))
        // CRLF and a byte-order mark don't change the fingerprint, so iOS and the web agree.
        let raw = try fixture("buenos-aires-trip_2026-11-18_export.csv")
        XCTAssertEqual(SplitwiseCSV.fingerprint(SplitwiseCSV.normalized("\u{feff}" + raw.replacingOccurrences(of: "\n", with: "\r\n"))), group.fingerprint)
    }
}
