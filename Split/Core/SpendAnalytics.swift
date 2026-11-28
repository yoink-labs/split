import Foundation

/// Integer-cent aggregation behind the Analytics tab. A line-for-line port of
/// `web/src/analytics.ts` so both clients show the same totals, buckets,
/// percentages and drill-downs. No floating point touches an amount.
enum SpendAnalytics {
    enum Granularity: String, CaseIterable, Identifiable, Hashable {
        case day, week, month
        var id: String { rawValue }
        var noun: String { rawValue }
    }

    struct Filter: Equatable {
        /// Inclusive `YYYY-MM-DD` bounds; empty means open-ended.
        var from: String = ""
        var to: String = ""
        /// When set, only expenses this person paid for or shares in, measured by their share.
        var person: String? = nil
    }

    struct Row: Identifiable {
        var entry: LedgerEntry
        /// The expense converted to the home currency, or nil when no rate is available.
        var home: LedgerEntry?
        var day: String
        var category: String
        /// The measured amount in home cents (whole expense, or the person's share). Nil without a rate.
        var amount: Int64?
        /// The measured amount in the expense's own currency.
        var original: Int64
        var estimated: Bool
        var id: String { entry.groupID + "/" + entry.id }
    }

    struct Bucket: Identifiable, Equatable {
        var key: String
        var amount: Int64 = 0
        var count: Int = 0
        var parts: [String: Int64] = [:]
        var id: String { key }
    }

    struct CategoryTotal: Identifiable, Equatable {
        var id: String
        var amount: Int64
        var count: Int
        var percent: Int
    }

    struct PersonTotal: Identifiable, Equatable {
        var key: String
        var paid: Int64
        var share: Int64
        var net: Int64
        var count: Int
        var id: String { key }
    }

    struct CurrencyTotal: Identifiable, Equatable {
        var currency: String
        var original: Int64
        var home: Int64?
        var count: Int
        var percent: Int
        var id: String { currency }
    }

    struct Report {
        var rows: [Row]
        /// Rows with a home amount; every chart in the home currency uses only these.
        var priced: [Row]
        var excluded: Int
        var total: Int64
        var estimated: Bool
        var granularity: Granularity
        var buckets: [Bucket]
        var categories: [CategoryTotal]
        var people: [PersonTotal]
        var currencies: [CurrencyTotal]

        /// `Math.round(total / priced.length)` from the web, in integers.
        var average: Int64 { roundedDivision(total, Int64(priced.count)) }
        /// The dashed average line on the time chart.
        var bucketMean: Int64 {
            buckets.contains { $0.count > 0 } ? roundedDivision(total, Int64(buckets.count)) : 0
        }
        var busiest: Bucket? {
            buckets.filter { $0.count > 0 }.reduce(nil) { top, bucket in
                guard let top else { return bucket }
                return bucket.amount > top.amount ? bucket : top
            }
        }
    }

    enum Drill: Hashable {
        case bucket(String)
        case category(String)
        case person(String)
        case currency(String)

        var bucket: String? { if case .bucket(let key) = self { key } else { nil } }
        var category: String? { if case .category(let id) = self { id } else { nil } }
        var person: String? { if case .person(let key) = self { key } else { nil } }
        var currency: String? { if case .currency(let code) = self { code } else { nil } }
    }

    /// Identifies the person behind a member seat. Inside one group this is the
    /// member ID, exactly like the web; across groups it merges one person's seats.
    typealias PersonKey = (_ groupID: String, _ memberID: String) -> String

    static let memberKey: PersonKey = { _, memberID in memberID }

    // MARK: - Dates

    private static let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = utc
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static func date(_ day: String) -> Date? {
        dayFormatter.date(from: String(day.prefix(10)))
    }

    static func isoDay(_ date: Date) -> String { dayFormatter.string(from: date) }

    /// The date a bucket key starts on, for chart axes.
    static func bucketDate(_ key: String) -> Date? {
        date(key.count == 7 ? key + "-01" : key)
    }

