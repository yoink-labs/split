import SwiftUI

/// Fixed exchange rates for a trip, the same as the web's group settings.
/// New expenses in a saved currency start from this rate; saved expenses keep theirs.
struct TripRatesSection: View {
    var group: ExpenseGroup
    var canEdit: Bool
    var run: (@escaping @MainActor () async throws -> Void) -> Void

    @EnvironmentObject private var store: ExpenseStore
    @State private var currency = ""
    @State private var rate = ""

    private var rates: [(String, Int64)] {
        (group.tripRates ?? [:]).sorted { $0.key < $1.key }
    }

    var body: some View {
        Section {
            if rates.isEmpty {
                Text("No custom rates saved.").foregroundStyle(.secondary)
            }
            ForEach(rates, id: \.0) { code, value in
                Button {
                    currency = code
                    rate = FXMath.rateText(value).replacingOccurrences(of: ",", with: "")
                } label: {
                    LabeledContent("1 \(code)", value: "\(FXMath.rateText(value)) \(group.currency)")
                        .monospacedDigit()
                }
                .disabled(!canEdit)
                .accessibilityHint(canEdit ? "Edits this rate" : "")
            }
            if canEdit {
                Picker("Expense currency", selection: $currency) {
                    ForEach(Money.currencies.filter { $0 != group.currency }, id: \.self) { Text($0).tag($0) }
                }
                LabeledContent("\(group.currency) per 1 \(currency)") {
                    TextField("Published rate", text: $rate)
                        .multilineTextAlignment(.trailing)
                        .keyboardType(.decimalPad)
                        .accessibilityIdentifier("trip-rate-value")
                }
                Button(rate.isEmpty && group.tripRates?[currency] != nil ? "Use published rates" : "Save rate") {
                    let input = rate.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
                    let value: Int64?
                    if input.isEmpty {
                        value = nil
                    } else {
                        guard let decimal = Decimal(string: input, locale: Locale(identifier: "en_US_POSIX")),
                              let parsed = FXMath.rateE8(decimal) else {
                            run { throw LedgerError.invalid("Enter a positive exchange rate.") }
                            return
                        }
                        value = parsed
                    }
                    let code = currency
                    run {
                        _ = try await store.groupAction(group.id, "trip-rate", [
                            "currency": code, "target": group.currency, "rateE8": (value as Any?) ?? NSNull(),
                        ])
                    }
                }
                .disabled(currency.isEmpty || (rate.isEmpty && group.tripRates?[currency] == nil))
            }
        } header: {
            Text("Exchange rates")
        } footer: {
            Text("Set default rates into \(group.currency) for new expenses. Saved expenses keep the rate they used. Clear a rate and save to use published rates again.")
        }
        .onAppear {
            guard currency.isEmpty else { return }
            currency = rates.first?.0 ?? (group.currency == "USD" ? "EUR" : "USD")
            rate = group.tripRates?[currency].map { FXMath.rateText($0).replacingOccurrences(of: ",", with: "") } ?? ""
        }
    }
}
