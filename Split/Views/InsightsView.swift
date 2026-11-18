import SwiftUI
import Charts

/// Free spending insights for one group or every group at once.
struct InsightsView: View {
    var group: ExpenseGroup? = nil
    var initialCurrency: String? = nil

    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var size
    @State private var pickedCurrency: String?

    init(group: ExpenseGroup? = nil, initialCurrency: String? = nil) {
        self.group = group
        self.initialCurrency = initialCurrency
    }

    private struct DayTotal: Identifiable, Equatable {
        var day: Int
        var amount: Int64
        var id: Int { day }
    }

    private struct MemberTotal: Identifiable {
        var id: String
        var name: String
        var paid: Int64
        var share: Int64
        var net: Int64
    }

    private static let dayParser: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private var scopeEntries: [LedgerEntry] {
        if let group { return store.entries(in: group) }
        let active = Set(store.groups.filter { !($0.archived ?? false) }.map(\.id))
        return store.entries.filter { active.contains($0.groupID) }
    }

    private var availableCurrencies: [String] {
        var values = Set(scopeEntries.map(\.settling.currency))
        if let group {
            values.insert(group.currency)
        } else {
            for group in store.groups where !(group.archived ?? false) { values.insert(group.currency) }
        }
        return values.sorted()
    }

    private var currency: String {
        if let pickedCurrency, availableCurrencies.contains(pickedCurrency) { return pickedCurrency }
        if let initialCurrency, availableCurrencies.contains(initialCurrency) { return initialCurrency }
        if let group, currenciesWithData.contains(group.currency) { return group.currency }
        if let first = currenciesWithData.first { return first }
        if let group, availableCurrencies.contains(group.currency) { return group.currency }
        return availableCurrencies.first ?? group?.currency ?? "USD"
    }

    private var currenciesWithData: [String] {
        availableCurrencies.filter { Analytics.monthlyTotal(scopeEntries, currency: $0) > 0 }
    }

    private var currencyBinding: Binding<String> {
        Binding(get: { currency }, set: { pickedCurrency = $0 })
    }

    private var monthly: [MonthTotal] {
        Analytics.monthly(scopeEntries, currency: currency)
    }

    private var categories: [CategoryTotal] {
        Analytics.categories(scopeEntries, currency: currency)
    }

    private var total: Int64 {
        Analytics.monthlyTotal(scopeEntries, currency: currency)
    }

    private var expenseCount: Int {
        scopeEntries.map(\.settling).filter { $0.currency == currency && $0.kind == "expense" }.count
    }

    private var categoryTotal: Int64 {
        categories.reduce(0) { $0 + $1.amount }
    }

    private var memberTotals: [MemberTotal] {
        var rows: [String: MemberTotal] = [:]
        let groups = group.map { [$0] } ?? store.groups.filter { !($0.archived ?? false) }
        for scope in groups {
            let entries = group == nil ? store.entries(in: scope) : scopeEntries
            for row in Analytics.personSpend(scope, entries: entries, currency: currency, people: scope.members) {
                let key = Analytics.key(row.person)
                var combined = rows[key] ?? MemberTotal(id: key, name: row.person.name, paid: 0, share: 0, net: 0)
                combined.name = row.person.name
                combined.paid += row.paid
                combined.share += row.share
                combined.net += row.net
                rows[key] = combined
            }
        }
        return rows.values
            .filter { $0.paid != 0 || $0.share != 0 || $0.net != 0 }
            .sorted { left, right in
                if left.paid != right.paid { return left.paid > right.paid }
                return left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
            }
    }

    private var paidCeiling: Int64 {
        Swift.max(1, memberTotals.map(\.paid).max() ?? 1)
    }

    private var memberTableTotals: [MemberTotal] {
        guard let group else { return memberTotals }
        return Analytics.personSpend(group, entries: scopeEntries, currency: currency, people: group.members)
            .map { row in
                MemberTotal(
                    id: "\(Analytics.key(row.person))|\(row.person.id)",
                    name: row.person.name,
                    paid: row.paid,
                    share: row.share,
                    net: row.net
                )
            }
            .sorted { left, right in
                if left.paid != right.paid { return left.paid > right.paid }
                return left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
            }
    }

    private var hasData: Bool {
        expenseCount > 0 && total > 0
    }

    private var maxMonthly: Double {
        Swift.max(1, Double(monthly.map(\.amount).max() ?? 0) / 100)
    }

