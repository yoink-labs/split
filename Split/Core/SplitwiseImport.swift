import Foundation
import CryptoKit

/// One group from Splitwise's per-group "Export as spreadsheet" CSV.
///
/// The export has a `Date, Description, Category, Cost, Currency` header followed by one
/// column per member holding that member's net effect (paid minus owed). Settle-ups use the
/// `Payment` category. The file ends with one `Total balance` row per currency.
struct SplitwiseGroup: Identifiable, Equatable {
    var id: String { fingerprint }
    /// Group name derived from the file name. Editable in the preview.
    var name: String
    var members: [String]
    var rows: [CSVExpense]
    /// Splitwise's own `Total balance` rows: currency → member → minor units.
    var totals: [String: [String: Int64]]
    /// Rows Split leaves out, with the reason (no balance effect, unsupported currency).
    var skipped: [String]
    /// SHA-256 of the file text. Re-importing the same file is detected by this.
    var fingerprint: String

    var currencies: [String] { Array(Set(rows.map(\.currency))).sorted() }
    var expenseCount: Int { rows.filter { !$0.payment }.count }
    var paymentCount: Int { rows.filter(\.payment).count }
    /// The currency most rows use, a sensible group currency.
    var mainCurrency: String {
        var counts: [String: Int] = [:]
        for row in rows { counts[row.currency, default: 0] += 1 }
        let ranked = counts.sorted { left, right in left.value == right.value ? left.key < right.key : left.value > right.value }
        return ranked.first?.key ?? "USD"
    }

    /// Net per member per currency after import, computed from the rows Split will create.
    var importedBalances: [String: [String: Int64]] {
        var result: [String: [String: Int64]] = [:]
        for row in rows {
            for payer in row.allPayers { result[row.currency, default: [:]][payer.name, default: 0] += payer.amount }
            for share in row.splits { result[row.currency, default: [:]][share.name, default: 0] -= share.amount }
        }
        return result
    }

    struct Mismatch: Equatable { var currency: String; var member: String; var expected: Int64; var imported: Int64 }

    /// Compares imported balances with Splitwise's `Total balance` rows. Empty means they match to the cent.
    var mismatches: [Mismatch] {
        let imported = importedBalances
        var result: [Mismatch] = []
        for currency in Set(totals.keys).union(imported.keys).sorted() {
            guard Money.currencies.contains(currency) else { continue }
            let expected = totals[currency] ?? [:], actual = imported[currency] ?? [:]
            for member in members {
                let e = expected[member] ?? 0, a = actual[member] ?? 0
                if e != a { result.append(Mismatch(currency: currency, member: member, expected: e, imported: a)) }
            }
        }
        return result
    }
    var reconciled: Bool { !totals.isEmpty && mismatches.isEmpty }
}

extension CSVExpense {
    var allPayers: [CSVShare] { payers?.isEmpty == false ? payers! : [CSVShare(name: payer, amount: amount)] }
}

enum SplitwiseCSV {
    static let maxRows = 1500

    /// True when the text looks like a Splitwise group export.
    static func detect(_ raw: String) -> Bool {
        guard let rows = try? LedgerCSV.table(raw) else { return false }
        return rows.prefix(5).contains { headerIndex($0) != nil }
    }

