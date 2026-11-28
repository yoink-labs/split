import SwiftUI

/// The Analytics tab: every group by default, or one group from the scope menu.
struct AnalyticsTab: View {
    @EnvironmentObject private var store: ExpenseStore
    @State private var groupID: String?

    var body: some View {
        NavigationStack {
            AnalyticsView(groupID: groupID, scopeSelection: $groupID)
                .ledgerDestinations()
        }
        .onChange(of: store.groups.map(\.id)) { _, ids in
            if let groupID, !ids.contains(groupID) { self.groupID = nil }
        }
    }
}

/// Spending over time, by category, by person and by currency, with date and
/// member filters and drill-down to the transactions behind each mark. The
/// math is `SpendAnalytics`, the same as the web Analytics page.
struct AnalyticsView: View {
    var groupID: String?
    var scopeSelection: Binding<String?>? = nil

    @EnvironmentObject private var store: ExpenseStore
    @EnvironmentObject private var fx: FXStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var range: SpendAnalytics.Range = .all
    @State private var customFrom = Calendar.current.date(byAdding: .day, value: -29, to: Date()) ?? Date()
    @State private var customTo = Date()
    @State private var person: String?
    @State private var grain: SpendAnalytics.Granularity = .week
    @State private var drill: SpendAnalytics.Drill?
    @State private var inspecting: LedgerEntry?
    @State private var width: CGFloat = 0

    private static let twoPaneWidth: CGFloat = 860

    var body: some View {
        let group = groupID.flatMap(store.group)
        let scope = AnalyticsScope(group: group, allGroups: store.groups, allEntries: store.state.snapshot.entries, currentUserID: store.currentUserID)
        let range = scope.tripRange || self.range != .trip ? self.range : .all
        let bounds = SpendAnalytics.bounds(range, group: group, custom: (Exchange.localDay(customFrom), Exchange.localDay(customTo)))
        let member = scope.members.first { $0.key == person }
        let report = SpendAnalytics.analyze(
            scope.entries, project: fx.homeEntry, home: fx.home,
            filter: .init(from: bounds.from, to: bounds.to, person: member?.key),
            people: scope.allKeys, granularity: grain, key: scope.personKey
        )
        let format = AnalyticsFormat(home: fx.home, estimated: report.estimated)
        let drilled = SpendAnalytics.drillRows(report, drill, key: scope.personKey)
        let context = Context(scope: scope, report: report, format: format, member: member, drill: drill, drilled: drilled)

        ScrollViewReader { proxy in
            Group {
                if width >= Self.twoPaneWidth && !report.rows.isEmpty {
                    HStack(alignment: .top, spacing: 0) {
                        ScrollView { charts(context, proxy: proxy).padding(.horizontal, Spacing.page).padding(.vertical, Spacing.m) }
                            .frame(maxWidth: .infinity)
                        Divider().overlay(Palette.line).ignoresSafeArea(edges: .bottom)
                        ScrollView { drillPanel(context).padding(Spacing.m) }
                            .frame(width: min(440, max(340, width * 0.4)))
                    }
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: Spacing.section) {
                            charts(context, proxy: proxy)
                            if !report.rows.isEmpty { drillPanel(context).id(Self.drillAnchor) }
                        }
                        .padding(.horizontal, Spacing.page)
                        .padding(.vertical, Spacing.m)
                        .frame(maxWidth: 820)
                        .frame(maxWidth: .infinity)
                    }
                }
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .background(AppBackground())
        .refreshable { await store.sync() }
        .navigationTitle("Analytics")
        .navigationBarTitleDisplayMode(.large)
        .sheet(item: $inspecting) { EntrySheet(entry: $0) }
        .onChange(of: groupID) { person = nil; self.range = .all; drill = nil }
        .onChange(of: self.range) { drill = nil }
        .onChange(of: person) { drill = nil }
        .onChange(of: grain) { drill = nil }
        .onChange(of: customFrom) { drill = nil }
        .onChange(of: customTo) { drill = nil }
    }

    private static let drillAnchor = "analytics-drill"

    struct Context {
        var scope: AnalyticsScope
        var report: SpendAnalytics.Report
        var format: AnalyticsFormat
        var member: AnalyticsScope.Member?
        var drill: SpendAnalytics.Drill?
        var drilled: [SpendAnalytics.Row]
    }

