import SwiftUI

/// "Show in" currency menu. Changing it re-expresses totals; it never changes the ledger.
struct ShowInMenu: View {
    @EnvironmentObject private var fx: FXStore
    var onHero = false

    var body: some View {
        Menu {
            Picker("Show in", selection: $fx.display) {
                ForEach(Money.currencies, id: \.self) { Text($0).tag($0) }
            }
        } label: {
            HStack(spacing: 4) {
                Text("Show in \(fx.display)")
                Image(systemName: "chevron.up.chevron.down").font(.caption2.weight(.bold))
            }
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .frame(minHeight: 30)
            .foregroundStyle(onHero ? Palette.lime : Palette.evergreen)
            .background((onHero ? Palette.lime : Palette.evergreen).opacity(0.12), in: Capsule())
            .contentShape(Capsule())
        }
        .accessibilityLabel("Show totals in \(fx.display)")
        .accessibilityIdentifier("show-in-menu")
    }
}

/// One approximate figure for amounts in several currencies, at today's rates. Always labelled
/// as approximate, with the source and date, and degrades to cached rates when offline.
struct ApproxTotal: View {
    var amounts: [String: Int64]
    var onHero = false
    /// Caption for positive and negative totals, from the reader's point of view.
    var positive = "you’re owed"
    var negative = "you owe"
    var showsMenu = true
    @EnvironmentObject private var fx: FXStore

    private var open: [String: Int64] { amounts.filter { $0.value != 0 } }
    private var needsConversion: Bool { open.keys.contains { $0 != fx.display } }
    private var result: (amount: Int64, missing: [String], quotes: [FXQuote]) { fx.total(open, in: fx.display) }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        conversionSummary
                    }
                    .fixedSize(horizontal: true, vertical: false)
                    if showsMenu {
                        Spacer(minLength: 6)
                        ShowInMenu(onHero: onHero)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                }
                VStack(alignment: .leading, spacing: 4) {
                    conversionSummary
                    if showsMenu { ShowInMenu(onHero: onHero) }
                }
            }
            if needsConversion, result.missing.count < open.count {
                Text(caption)
                    .font(.caption2)
                    .foregroundStyle(onHero ? Palette.onHero.opacity(0.55) : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .contain)
        .task(id: Array(open.keys).sorted().joined() + fx.display) {
            await fx.refresh(currencies: Set(open.keys), into: fx.display)
        }
    }

    @ViewBuilder private var conversionSummary: some View {
        if needsConversion, result.missing.count < open.count {
            Text("≈ " + Money.text(abs(result.amount), fx.display))
                .font(.splitAmount(onHero ? 17 : 15, weight: .semibold))
                .foregroundStyle(onHero ? Palette.onHero : Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .contentTransition(.numericText())
            if result.amount != 0 {
                Text(result.amount > 0 ? positive : negative)
                    .font(.caption)
                    .foregroundStyle(onHero ? Palette.onHero.opacity(0.62) : .secondary)
            }
        } else if needsConversion {
            Text(fx.refreshing ? "Getting today’s rates…" : "Rates unavailable offline")
                .font(.caption)
                .foregroundStyle(onHero ? Palette.onHero.opacity(0.62) : .secondary)
        }
    }

    private var caption: String {
        var parts = ["Approximate, at today’s rate"]
        let sources = Array(Set(result.quotes.map { $0.source == "Frankfurter" ? "Frankfurter · ECB" : $0.source == "BCRA" ? "BCRA official" : "your rate" })).sorted()
        if !sources.isEmpty { parts.append(sources.joined(separator: ", ")) }
        if let day = result.quotes.map(\.date).filter({ !$0.isEmpty }).min() { parts.append(FXQuote.shortDay(day)) }
        if fx.offline { parts.append("offline, last saved rates") }
        if !result.missing.isEmpty { parts.append("excludes " + result.missing.joined(separator: ", ")) }
        return parts.joined(separator: " · ")
    }
}

/// A small standalone converter. Free: published rates from Frankfurter (ECB) and BCRA, or your own.
struct ConverterView: View {
    var initialAmount: Int64? = nil
    var from: String? = nil
    var to: String? = nil
    @EnvironmentObject private var fx: FXStore
    @Environment(\.dismiss) private var dismiss
    @State private var amount = ""
    @State private var base = "USD"
    @State private var quote = "ARS"
    @State private var useOwn = false
    @State private var ownRate = ""
    @State private var loading = false
    @State private var failure: String?
    @State private var initialized = false
    @FocusState private var amountFocused: Bool