    private static func key(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    // Splitwise translates the header, categories and the total label into the account language,
    // so columns are matched by position and rows by shape. These lists only add confidence.
    static let paymentWords: Set<String> = ["payment", "zahlung", "pago", "paiement", "pagamento", "betaling", "betalning", "płatność", "platba", "платеж", "ödeme"]
    static let totalWords: Set<String> = ["total balance", "gesamtbilanz", "saldo total", "solde total", "saldo totale", "totaal saldo", "saldo całkowite", "общий баланс"]
    static let generalWords: Set<String> = ["general", "allgemein", "général", "generale", "geral", "algemeen"]

    static let categories: [String: String] = ["dining out": "Dining", "groceries": "Groceries", "liquor": "Liquor", "rent": "Rent", "mortgage": "Rent", "household supplies": "Home", "furniture": "Home", "maintenance": "Home", "pets": "Home", "services": "Home", "electronics": "Home", "home - other": "Home", "electricity": "Utilities", "heat/gas": "Utilities", "water": "Utilities", "tv/phone/internet": "Utilities", "trash": "Utilities", "cleaning": "Utilities", "utilities - other": "Utilities", "taxi": "Transport", "bus/train": "Transport", "car": "Transport", "gas/fuel": "Transport", "parking": "Transport", "bicycle": "Transport", "transportation - other": "Transport", "plane": "Travel", "hotel": "Travel", "movies": "Entertainment", "music": "Entertainment", "sports": "Entertainment", "games": "Entertainment", "entertainment - other": "Entertainment", "clothing": "Shopping", "gifts": "Gifts", "medical expenses": "Health", "education": "Education", "childcare": "Education", "insurance": "Fees", "taxes": "Fees", "food and drink - other": "Dining", "life - other": "Other", "other": "Other", "entertainment": "Entertainment"]
    /// Splitwise's English category names mapped onto Split's; anything else keeps its own name.
    static func category(_ name: String) -> String { categories[key(name)] ?? String(name.prefix(50)) }

    /// The header is the first row with 6+ cells whose first cell isn't a date and fourth isn't an amount.
    private static func headerIndex(_ row: [String]) -> Int? {
        guard row.count >= 6, row.prefix(5).allSatisfy({ !$0.trimmingCharacters(in: .whitespaces).isEmpty }),
              day(row[0]) == nil, amount(row[3]) == nil else { return nil }
        return 5
    }

    /// "buenos-aires-trip_2026-11-18_export.csv" → "Buenos Aires Trip".
    static func groupName(fromFile file: String) -> String {
        var name = (file as NSString).deletingPathExtension
        if let range = name.range(of: #"_\d{4}-\d{2}-\d{2}_export$"#, options: .regularExpression) { name.removeSubrange(range) }
        name = name.replacingOccurrences(of: #"[-_]+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        if name.isEmpty { return "Splitwise group" }
        if name == name.lowercased() { name = name.capitalized }
        return String(name.prefix(80))
    }

    /// Signed decimal with up to two places. Splitwise writes plain `12.50` / `-4.17`.
    static func amount(_ text: String) -> Int64? {
        var clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.isEmpty { return 0 }
        let negative = clean.hasPrefix("-")
        if negative || clean.hasPrefix("+") { clean.removeFirst() }
        guard clean.range(of: #"^\d{1,10}(\.\d{1,2})?$"#, options: .regularExpression) != nil,
              let value = Decimal(string: clean, locale: Locale(identifier: "en_US_POSIX")) else { return nil }
        let minor = NSDecimalNumber(decimal: value * 100).int64Value
        guard minor <= Money.maxAmount else { return nil }
        return negative ? -minor : minor
    }

    static func day(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let iso = String(trimmed.prefix(10))
        func valid(_ d: String) -> Bool {
            guard d.range(of: #"^\d{4}-\d\d-\d\d$"#, options: .regularExpression) != nil,
                  let date = ISO8601DateFormatter().date(from: d + "T12:00:00Z") else { return false }
            return String(ISO8601DateFormatter().string(from: date).prefix(10)) == d
        }
        if valid(iso) { return iso }
        // Some spreadsheet round-trips rewrite dates as M/D/YYYY.
        let parts = trimmed.split(separator: "/").map(String.init)
        if parts.count == 3, parts[2].count == 2 || parts[2].count == 4, let m = Int(parts[0]), let d = Int(parts[1]), let year = Int(parts[2]) {
            let y = parts[2].count == 2 ? 2000 + year : year
            let candidate = String(format: "%04d-%02d-%02d", y, m, d)
            if valid(candidate) { return candidate }
        }
        return nil
    }

    /// Byte-order mark and line endings removed, so iOS and the web agree on a file's fingerprint.
    static func normalized(_ raw: String) -> String {
        var text = raw.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        if text.hasPrefix("\u{feff}") { text.removeFirst() }
        return text
    }

    static func fingerprint(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// Parses a Splitwise group export. Throws with the row number when a row can't be read.
    static func parse(_ raw: String, fileName: String) throws -> SplitwiseGroup {
        let rows = try LedgerCSV.table(raw)
        guard let start = rows.firstIndex(where: { headerIndex($0) != nil }) else {
            throw LedgerError.invalid("\(fileName) isn’t a Splitwise export. In Splitwise, open the group, then Settings → Export as spreadsheet.")
        }
        let header = rows[start]
        var memberColumns: [(Int, String)] = []
        for i in 5..<header.count {
            let name = header[i].trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty { memberColumns.append((i, String(name.prefix(60)))) }
        }
        guard !memberColumns.isEmpty, memberColumns.count <= 50 else { throw LedgerError.invalid("\(fileName) needs 1–50 member columns.") }
        guard Set(memberColumns.map { key($0.1) }).count == memberColumns.count else {
            throw LedgerError.invalid("Two people in \(fileName) share a name. Rename one in Splitwise and export again.")
        }
        var expenses: [CSVExpense] = [], totals: [String: [String: Int64]] = [:], skipped: [String] = []
        for (offset, row) in rows.dropFirst(start + 1).enumerated() {
            let line = start + offset + 2
            func cell(_ i: Int) -> String { i < row.count ? row[i].trimmingCharacters(in: .whitespacesAndNewlines) : "" }
            if row.allSatisfy({ $0.trimmingCharacters(in: .whitespaces).isEmpty }) { continue }
            let invalid = LedgerError.invalid("Check row \(line) of \(fileName).")
            let title = cell(1), currency = cell(4).uppercased()
            var nets: [(String, Int64)] = []
            for (i, name) in memberColumns {
                guard let value = amount(cell(i)) else { throw invalid }
                nets.append((name, value))
            }
            if totalWords.contains(key(title)) || (cell(2).isEmpty && cell(3).isEmpty && !currency.isEmpty) {
                guard !currency.isEmpty else { throw invalid }
                var line: [String: Int64] = [:]
                for (name, value) in nets { line[name] = value }
                totals[currency] = line
                continue
            }
            guard let date = day(cell(0)), !title.isEmpty, let cost = amount(cell(3)) else { throw invalid }
            guard Money.currencies.contains(currency) else {
                skipped.append("\(title) (\(currency.isEmpty ? "no currency" : currency) isn’t supported yet)")
                continue
            }
            let positive = nets.filter { $0.1 > 0 }, negative = nets.filter { $0.1 < 0 }
            let credit = positive.reduce(Int64(0)) { $0 + $1.1 }, debit = negative.reduce(Int64(0)) { $0 - $1.1 }
            guard credit == debit else { throw LedgerError.invalid("Row \(line) of \(fileName) doesn’t balance.") }
            if credit == 0 {
                skipped.append("\(title) (no effect on balances)")
                continue
            }
            let clean = String(title.prefix(120))
            let category = cell(2)
            let isPayment = paymentWords.contains(key(category)) && positive.count == 1 && negative.count == 1
            if isPayment {
                expenses.append(CSVExpense(title: clean, day: date, payer: positive[0].0, amount: credit, currency: currency, category: nil, payment: true,
                                           splits: [CSVShare(name: negative[0].0, amount: credit)], sourceID: nil, sourceGroup: nil, exchange: nil))
                continue
            }
            // Cost is what was spent; the nets only say who is up or down. People with a positive
            // net paid; any remaining cost is the payers' own share.
            let total = max(abs(cost), credit)
            let extra = total - credit
            let ownShares = try positive.count == 1 ? [extra] : (extra == 0 ? positive.map { _ in Int64(0) } : Ledger.allocate(total: extra, weights: positive.map(\.1)))
            var splits: [CSVShare] = [], payers: [CSVShare] = []
            for (index, (name, net)) in positive.enumerated() {
                payers.append(CSVShare(name: name, amount: net + ownShares[index]))
                if ownShares[index] > 0 { splits.append(CSVShare(name: name, amount: ownShares[index])) }
            }
            for (name, net) in negative { splits.append(CSVShare(name: name, amount: -net)) }
            let order = memberColumns.map(\.1)
            splits.sort { (order.firstIndex(of: $0.name) ?? 0) < (order.firstIndex(of: $1.name) ?? 0) }
            let categoryName = category.isEmpty || generalWords.contains(key(category)) ? nil : SplitwiseCSV.category(category)
            expenses.append(CSVExpense(title: clean, day: date, payer: payers[0].name, amount: total, currency: currency, category: categoryName, payment: false,
                                       splits: splits, sourceID: nil, sourceGroup: nil, exchange: nil, payers: payers.count > 1 ? payers : nil))
        }
        guard !expenses.isEmpty else { throw LedgerError.invalid("\(fileName) has no expenses to import.") }
        guard expenses.count <= maxRows else { throw LedgerError.invalid("\(fileName) has \(expenses.count) entries. Split imports up to \(maxRows) per group.") }
        return SplitwiseGroup(name: groupName(fromFile: fileName), members: memberColumns.map(\.1), rows: expenses, totals: totals, skipped: skipped, fingerprint: fingerprint(normalized(raw)))
    }
}

/// How one Splitwise name lands in Split.
enum MemberMapping: Hashable {
    case me
    case member(String)
    case placeholder
}

struct SplitwiseImportRequest: Encodable {
    struct NewGroup: Encodable { var id: String; var name: String; var kind: String; var currency: String }
    struct PersonMap: Encodable { var name: String; var memberID: String?; var me: Bool? }
    var group: NewGroup?
    var groupID: String?
    var people: [PersonMap]
    var rows: [CSVExpense]

    /// A stable group id for this file and account, so importing the same export twice is detected.
    static func groupID(fingerprint: String, userID: String) -> String {
        "sw-" + String(SplitwiseCSV.fingerprint(userID + ":" + fingerprint).prefix(40))
    }

    static func make(_ parsed: SplitwiseGroup, name: String, currency: String, kind: String, target: ExpenseGroup?, mapping: [String: MemberMapping], userID: String) throws -> SplitwiseImportRequest {
        guard mapping.values.filter({ $0 == .me }).count <= 1 else { throw LedgerError.invalid("Choose yourself once.") }
        if target == nil, !mapping.values.contains(.me) { throw LedgerError.invalid("Choose which Splitwise name is you.") }
        let people = parsed.members.map { name -> PersonMap in
            switch mapping[name] ?? .placeholder {
            case .me: return PersonMap(name: name, memberID: nil, me: true)
            case .member(let id): return PersonMap(name: name, memberID: id, me: nil)
            case .placeholder: return PersonMap(name: name, memberID: nil, me: nil)
            }
        }
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let target {
            return SplitwiseImportRequest(group: nil, groupID: target.id, people: people, rows: parsed.rows)
        }
        guard !cleanName.isEmpty, cleanName.count <= 80 else { throw LedgerError.invalid("Name the group.") }
        return SplitwiseImportRequest(group: NewGroup(id: groupID(fingerprint: parsed.fingerprint, userID: userID), name: cleanName, kind: kind, currency: currency),
                                      groupID: nil, people: people, rows: parsed.rows)
    }
}
