import SwiftUI

/// The expenses behind the selected chart mark, in pages of 25 so the list
/// never grows past a screen's worth of rows. The full list opens on its own.
struct AnalyticsDrillPanel: View {
    var title: String
    var rows: [SpendAnalytics.Row]
    var scope: AnalyticsScope
    var format: AnalyticsFormat
    var member: AnalyticsScope.Member?
    var filtered: Bool
    var onClear: () -> Void
    var onInspect: (LedgerEntry) -> Void

    static let pageSize = 25

    private var total: Int64 { rows.reduce(0) { $0 + ($1.amount ?? 0) } }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            header
            Card(padding: 0) {
                PagedAnalyticsRows(rows: rows, pageSize: Self.pageSize, scope: scope, format: format, member: member, onInspect: onInspect)
            }
            if rows.count > Self.pageSize {
                NavigationLink {
                    AnalyticsTransactionList(title: title, rows: rows, scope: scope, format: format, member: member)
                } label: {
                    Label("Open all \(rows.count)", systemImage: "list.bullet")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(GhostButton())
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(Palette.ink)
                    .accessibilityAddTraits(.isHeader)
                Text(summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .contentTransition(.numericText())
            }
            Spacer(minLength: Spacing.s)
            if filtered {
                Button("Show all", action: onClear)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.evergreen)
                    .frame(minHeight: HitTarget.minimum)
                    .accessibilityIdentifier("analytics-show-all")
            }
        }
    }

    private var summary: String {
        var text = AnalyticsFormat.count(rows.count, "expense")
        if rows.contains(where: { $0.amount != nil }) {
            text += " · " + format.money(total, estimated: rows.contains { $0.estimated }) + (member == nil ? "" : " share")
        }
        if !filtered { text += " · Tap a bar or row to filter" }
        return text
    }
}

/// One page of analytics rows with Previous and Next. Rows render lazily.
struct PagedAnalyticsRows: View {
    var rows: [SpendAnalytics.Row]
    var pageSize: Int
    var scope: AnalyticsScope
    var format: AnalyticsFormat
    var member: AnalyticsScope.Member?
    var onInspect: (LedgerEntry) -> Void

    @State private var page = 0

    private var pages: Int { Swift.max(1, (rows.count + pageSize - 1) / pageSize) }
    private var current: Int { Swift.min(page, pages - 1) }
    private var visible: ArraySlice<SpendAnalytics.Row> {
        let start = current * pageSize
        return rows[start..<Swift.min(rows.count, start + pageSize)]
    }

    var body: some View {
        VStack(spacing: 0) {
            if rows.isEmpty {
                Text("No expenses here.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(Spacing.m)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                LazyVStack(spacing: 0) {
                    ForEach(visible) { row in
                        Button { onInspect(row.entry) } label: {
                            AnalyticsEntryRow(row: row, scope: scope, format: format, member: member)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 10)
                        }
                        .buttonStyle(.plain)
                        if row.id != visible.last?.id {
                            Divider().overlay(Palette.line).padding(.leading, 60)
                        }
                    }
                }
                footer
            }
        }
    }

    private var footer: some View {
        HStack(spacing: Spacing.s) {
            Text(pages > 1 ? "\(current * pageSize + 1)–\(current * pageSize + visible.count) of \(rows.count)" : AnalyticsFormat.count(rows.count, "transaction"))
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            if pages > 1 {
                Button { page = current - 1 } label: { Label("Previous page", systemImage: "chevron.left").labelStyle(.iconOnly) }
                    .disabled(current == 0)
                    .frame(minWidth: HitTarget.minimum, minHeight: HitTarget.minimum)
                Text("Page \(current + 1) of \(pages)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button { page = current + 1 } label: { Label("Next page", systemImage: "chevron.right").labelStyle(.iconOnly) }
                    .disabled(current >= pages - 1)
                    .frame(minWidth: HitTarget.minimum, minHeight: HitTarget.minimum)
                    .accessibilityIdentifier("analytics-next-page")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 4)
        .overlay(alignment: .top) { Divider().overlay(Palette.line) }
    }
}

/// A transaction in an analytics list: what it was, where, who paid, and the measured amount.
struct AnalyticsEntryRow: View {
    var row: SpendAnalytics.Row
    var scope: AnalyticsScope
    var format: AnalyticsFormat
    var member: AnalyticsScope.Member?

    private var entry: LedgerEntry { row.entry }
    private var meta: AnalyticsCategory { AnalyticsCategory.meta(row.category) }
    private var group: ExpenseGroup? { scope.groups.first { $0.id == entry.groupID } }
    private var foreign: Bool { entry.currency != format.home }

    private var payers: String {
        entry.allPayers.map { payer in scope.name(scope.personKey(entry.groupID, payer.memberID)) }.joined(separator: ", ")
    }

    private var day: String {
        SpendAnalytics.date(row.day)?.formatted(Date.FormatStyle(timeZone: TimeZone(identifier: "UTC")!).month(.abbreviated).day()) ?? row.day
    }

    private var detailLine: String {
        var parts = [day, meta.label]
        if scope.group == nil, let group { parts.append(group.name) }
        parts.append("\(payers) paid")
        return parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.s) {
            Image(systemName: meta.symbol)
                .font(.system(size: 14, weight: .semibold))
                .frame(width: 34, height: 34)
                .foregroundStyle(meta.tint)
                .background(meta.tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
                Text(detailLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: Spacing.xs)
            VStack(alignment: .trailing, spacing: 2) {
                Text(row.home.map { format.money(entry.sign * $0.amount, estimated: foreign) } ?? Money.text(entry.signedAmount, entry.currency))
                    .font(.splitAmount(14))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                if foreign {
                    Text(row.home == nil ? "Rate unavailable" : Money.text(entry.signedAmount, entry.currency))
                        .font(.caption2)
                        .foregroundStyle(row.home == nil ? Palette.amber : Color.secondary)
                        .lineLimit(1)
                }
                if member != nil, let amount = row.amount {
                    Text("Share \(format.money(amount, estimated: foreign))")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(Palette.evergreen)
                        .lineLimit(1)
                }
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the expense")
    }
}

/// Every expense behind a drill-down, a page at a time.
struct AnalyticsTransactionList: View {
    var title: String
    var rows: [SpendAnalytics.Row]
    var scope: AnalyticsScope
    var format: AnalyticsFormat
    var member: AnalyticsScope.Member?
    @State private var inspecting: LedgerEntry?

    var body: some View {
        ScrollView {
            Card(padding: 0) {
                PagedAnalyticsRows(rows: rows, pageSize: 50, scope: scope, format: format, member: member) { inspecting = $0 }
            }
            .padding(.horizontal, Spacing.page)
            .padding(.vertical, Spacing.m)
            .frame(maxWidth: 820)
            .frame(maxWidth: .infinity)
        }
        .background(AppBackground())
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $inspecting) { EntrySheet(entry: $0) }
    }
}
