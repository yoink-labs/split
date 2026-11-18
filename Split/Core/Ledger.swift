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
    var simplify: Bool? = nil
    var archived: Bool? = nil
    var symbol: String { kind == "trip" ? "airplane" : kind == "home" ? "house.fill" : "person.2.fill" }
    var isFriend: Bool { kind == "friend" }
}
struct Portion: Codable, Equatable { var memberID: String; var amount: Int64 }
struct Payer: Codable, Equatable, Identifiable {
    var memberID: String
    var amount: Int64
    var id: String { memberID }
}
struct EntryComment: Codable, Identifiable, Equatable {
    var id: String
    var entryID: String
    var authorUserID: String
    var authorName: String
    var body: String
    var createdAt: String
    var mine: Bool
}
enum SplitMode: String, Codable, CaseIterable {
    case equal, exact, percent, shares, adjustment
    var title: String { switch self { case .equal: "Equally"; case .exact: "Amounts"; case .percent: "Percent"; case .shares: "Shares"; case .adjustment: "Adjustment" } }
    var shortTitle: String { switch self { case .equal: "Equally"; case .exact: "Unequally"; case .percent: "Percent"; case .shares: "Shares"; case .adjustment: "Adjust" } }
    var detail: String {
        switch self {
        case .equal: "Everyone in the split pays the same amount."
        case .exact: "Type each person’s exact share. The shares must add up to the total."
        case .percent: "Give each person a percentage. Percentages must add up to 100%."
        case .shares: "Use relative weights, like 2 shares for a couple and 1 for one person."
        case .adjustment: "Start from an equal split, then add or subtract an amount for each person."
        }
    }
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
    var payers: [Payer]? = nil
    var notes: String? = nil
    var commentCount: Int? = nil
    var likeCount: Int? = nil
    var likedByMe: Bool? = nil
    /// Payers in canonical form. Older entries paid by one person.
    var allPayers: [Payer] {
        if let payers, !payers.isEmpty { return payers }
        return [Payer(memberID: paidBy, amount: amount)]
    }
    var isSettlement: Bool { kind == "settlement" }
    var day: String { String(createdAt.prefix(10)) }
}
struct Transfer: Identifiable {
    var from: String; var to: String; var amount: Int64; var currency: String
    var id: String { from + to + currency }
}
struct Snapshot: Codable, Equatable { var groups: [ExpenseGroup] = []; var entries: [LedgerEntry] = [] }
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
    /// Parses a signed decimal, used by the adjustment split mode.
    static func parseSigned(_ text: String) -> Int64? {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: ".")
        guard clean.range(of: #"^-?\d{1,10}(\.\d{0,2})?$"#, options: .regularExpression) != nil,
              let number = Decimal(string: clean, locale: Locale(identifier: "en_US_POSIX")) else { return nil }
        let minor = NSDecimalNumber(decimal: number * 100).int64Value
        return abs(minor) <= maxAmount ? minor : nil
    }
    static func text(_ minor: Int64, _ currency: String) -> String {
        let formatter = NumberFormatter(); formatter.numberStyle = .currency
        formatter.currencyCode = currency; formatter.currencySymbol = currency + " "
        formatter.minimumFractionDigits = 2; formatter.maximumFractionDigits = 2
        return formatter.string(from: NSDecimalNumber(decimal: Decimal(minor) / 100)) ?? "\(currency) 0.00"
    }
    static func text(_ minor: Int64, _ currency: String, signed: Bool) -> String {
        guard signed, minor != 0 else { return text(minor, currency) }
        return (minor > 0 ? "+" : "−") + text(abs(minor), currency)
    }
    static func input(_ minor: Int64) -> String { String(format: "%.2f", Double(minor) / 100) }
    static func compactInput(_ minor: Int64) -> String {
        let value = Double(minor) / 100
        if abs(value) >= 1_000 { return String(format: "%.0f", value) }
        return String(format: "%.2f", value)
    }
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
        else if mode == .adjustment {
            var base = try allocate(total: total, weights: people.map { _ in 1 })
            let deltas = try people.map { id -> Int64 in
                let raw = values[id] ?? ""
                if raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return 0 }
                guard let value = Money.parseSigned(raw) else { throw LedgerError.invalid("Use a signed number with up to two decimal places for each adjustment.") }
                return value
            }
            guard deltas.reduce(0,+) == 0 else { throw LedgerError.invalid("Adjustments must add up to zero.") }
            for index in base.indices {
                base[index] += deltas[index]
                guard base[index] >= 0 else { throw LedgerError.invalid("An adjustment cannot take a share below zero.") }
            }
            guard base.reduce(0,+) == total else { throw LedgerError.invalid("Check the adjustments.") }
            amounts = base
        } else {
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
            for payer in e.allPayers { values[payer.memberID, default: 0] += payer.amount }
            for s in e.splits { values[s.memberID, default: 0] -= s.amount }
        }
        return values
    }
    static func paid(_ entry: LedgerEntry, by memberID: String) -> Int64 {
        entry.allPayers.filter { $0.memberID == memberID }.reduce(0) { $0 + $1.amount }
    }
    static func share(_ entry: LedgerEntry, of memberID: String) -> Int64 {
        entry.splits.filter { $0.memberID == memberID }.reduce(0) { $0 + $1.amount }
    }
    static func net(_ entry: LedgerEntry, for memberID: String) -> Int64 {
        paid(entry, by: memberID) - share(entry, of: memberID)
    }
    static func simplify(_ entries: [LedgerEntry], currency: String) -> [Transfer] {
        plan(balances(entries,currency:currency),currency:currency)
    }
}
