import Foundation

struct ExpenseSpread: Codable, Equatable {
    var start: String
    var end: String

    private static let utc = TimeZone(secondsFromGMT: 0)!

    private static func calendar(in timeZone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    private static func date(_ day: String, in timeZone: TimeZone) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar(in: timeZone).date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    static func localDate(_ day: String) -> Date? {
        date(day, in: .current)
    }

    var dayCount: Int {
        guard let first = Self.date(start, in: Self.utc), let last = Self.date(end, in: Self.utc) else { return 0 }
        return Self.calendar(in: Self.utc).dateComponents([.day], from: first, to: last).day ?? 0
    }

    func days(count: Int) -> [String] {
        guard let first = Self.date(start, in: Self.utc), (1...366).contains(count) else { return [] }
        let calendar = Self.calendar(in: Self.utc)
        return (0..<count).compactMap { offset in
            calendar.date(byAdding: .day, value: offset, to: first)?
                .formatted(.iso8601.year().month().day().dateSeparator(.dash))
        }
    }
}

struct DailyCost: Identifiable {
    struct Line: Identifiable {
        var id: String
        var title: String
        var amount: Int64
    }

    var day: String
    var currency: String
    var amount: Int64 = 0
    var lines: [Line] = []
    var id: String { day + ":" + currency }

    static func report(_ entries: [LedgerEntry], person: String, key: (String, String) -> String) -> [Self] {
        var days: [String: Self] = [:]
        for entry in entries where entry.isSpending {
            for portion in entry.splits where key(entry.groupID, portion.memberID) == person {
                let dates: [String]
                if let spread = entry.spread, (1...366).contains(spread.dayCount) {
                    dates = spread.days(count: min(portion.nights ?? spread.dayCount, spread.dayCount))
                } else {
                    dates = [entry.day]
                }
                guard !dates.isEmpty else { continue }
                let count = Int64(dates.count)
                let unit = portion.amount / count
                let remainder = portion.amount % count
                for (index, day) in dates.enumerated() {
                    let amount = entry.sign * (unit + (Int64(index) < remainder ? 1 : 0))
                    let id = day + ":" + entry.currency
                    let initial = Self(day: day, currency: entry.currency)
                    days[id, default: initial].amount += amount
                    days[id, default: initial].lines.append(.init(id: entry.id + ":" + portion.memberID, title: entry.title, amount: amount))
                }
            }
        }
        return days.values.sorted { $0.day == $1.day ? $0.currency < $1.currency : $0.day > $1.day }
    }
}
