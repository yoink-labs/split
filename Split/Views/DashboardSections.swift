import SwiftUI

struct DashboardSections: View {
    var model: DashboardModel
    var inspect: (LedgerEntry) -> Void
    var create: () -> Void
    var loadComplete: Bool
    @EnvironmentObject private var fx: FXStore
    @Environment(\.horizontalSizeClass) private var size
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var grain: SpendAnalytics.Granularity = .week
    @State private var groupID = ""
    @State private var category = ""
    @State private var bucket: String?
    @State private var direction: Direction = .all
    @State private var limit = 12

    private enum Direction: String, CaseIterable, Identifiable {
        case all = "All transactions"
        case owed = "Owed to you"
        case owe = "You owe"
        var id: Self { self }
    }

    var body: some View {
        if !loadComplete && model.groups.isEmpty {
            ProgressView().frame(maxWidth: .infinity)
        } else if model.groups.isEmpty {
            Card { EmptyPanel(title: "Start a group", message: "Add a group to track your shared expenses.", symbol: "person.3", actionTitle: "New group", action: create) }
        } else {
            let report = SpendAnalytics.analyze(
                model.transactions.map(\.entry), project: fx.homeEntry, home: fx.home,
                filter: .init(person: "viewer"), people: [], granularity: grain,
                key: { group, member in model.seats[group] == member ? "viewer" : "" }
            )
            let format = AnalyticsFormat(home: fx.home, estimated: report.estimated)
            if size == .regular && !typeSize.isAccessibilitySize {
                HStack(alignment: .top, spacing: Spacing.m) {
                    spending(report, format: format).frame(maxWidth: .infinity)
                    rightColumn.frame(minWidth: 240, idealWidth: 300, maxWidth: 330)
                }
            } else {
                spending(report, format: format)
                rightColumn
            }
            transactionSection
        }
    }