    private var daily: [DayTotal] {
        guard let month = monthly.first?.month else { return [] }
        var totals: [Int: Int64] = [:]
        for entry in scopeEntries.map(\.settling) where entry.currency == currency && entry.kind == "expense" && String(entry.createdAt.prefix(7)) == month {
            guard let day = Int(entry.createdAt.dropFirst(8).prefix(2)) else { continue }
            totals[day, default: 0] += entry.amount
        }
        return totals.keys.sorted().map { DayTotal(day: $0, amount: totals[$0] ?? 0) }
    }

    private var maxDaily: Double {
        Swift.max(1, Double(daily.map(\.amount).max() ?? 0) / 100)
    }

    private var dailyPeak: Int64 { daily.map(\.amount).max() ?? 0 }

    private var dailySubtitle: String {
        guard let month = monthly.first?.month,
              let date = Self.dayParser.date(from: month + "-01") else { return "Daily spending this month" }
        return "Daily spending in \(date.formatted(.dateTime.month(.wide).year()))"
    }

    private var largestCategory: CategoryTotal? { categories.first }
    private var averageExpense: Int64 { expenseCount > 0 ? total / Int64(expenseCount) : 0 }

    private var rangeLabel: String? {
        let days = scopeEntries
            .map(\.settling)
            .filter { $0.currency == currency && $0.kind == "expense" }
            .map(\.day)
            .sorted()
        guard let firstDay = days.first, let lastDay = days.last,
              let first = Self.dayParser.date(from: firstDay),
              let last = Self.dayParser.date(from: lastDay) else { return nil }
        if Calendar.current.isDate(first, equalTo: last, toGranularity: .month) {
            return last.formatted(.dateTime.month(.wide).year())
        }
        if Calendar.current.component(.year, from: first) == Calendar.current.component(.year, from: last) {
            return "\(first.formatted(.dateTime.month(.abbreviated))) – \(last.formatted(.dateTime.month(.abbreviated))) \(last.formatted(.dateTime.year()))"
        }
        return "\(first.formatted(.dateTime.month(.abbreviated).year())) – \(last.formatted(.dateTime.month(.abbreviated).year()))"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                if hasData {
                    hero
                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: 320), spacing: 14, alignment: .top)],
                        alignment: .leading,
                        spacing: 14
                    ) {
                        monthlyCard
                        categoryCard
                        memberCard
                        if group != nil {
                            memberTableCard
                        }
                    }
                } else {
                    Card {
                        EmptyPanel(
                            title: "No spending yet",
                            message: group == nil
                                ? "Add an expense to any group and its charts will appear here."
                                : "Add an expense in \(group?.name ?? "this group") and its charts will appear here.",
                            symbol: "chart.bar.xaxis"
                        )
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: 800)
            .frame(maxWidth: .infinity)
        }
        .background(AppBackground())
        .ledgerDestinations()
        .navigationTitle("Insights")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(group?.name ?? "All groups")
                    .font(.splitDisplay(26))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
                    .minimumScaleFactor(0.7)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            currencyPicker
        }
    }

    private var subtitle: String {
        guard let group else { return "Across every group and shared tab" }
        let count = group.members.count
        return "\(count) \(count == 1 ? "person" : "people") · \(group.kind == "trip" ? "Trip" : group.kind == "home" ? "Home" : group.isFriend ? "One-to-one tab" : "Group")"
    }

    private var currencyPicker: some View {
        Picker("Currency", selection: currencyBinding) {
            ForEach(availableCurrencies, id: \.self) { code in
                Text(code).tag(code)
            }
        }
        .pickerStyle(.menu)
        .labelsHidden()
        .disabled(availableCurrencies.count < 2)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(minHeight: 44)
        .background(Palette.raised)
        .clipShape(Capsule())
        .overlay(Capsule().stroke(Palette.line, lineWidth: 1))
        .accessibilityLabel("Insights currency")
        .accessibilityValue(currency)
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Total spent")
                        .font(.splitEyebrow)
                        .foregroundStyle(Palette.lime.opacity(0.72))
                    Text(Money.text(total, currency))
                        .font(.splitDisplay(36))
                        .foregroundStyle(Palette.lime)
                        .lineLimit(1)
                        .minimumScaleFactor(0.55)
                        .contentTransition(.numericText())
                    Text("\(expenseCount) \(expenseCount == 1 ? "expense" : "expenses")\(rangeLabel.map { " · \($0)" } ?? "")")
                        .font(.caption)
                        .foregroundStyle(Palette.paper.opacity(0.72))
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                if size == .regular, let largestCategory {
                    VStack(alignment: .trailing, spacing: 12) {
                        VStack(alignment: .trailing, spacing: 2) {
                            Text("Largest category").font(.splitEyebrow).foregroundStyle(Palette.lime.opacity(0.55))
                            Text(largestCategory.category).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.lime)
                            Text("\(Int((Double(largestCategory.amount) / Double(total) * 100).rounded()))% of spending")
                                .font(.caption2).foregroundStyle(Palette.paper.opacity(0.62))
                        }
                        VStack(alignment: .trailing, spacing: 2) {
                            Text("Average expense").font(.splitEyebrow).foregroundStyle(Palette.lime.opacity(0.55))
                            Text(Money.text(averageExpense, currency)).font(.splitAmount(15)).foregroundStyle(Palette.lime)
                        }
                    }
                } else {
                    Image(systemName: "chart.bar.xaxis")
                        .font(.system(size: 28, weight: .light))
                        .foregroundStyle(Palette.lime.opacity(0.42))
                        .accessibilityHidden(true)
                }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(LinearGradient(colors: [Palette.hero, Palette.hero.opacity(0.94)], startPoint: .topLeading, endPoint: .bottomTrailing))
        .clipShape(RoundedRectangle(cornerRadius: Radius.header))
        .overlay(RoundedRectangle(cornerRadius: Radius.header).stroke(Palette.lime.opacity(0.16), lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Total spent \(Money.text(total, currency)), \(expenseCount) expenses\(rangeLabel.map { ", \($0)" } ?? "")")
    }

    private var monthlyCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                let singleMonth = monthly.count == 1 && daily.count > 1
                SectionHeader(
                    title: singleMonth ? "By day" : "By month",
                    subtitle: singleMonth ? dailySubtitle : "The last six months with spending"
                )
                if monthly.isEmpty {
                    Text("No monthly spending in \(currency).")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else if singleMonth {
                    Chart(daily) { item in
                        BarMark(
                            x: .value("Day", item.day),
                            y: .value("Spent", Double(item.amount) / 100),
                            width: .fixed(7)
                        )
                        .foregroundStyle(Palette.evergreen)
                        .cornerRadius(3, style: .continuous)
                        .annotation(position: .top, spacing: 2) {
                            if item.amount == dailyPeak && item.amount > 0 {
                                Text(compact(item.amount))
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .accessibilityLabel("Day \(item.day)")
                        .accessibilityValue(Money.text(item.amount, currency))
                    }
                    .chartYScale(domain: 0...(maxDaily * 1.18))
                    .chartYAxis(.hidden)
                    .chartXScale(domain: 1...31)
                    .chartXAxis {
                        AxisMarks(values: [1, 8, 15, 22, 29]) { value in
                            AxisValueLabel {
                                if let day = value.as(Int.self) { Text("\(day)") }
                            }
                            .font(.caption2)
                        }
                    }
                    .frame(height: 190)
                    .animation(reduceMotion ? nil : .snappy(duration: 0.35), value: daily)
                    .accessibilityLabel("Daily spending chart")
                } else {
                    Chart(monthly) { item in
                        BarMark(
                            x: .value("Month", item.label),
                            y: .value("Spent", Double(item.amount) / 100),
                            width: .fixed(34)
                        )
                        .foregroundStyle(Palette.evergreen)
                        .cornerRadius(6, style: .continuous)
                        .annotation(position: .top, spacing: 3) {
                            Text(compact(item.amount))
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                        .accessibilityLabel(monthLabel(item.month))
                        .accessibilityValue(Money.text(item.amount, currency))
                    }
                    .chartYScale(domain: 0...(maxMonthly * 1.18))
                    .chartYAxis(.hidden)
                    .chartXAxis {
                        AxisMarks { AxisValueLabel().font(.caption) }
                    }
                    .frame(height: 190)
                    .animation(reduceMotion ? nil : .snappy(duration: 0.35), value: monthly)
                    .accessibilityLabel("Monthly spending chart")
                }
            }
        }
    }

    private var categoryCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                SectionHeader(
                    title: "By category",
                    subtitle: categoryTotal > 0 ? "Share of \(Money.text(categoryTotal, currency))" : "No categories yet"
                )
                if categories.isEmpty {
                    Text("Expenses will be grouped by category here.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(categories) { item in
                        categoryRow(item)
                    }
                }
            }
        }
    }

    private var memberCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                SectionHeader(
                    title: "Who paid",
                    subtitle: group == nil ? "Across every group" : "Before shares are applied"
                )
                if memberTotals.isEmpty {
                    Text("No member spending in \(currency).")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(memberTotals) { row in
                        memberRow(row)
                    }
                }
            }
        }
    }

    private var memberTableCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(title: "Member balances", subtitle: "Amounts in \(currency)")
                Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 9) {
                    GridRow {
                        Text("Member")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text("Paid")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .gridColumnAlignment(.trailing)
                        Text("Share")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .gridColumnAlignment(.trailing)
                        Text("Net")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .gridColumnAlignment(.trailing)
                    }
                    Divider().gridCellColumns(4)
                    ForEach(memberTableTotals) { row in
                        GridRow {
                            Text(row.name)
                                .font(.subheadline)
                                .lineLimit(1)
                            Text(Money.input(row.paid))
                                .font(.splitAmount(12))
                                .lineLimit(1)
                                .minimumScaleFactor(0.65)
                            Text(Money.input(row.share))
                                .font(.splitAmount(12))
                                .lineLimit(1)
                                .minimumScaleFactor(0.65)
                            Text(netText(row.net))
                                .font(.splitAmount(12))
                                .lineLimit(1)
                                .minimumScaleFactor(0.65)
                                .foregroundStyle(row.net == 0 ? Color.secondary : row.net > 0 ? Palette.positive : Palette.negative)
                        }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(row.name), paid \(Money.text(row.paid, currency)), share \(Money.text(row.share, currency)), net \(Money.text(row.net, currency, signed: true))")
                    }
                }
                Text("Paid and share count expenses only. Net includes payments recorded in this group.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private func categoryRow(_ item: CategoryTotal) -> some View {
        let fraction = categoryTotal > 0 ? Double(item.amount) / Double(categoryTotal) : 0
        let percent = Int((fraction * 100).rounded())
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 9) {
                CategoryBadge(category: item.category, size: 28)
                    .accessibilityHidden(true)
                Text(item.meta.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                Spacer(minLength: 6)
                Text(Money.text(item.amount, currency))
                    .font(.splitAmount(13))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Text("\(percent)%")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 36, alignment: .trailing)
            }
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Palette.raised)
                    Capsule()
                        .fill(item.meta.tint)
                        .frame(width: Swift.max(4, proxy.size.width * fraction))
                }
            }
            .frame(height: 7)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(item.meta.name), \(percent) percent, \(Money.text(item.amount, currency))")
    }

    private func memberRow(_ row: MemberTotal) -> some View {
        let fraction = paidCeiling > 0 ? Double(row.paid) / Double(paidCeiling) : 0
        return HStack(spacing: 10) {
            Avatar(name: row.name, size: 34)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(row.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Text(Money.text(row.paid, currency))
                        .font(.splitAmount(13))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                Text("Share \(Money.text(row.share, currency)) · Net \(Money.text(row.net, currency, signed: true))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Palette.raised)
                        Capsule()
                            .fill(Palette.evergreen.opacity(0.65))
                            .frame(width: Swift.max(3, proxy.size.width * fraction))
                    }
                }
                .frame(height: 5)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(row.name), paid \(Money.text(row.paid, currency)), share \(Money.text(row.share, currency)), net \(Money.text(row.net, currency, signed: true))")
    }

    private func compact(_ minor: Int64) -> String {
        let value = Double(minor) / 100
        if value >= 1_000_000 { return String(format: "%.1fM", value / 1_000_000) }
        if value >= 1_000 { return String(format: "%.0fk", value / 1_000) }
        return String(format: "%.0f", value)
    }

    private func netText(_ minor: Int64) -> String {
        guard minor != 0 else { return Money.input(0) }
        return (minor > 0 ? "+" : "−") + Money.input(abs(minor))
    }

    private func monthLabel(_ storage: String) -> String {
        guard let date = Self.dayParser.date(from: storage + "-01") else { return storage }
        return date.formatted(.dateTime.month(.wide).year())
    }
}