    /// `day`, `week` or `month` for a span of days, so a chart stays readable at any range.
    static func autoGranularity(from: String, to: String) -> Granularity {
        guard let start = date(from), let end = date(to) else { return .month }
        let span = (utc.dateComponents([.day], from: start, to: end).day ?? 0) + 1
        return span <= 45 ? .day : span <= 210 ? .week : .month
    }

    /// The bucket a day falls in. Weeks start on Monday (UTC).
    static func bucketKey(_ day: String, _ granularity: Granularity) -> String {
        switch granularity {
        case .day: return String(day.prefix(10))
        case .month: return String(day.prefix(7))
        case .week:
            guard let value = date(day) else { return String(day.prefix(10)) }
            let weekday = (utc.component(.weekday, from: value) + 5) % 7
            return isoDay(utc.date(byAdding: .day, value: -weekday, to: value) ?? value)
        }
    }

    /// Every bucket key from `from` to `to`, inclusive, so empty periods still show as gaps.
    static func bucketRange(from: String, to: String, _ granularity: Granularity, limit: Int = 400) -> [String] {
        var keys: [String] = []
        if granularity == .month {
            let parts = from.prefix(7).split(separator: "-").compactMap { Int($0) }
            guard parts.count == 2 else { return [] }
            var year = parts[0], month = parts[1]
            let end = String(to.prefix(7))
            var key = String(from.prefix(7))
            while key <= end && keys.count < limit {
                keys.append(key)
                month += 1
                if month > 12 { month = 1; year += 1 }
                key = String(format: "%04d-%02d", year, month)
            }
            return keys
        }
        guard var current = date(bucketKey(from, granularity)), let last = date(bucketKey(to, granularity)) else { return [] }
        let step = granularity == .week ? 7 : 1
        while current <= last && keys.count < limit {
            keys.append(isoDay(current))
            current = utc.date(byAdding: .day, value: step, to: current) ?? last.addingTimeInterval(1)
        }
        return keys
    }

    // MARK: - Math

    /// Whole percentages that always add up to 100, by largest remainder.
    static func percents(_ amounts: [Int64]) -> [Int] {
        let total = amounts.reduce(Int64(0), +)
        guard total > 0 else { return amounts.map { _ in 0 } }
        let denominator = Decimal(total)
        var parts = amounts.enumerated().map { index, amount -> (index: Int, percent: Int, remainder: Decimal) in
            let scaled = Decimal(Swift.max(0, amount)) * 100
            var quotient = scaled / denominator
            var whole = Decimal()
            NSDecimalRound(&whole, &quotient, 0, .down)
            return (index, NSDecimalNumber(decimal: whole).intValue, scaled - whole * denominator)
        }
        var left = 100 - parts.reduce(0) { $0 + $1.percent }
        let order = parts.indices.sorted { a, b in
            parts[a].remainder == parts[b].remainder ? parts[a].index < parts[b].index : parts[a].remainder > parts[b].remainder
        }
        for position in order where left > 0 {
            parts[position].percent += 1
            left -= 1
        }
        return parts.map(\.percent)
    }

    /// `Math.round(a / b)` for non-negative totals, without floating point.
    static func roundedDivision(_ value: Int64, _ divisor: Int64) -> Int64 {
        guard divisor > 0 else { return 0 }
        let quotient = value / divisor, remainder = value % divisor
        if remainder >= 0 { return quotient + (remainder * 2 >= divisor ? 1 : 0) }
        return quotient - (-remainder * 2 > divisor ? 1 : 0)
    }

    /// The web's category normalization (`categoryMeta(name).id`), so a
    /// category lands in the same bucket on every client.
    static func categoryID(_ name: String?) -> String {
        guard let name, !name.isEmpty else { return "Other" }
        let lower = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        for category in AnalyticsCategory.web {
            if category.id.lowercased() == lower || category.label.lowercased() == lower { return category.id }
            switch category.id {
            case "Dining" where lower.contains("food"): return category.id
            case "Lodging" where lower.contains("hotel"): return category.id
            case "Rent & Utilities" where lower.contains("rent") || lower.contains("util"): return category.id
            case "Drinks" where lower.contains("coffee"): return category.id
            case "Transport" where lower.contains("taxi") || lower.contains("uber"): return category.id
            default: continue
            }
        }
        return name
    }

