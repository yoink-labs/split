import SwiftUI

struct DashboardPosition: View {
    var model: DashboardModel
    @EnvironmentObject private var fx: FXStore

    private var currencies: [String] {
        let currencies = Set(model.owed.keys).union(model.owe.keys).sorted()
        return currencies.isEmpty ? [fx.home] : currencies
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            Text("Net position")
                .font(.headline)
                .foregroundStyle(Palette.onHero)
                .accessibilityAddTraits(.isHeader)
            ForEach(currencies, id: \.self) { currency in
                if currency != currencies.first { Divider().overlay(Palette.onHero.opacity(0.18)) }
                let owed = model.owed[currency, default: 0]
                let owe = model.owe[currency, default: 0]
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Text(currency).font(.caption.weight(.semibold)).foregroundStyle(Palette.onHero.opacity(0.78))
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline, spacing: Spacing.m) {
                            metrics(owed: owed, owe: owe, currency: currency)
                        }
                        VStack(alignment: .leading, spacing: Spacing.xs) {
                            metrics(owed: owed, owe: owe, currency: currency)
                        }
                    }
                }
            }
        }
        .padding(Spacing.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.hero, in: RoundedRectangle(cornerRadius: Radius.header))
    }

    @ViewBuilder private func metrics(owed: Int64, owe: Int64, currency: String) -> some View {
        metric("Net balance", owed - owe, currency: currency, headline: true)
        metric("You owe", owe, currency: currency)
        metric("You’re owed", owed, currency: currency)
    }

    private func metric(_ title: String, _ amount: Int64, currency: String, headline: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption).foregroundStyle(Palette.onHero.opacity(0.78))
            Text(Money.text(amount, currency, signed: headline))
                .font(headline ? .title2.bold().monospacedDigit() : .subheadline.weight(.semibold).monospacedDigit())
                .foregroundStyle(headline ? (amount < 0 ? Palette.heroNegative : Palette.lime) : Palette.onHero)
        }
        .fixedSize(horizontal: true, vertical: false)
        .accessibilityElement(children: .combine)
    }
}
