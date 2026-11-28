import Foundation

struct ChangeHistoryPage: Decodable {
    var events: [ChangeHistoryEvent]
    var next: Int?
}

struct ChangeHistoryEvent: Decodable, Identifiable {
    struct Change: Decodable {
        var before: HistoryValue?
        var after: HistoryValue?
    }

    var id: Int
    var actor: String?
    var actorName: String?
    var timestamp: String
    var type: String
    var entity: String
    var expense: String?
    var action: String
    var title: String?
    var reason: String?
    var currency: String?
    var chargedCurrency: String?
    var changes: [String: Change]

    var verb: String {
        switch action {
        case "add": "added"
        case "edit": "updated"
        case "delete": "deleted"
        case "restore": "restored"
        case "remove": "removed"
        case "rename": "renamed"
        case "record", "recurring": "recorded"
        case "approve": "approved"
        case "decline": "declined"
        case "cancel": "canceled"
        case "combine": "combined"
        case "undo-combine": "undid the combination of"
        case "claim": "changed the claims on"
        case "unclaim": "unclaimed items on"
        case "close": "closed"
        case "reopen": "reopened"
        case "pair": "paired"
        case "move": "moved"
        case "detach": "detached"
        case "link": "linked"
        case "unlink": "unlinked"
        case "resolve": "resolved"
        case "schedule": "updated the schedule for"
        default: "changed"
        }
    }

    static func label(_ field: String) -> String {
        switch field {
        case "paidBy": "Payer"
        case "splits": "Shares"
        case "splitMode": "Split method"
        case "createdAt": "Date"
        case "chargedAmount": "Charged amount"
        case "chargedCurrency": "Charged currency"
        case "bill": "Receipt items"
        default: field.replacing(/[A-Z]/) { " " + $0.output.lowercased() }.capitalized
        }
    }
}

enum HistoryValue: Decodable, CustomStringConvertible {
    case text(String)
    case integer(Int64)
    case flag(Bool)
    case list([HistoryValue])
    case object([String: HistoryValue])
    case none

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .none }
        else if let text = try? value.decode(String.self) { self = .text(text) }
        else if let integer = try? value.decode(Int64.self) { self = .integer(integer) }
        else if let flag = try? value.decode(Bool.self) { self = .flag(flag) }
        else if let list = try? value.decode([Self].self) { self = .list(list) }
        else { self = .object(try value.decode([String: Self].self)) }
    }

    var string: String? {
        if case .text(let value) = self { return value }
        return nil
    }

    var description: String {
        switch self {
        case .none: "None"
        case .text(let value): value
        case .integer(let value): String(value)
        case .flag(let value): value ? "Yes" : "No"
        case .list(let values): values.map(\.description).joined(separator: ", ")
        case .object(let fields): fields.keys.sorted().map { "\(ChangeHistoryEvent.label($0)) \(fields[$0]!)" }.joined(separator: ", ")
        }
    }
}