    private var rate: FXQuote? { fx.rate(base, quote) }
    private var minor: Int64? { Money.parse(amount) }
    private var converted: Int64? {
        guard let minor, let rate else { return nil }
        return FXMath.convert(minor, rateE8: rate.rateE8)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.section) {
                    Card {
                        VStack(alignment: .leading, spacing: 14) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                currencyMenu($base, label: "From")
                                TextField("0.00", text: $amount)
                                    .font(.splitAmount(30))
                                    .keyboardType(.decimalPad)
                                    .multilineTextAlignment(.trailing)
                                    .focused($amountFocused)
                                    .accessibilityLabel("Amount in \(base)")
                            }
                            HStack {
                                Rectangle().fill(Palette.line).frame(height: 1)
                                Button {
                                    swap(&base, &quote)
                                } label: {
                                    Image(systemName: "arrow.up.arrow.down")
                                }
                                .buttonStyle(IconButton())
                                .accessibilityLabel("Swap currencies")
                                Rectangle().fill(Palette.line).frame(height: 1)
                            }
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                currencyMenu($quote, label: "To")
                                Spacer()
                                Text(converted.map { Money.input($0) } ?? "—")
                                    .font(.splitAmount(30, weight: .bold))
                                    .foregroundStyle(Palette.ink)
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.5)
                                    .contentTransition(.numericText())
                                    .accessibilityLabel(converted.map { Money.text($0, quote) } ?? "No result")
                            }
                        }
                    }
                    rateCard
                    Label("Free for everyone. Rates come from Frankfurter (European Central Bank) and, for pesos, the BCRA official rate. No account or subscription needed.", systemImage: "gift")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(Spacing.page)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .background(AppBackground())
            .navigationTitle("Currency converter")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onAppear(perform: initialize)
            .task(id: base + quote) { await load() }
        }
    }

    private var rateCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                if let rate, base != quote {
                    Text("1 \(base) = \(FXMath.rateText(rate.rateE8)) \(quote)")
                        .font(.headline)
                        .foregroundStyle(Palette.ink)
                    Text(rate.source == "Manual" ? "Your rate, saved on this device" : rate.sourceLabel + (fx.offline ? " · offline, last saved rate" : ""))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if loading {
                    HStack(spacing: 8) { ProgressView(); Text("Getting today’s rate…").font(.subheadline).foregroundStyle(.secondary) }
                } else if let failure {
                    InlineError(text: failure)
                }
                Toggle(isOn: $useOwn) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Use my own rate").font(.subheadline.weight(.semibold))
                        Text([base, quote].contains("ARS") ? "For the blue dollar or a cash rate. BCRA official stays the default." : "For a card or cash rate.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .onChange(of: useOwn) { _, on in
                    if on { ownRate = rate.map { NSDecimalNumber(decimal: Decimal($0.rateE8) / 100_000_000).stringValue } ?? "" }
                    else { fx.setManual(base, quote, rateE8: nil) }
                }
                if useOwn {
                    HStack {
                        Text("1 \(base) =").font(.subheadline).foregroundStyle(.secondary)
                        TextField("Rate", text: $ownRate)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                            .font(.splitAmount(17))
                            .accessibilityLabel("Your rate, one \(base) in \(quote)")
                        Text(quote).font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 12)
                    .frame(minHeight: 48)
                    .background(Palette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .onChange(of: ownRate) { _, text in fx.setManual(base, quote, rateE8: Exchange.units(text)) }
                    Text("Used for approximate totals on this device. Expenses keep the rate saved with them.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func currencyMenu(_ selection: Binding<String>, label: String) -> some View {
        Menu {
            Picker(label, selection: selection) {
                ForEach(Money.currencies, id: \.self) { Text($0).tag($0) }
            }
        } label: {
            HStack(spacing: 4) {
                Text(selection.wrappedValue).font(.headline)
                Image(systemName: "chevron.down").font(.caption2.weight(.bold))
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 40)
            .foregroundStyle(Palette.ink)
            .glassCapsule(tint: Palette.card.opacity(0.4))
        }
        .accessibilityLabel("\(label) currency, \(selection.wrappedValue)")
    }

    private func initialize() {
        guard !initialized else { return }
        initialized = true
        base = from ?? (fx.home == "ARS" ? "USD" : fx.home)
        quote = to ?? (base == "ARS" ? "USD" : "ARS")
        if base == quote { quote = Money.currencies.first { $0 != base } ?? "EUR" }
        amount = initialAmount.map { Money.input($0) } ?? "100"
        useOwn = fx.manualRate(base, quote) != nil
        if let own = fx.manualRate(base, quote) { ownRate = NSDecimalNumber(decimal: Decimal(own) / 100_000_000).stringValue }
    }

    private func load() async {
        guard base != quote else { return }
        useOwn = fx.manualRate(base, quote) != nil
        loading = true; failure = nil
        await fx.refresh(currencies: [base], into: quote)
        loading = false
        if fx.rate(base, quote) == nil { failure = "No rate available. Check your connection or use your own rate." }
    }
}
