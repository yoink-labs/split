import SwiftUI
import Foundation

/// The full Splitwise-style expense composer: amount and currency, multiple
/// payers, five split modes, categories, notes, receipts and repeat schedules.
struct AddExpenseView: View {
    var group: ExpenseGroup
    var original: LedgerEntry? = nil
    var onSaved: (() -> Void)? = nil

    @EnvironmentObject var store: ExpenseStore
    @EnvironmentObject var session: SessionStore
    @Environment(\.dismiss) var dismiss

    @State private var initialized = false
    @State private var entryID = UUID().uuidString
    @State private var title = ""
    @State private var amount = ""
    @State private var currency = ""
    @State private var purchaseDate = Date()
    @State private var category = ""
    @State private var notes = ""
    @State private var payers: [Payer] = []
    @State private var payerText: [String: String] = [:]
    @State private var mode: SplitMode = .equal
    @State private var selected = Set<String>()
    @State private var values: [String: String] = [:]
    @State private var bill = ReceiptBill()
    @State private var photos: [ReceiptPhoto] = []
    @State private var itemized = false
    @State private var reading = false
    @State private var rateText = ""
    @State private var manualRate = false
    @State private var quote: Exchange?
    @State private var rateError: String?
    @State private var recurrence = "off"
    @State private var repeatWorking = false
    @State private var saving = false
    @State private var addingMember = false
    @State private var error: String?
    @FocusState private var amountFocused: Bool
    @State private var width: CGFloat = 0