    @ViewBuilder
    private func charts(_ context: Context, proxy: ScrollViewProxy) -> some View {
        let report = context.report
        VStack(alignment: .leading, spacing: Spacing.section) {
            header(context)
            AnalyticsFilterBar(
                scope: context.scope,
                range: $range,
                customFrom: $customFrom,
                customTo: $customTo,
                person: $person,
                scopeSelection: scopeSelection,
                groups: store.groups.filter { !($0.archived ?? false) }
            )
            if report.rows.isEmpty {
                Card {
                    EmptyPanel(
                        title: context.scope.hasExpenses ? "Nothing in this range" : "No spending yet",
                        message: context.scope.hasExpenses
                            ? "Choose a wider date range or another member."
                            : "Add an expense and its charts will appear here.",
                        symbol: "chart.bar.xaxis"
                    )
                }
            } else {
                AnalyticsSummary(report: report, format: context.format, member: context.member, home: fx.home)
                if let group = context.scope.group, group.kind == "trip" {
                    phaseBreakdown(group, context: context)
                }
                SpendingTimeChart(
                    report: report, format: context.format, grain: $grain,
                    active: context.drill?.bucket,
                    onSelect: { select(.bucket($0), proxy: proxy) }
                )
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 330), spacing: 14, alignment: .top)], alignment: .leading, spacing: 14) {
                    CategoryBreakdownCard(
                        report: report, format: context.format,
                        active: context.drill?.category,
                        onSelect: { select(.category($0), proxy: proxy) }
                    )
                    PeopleBreakdownCard(
                        report: report, format: context.format, scope: context.scope, highlight: context.member?.key,
                        active: context.drill?.person,
                        onSelect: { select(.person($0), proxy: proxy) }
                    )
                    CurrencyBreakdownCard(
                        report: report, format: context.format, home: fx.home,
                        active: context.drill?.currency,
                        onSelect: { select(.currency($0), proxy: proxy) }
                    )
                }
            }
        }
    }

    private func phaseBreakdown(_ group: ExpenseGroup, context: Context) -> some View {
        Card {
            VStack(alignment: .leading, spacing: Spacing.m) {
                SectionHeader(title: "Expenses by trip phase")
                ForEach(TripPhase.allCases) { phase in
                    let rows = context.report.rows.filter { group.phase(for: $0.entry) == phase }
                    let amounts = rows.compactMap(\.amount)
                    let missing = rows.count - amounts.count
                    LabeledContent {
                        Text(!rows.isEmpty && amounts.isEmpty ? "Unavailable" : context.format.money(amounts.reduce(0, +)))
                            .monospacedDigit()
                    } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(phase.title)
                            Text("\(rows.count) \(rows.count == 1 ? "expense" : "expenses")" + (missing > 0 ? " · \(missing) unpriced" : ""))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }

    private func header(_ context: Context) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(context.scope.title)
                .font(.splitDisplay(24))
                .foregroundStyle(Palette.ink)
                .lineLimit(2)
            Text(context.member.map { "\($0.name == "You" ? "Your" : $0.name + "’s") share of expenses \($0.name == "You" ? "you’re" : "they’re") part of, in \(fx.home)" }
                 ?? "\(context.scope.group == nil ? "Every expense in every group" : "Every expense in the group"), in \(fx.home)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private func drillPanel(_ context: Context) -> some View {
        AnalyticsDrillPanel(
            title: drillTitle(context),
            rows: context.drilled,
            scope: context.scope,
            format: context.format,
            member: context.member,
            filtered: context.drill != nil,
            onClear: { withAnimation(reduceMotion ? nil : .snappy) { drill = nil } },
            onInspect: { inspecting = $0 }
        )
        .id(PanelIdentity(drill: context.drill, from: Exchange.localDay(customFrom), to: Exchange.localDay(customTo), range: range, person: person, grain: grain))
    }

    /// Resets the drill list's page whenever what it lists changes.
    private struct PanelIdentity: Hashable {
        var drill: SpendAnalytics.Drill?
        var from: String
        var to: String
        var range: SpendAnalytics.Range
        var person: String?
        var grain: SpendAnalytics.Granularity
    }

    private func drillTitle(_ context: Context) -> String {
        switch context.drill {
        case nil: "All expenses in range"
        case .bucket(let key): AnalyticsFormat.bucket(key, context.report.granularity, long: true)
        case .category(let id): AnalyticsCategory.meta(id).label
        case .person(let key): context.scope.name(key) == "You" ? "Your expenses" : "\(context.scope.name(key))’s expenses"
        case .currency(let code): "Paid in \(code)"
        }
    }

    private func select(_ next: SpendAnalytics.Drill, proxy: ScrollViewProxy) {
        let same = drill == next
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) { drill = same ? nil : next }
        guard !same, width < Self.twoPaneWidth else { return }
        withAnimation(reduceMotion ? nil : .smooth) { proxy.scrollTo(Self.drillAnchor, anchor: .top) }
    }
}
