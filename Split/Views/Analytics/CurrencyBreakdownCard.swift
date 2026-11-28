import SwiftUI

/// The currencies expenses were paid in, each totalled in the home currency.
struct CurrencyBreakdownCard: View {
    var report: SpendAnalytics.Report
    var format: AnalyticsFormat
    var home: String
    var active: String?
    var onSelect: (String) -> Void

    private var subtitle: String {
        report.currencies.count == 1
            ? "Every expense was paid in \(report.currencies[0].currency)"
            : "Paid in \(report.currencies.count) currencies, totalled in \(home)"
    }

    var body: some View {
        let ceiling = Swift.max(1, report.currencies.compactMap(\.home).max() ?? 1)
        Card {
            VStack(alignment: .leading, spacing: Spacing.s) {
                SectionHeader(title: "By currency", subtitle: subtitle)
                VStack(spacing: 2) {
                    ForEach(report.currencies) { currency in
                        row(currency, ceiling: ceiling)
                    }
                }
            }
        }
    }

    private func value(_ currency: SpendAnalytics.CurrencyTotal) -> String {
        guard let amount = currency.home else { return "Rate unavailable" }
        return format.money(amount, estimated: currency.currency != home)
    }

    private func row(_ currency: SpendAnalytics.CurrencyTotal, ceiling: Int64) -> some View {
        let selected = active == currency.currency
        return Button { onSelect(currency.currency) } label: {
            HStack(spacing: Spacing.s) {
                Text(currency.currency)
                    .font(.caption.weight(.bold).monospaced())
                    .frame(minWidth: 40, minHeight: 30)
                    .foregroundStyle(Palette.evergreen)
                    .background(Palette.mint.opacity(0.45), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(Money.text(currency.original, currency.currency))
                                .font(.splitAmount(13))
                                .foregroundStyle(Palette.ink)
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                            Text(AnalyticsFormat.count(currency.count, "expense")).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 4)
                        VStack(alignment: .trailing, spacing: 1) {
                            Text(value(currency))
                                .font(.splitAmount(13))
                                .foregroundStyle(currency.home == nil ? Palette.amber : Palette.ink)
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                            if currency.home != nil {
                                Text("\(currency.percent)%").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    ProportionBar(fraction: Double(currency.home ?? 0) / Double(ceiling), tint: Palette.evergreen)
                }
            }
            .padding(.vertical, 7)
            .padding(.horizontal, 8)
            .background(selected ? Palette.evergreen.opacity(0.10) : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(currency.currency)
        .accessibilityValue("\(Money.text(currency.original, currency.currency)), \(value(currency))\(currency.home == nil ? "" : ", \(currency.percent) percent"), \(AnalyticsFormat.count(currency.count, "expense"))")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityHint("Lists these expenses")
    }
}