    private static func portion<S: Sequence>(_ parts: S, _ person: String, groupID: String, key: PersonKey) -> Int64
    where S.Element == (memberID: String, amount: Int64) {
        parts.reduce(Int64(0)) { $0 + (key(groupID, $1.memberID) == person ? $1.amount : 0) }
    }

    private static func shares(_ entry: LedgerEntry) -> [(memberID: String, amount: Int64)] {
        entry.splits.map { ($0.memberID, $0.amount) }
    }

    private static func payers(_ entry: LedgerEntry) -> [(memberID: String, amount: Int64)] {
        entry.allPayers.map { ($0.memberID, $0.amount) }
    }

    static func paid(_ entry: LedgerEntry, by person: String, key: PersonKey = memberKey) -> Int64 {
        portion(payers(entry), person, groupID: entry.groupID, key: key)
    }

    static func share(_ entry: LedgerEntry, of person: String, key: PersonKey = memberKey) -> Int64 {
        portion(shares(entry), person, groupID: entry.groupID, key: key)
    }

    // MARK: - Report

    /// The rows an analytics view covers: expenses and refunds (negative, so spending is net of
    /// refunds), inside the date range, involving the person.
    static func rows(_ entries: [LedgerEntry], project: (LedgerEntry) -> LedgerEntry?, home: String,
                     filter: Filter, key: PersonKey = memberKey) -> [Row] {
        var rows: [Row] = []
        for entry in entries where entry.isSpending {
            let day = entry.day
            if !filter.from.isEmpty && day < filter.from { continue }
            if !filter.to.isEmpty && day > filter.to { continue }
            let person = filter.person
            if let person,
               !entry.splits.contains(where: { key(entry.groupID, $0.memberID) == person && $0.amount > 0 }),
               !entry.allPayers.contains(where: { key(entry.groupID, $0.memberID) == person && $0.amount > 0 }) { continue }
            let projected = project(entry)
            let direction = entry.sign
            let amount = projected.map { projected in direction * (person.map { share(projected, of: $0, key: key) } ?? projected.amount) }
            rows.append(Row(
                entry: entry, home: projected, day: day, category: categoryID(entry.category),
                amount: amount, original: direction * (person.map { share(entry, of: $0, key: key) } ?? entry.amount),
                estimated: entry.currency != home
            ))
        }
        return rows
    }

