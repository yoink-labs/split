import SwiftUI

struct ConverterView: View {
    var initialAmount: Int64? = nil
    var from: String? = nil
    var to: String? = nil
    var initialDate: Date? = nil

    @EnvironmentObject private var fx: FXStore
    @Environment(\.dismiss) private var dismiss
    @State private var amount = ""
    @State private var base = "ARS"
    @State private var quote = "USD"
    @State private var historical = false
    @State private var date = Date.now
    @State private var revision = 0
    @State private var forceNextLookup = false
    @State private var loadedKey: [String] = []
    @State private var published: FXQuote?
    @State private var usingSavedRate = false
    @State private var usingFallback = false
    @State private var editingRate = false
    @State private var ownRate = ""
    @State private var initialized = false

    private var day: String { Exchange.localDay(date) }
    private var lookupKey: [String] { [base, quote, historical ? day : "", String(revision), String(initialized)] }
    private var matchesLookup: Bool { loadedKey == lookupKey }
    private var manual: FXQuote? {
        guard !historical, base != quote, let rate = fx.rate(base, quote), rate.source == "Manual" else { return nil }
        return rate
    }
    private var rate: FXQuote? {
        if base == quote { return fx.rate(base, quote) }
        return manual ?? (matchesLookup ? published : nil)
    }
    private var result: String? {
        guard let value = Money.parse(amount), let rate,
              let converted = FXMath.convert(value, rateE8: rate.rateE8) else { return nil }
        return (base == quote ? "" : "≈ ") + Money.text(converted, quote)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.s) {
                    amountCard
                    if base != quote {
                        rateCard
                        if !historical { manualCard }
                    }
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
            .task(id: lookupKey) { if initialized { await load() } }
            .onChange(of: [base, quote]) {
                editingRate = false
                ownRate = ""
            }
        }
    }

    private var amountCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .bottom, spacing: 8) {
                    currencyMenu($base, label: "From")
                    Button {
                        let prior = base
                        base = quote
                        quote = prior
                    } label: {
                        Image(systemName: "arrow.left.arrow.right")
                    }
                    .buttonStyle(IconButton())
                    .accessibilityLabel("Swap currencies")
                    currencyMenu($quote, label: "To")
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Amount in \(base)").font(.subheadline).foregroundStyle(.secondary)
                    TextField("0.00", text: $amount)
                        .font(.splitAmount(30))
                        .keyboardType(.decimalPad)
                        .accessibilityLabel("Amount in \(base)")
                }
                Divider()
                VStack(alignment: .leading, spacing: 4) {
                    Text(base == quote ? "Amount in \(quote)" : "Estimated amount in \(quote)")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Text(result ?? "—")
                        .font(.splitAmount(32, weight: .bold))
                        .foregroundStyle(Palette.evergreen)
                        .lineLimit(1)
                        .minimumScaleFactor(0.55)
                        .contentTransition(.numericText())
                        .accessibilityIdentifier("conversion-result")
                }
            }
        }
    }

    private var rateCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(title: "Exchange rate")
                Picker("Rate date", selection: $historical) {
                    Text("Latest").tag(false)
                    Text("By date").tag(true)
                }
                .pickerStyle(.segmented)
                if historical {
                    DatePicker("Rate date", selection: $date, in: ...Date.now, displayedComponents: .date)
                }
                if let rate {
                    Text("1 \(base) = \(FXMath.rateText(rate.rateE8)) \(quote)")
                        .font(.headline)
                        .fixedSize(horizontal: false, vertical: true)
                    if rate.source == "Manual" {
                        Text("Your rate · saved on this device")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        LabeledContent("Source", value: rate.source == "BCRA" ? "BCRA via Frankfurter" : rate.source == "Frankfurter" ? "ECB via Frankfurter" : "Frankfurter")
                        LabeledContent("Published", value: Exchange.date(fromDay: rate.date)?.formatted(date: .abbreviated, time: .omitted) ?? rate.date)
                        if usingSavedRate {
                            Text("Showing a saved quote. The service couldn’t be reached.")
                                .font(.caption).foregroundStyle(.secondary)
                        } else if usingFallback {
                            Text("The charge-date quote was unavailable. Showing the latest published rate.")
                                .font(.caption).foregroundStyle(.secondary)
                        } else if historical && day != rate.date {
                            Text("Showing the last published rate before the selected date.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                } else if !matchesLookup {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Getting the exchange rate…").font(.subheadline).foregroundStyle(.secondary)
                    }
                } else {
                    InlineError(text: "No published rate was available for this lookup.")
                }
                if manual == nil && (!historical || (matchesLookup && published == nil)) {
                    Button {
                        forceNextLookup = !historical
                        revision += 1
                    } label: {
                        Label(historical ? "Retry lookup" : "Refresh rate", systemImage: "arrow.clockwise")
                    }
                    .disabled(!matchesLookup)
                }
                Text("Reference rates are estimates. Your card or bank may charge a different rate or fees.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var manualCard: some View {
        Card {
            DisclosureGroup(isExpanded: $editingRate) {
                VStack(alignment: .leading, spacing: 8) {
                    TextField("Rate in \(quote)", text: $ownRate)
                        .keyboardType(.decimalPad)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Your rate, one \(base) in \(quote)")
                    Text("Used for balance estimates on this device. Saved expenses keep their original rates.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Save rate") {
                        guard let units = Exchange.units(ownRate) else { return }
                        fx.setManual(base, quote, rateE8: units)
                        editingRate = false
                    }
                    .disabled(Exchange.units(ownRate) == nil)
                    if manual != nil {
                        Button("Use published rate") {
                            fx.setManual(base, quote, rateE8: nil)
                            editingRate = false
                            revision += 1
                        }
                    }
                }
                .padding(.top, 8)
            } label: {
                Text(manual == nil ? "Enter your own rate" : "Edit your rate").font(.subheadline.weight(.semibold))
            }
            .onChange(of: editingRate) { _, open in
                if open {
                    ownRate = manual.map { NSDecimalNumber(decimal: Decimal($0.rateE8) / 100_000_000).stringValue } ?? ""
                }
            }
        }
    }

    private func currencyMenu(_ selection: Binding<String>, label: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary).accessibilityHidden(true)
            Picker(label, selection: selection) {
                ForEach(Money.currencies, id: \.self) { Text($0).tag($0) }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(Palette.raised, in: RoundedRectangle(cornerRadius: 12))
            .accessibilityLabel("\(label) currency")
        }
    }

    private func initialize() {
        guard !initialized else { return }
        quote = to ?? fx.home
        base = from ?? (quote == "USD" ? "ARS" : "USD")
        amount = initialAmount.map { Money.input($0) } ?? "100"
        if let initialDate, Exchange.localDay(initialDate) < Exchange.localDay(.now) {
            date = initialDate
            historical = true
        }
        initialized = true
    }

    private func load() async {
        let key = lookupKey
        let requestBase = base, requestQuote = quote
        guard requestBase != requestQuote else { return }
        let selectedDay = historical ? day : nil
        let force = forceNextLookup
        forceNextLookup = false
        let result: FXQuote?
        let saved: Bool
        var fallback = false
        if let selectedDay {
            result = try? await fx.quote(base: requestBase, target: requestQuote, date: selectedDay)
            fallback = result != nil && selectedDay < Exchange.localDay(.now)
                && fx.cache.published(requestBase, requestQuote, day: selectedDay) == nil
            saved = result != nil && fx.offline
        } else {
            await fx.refresh(currencies: [requestBase], into: requestQuote, force: force)
            result = fx.cache.published(requestBase, requestQuote)
            saved = fx.offline && result != nil
        }
        guard !Task.isCancelled, lookupKey == key else { return }
        published = result
        usingSavedRate = saved
        usingFallback = fallback
        loadedKey = key
    }
}
