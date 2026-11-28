import SwiftUI

/// What each person paid against their share of the same expenses.
struct PeopleBreakdownCard: View {
    var report: SpendAnalytics.Report
    var format: AnalyticsFormat
    var scope: AnalyticsScope
    var highlight: String?
    var active: String?
    var onSelect: (String) -> Void

    private var rows: [SpendAnalytics.PersonTotal] {
        report.people.sorted { $0.share != $1.share ? $0.share > $1.share : $0.paid > $1.paid }
    }

    var body: some View {
        let ceiling = Swift.max(1, rows.flatMap { [$0.paid, $0.share] }.max() ?? 1)
        Card {
            VStack(alignment: .leading, spacing: Spacing.s) {
                HStack(alignment: .firstTextBaseline) {
                    SectionHeader(title: "By person", subtitle: "What each person paid against their share")
                    swatches
                }
                VStack(spacing: 2) {
                    ForEach(rows) { row in
                        personRow(row, ceiling: ceiling)
                    }
                }
            }
        }
    }

    private var swatches: some View {
        VStack(alignment: .trailing, spacing: 3) {
            swatch("Paid", Palette.evergreen)
            swatch("Share", Palette.sky)
        }
        .accessibilityHidden(true)
    }

    private func swatch(_ title: String, _ color: Color) -> some View {
        HStack(spacing: 4) {
            Capsule().fill(color).frame(width: 12, height: 5)
            Text(title).font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func personRow(_ row: SpendAnalytics.PersonTotal, ceiling: Int64) -> some View {
        let name = scope.name(row.key)
        let selected = active == row.key
        return Button { onSelect(row.key) } label: {
            HStack(alignment: .center, spacing: Spacing.s) {
                Avatar(name: name, size: 32)
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(name)
                            .font(.subheadline.weight(highlight == row.key ? .bold : .semibold))
                            .foregroundStyle(Palette.ink)
                            .lineLimit(1)
                        Spacer(minLength: 6)
                        netLabel(row.net)
                    }
                    VStack(spacing: 3) {
                        ProportionBar(fraction: Double(row.paid) / Double(ceiling), tint: Palette.evergreen, height: 5)
                        ProportionBar(fraction: Double(row.share) / Double(ceiling), tint: Palette.sky, height: 5)
                    }
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: Spacing.s) { figures(row) }
                        VStack(alignment: .leading, spacing: 1) { figures(row) }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 7)
            .padding(.horizontal, 8)
            .background(selected ? Palette.evergreen.opacity(0.10) : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(name)
        .accessibilityValue("Paid \(format.money(row.paid)), share \(format.money(row.share)), \(netDescription(row.net))")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityHint("Lists expenses they paid for or share in")
    }

    @ViewBuilder private func figures(_ row: SpendAnalytics.PersonTotal) -> some View {
        Text("Paid ") + Text(format.money(row.paid)).monospacedDigit().foregroundStyle(Palette.ink)
        Text("Share ") + Text(format.money(row.share)).monospacedDigit().foregroundStyle(Palette.ink)
    }

    private func netLabel(_ net: Int64) -> some View {
        VStack(alignment: .trailing, spacing: 0) {
            Text(net == 0 ? "Even" : format.money(net, signed: true))
                .font(.splitAmount(13))
                .foregroundStyle(net > 0 ? Palette.positive : net < 0 ? Palette.negative : Color.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            if net != 0 {
                Text(net > 0 ? "covered others" : "covered by others")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    private func netDescription(_ net: Int64) -> String {
        net == 0 ? "even" : net > 0 ? "covered others by \(format.money(net))" : "covered by others by \(format.money(-net))"
    }
}
