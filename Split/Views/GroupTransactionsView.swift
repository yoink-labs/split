import SwiftUI

/// Every transaction in a group as a scannable table: one line per row with
/// date, description, payer and amount columns on a wide display, and a
/// two-line row on a phone.
struct GroupTransactionsView: View {
    let group: ExpenseGroup
    let entries: [LedgerEntry]
    @Binding var phase: TripPhase?
    @Binding var groupByPhase: Bool
    let open: (LedgerEntry) -> Void
    let exportPDF: () -> Void
    var combine: (() -> Void)? = nil

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.horizontalSizeClass) private var sizeClass
    @ScaledMetric(relativeTo: .subheadline) private var amountWidth = 120.0
    @ScaledMetric(relativeTo: .subheadline) private var dateWidth = 64.0
    @ScaledMetric(relativeTo: .subheadline) private var payerWidth = 140.0
    @State private var width: CGFloat = 0

    /// Columns only where the description still gets most of the row.
    private var wide: Bool { width >= 640 && !dynamicTypeSize.isAccessibilitySize }

    private var filtered: [LedgerEntry] {
        guard group.kind == "trip", let phase else { return entries }
        return entries.filter { group.phase(for: $0) == phase }
    }

    var body: some View {
        if entries.isEmpty {
            ContentUnavailableView("No transactions yet", systemImage: "list.bullet.rectangle",
                                   description: Text("Recorded expenses and payments appear here."))
        } else {
            VStack(alignment: .leading, spacing: Spacing.s) {
                let rows = filtered
                header(count: rows.count)
                if group.kind == "trip" { phaseMenu }
                if rows.isEmpty {
                    ContentUnavailableView("No matching transactions", systemImage: "line.3.horizontal.decrease")
                } else if group.kind == "trip" && groupByPhase {
                    ForEach(group.phaseSections(rows), id: \.0) { title, section in
                        SectionHeader(title: title)
                        table(section)
                    }
                } else {
                    table(rows)
                }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        }
    }

    private func header(count: Int) -> some View {
        HStack(alignment: .center, spacing: Spacing.xs) {
            Text("\(count) \(count == 1 ? "transaction" : "transactions")")
                .font(.headline)
                .foregroundStyle(Palette.ink)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: Spacing.xs)
            if let combine {
                Button(action: combine) {
                    Label("Combine", systemImage: "rectangle.on.rectangle")
                }
                .buttonStyle(GhostButton())
                .accessibilityLabel("Combine expenses")
            }
            Button(action: exportPDF) {
                Label("Export PDF", systemImage: "arrow.down.doc")
            }
            .buttonStyle(GhostButton())
        }
        .labelStyle(AdaptiveLabelStyle(iconOnly: width < 420))
    }

    private var phaseMenu: some View {
        Menu {
            Picker("Trip phase", selection: $phase) {
                Text("All phases").tag(nil as TripPhase?)
                ForEach(TripPhase.allCases) { phase in Text(phase.title).tag(Optional(phase)) }
            }
            Toggle("Group by trip phase", isOn: $groupByPhase)
        } label: {
            Label(phase?.title ?? "Trip phases", systemImage: "line.3.horizontal.decrease.circle")
                .frame(minHeight: HitTarget.minimum)
        }
        .accessibilityIdentifier("transaction-trip-phases")
    }

    private func table(_ entries: [LedgerEntry]) -> some View {
        let names = Dictionary(group.members.map { ($0.id, $0.name) }, uniquingKeysWith: { name, _ in name })
        return LazyVStack(spacing: 0) {
            if wide {
                HStack(spacing: Spacing.s) {
                    Text("Date").frame(width: dateWidth, alignment: .leading)
                    Text("Description").frame(maxWidth: .infinity, alignment: .leading)
                    Text("Paid by").frame(width: payerWidth, alignment: .leading)
                    Text("Amount").frame(width: amountWidth, alignment: .trailing)
                    Color.clear.frame(width: 10)
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, Spacing.m)
                .padding(.vertical, 10)
                .background(Palette.raised.opacity(0.6))
                .accessibilityHidden(true)
                Divider().overlay(Palette.line)
            }
            ForEach(entries) { entry in
                Button { open(entry) } label: {
                    Group {
                        if wide { wideRow(entry, names: names) } else { compactRow(entry, names: names) }
                    }
                    .padding(.horizontal, Spacing.m)
                    .padding(.vertical, wide ? 9 : 10)
                    .frame(minHeight: HitTarget.minimum)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityHint("Shows who paid and how the amount was split")
                if entry.id != entries.last?.id { RowDivider(inset: wide ? Spacing.m : Spacing.m + 32 + Spacing.s) }
            }
        }
        .background(Palette.card, in: RoundedRectangle(cornerRadius: Radius.card))
        .clipShape(RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.line).allowsHitTesting(false))
    }

    private func category(_ entry: LedgerEntry) -> String {
        (entry.isSettlement ? "Payment" : entry.isRefund ? "Refund" : CategoryMeta.named(entry.category).name)
            + (entry.isPending ? " · Pending" : "")
    }

    private func payer(_ entry: LedgerEntry, names: [String: String]) -> String {
        let payers = entry.allPayers
        let name = names[payers.first?.memberID ?? entry.paidBy] ?? "Former member"
        return payers.count > 1 ? "\(payers.count) people" : name
    }

    private func amount(_ entry: LedgerEntry) -> some View {
        Text(Money.text(entry.signedAmount, entry.currency))
            .font(.splitAmount(15))
            .foregroundStyle(entry.isRefund ? Palette.positive : Palette.ink)
            .lineLimit(1)
            .minimumScaleFactor(0.75)
    }

    private var chevron: some View {
        Image(systemName: "chevron.right")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.tertiary)
            .frame(width: 10)
            .accessibilityHidden(true)
    }

    private func wideRow(_ entry: LedgerEntry, names: [String: String]) -> some View {
        HStack(spacing: Spacing.s) {
            Text(LedgerDate.short(entry.createdAt))
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: dateWidth, alignment: .leading)
            HStack(spacing: Spacing.s) {
                EntryBadge(title: entry.title, category: entry.isSettlement ? "Payment" : entry.category, size: 28)
                VStack(alignment: .leading, spacing: 1) {
                    Text(entry.title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink).lineLimit(1)
                    Text(category(entry)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    phaseLabel(entry)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text(payer(entry, names: names))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(width: payerWidth, alignment: .leading)
            amount(entry).frame(width: amountWidth, alignment: .trailing)
            chevron
        }
    }

    private func compactRow(_ entry: LedgerEntry, names: [String: String]) -> some View {
        HStack(spacing: Spacing.s) {
            EntryBadge(title: entry.title, category: entry.isSettlement ? "Payment" : entry.category, size: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink).lineLimit(1)
                Text("\(LedgerDate.short(entry.createdAt)) · " + (entry.isRefund ? "Refund to \(payer(entry, names: names))" : "\(payer(entry, names: names)) paid"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                phaseLabel(entry)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            amount(entry).layoutPriority(1)
            chevron
        }
    }

    @ViewBuilder private func phaseLabel(_ entry: LedgerEntry) -> some View {
        if let phase = group.phase(for: entry) {
            Text(phase.title).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
        }
    }
}

/// Shows a label's title and icon, or only its icon where space is tight.
struct AdaptiveLabelStyle: LabelStyle {
    var iconOnly: Bool
    func makeBody(configuration: Configuration) -> some View {
        if iconOnly {
            configuration.icon
        } else {
            HStack(spacing: 6) { configuration.icon; configuration.title }
        }
    }
}