    static func analyze(_ entries: [LedgerEntry], project: (LedgerEntry) -> LedgerEntry?, home: String,
                        filter: Filter, people: [String], granularity: Granularity? = nil,
                        key: PersonKey = memberKey) -> Report {
        let rows = rows(entries, project: project, home: home, filter: filter, key: key)
        let priced = rows.filter { $0.amount != nil }
        let total = priced.reduce(Int64(0)) { $0 + ($1.amount ?? 0) }
        let days = rows.map(\.day).sorted()
        let from = filter.from.isEmpty ? days.first ?? "" : filter.from
        let to = filter.to.isEmpty ? days.last ?? "" : filter.to
        let grain = granularity ?? (!from.isEmpty && !to.isEmpty ? autoGranularity(from: from, to: to) : .month)

        var buckets: [String: Bucket] = [:]
        if !from.isEmpty && !to.isEmpty {
            for bucket in bucketRange(from: from, to: to, grain) { buckets[bucket] = Bucket(key: bucket) }
        }
        for row in priced {
            let bucket = bucketKey(row.day, grain)
            buckets[bucket, default: Bucket(key: bucket)].amount += row.amount ?? 0
            buckets[bucket, default: Bucket(key: bucket)].count += 1
            buckets[bucket, default: Bucket(key: bucket)].parts[row.category, default: 0] += row.amount ?? 0
        }

        var byCategory: [String: (amount: Int64, count: Int)] = [:]
        for row in priced {
            byCategory[row.category, default: (0, 0)].amount += row.amount ?? 0
            byCategory[row.category, default: (0, 0)].count += 1
        }
        let categoryList = byCategory.map { (id: $0.key, amount: $0.value.amount, count: $0.value.count) }
            .sorted { $0.amount != $1.amount ? $0.amount > $1.amount : $0.id.localizedCompare($1.id) == .orderedAscending }
        let categoryPercents = percents(categoryList.map { Swift.max(0, $0.amount) })

        let personTotals = (filter.person.map { [$0] } ?? people).map { person -> PersonTotal in
            var paid: Int64 = 0, share: Int64 = 0, count = 0
            for row in priced {
                guard let home = row.home else { continue }
                let p = row.entry.sign * Self.paid(home, by: person, key: key)
                let s = row.entry.sign * Self.share(home, of: person, key: key)
                paid += p
                share += s
                if p != 0 || s != 0 { count += 1 }
            }
            return PersonTotal(key: person, paid: paid, share: share, net: paid - share, count: count)
        }.filter { $0.count > 0 }

        var byCurrency: [String: (original: Int64, home: Int64?, count: Int)] = [:]
        for row in rows {
            var current = byCurrency[row.entry.currency] ?? (0, 0, 0)
            current.original += row.original
            if let home = current.home, let amount = row.amount { current.home = home + amount } else { current.home = nil }
            current.count += 1
            byCurrency[row.entry.currency] = current
        }
        let currencyList = byCurrency.map { (currency: $0.key, original: $0.value.original, home: $0.value.home, count: $0.value.count) }
            .sorted { ($0.home ?? -1) != ($1.home ?? -1) ? ($0.home ?? -1) > ($1.home ?? -1) : $0.currency.localizedCompare($1.currency) == .orderedAscending }
        let currencyPercents = percents(currencyList.map { Swift.max(0, $0.home ?? 0) })

        return Report(
            rows: rows, priced: priced, excluded: rows.count - priced.count, total: total,
            estimated: priced.contains { $0.estimated },
            granularity: grain,
            buckets: buckets.values.sorted { $0.key < $1.key },
            categories: categoryList.enumerated().map { CategoryTotal(id: $1.id, amount: $1.amount, count: $1.count, percent: categoryPercents[$0]) },
            people: personTotals,
            currencies: currencyList.enumerated().map { CurrencyTotal(currency: $1.currency, original: $1.original, home: $1.home, count: $1.count, percent: currencyPercents[$0]) }
        )
    }

    /// Rows behind one chart segment, for the drill-down list.
    static func drillRows(_ report: Report, _ drill: Drill?, key: PersonKey = memberKey) -> [Row] {
        guard let drill else { return report.rows }
        switch drill {
        case .bucket(let bucket): return report.priced.filter { bucketKey($0.day, report.granularity) == bucket }
        case .category(let id): return report.priced.filter { $0.category == id }
        case .currency(let currency): return report.rows.filter { $0.entry.currency == currency }
        case .person(let person): return report.priced.filter { row in
            guard let home = row.home else { return false }
            return paid(home, by: person, key: key) > 0 || share(home, of: person, key: key) > 0
        }
        }
    }

    // MARK: - Date ranges

    enum Range: String, CaseIterable, Identifiable, Hashable {
        case all, trip, days30, days90, months12, custom
        var id: String { rawValue }
        var title: String {
            switch self {
            case .all: "All time"
            case .trip: "Trip dates"
            case .days30: "30 days"
            case .days90: "90 days"
            case .months12: "12 months"
            case .custom: "Custom"
            }
        }
    }

    /// The web's `rangeBounds`: rolling windows end today (UTC); a custom range is put in order.
    static func bounds(_ range: Range, group: ExpenseGroup?, custom: (from: String, to: String), now: Date = Date()) -> (from: String, to: String) {
        let today = isoDay(now)
        func back(_ days: Int) -> String { isoDay(now.addingTimeInterval(-Double(days) * 86_400)) }
        switch range {
        case .all: return ("", "")
        case .trip: return (group?.startDate ?? "", group?.endDate ?? "")
        case .days30: return (back(29), today)
        case .days90: return (back(89), today)
        case .months12: return (back(364), today)
        case .custom:
            if !custom.from.isEmpty && !custom.to.isEmpty && custom.from > custom.to { return (custom.to, custom.from) }
            return custom
        }
    }
}
