import Foundation

struct Person: Codable, Identifiable, Equatable {
    var id: String = UUID().uuidString
    var groupID: String
    var userID: String?
    var name: String
    var email: String?
    var phone: String?
    var payment:[String:String]?
}
struct ExpenseGroup: Codable, Identifiable, Equatable {
    var id: String = UUID().uuidString
    var name: String
    var kind: String
    var currency: String
    var createdAt: String = ISO8601DateFormatter().string(from: Date())
    var defaultWeights:[String:Int]?
    var members: [Person]
    var symbol: String { kind == "trip" ? "airplane" : kind == "home" ? "house.fill" : "person.2.fill" }
}
struct Portion: Codable, Equatable { var memberID: String; var amount: Int64 }
enum SplitMode: String, Codable, CaseIterable {
    case equal, exact, percent, shares
    var title: String { switch self { case .equal: "Equally"; case .exact: "Amounts"; case .percent: "Percent"; case .shares: "Shares" } }
}
struct LedgerEntry: Codable, Identifiable, Equatable {
    var id: String = UUID().uuidString
    var groupID: String
    var title: String
    var amount: Int64
    var currency: String
    var paidBy: String
    var splits: [Portion]
    var exchange:Exchange?
    var category: String?
    var bill: ReceiptBill?
    var receiptIDs: [String]?
    var kind: String = "expense"
    var editable: Bool?
    var recurrence:String?
    var splitMode: SplitMode = .equal
    var createdAt: String = ISO8601DateFormatter().string(from: Date())
}
struct Transfer: Identifiable {
    var from: String; var to: String; var amount: Int64; var currency: String
    var id: String { from + to + currency }
}
struct Snapshot: Codable { var groups: [ExpenseGroup] = []; var entries: [LedgerEntry] = [] }
struct OutboxItem: Codable, Identifiable {
    var id: String
    var path: String
    var body: Data
}
struct DiskState: Codable { var snapshot = Snapshot(); var outbox: [OutboxItem] = [] }

enum LedgerError: LocalizedError {
    case invalid(String)
    var errorDescription: String? { if case .invalid(let message) = self { return message }; return nil }
}
enum Money {
    static let currencies = ["USD", "ARS", "EUR", "GBP", "BRL", "CAD", "AUD", "MXN"]
    static let maxAmount: Int64 = 100_000_000_000
    /// Accept the user's decimal separator, with no ambiguous grouping separators.
    static func parse(_ text: String) -> Int64? {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: ".")
        guard clean.range(of: #"^\d{1,10}(\.\d{0,2})?$"#, options: .regularExpression) != nil,
              let number = Decimal(string: clean, locale: Locale(identifier: "en_US_POSIX")) else { return nil }
        let minor = NSDecimalNumber(decimal: number * 100).int64Value
        return minor <= maxAmount ? minor : nil
    }
    static func text(_ minor: Int64, _ currency: String) -> String {
        let formatter = NumberFormatter(); formatter.numberStyle = .currency
        formatter.currencyCode = currency; formatter.currencySymbol = currency + " "
        formatter.minimumFractionDigits = 2; formatter.maximumFractionDigits = 2
        return formatter.string(from: NSDecimalNumber(decimal: Decimal(minor) / 100)) ?? "\(currency) 0.00"
    }
    static func input(_ minor: Int64) -> String { String(format: "%.2f", Double(minor) / 100) }
}
enum Ledger {
    /// Largest-remainder allocation preserves every cent and resolves ties in input order.
    static func allocate(total: Int64, weights: [Int64]) throws -> [Int64] {
        guard total > 0, total <= Money.maxAmount, !weights.isEmpty, weights.count <= 50,
              weights.allSatisfy({ $0 >= 0 && $0 <= Money.maxAmount }), weights.contains(where: { $0 > 0 }) else { throw LedgerError.invalid("Enter a positive amount and at least one participant.") }
        let sum = weights.reduce(Decimal(0)) { $0 + Decimal($1) }
        let raw = weights.map { Decimal(total) * Decimal($0) / sum }
        var amounts = raw.map { value -> Int64 in var x = value, rounded = Decimal(); NSDecimalRound(&rounded, &x, 0, .down); return NSDecimalNumber(decimal: rounded).int64Value }
        let order = raw.indices.sorted { a, b in
            let left = raw[a] - Decimal(amounts[a]), right = raw[b] - Decimal(amounts[b])
            return left == right ? a < b : left > right
        }
        let remainder = Int(total - amounts.reduce(0,+))
        guard remainder >= 0, remainder <= order.count else { throw LedgerError.invalid("Could not calculate this split.") }
        for i in 0..<remainder { amounts[order[i]] += 1 }
        return amounts
    }
    static func split(total: Int64, people: [String], mode: SplitMode, values: [String: String]) throws -> [Portion] {
        guard !people.isEmpty, Set(people).count == people.count, total > 0, total <= Money.maxAmount else { throw LedgerError.invalid("Choose participants and a valid amount.") }
        let amounts: [Int64]
        if mode == .equal { amounts = try allocate(total: total, weights: people.map { _ in 1 }) }
        else {
            let inputs = try people.map { id -> Int64 in
                guard let value = Money.parse(values[id] ?? "0") else { throw LedgerError.invalid("Use a number with up to two decimal places for each person.") }; return value
            }
            if mode == .exact {
                guard inputs.reduce(0,+) == total else { throw LedgerError.invalid("Individual amounts must add up to \(Money.input(total)).") }; amounts = inputs
            } else {
                if mode == .percent && inputs.reduce(0,+) != 10_000 { throw LedgerError.invalid("Percentages must add up to 100%.") }
                amounts = try allocate(total: total, weights: inputs)
            }
        }
        return zip(people, amounts).map { Portion(memberID: $0, amount: $1) }
    }
    static func balances(_ entries: [LedgerEntry], currency: String) -> [String:Int64] {
        var values: [String:Int64] = [:]
        for e in entries.map(\.settling) where e.currency == currency {
            values[e.paidBy, default: 0] += e.amount
            for s in e.splits { values[s.memberID, default: 0] -= s.amount }
        }
        return values
    }
    static func simplify(_ entries: [LedgerEntry], currency: String) -> [Transfer] {
        plan(balances(entries,currency:currency),currency:currency)
    }
}
