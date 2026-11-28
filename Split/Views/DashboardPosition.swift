import SwiftUI

struct DashboardPosition: View {
    var model: DashboardModel
    @EnvironmentObject private var fx: FXStore

    private var currencies: [String] {
        let currencies = Set(model.owed.keys).union(model.owe.keys).sorted()
        return currencies.isEmpty ? [fx.home] : currencies
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            Text("Net position")
                .font(.headline)
                .foregroundStyle(Palette.onHero)
                .accessibilityAddTraits(.isHeader)
            ViewThatFits(in: .horizontal) {
                balanceGrid
                stackedBalances
            }
        }
        .padding(Spacing.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.hero, in: RoundedRectangle(cornerRadius: Radius.header))
    }

    private var balanceGrid: some View {
        Grid(alignment: .leading, horizontalSpacing: Spacing.s, verticalSpacing: Spacing.s) {
            GridRow {
                Color.clear.frame(width: 0, height: 0)
                heading("Net balance")
                heading("You owe")
                heading("You’re owed")
            }
            .accessibilityHidden(true)
            ForEach(currencies, id: \.self) { currency in
                if currency != currencies.first {
                    Divider().overlay(Palette.onHero.opacity(0.18))
                        .gridCellUnsizedAxes(.horizontal)
                }
                let owed = model.owed[currency, default: 0]
                let owe = model.owe[currency, default: 0]
                GridRow {
                    heading(currency).accessibilityHidden(true)
                    amount("Net balance", owed - owe, currency: currency, net: true)
                    amount("You owe", owe, currency: currency)
                    amount("You’re owed", owed, currency: currency)
                }
            }
        }
    }

    private var stackedBalances: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            ForEach(currencies, id: \.self) { currency in
                if currency != currencies.first { Divider().overlay(Palette.onHero.opacity(0.18)) }
                let owed = model.owed[currency, default: 0]
                let owe = model.owe[currency, default: 0]
                heading(currency).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    stackedMetric("Net balance", owed - owe, currency: currency, net: true)
                    stackedMetric("You owe", owe, currency: currency)
                    stackedMetric("You’re owed", owed, currency: currency)
                }
            }
        }
    }

    private func heading(_ title: String) -> some View {
        Text(title).font(.caption.weight(.medium)).foregroundStyle(Palette.onHero.opacity(0.78))
            .fixedSize(horizontal: true, vertical: false)
    }

    private func stackedMetric(_ title: String, _ value: Int64, currency: String, net: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            heading(title).accessibilityHidden(true)
            amount(title, value, currency: currency, net: net)
        }
    }

    private func amount(_ title: String, _ value: Int64, currency: String, net: Bool = false) -> some View {
        let sign = value < 0 ? "−" : net && value > 0 ? "+" : ""
        let number = (Decimal(abs(value)) / 100).formatted(.number.precision(.fractionLength(2)))
        return Text(sign + number)
            .font(net ? .title3.bold().monospacedDigit() : .subheadline.weight(.semibold).monospacedDigit())
            .foregroundStyle(net ? (value < 0 ? Palette.heroNegative : Palette.lime) : Palette.onHero)
            .fixedSize(horizontal: true, vertical: false)
            .accessibilityLabel("\(title), \(Money.text(value, currency, signed: net))")
    }
}