    private func spending(_ report: SpendAnalytics.Report, format: AnalyticsFormat) -> some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            Card {
                VStack(alignment: .leading, spacing: Spacing.s) {
                    SectionHeader(title: "Your spending", subtitle: "All time · \(fx.home) · Net of refunds")
                    if report.estimated {
                        Text("≈ Includes currency conversions").font(.caption).foregroundStyle(.secondary)
                    }
                    if report.excluded > 0 {
                        Text("\(report.excluded) excluded without an exchange rate").font(.caption).foregroundStyle(.secondary)
                    }
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .top, spacing: Spacing.m) { spendingMetrics(report, format: format) }
                        VStack(alignment: .leading, spacing: Spacing.s) { spendingMetrics(report, format: format) }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !report.priced.isEmpty {
                SpendingTimeChart(report: report, format: format, grain: $grain, active: bucket) { key in
                    bucket = bucket == key ? nil : key
                    limit = 12
                }
                .onChange(of: grain) { bucket = nil }
                CategoryBreakdownCard(report: report, format: format, active: category.isEmpty ? nil : category) { id in
                    category = category == id ? "" : id
                    limit = 12
                }
                groupSpending(report, format: format)
            }
        }
    }

    @ViewBuilder private func spendingMetrics(_ report: SpendAnalytics.Report, format: AnalyticsFormat) -> some View {
        metric("You paid", format.money(report.people.first?.paid ?? 0))
        metric("Your share", format.money(report.total))
        metric("Paid minus share", format.money(report.people.first?.net ?? 0, signed: true))
    }

    private func metric(_ label: String, _ amount: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(amount).font(.subheadline.weight(.semibold).monospacedDigit()).foregroundStyle(Palette.ink)
        }
        .fixedSize(horizontal: true, vertical: false)
        .accessibilityElement(children: .combine)
    }

    private func groupSpending(_ report: SpendAnalytics.Report, format: AnalyticsFormat) -> some View {
        let amounts = report.priced.reduce(into: [String: Int64]()) { values, row in
            values[row.entry.groupID, default: 0] += row.amount ?? 0
        }
        let groups = model.groups.filter { amounts[$0.id] != nil }.sorted {
            amounts[$0.id, default: 0] > amounts[$1.id, default: 0]
        }
        return Card {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                SectionHeader(title: "By group")
                ForEach(groups) { summary in
                    Button {
                        groupID = groupID == summary.id ? "" : summary.id
                        limit = 12
                    } label: {
                        HStack {
                            Text(summary.group.name)
                            Spacer()
                            Text(format.money(amounts[summary.id, default: 0])).monospacedDigit()
                            if groupID == summary.id { Image(systemName: "checkmark").accessibilityHidden(true) }
                        }
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink)
                        .frame(minHeight: HitTarget.minimum)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(groupID == summary.id ? .isSelected : [])
                    if summary.id != groups.last?.id { Divider() }
                }
            }
        }
    }

    private var rightColumn: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            Card {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    SectionHeader(title: "Balances by person", subtitle: "Suggested payments across groups")
                    if model.people.isEmpty {
                        Text("Everyone is settled up.").font(.subheadline).foregroundStyle(.secondary)
                    }
                    ForEach(model.people) { person in
                        NavigationLink {
                            DashboardPersonDetail(name: person.name, personID: person.id)
                        } label: {
                            HStack(spacing: Spacing.s) {
                                Avatar(name: person.name, size: 32)
                                VStack(alignment: .leading, spacing: 3) {
                                    ForEach(person.currencies, id: \.self) { currency in
                                        let amount = person.amount(currency)
                                        Text(amount < 0 ? "You owe \(person.name)" : amount > 0 ? "\(person.name) owes you" : person.name)
                                            .font(.subheadline.weight(.semibold))
                                        Text(amount == 0 ? "Net zero in \(currency)" : Money.text(abs(amount), currency))
                                            .font(.caption.monospacedDigit())
                                            .foregroundStyle(amount < 0 ? Palette.negative : amount > 0 ? Palette.positive : .secondary)
                                    }
                                }
                                Spacer(minLength: 4)
                                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.secondary)
                            }
                            .foregroundStyle(Palette.ink)
                            .frame(minHeight: HitTarget.minimum)
                            .contentShape(Rectangle())
                            .accessibilityElement(children: .combine)
                        }
                        .buttonStyle(.plain)
                        if person.id != model.people.last?.id { Divider() }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Card {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    SectionHeader(title: "Your groups")
                    ForEach(model.groups) { summary in
                        NavigationLink {
                            GroupDetail(groupID: summary.id)
                        } label: {
                            HStack {
                                Image(systemName: summary.group.symbol).accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(summary.group.name).font(.subheadline.weight(.semibold))
                                    if summary.group.archived == true { Text("Archived").font(.caption).foregroundStyle(.secondary) }
                                }
                                Spacer(minLength: 6)
                                VStack(alignment: .trailing, spacing: 2) {
                                    if summary.isSettled {
                                        Text("Settled up").foregroundStyle(.secondary)
                                    }
                                    ForEach(summary.mine.keys.sorted().filter { summary.mine[$0] != 0 }, id: \.self) { currency in
                                        let amount = summary.mine[currency, default: 0]
                                        Text(Money.text(amount, currency, signed: true))
                                            .foregroundStyle(amount < 0 ? Palette.negative : Palette.positive)
                                    }
                                }
                                .font(.caption.monospacedDigit())
                            }
                            .foregroundStyle(Palette.ink)
                            .frame(minHeight: HitTarget.minimum)
                            .contentShape(Rectangle())
                            .accessibilityElement(children: .combine)
                        }
                        .buttonStyle(.plain)
                        if summary.id != model.groups.last?.id { Divider() }
                    }
                }
            }
        }
    }

    private var transactionSection: some View {
        let filtered = model.transactions.filter { row in
            (groupID.isEmpty || row.group.id == groupID)
                && (category.isEmpty || row.entry.isSpending && SpendAnalytics.categoryID(row.entry.category) == category)
                && (bucket == nil || row.entry.isSpending && SpendAnalytics.bucketKey(row.entry.day, grain) == bucket)
                && (direction == .all || row.entry.isSpending && (direction == .owed ? row.direction > 0 : row.direction < 0))
        }
        let categories = Set(model.transactions.filter { $0.entry.isSpending }.map { SpendAnalytics.categoryID($0.entry.category) })
        return Card {
            VStack(alignment: .leading, spacing: Spacing.s) {
                HStack {
                    SectionHeader(title: "Your transactions")
                    Spacer()
                    NavigationLink("See all activity") { ActivityFeedView(embedded: true) }
                        .font(.subheadline)
                        .accessibilityIdentifier("home-see-all-activity")
                }
                Menu {
                    Picker("Group", selection: $groupID) {
                        Text("All groups").tag("")
                        ForEach(model.groups) { Text($0.group.name).tag($0.id) }
                    }
                    Picker("Category", selection: $category) {
                        Text("All categories").tag("")
                        ForEach(categories.sorted(), id: \.self) { id in Text(CategoryMeta.named(id).name).tag(id) }
                    }
                    Picker("Direction", selection: $direction) {
                        ForEach(Direction.allCases) { Text($0.rawValue).tag($0) }
                    }
                } label: {
                    Label("Filter transactions", systemImage: "line.3.horizontal.decrease")
                        .frame(minHeight: HitTarget.minimum)
                }
                if !groupID.isEmpty || !category.isEmpty || direction != .all || bucket != nil {
                    Button {
                        groupID = ""
                        category = ""
                        direction = .all
                        bucket = nil
                    } label: {
                        Label("Clear filters", systemImage: "xmark.circle")
                    }
                    .font(.subheadline)
                    Text(filterDescription).font(.caption).foregroundStyle(.secondary)
                }
                if filtered.isEmpty {
                    Text("No transactions match your filters.").font(.subheadline).foregroundStyle(.secondary)
                }
                ForEach(filtered.prefix(limit)) { row in
                    Button { inspect(row.entry) } label: {
                        DashboardTransactionRow(row: row)
                    }
                    .buttonStyle(.plain)
                    if row.id != filtered.prefix(limit).last?.id { Divider() }
                }
                if filtered.count > limit {
                    Button("Show more transactions") { limit += 12 }.buttonStyle(.splitSecondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onChange(of: groupID) { limit = 12 }
        .onChange(of: category) { limit = 12 }
        .onChange(of: direction) { limit = 12 }
    }

    private var filterDescription: String {
        [model.groups.first { $0.id == groupID }?.group.name,
         category.isEmpty ? nil : CategoryMeta.named(category).name,
         direction == .all ? nil : direction.rawValue,
         bucket.map { AnalyticsFormat.bucket($0, grain, long: true) }]
            .compactMap { $0 }.joined(separator: " · ")
    }
}
