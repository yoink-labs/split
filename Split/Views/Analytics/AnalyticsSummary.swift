import SwiftUI

/// The headline figures: total (or a member's share), count, average and the largest category.
struct AnalyticsSummary: View {
    var report: SpendAnalytics.Report
    var format: AnalyticsFormat
    var member: AnalyticsScope.Member?
    var home: String

    @Environment(\.dynamicTypeSize) private var typeSize

    private var totalTitle: String {
        guard let member else { return "Total spend" }
        return member.name == "You" ? "Your share" : "\(member.name)’s share"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            VStack(alignment: .leading, spacing: 4) {
                Text(totalTitle)
                    .font(.splitEyebrow)
                    .foregroundStyle(Palette.lime.opacity(0.75))
                Text(format.money(report.total))
                    .font(.splitDisplay(38))
                    .foregroundStyle(Palette.lime)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                    .contentTransition(.numericText())
            }
            .accessibilityElement(children: .combine)

            let columns = typeSize.isAccessibilitySize ? 1 : 3
            Grid(alignment: .leading, horizontalSpacing: Spacing.m, verticalSpacing: Spacing.s) {
                if columns == 1 {
                    GridRow { expensesStat }
                    GridRow { secondaryStat }
                    if let largest = report.categories.first { GridRow { largestStat(largest) } }
                } else {
                    GridRow {
                        expensesStat
                        secondaryStat
                        if let largest = report.categories.first { largestStat(largest) }
                    }
                }
            }

            if report.excluded > 0 || report.estimated {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(Palette.onHero.opacity(0.7))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(Spacing.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.hero, in: RoundedRectangle(cornerRadius: Radius.header))
        .overlay(RoundedRectangle(cornerRadius: Radius.header).strokeBorder(Palette.lime.opacity(0.16)))
    }

    private var note: String {
        var parts: [String] = []
        if report.estimated { parts.append("≈ marks amounts converted to \(home) at saved or published rates.") }
        if report.excluded > 0 {
            let one = report.excluded == 1
            parts.append("\(AnalyticsFormat.count(report.excluded, "expense")) \(one ? "has" : "have") no \(home) rate yet and \(one ? "is" : "are") shown only under currency.")
        }
        return parts.joined(separator: " ")
    }

    private var expensesStat: some View {
        stat("Expenses", "\(report.rows.count)")
    }

    private var secondaryStat: some View {
        if let member {
            stat("Paid", format.money(report.people.first { $0.key == member.key }?.paid ?? 0))
        } else {
            stat("Average", format.money(report.average))
        }
    }

    private func largestStat(_ largest: SpendAnalytics.CategoryTotal) -> some View {
        stat("Top category", AnalyticsCategory.meta(largest.id).label, detail: "\(largest.percent)%")
    }

    private func stat(_ title: String, _ value: String, detail: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption)
                .foregroundStyle(Palette.onHero.opacity(0.62))
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(value)
                    .font(.splitAmount(16))
                    .foregroundStyle(Palette.onHero)
                    .lineLimit(detail == nil ? 1 : 2)
                    .minimumScaleFactor(0.6)
                if let detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(Palette.lime.opacity(0.8))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