    private var current: ExpenseGroup { store.group(group.id) ?? group }
    private var showExchange: Bool { !currency.isEmpty && currency != group.currency }
    private var quoteDate: String {
        original.map { String($0.createdAt.prefix(10)) } ?? Exchange.localDay(purchaseDate)
    }
    private var people: [String] {
        current.members.filter { selected.contains($0.id) }.map(\.id)
    }
    private var totalAmount: Int64? {
        if itemized { return bill.total > 0 ? bill.total : nil }
        guard let value = Money.parse(amount), value > 0 else { return nil }
        return value
    }
    private var ledgerValues: [String: String] {
        values.mapValues { value in
            var clean = value
                .replacingOccurrences(of: "−", with: "-")
                .replacingOccurrences(of: "–", with: "-")
            if clean.hasPrefix("+") { clean.removeFirst() }
            return clean
        }
    }
    private var portions: [Portion]? {
        guard let total = totalAmount, total > 0, !people.isEmpty else { return nil }
        return try? Ledger.split(total: total, people: people, mode: mode, values: ledgerValues)
    }
    private var previewPayerID: String {
        payers.first?.memberID ?? current.members.first?.id ?? ""
    }
    private var receiptPortions: [Portion] {
        guard !bill.items.isEmpty, bill.total > 0, !previewPayerID.isEmpty else { return [] }
        return (try? bill.split(payer: previewPayerID)) ?? []
    }
    private var payerSum: Int64? {
        guard payers.count > 1 else { return totalAmount }
        var sum: Int64 = 0
        for payer in payers {
            guard let value = Money.parse(payerText[payer.memberID] ?? "") else { return nil }
            sum += value
        }
        return sum
    }
    private var inputHint: String {
        switch mode {
        case .percent: return "0"
        case .shares: return "1"
        case .adjustment: return "±0.00"
        default: return "0.00"
        }
    }
    private var inputSuffix: String {
        switch mode {
        case .percent: return "%"
        case .shares: return "sh"
        case .equal: return ""
        case .exact, .adjustment: return currency
        }
    }
    private var repeatAllowed: Bool {
        guard let original, !store.isDemo else { return false }
        return original.kind == "expense" && original.bill == nil && original.exchange == nil
    }
    private var categoryOptions: [CategoryMeta] {
        var options = CategoryMeta.grid
        if !category.isEmpty, category.caseInsensitiveCompare("General") != .orderedSame,
           !options.contains(where: { $0.name.caseInsensitiveCompare(category) == .orderedSame }) {
            options.append(CategoryMeta.named(category))
        }
        return options
    }
    private var liveExchange: Exchange? {
        guard currency != group.currency else { return nil }
        if manualRate, let units = Exchange.units(rateText) {
            return Exchange(target: group.currency, rateE8: units, date: quoteDate, source: "Manual")
        }
        if let quote, quote.target == group.currency, quote.rateE8 > 0 { return quote }
        return nil
    }
    private var convertedTotal: Int64? {
        guard let exchange = liveExchange, let total = totalAmount, total > 0 else { return nil }
        var raw = Decimal(total) * exchange.rate
        var rounded = Decimal()
        NSDecimalRound(&rounded, &raw, 0, .plain)
        guard rounded > 0, rounded <= Decimal(Money.maxAmount) else { return nil }
        return NSDecimalNumber(decimal: rounded).int64Value
    }
    private var splitIssue: String? {
        guard mode != .equal, !itemized, let total = totalAmount, total > 0, !people.isEmpty else { return nil }
        let filled = people.allSatisfy {
            !(values[$0] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        guard mode == .adjustment || filled else { return nil }
        do {
            _ = try Ledger.split(total: total, people: people, mode: mode, values: ledgerValues)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                Group {
                    if initialized {
                        if width >= 820 {
                            // Wide sheets (iPad, iPhone Duo open): money on the left,
                            // context and the receipt review on the right.
                            HStack(alignment: .top, spacing: 16) {
                                VStack(spacing: 16) {
                                    amountCard
                                    detailsCard
                                    if showExchange { exchangeCard }
                                    payersCard
                                    if itemized { receiptSplitCard } else { splitCard }
                                }
                                .frame(maxWidth: .infinity)
                                VStack(spacing: 16) {
                                    receiptCard
                                    categoryCard
                                    notesCard
                                    if repeatAllowed { repeatCard }
                                }
                                .frame(maxWidth: .infinity)
                            }
                        } else {
                            VStack(spacing: 16) {
                                amountCard
                                detailsCard
                                if showExchange { exchangeCard }
                                payersCard
                                if itemized { receiptSplitCard } else { splitCard }
                                categoryCard
                                notesCard
                                receiptCard
                                if repeatAllowed { repeatCard }
                            }
                        }
                    } else {
                        ProgressView("Preparing expense…")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 80)
                    }
                }
                .padding(16)
                .frame(maxWidth: 1080)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            .background(AppBackground())
            .navigationTitle(original == nil ? "New expense" : "Edit expense")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(saving)
                }
            }
            .safeAreaInset(edge: .bottom) { saveBar }
            .sheet(isPresented: $addingMember) {
                MemberEditor { draft in
                    let id = try await store.addMember(groupID: group.id, draft: draft)
                    selected.insert(id)
                    if payers.isEmpty {
                        payers = [Payer(memberID: id, amount: 0)]
                    }
                }
            }
            .interactiveDismissDisabled(saving)
            .onAppear(perform: initialize)
        }
    }

    // MARK: - Amount

    private var amountCard: some View {
        Card(padding: 20) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .center) {
                    Text(itemized ? "Receipt total" : "Amount")
                        .font(.splitEyebrow)
                        .foregroundStyle(.secondary)
                    Spacer()
                    currencyMenu
                }
                if itemized {
                    Text(Money.text(bill.total, currency))
                        .font(.splitAmount(38))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.55)
                        .accessibilityIdentifier("expense-amount")
                        .accessibilityLabel("Receipt total \(Money.text(bill.total, currency))")
                    Text(bill.items.isEmpty ? "Add line items below to set the total." : "\(bill.items.count) \(bill.items.count == 1 ? "item" : "items") from your receipt.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    TextField("0.00", text: $amount)
                        .font(.splitAmount(38))
                        .foregroundStyle(Palette.ink)
                        .keyboardType(.decimalPad)
                        .focused($amountFocused)
                        .accessibilityIdentifier("expense-amount")
                        .accessibilityLabel("Amount in \(currency)")
                }
                if totalAmount != nil, currency != group.currency, let converted = convertedTotal {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Palette.evergreen)
                        Text("Settles in \(group.currency) at \(Money.text(converted, group.currency))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    private var currencyMenu: some View {
        Menu {
            ForEach(Money.currencies, id: \.self) { code in
                Button {
                    currency = code
                    quote = nil
                    rateText = ""
                    rateError = nil
                    manualRate = false
                    error = nil
                } label: {
                    if code == currency {
                        Label(code, systemImage: "checkmark")
                    } else {
                        Text(code)
                    }
                }
            }
        } label: {
            HStack(spacing: 5) {
                Text(currency.isEmpty ? group.currency : currency)
                    .font(.subheadline.weight(.bold))
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2.weight(.bold))
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .foregroundStyle(Palette.ink)
            .background(Palette.raised)
            .clipShape(Capsule())
            .overlay(Capsule().stroke(Palette.line, lineWidth: 1))
            .contentShape(Capsule())
        }
        .accessibilityIdentifier("expense-currency")
        .accessibilityLabel("Currency, \(currency)")
    }

    // MARK: - Details

    private var detailsCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                SectionHeader(title: "Details", subtitle: "What was this for?")
                TextField("Description", text: $title)
                    .font(.body)
                    .textInputAutocapitalization(.sentences)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 12)
                    .frame(minHeight: 48)
                    .background(Palette.raised)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Palette.line, lineWidth: 1))
                    .accessibilityIdentifier("expense-title")
                    .accessibilityLabel("Description")
                if title.count > 100 {
                    Text("\(title.count)/120")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(title.count > 120 ? Palette.negative : .secondary)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                Rectangle().fill(Palette.line).frame(height: 1)
                DatePicker("Date", selection: $purchaseDate, in: ...Date(), displayedComponents: .date)
                    .font(.subheadline.weight(.medium))
                    .disabled(original != nil)
                    .accessibilityLabel("Expense date")
                if original != nil {
                    Text("The original date is kept when you edit an expense.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: - Exchange

    private var exchangeCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(
                    title: "Settle in \(group.currency)",
                    subtitle: "Your group records balances in \(group.currency)."
                )
                Picker("Rate source", selection: $manualRate) {
                    Text("Published").tag(false)
                    Text("Manual").tag(true)
                }
                .pickerStyle(.segmented)
                .accessibilityLabel("Rate source")
                if manualRate {
                    TextField("1 \(currency) in \(group.currency)", text: $rateText)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                        .font(.splitAmount(17))
                        .padding(.horizontal, 12)
                        .frame(minHeight: 48)
                        .background(Palette.raised)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Palette.line, lineWidth: 1))
                        .accessibilityLabel("Exchange rate, one \(currency) in \(group.currency)")
                } else if let quote {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(quote.description(base: currency))
                            .font(.subheadline)
                            .foregroundStyle(Palette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        if let total = totalAmount, let converted = convertedTotal {
                            Text("\(Money.text(total, currency)) becomes \(Money.text(converted, group.currency)).")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                } else if let rateError {
                    InlineError(text: rateError)
                    Button("Enter a manual rate") { manualRate = true }
                        .buttonStyle(GhostButton())
                } else {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Looking up the published rate…")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .frame(minHeight: 44, alignment: .leading)
                }
                Text("Published rates use the expense date. Manual rates are saved with this expense.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .task(id: currency + quoteDate) { await loadRate() }
        }
    }

    private func loadRate() async {
        let base = currency
        guard !base.isEmpty else { return }
        rateText = ""
        quote = nil
        rateError = nil
        manualRate = false
        if let original, base == original.currency, let exchange = original.exchange, exchange.target == group.currency {
            if exchange.source == "Manual" {
                manualRate = true
                rateText = NSDecimalNumber(decimal: exchange.rate).stringValue
            } else {
                quote = exchange
                return
            }
        }
        do {
            let fetched = try await Exchange.fetch(base: base, target: group.currency, date: quoteDate)
            guard !Task.isCancelled, base == currency else { return }
            quote = fetched
        } catch {
            guard !Task.isCancelled else { return }
            rateError = "Published rate unavailable. Enter a manual rate."
        }
    }

    // MARK: - Payers

    private var payersCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Paid by").font(.headline).foregroundStyle(Palette.ink)
                        Text(payers.count > 1 ? "What each person put in" : "One payer is the simplest split")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    Button { addPayer() } label: {
                        Label("Add", systemImage: "plus")
                            .font(.subheadline.weight(.semibold))
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Palette.evergreen)
                    .accessibilityIdentifier("expense-add-payer")
                    .accessibilityLabel("Add another payer")
                }
                if payers.isEmpty {
                    Text("This group has no members to choose from yet.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(payers) { payer in
                        payerRow(payer)
                        if payer.memberID != payers.last?.memberID {
                            Rectangle().fill(Palette.line).frame(height: 1)
                        }
                    }
                }
                if payers.count > 1 {
                    HStack(spacing: 8) {
                        Text("Paid \(payerSum.map { Money.text($0, currency) } ?? "—") of \(totalAmount.map { Money.text($0, currency) } ?? "—")")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(totalAmount != nil && payerSum == totalAmount ? Palette.positive : Palette.negative)
                        Spacer(minLength: 0)
                        Button("Split evenly") { splitPayersEvenly() }
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Palette.evergreen)
                            .frame(minHeight: 44)
                            .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func payerRow(_ payer: Payer) -> some View {
        let name = personName(payer.memberID)
        return HStack(spacing: 12) {
            Avatar(name: name, size: 36)
            VStack(alignment: .leading, spacing: 5) {
                Text(displayName(payer.memberID))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                if payers.count > 1 {
                    HStack(spacing: 4) {
                        TextField("0.00", text: payerBinding(payer.memberID))
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.leading)
                            .font(.splitAmount(15))
                            .frame(maxWidth: 120)
                            .accessibilityLabel("Amount paid by \(name)")
                        Text(currency)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                } else if let total = totalAmount {
                    Text("Paid the full \(Money.text(total, currency))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Paid the full amount")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            if payers.count > 1 {
                Button { removePayer(payer) } label: {
                    Image(systemName: "minus.circle")
                        .font(.body.weight(.semibold))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Palette.negative)
                .accessibilityLabel("Remove \(name) as a payer")
            } else if let total = totalAmount {
                AmountText(minor: total, currency: currency, size: 15)
            }
        }
    }

    private func addPayer() {
        guard let person = current.members.first(where: { member in
            !payers.contains(where: { $0.memberID == member.id })
        }) else {
            error = "Everyone in this group is already a payer."
            return
        }
        if payers.count == 1, let first = payers.first, let total = totalAmount {
            payerText[first.memberID] = Money.input(total)
        }
        payers.append(Payer(memberID: person.id, amount: 0))
        payerText[person.id] = "0.00"
        error = nil
    }

    private func removePayer(_ payer: Payer) {
        guard payers.count > 1 else { return }
        payers.removeAll { $0.memberID == payer.memberID }
        payerText[payer.memberID] = nil
        error = nil
    }

    private func splitPayersEvenly() {
        guard let total = totalAmount, !payers.isEmpty,
              let shares = try? Ledger.allocate(total: total, weights: payers.map { _ in 1 }) else { return }
        for (payer, share) in zip(payers, shares) {
            payerText[payer.memberID] = Money.input(share)
        }
        error = nil
    }

    private func payerBinding(_ id: String) -> Binding<String> {
        Binding(
            get: { payerText[id] ?? "" },
            set: { payerText[id] = $0 }
        )
    }

    // MARK: - Split

    private var splitCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(title: "Split", subtitle: mode.detail)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(SplitMode.allCases, id: \.self) { option in
                            ExpenseChoiceChip(title: option.title, selected: mode == option) {
                                mode = option
                                values = [:]
                                error = nil
                            }
                            .accessibilityIdentifier("expense-split-mode-\(option.rawValue)")
                        }
                    }
                    .padding(.vertical, 2)
                }
                Rectangle().fill(Palette.line).frame(height: 1)
                if current.members.isEmpty {
                    Text("Add someone to this group before choosing a split.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(current.members) { person in
                        participantRow(person)
                    }
                }
                Button { addingMember = true } label: {
                    Label("Add a person", systemImage: "person.badge.plus")
                        .font(.subheadline.weight(.semibold))
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Palette.evergreen)
                .accessibilityIdentifier("expense-add-member")
                if mode == .adjustment {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Start from an equal split, then add + or − for each person. Adjustments must add up to zero.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Button("Start from equal") {
                            values = Dictionary(uniqueKeysWithValues: people.map { ($0, "0.00") })
                            error = nil
                        }
                        .buttonStyle(GhostButton())
                        .disabled(people.isEmpty)
                    }
                    .padding(.top, 2)
                }
                if let splitIssue {
                    InlineError(text: splitIssue)
                }
                splitSummary
            }
        }
    }

    private func participantRow(_ person: Person) -> some View {
        let included = selected.contains(person.id)
        let share = preview(person.id)
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 10) {
                Button {
                    toggle(person)
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: included ? "checkmark.circle.fill" : "circle")
                            .font(.system(size: 19, weight: .semibold))
                            .foregroundStyle(included ? Palette.evergreen : .secondary)
                        Avatar(name: person.name, size: 28)
                        Text(displayName(person.id))
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Palette.ink)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("expense-split-\(person.id)")
                .accessibilityLabel("Include \(person.name) in the split")
                .accessibilityValue(included ? "Included" : "Not included")
                .accessibilityAddTraits(included ? .isSelected : [])

                if included {
                    if mode == .equal {
                        if let share {
                            AmountText(minor: share, currency: currency, size: 15)
                                .frame(maxWidth: 104, alignment: .trailing)
                        } else {
                            Text("—").foregroundStyle(.tertiary)
                        }
                    } else {
                        HStack(spacing: 3) {
                            TextField(inputHint, text: valueBinding(person.id))
                                .keyboardType(mode == .adjustment ? .numbersAndPunctuation : .decimalPad)
                                .multilineTextAlignment(.trailing)
                                .font(.splitAmount(15))
                                .frame(width: 76)
                                .accessibilityLabel("\(person.name) \(mode.title)")
                            Text(inputSuffix)
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .frame(minWidth: 14, alignment: .leading)
                        }
                    }
                }
            }
            if included, mode != .equal, let share {
                Text("Share \(Money.text(share, currency))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 57)
            }
            if included, mode == .adjustment {
                Text("Add + or − to the equal share. The adjustments must total zero.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .padding(.leading, 57)
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var splitSummary: some View {
        if let total = totalAmount, !people.isEmpty {
            HStack(spacing: 8) {
                Image(systemName: portions == nil ? "exclamationmark.circle" : "checkmark.circle.fill")
                    .foregroundStyle(portions == nil ? Palette.amber : Palette.positive)
                Text(portions == nil
                     ? "Check the split before saving."
                     : "\(Money.text(total, currency)) allocated across \(people.count) \(people.count == 1 ? "person" : "people").")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
        } else if totalAmount != nil {
            Text("Choose at least one person to share this expense.")
                .font(.caption)
                .foregroundStyle(Palette.negative)
        }
    }

    private var receiptSplitCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "Split", subtitle: "Shares come from the receipt line items.")
                if receiptPortions.isEmpty {
                    Text("Add at least one line item to preview each person’s share.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(receiptPortions, id: \.memberID) { portion in
                        HStack(spacing: 10) {
                            Avatar(name: personName(portion.memberID), size: 30)
                            Text(displayName(portion.memberID))
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(Palette.ink)
                            Spacer()
                            AmountText(minor: portion.amount, currency: currency, size: 15)
                        }
                        .frame(minHeight: 40)
                        .accessibilityElement(children: .combine)
                    }
                }
                Text("People can claim purchases after you save. Unclaimed items stay with \(personName(previewPayerID)).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func toggle(_ person: Person) {
        if selected.contains(person.id) {
            selected.remove(person.id)
        } else {
            selected.insert(person.id)
        }
        error = nil
    }

    private func preview(_ id: String) -> Int64? {
        portions?.first { $0.memberID == id }?.amount
    }

    private func valueBinding(_ id: String) -> Binding<String> {
        Binding(
            get: { values[id] ?? "" },
            set: { values[id] = $0 }
        )
    }

    // MARK: - Category

    private var categoryCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(title: "Category", subtitle: category.isEmpty ? "General" : category)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 118), spacing: 8)], alignment: .leading, spacing: 8) {
                    categoryButton(CategoryMeta.all[0], clearing: true)
                    ForEach(categoryOptions) { meta in
                        categoryButton(meta, clearing: false)
                    }
                }
            }
        }
    }

    private func categoryButton(_ meta: CategoryMeta, clearing: Bool) -> some View {
        let isSelected = clearing
            ? (category.isEmpty || category.caseInsensitiveCompare("General") == .orderedSame)
            : category.caseInsensitiveCompare(meta.name) == .orderedSame
        return Button {
            category = clearing ? "" : meta.name
            error = nil
        } label: {
            Chip(title: meta.name, symbol: meta.symbol, selected: isSelected)
        }
        .buttonStyle(.plain)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityIdentifier("expense-category-\(meta.name)")
        .accessibilityLabel("\(meta.name) category")
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    // MARK: - Notes and receipt

    private var notesCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "Notes", subtitle: "Optional context for your group.")
                TextField("Add a note for everyone in \(group.name)…", text: $notes, axis: .vertical)
                    .lineLimit(3...8)
                    .font(.body)
                    .textInputAutocapitalization(.sentences)
                    .padding(12)
                    .background(Palette.raised)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Palette.line, lineWidth: 1))
                    .accessibilityIdentifier("expense-notes")
                    .accessibilityLabel("Notes")
                    .onChange(of: notes) { _, value in
                        if value.count > 2000 { notes = String(value.prefix(2000)) }
                    }
                if notes.count >= 1900 {
                    Text("\(notes.count)/2,000")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(notes.count >= 2000 ? Palette.negative : .secondary)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
        }
    }

    private var receiptCard: some View {
        Card {
            ReceiptComposer(
                bill: $bill,
                photos: $photos,
                itemized: $itemized,
                processing: $reading,
                existing: original?.receiptIDs?.count ?? 0,
                mustItemize: original?.bill != nil,
                members: current.members,
                payerID: previewPayerID,
                currentUserID: session.userID,
                currency: currency,
                chipsEditable: !(original?.bill?.items.contains { !$0.memberIDs.isEmpty } ?? false)
            )
        }
    }

    // MARK: - Repeat

    private var repeatCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "Repeat", subtitle: "Add this expense again on a schedule.")
                if repeatWorking {
                    ProgressView().frame(minHeight: 44, alignment: .leading)
                }
                Menu {
                    ForEach(["off", "daily", "weekly", "monthly", "yearly"], id: \.self) { cadence in
                        Button {
                            Task { await setRepeat(cadence) }
                        } label: {
                            if recurrence == cadence {
                                Label(cadence.capitalized, systemImage: "checkmark")
                            } else {
                                Text(cadence.capitalized)
                            }
                        }
                    }
                } label: {
                    HStack {
                        Text(recurrence == "off" ? "Off" : recurrence.capitalized)
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.caption2.weight(.bold))
                    }
                    .padding(.horizontal, 12)
                    .frame(minHeight: 48)
                    .foregroundStyle(Palette.ink)
                    .background(Palette.raised)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Palette.line, lineWidth: 1))
                    .contentShape(Rectangle())
                }
                .accessibilityLabel("Repeat schedule, \(recurrence == "off" ? "off" : recurrence)")
                Text("Changing the schedule updates this expense now. It does not change the amount or split.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func setRepeat(_ cadence: String) async {
        guard let original, !repeatWorking else { return }
        repeatWorking = true
        error = nil
        defer { repeatWorking = false }
        do {
            _ = try await store.groupAction(group.id, "repeat", ["entryID": original.id, "cadence": cadence])
            recurrence = cadence
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: - Save

    private var saveBar: some View {
        VStack(spacing: 8) {
            if let error {
                InlineError(text: error)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 10) {
                if original == nil {
                    Button {
                        Task { await save(another: true) }
                    } label: {
                        Label("Save + new", systemImage: "plus")
                            .labelStyle(.titleAndIcon)
                            .lineLimit(1)
                    }
                    .buttonStyle(GhostButton())
                    .fixedSize()
                    .disabled(!initialized || saving || reading || repeatWorking)
                    .accessibilityIdentifier("save-expense-another")
                    .accessibilityLabel("Save and add another")
                }
                Button {
                    Task { await save(another: false) }
                } label: {
                    HStack(spacing: 8) {
                        if saving { ProgressView().tint(Palette.paper) }
                        Text(saving ? "Saving…" : "Save expense")
                        if !saving, let total = totalAmount {
                            Text(Money.text(total, currency))
                                .font(.splitAmount(14, weight: .semibold))
                                .opacity(0.75)
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                        }
                    }
                }
                .buttonStyle(SolidButton())
                .disabled(!initialized || saving || reading || repeatWorking)
                .accessibilityIdentifier("save-expense")
                .accessibilityLabel(saving ? "Saving expense" : "Save expense")
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 6)
        .background(.ultraThinMaterial, ignoresSafeAreaEdges: .bottom)
        .overlay(alignment: .top) {
            Rectangle().fill(Palette.line).frame(height: 0.5)
        }
    }

    private func save(another: Bool) async {
        guard !saving, !reading, !repeatWorking else { return }
        saving = true
        error = nil
        defer { saving = false }
        do {
            let entry = try buildEntry()
            try await store.saveReceipted(entry, original: original, photos: photos)
            if another, original == nil {
                resetForAnother()
            } else {
                onSaved?()
                dismiss()
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func buildEntry() throws -> LedgerEntry {
        guard initialized else { throw LedgerError.invalid("The expense is still loading. Try again in a moment.") }
        guard Money.currencies.contains(currency) else { throw LedgerError.invalid("Choose a supported currency.") }
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleanTitle.count <= 120 else { throw LedgerError.invalid("Use a description of 120 characters or fewer.") }
        guard notes.count <= 2000 else { throw LedgerError.invalid("Notes can be up to 2,000 characters.") }
        guard !current.members.isEmpty else { throw LedgerError.invalid("Add someone to this group before recording an expense.") }

        let total: Int64
        if itemized {
            guard bill.total > 0 else { throw LedgerError.invalid("Add at least one line item so the receipt has a total.") }
            guard bill.total <= Money.maxAmount else { throw LedgerError.invalid("This receipt total is too large to record.") }
            total = bill.total
        } else {
            guard let parsed = Money.parse(amount), parsed > 0 else {
                throw LedgerError.invalid("Enter an amount greater than zero, with up to two decimal places.")
            }
            total = parsed
        }

        let payerList = try validatedPayers(total: total)
        guard let primary = payerList.first else { throw LedgerError.invalid("Choose who paid for this expense.") }

        let splits: [Portion]
        if itemized {
            splits = try bill.split(payer: primary.memberID)
            guard !splits.isEmpty else { throw LedgerError.invalid("Add line items with prices to split this receipt.") }
        } else {
            guard !people.isEmpty else { throw LedgerError.invalid("Choose at least one person to share this expense.") }
            splits = try Ledger.split(total: total, people: people, mode: mode, values: ledgerValues)
        }

        let created: String
        if let original {
            created = original.createdAt
        } else if currency != group.currency {
            created = quoteDate + "T12:00:00Z"
        } else {
            created = ISO8601DateFormatter().string(from: purchaseDate)
        }

        var entry = LedgerEntry(
            id: entryID,
            groupID: group.id,
            title: cleanTitle.isEmpty ? "Shared expense" : cleanTitle,
            amount: total,
            currency: currency,
            paidBy: primary.memberID,
            splits: splits,
            category: category.isEmpty ? nil : category,
            bill: itemized ? bill : nil,
            receiptIDs: original?.receiptIDs,
            kind: original?.kind ?? "expense",
            editable: original?.editable,
            recurrence: recurrence == "off" ? nil : recurrence,
            splitMode: itemized ? .exact : mode,
            createdAt: created
        )
        if payerList.count > 1 { entry.payers = payerList }
        let cleanNotes = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        entry.notes = cleanNotes.isEmpty ? nil : cleanNotes
        entry.commentCount = original?.commentCount
        entry.likeCount = original?.likeCount
        entry.likedByMe = original?.likedByMe

        if let exchange = try resolvedExchange() {
            entry.exchange = exchange
            _ = try exchange.converting(entry)
        }
        if let original, !itemized, entry.splits == original.splits {
            entry.splitMode = original.splitMode
        }
        return entry
    }

    private func validatedPayers(total: Int64) throws -> [Payer] {
        guard !payers.isEmpty else { throw LedgerError.invalid("Choose who paid for this expense.") }
        let memberIDs = Set(current.members.map(\.id))
        guard Set(payers.map(\.memberID)).count == payers.count else {
            throw LedgerError.invalid("Each payer can only be listed once.")
        }
        guard payers.allSatisfy({ memberIDs.contains($0.memberID) }) else {
            throw LedgerError.invalid("Choose payers from this group.")
        }
        if payers.count == 1 {
            return [Payer(memberID: payers[0].memberID, amount: total)]
        }
        var result: [Payer] = []
        for payer in payers {
            guard let value = Money.parse(payerText[payer.memberID] ?? "") else {
                throw LedgerError.invalid("Enter how much each payer paid, with up to two decimal places.")
            }
            result.append(Payer(memberID: payer.memberID, amount: value))
        }
        guard result.reduce(0, { $0 + $1.amount }) == total else {
            throw LedgerError.invalid("What each payer paid must add up to \(Money.text(total, currency)).")
        }
        return result
    }

    private func resolvedExchange() throws -> Exchange? {
        guard currency != group.currency else { return nil }
        if manualRate {
            guard let units = Exchange.units(rateText) else {
                throw LedgerError.invalid("Enter a positive manual rate with up to eight decimal places.")
            }
            return Exchange(target: group.currency, rateE8: units, date: quoteDate, source: "Manual")
        }
        guard let quote, quote.target == group.currency, quote.rateE8 > 0 else {
            throw LedgerError.invalid("Wait for the published rate, or choose Manual to enter your own rate.")
        }
        return quote
    }

    // MARK: - Initialization

    private func initialize() {
        guard !initialized else { return }
        initialized = true
        currency = original?.currency ?? group.currency
        title = original?.title ?? ""
        amount = original.map { Money.input($0.amount) } ?? ""
        category = original?.category ?? ""
        notes = original?.notes ?? ""
        bill = original?.bill ?? ReceiptBill()
        itemized = original?.bill != nil
        recurrence = original?.recurrence ?? "off"

        if let original {
            entryID = original.id
            purchaseDate = ISO8601DateFormatter().date(from: original.createdAt) ?? Date()
            payers = original.allPayers
            payerText = Dictionary(uniqueKeysWithValues: original.allPayers.map { ($0.memberID, Money.input($0.amount)) })
            if currency != group.currency, let exchange = original.exchange, exchange.target == group.currency {
                if exchange.source == "Manual" {
                    manualRate = true
                    rateText = NSDecimalNumber(decimal: exchange.rate).stringValue
                } else {
                    quote = exchange
                }
            }
            let known = Set(current.members.map(\.id))
            selected = Set(original.splits.map(\.memberID)).intersection(known)
            switch original.splitMode {
            case .equal:
                mode = .equal
            case .adjustment:
                mode = .adjustment
                prepareAdjustmentValues()
            case .exact, .percent, .shares:
                mode = .exact
                values = Dictionary(uniqueKeysWithValues: original.splits.map { ($0.memberID, Money.input($0.amount)) })
            }
        } else {
            let me = current.members.first { $0.userID == session.userID } ?? current.members.first
            if let me { payers = [Payer(memberID: me.id, amount: 0)] }
            selected = Set(current.members.map(\.id))
            if let weights = current.defaultWeights, !weights.isEmpty {
                let known = Set(current.members.map(\.id))
                let ids = weights.keys.filter { known.contains($0) }
                if !ids.isEmpty {
                    selected = Set(ids)
                    mode = .shares
                    values = Dictionary(uniqueKeysWithValues: ids.map { ($0, String(weights[$0] ?? 1)) })
                }
            }
            Task {
                try? await Task.sleep(for: .milliseconds(300))
                if initialized && !itemized { amountFocused = true }
            }
        }
    }

    private func prepareAdjustmentValues() {
        guard let total = Money.parse(amount), total > 0, !people.isEmpty,
              let base = try? Ledger.split(total: total, people: people, mode: .equal, values: [:]) else { return }
        values = Dictionary(uniqueKeysWithValues: base.map { portion in
            let actual = original?.splits.first { $0.memberID == portion.memberID }?.amount ?? portion.amount
            return (portion.memberID, Money.input(actual - portion.amount))
        })
    }

    private func resetForAnother() {
        amount = ""
        title = ""
        notes = ""
        bill = ReceiptBill()
        photos = []
        itemized = false
        rateText = ""
        quote = nil
        rateError = nil
        manualRate = false
        purchaseDate = Date()
        entryID = UUID().uuidString
        error = nil
        values = [:]
        payerText = [:]
        if let me = current.members.first(where: { $0.userID == session.userID }) ?? current.members.first {
            payers = [Payer(memberID: me.id, amount: 0)]
        } else {
            payers = []
        }
        amountFocused = true
    }

    // MARK: - Names

    private func personName(_ id: String) -> String {
        current.members.first { $0.id == id }?.name ?? "Someone"
    }

    private func displayName(_ id: String) -> String {
        guard let person = current.members.first(where: { $0.id == id }) else { return "Group member" }
        return person.userID == session.userID ? "You" : person.name
    }
}

private struct ExpenseChoiceChip: View {
    var title: String
    var selected: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 13)
                .frame(minHeight: 44)
                .foregroundStyle(selected ? Palette.paper : Palette.ink)
                .background(selected ? Palette.evergreen : Palette.raised)
                .clipShape(Capsule())
                .overlay(Capsule().stroke(selected ? Color.clear : Palette.line, lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
