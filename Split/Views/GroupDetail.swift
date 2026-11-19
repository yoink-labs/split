import SwiftUI

enum GroupDetailSheet: Identifiable {
    case expense(ExpenseGroup)
    case settlement(ExpenseGroup)
    case balances(ExpenseGroup)
    case receipt(LedgerEntry)

    var id: String {
        switch self {
        case .expense(let group): "expense-\(group.id)"
        case .settlement(let group): "settlement-\(group.id)"
        case .balances(let group): "balances-\(group.id)"
        case .receipt(let entry): "receipt-\(entry.id)"
        }
    }

    @ViewBuilder var content: some View {
        switch self {
        case .expense(let group): AddExpenseView(group: group)
        case .settlement(let group): SettleUpView(group: group)
        case .balances(let group): GroupBalancesView(groupID: group.id)
        case .receipt(let entry): EntrySheet(entry: entry)
        }
    }
}

struct GroupDetail: View {
    var groupID: String
    var onPresentSheet: ((GroupDetailSheet) -> Void)? = nil
    @EnvironmentObject private var store: ExpenseStore
    @EnvironmentObject private var session: SessionStore
    @Environment(\.horizontalSizeClass) private var size
    @State private var presentedSheet: GroupDetailSheet?
    @State private var inviting = false
    @State private var settings = false
    @State private var insights = false
    @State private var openOnly = false

    private var group: ExpenseGroup? { store.group(groupID) }
    private var entries: [LedgerEntry] { group.map { store.entries(in: $0) } ?? [] }
    private var summary: GroupSummary? { group.map { store.summary(for: $0) } }
    private var months: [(String, [LedgerEntry])] {
        let filtered = entries.filter { !openOnly || ($0.bill?.openCount ?? 0) > 0 }
        let grouped = Dictionary(grouping: filtered) { String($0.createdAt.prefix(7)) }
        return grouped.keys.sorted(by: >).map { ($0, grouped[$0]?.sorted { $0.createdAt > $1.createdAt } ?? []) }
    }
    private var openCount: Int { entries.compactMap(\.bill).reduce(0) { $0 + $1.openCount } }

    var body: some View {
        Group {
            if let group {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        header(group)
                        if store.isDemo { Label("Sample group · changes stay in this preview", systemImage: "sparkles").font(.caption).foregroundStyle(.secondary) }
                        if store.pending > 0 { Label("\(store.pending) pending · saved on this device", systemImage: "arrow.triangle.2.circlepath").font(.caption).foregroundStyle(.secondary) }
                        if let error = store.error { InlineError(text: error) }
                        expensesSection(group)
                    }
                    .padding(16)
                    .frame(maxWidth: 960)
                    .frame(maxWidth: .infinity)
                }
                .background(AppBackground())
                .refreshable { await store.sync() }
                .toolbar {
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        Button { present(.balances(group)) } label: { Label("Balances", systemImage: "chart.pie") }
                        Button { inviting = true } label: { Label("People", systemImage: "person.2") }
                        Menu {
                            Button { insights = true } label: { Label("Insights", systemImage: "chart.bar.xaxis") }
                            Button { settings = true } label: { Label("Group settings", systemImage: "slider.horizontal.3") }
                        } label: {
                            Label("More", systemImage: "ellipsis.circle")
                        }
                    }
                }
                .sheet(isPresented: $inviting) { InviteView(group: group) }
                .sheet(isPresented: $settings) { GroupTools(group: group) }
                .sheet(isPresented: $insights) {
                    NavigationStack {
                        InsightsView(group: group)
                            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { insights = false } } }
                    }
                }
                .sheet(item: $presentedSheet) { $0.content }
            } else {
                ContentUnavailableView("Group unavailable", systemImage: "person.2.slash")
                    .background(AppBackground())
            }
        }
        .ledgerDestinations()
        .navigationTitle(group?.name ?? "Group")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // The ink header names the group; keep the title for the back menu only.
            ToolbarItem(placement: .principal) {
                Color.clear.frame(width: 1, height: 1).accessibilityHidden(true)
            }
        }
    }

    private func present(_ sheet: GroupDetailSheet) {
        if let onPresentSheet {
            onPresentSheet(sheet)
        } else {
            presentedSheet = sheet
        }
    }

    private func header(_ group: ExpenseGroup) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .center, spacing: 12) {
                    Image(systemName: group.symbol)
                        .font(.system(size: 20, weight: .semibold))
                        .frame(width: 48, height: 48)
                        .background(Palette.lime, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                        .foregroundStyle(Palette.hero)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(group.name)
                            .font(.splitDisplay(24))
                            .foregroundStyle(Palette.onHero)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityAddTraits(.isHeader)
                        Text("\(group.members.count) \(group.members.count == 1 ? "person" : "people") · \(group.kind == "trip" ? "Trip" : group.kind == "home" ? "Home" : "Group") · \(group.currency)")
                            .font(.caption)
                            .foregroundStyle(Palette.lime.opacity(0.62))
                    }
                    Spacer(minLength: 8)
                    if size == .regular {
                        HStack(spacing: -8) {
                            ForEach(group.members.prefix(4)) { member in
                                Avatar(name: member.userID == store.currentUserID ? "You" : member.name, size: 30, tint: Palette.lime)
                                    .background(Palette.hero, in: Circle())
                                    .overlay(Circle().stroke(Palette.hero, lineWidth: 2))
                            }
                            if group.members.count > 4 {
                                Text("+\(group.members.count - 4)")
                                    .font(.caption2.weight(.bold))
                                    .frame(width: 30, height: 30)
                                    .background(Palette.onHero.opacity(0.12), in: Circle())
                                    .foregroundStyle(Palette.onHero)
                                    .overlay(Circle().stroke(Palette.hero, lineWidth: 2))
                            }
                        }
                        .accessibilityHidden(true)
                    }
                }
                if let summary {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .bottom, spacing: 16) {
                            VStack(alignment: .leading, spacing: 2) { netSummary(summary) }
                            Spacer(minLength: 8)
                            totalSpent(summary, group: group, alignment: .trailing)
                        }
                        VStack(alignment: .leading, spacing: 10) {
                            VStack(alignment: .leading, spacing: 2) { netSummary(summary) }
                            totalSpent(summary, group: group, alignment: .leading)
                        }
                    }
                    if !summary.isSettled {
                        ApproxTotal(amounts: summary.mine, onHero: true)
                    }
                }
            }
            .padding(18)
            .background(
                LinearGradient(colors: [Palette.hero, Palette.hero.opacity(0.94)], startPoint: .topLeading, endPoint: .bottomTrailing),
                in: RoundedRectangle(cornerRadius: Radius.header)
            )
            .overlay(RoundedRectangle(cornerRadius: Radius.header).stroke(Palette.lime.opacity(0.16), lineWidth: 1))

            ActionBar {
                SplitActionButton(title: "Add expense", symbol: "plus", prominent: true) { present(.expense(group)) }
                    .accessibilityIdentifier("group-add-expense")
                SplitActionButton(title: "Settle up", symbol: "arrow.left.arrow.right") { present(.settlement(group)) }
            }
        }
    }

    @ViewBuilder private func totalSpent(_ summary: GroupSummary, group: ExpenseGroup, alignment: HorizontalAlignment) -> some View {
        let totals = summary.currencies.compactMap { currency -> (String, Int64)? in
            guard let value = summary.totalSpend[currency], value > 0 else { return nil }
            return (currency, value)
        }
        if !totals.isEmpty {
            VStack(alignment: alignment, spacing: 2) {
                Text("Total spent").font(.caption2.weight(.semibold)).foregroundStyle(Palette.lime.opacity(0.55))
                ForEach(totals, id: \.0) { currency, value in
                    Text(Money.text(value, currency))
                        .font(.splitAmount(15))
                        .foregroundStyle(Palette.onHero.opacity(0.9))
                        .lineLimit(1)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder private func netSummary(_ summary: GroupSummary) -> some View {
        if summary.isSettled {
            Label("Settled up", systemImage: "checkmark.circle.fill")
                .font(.headline)
                .foregroundStyle(Palette.lime)
        } else {
            ForEach(summary.currencies, id: \.self) { currency in
                let amount = summary.mine[currency] ?? 0
                if amount != 0 {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(Money.text(abs(amount), currency))
                            .font(.splitAmount(summary.currencies.count > 1 ? 20 : 26, weight: .bold))
                            .foregroundStyle(amount > 0 ? Palette.lime : Color(red: 1, green: 0.72, blue: 0.60))
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                            .contentTransition(.numericText())
                        Text(amount > 0 ? "you’re owed" : "you owe")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(Palette.onHero.opacity(0.65))
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    private func expensesSection(_ group: ExpenseGroup) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Expenses").font(.headline).foregroundStyle(Palette.ink)
                    Text(openOnly ? "Showing open purchases" : "\(entries.count) \(entries.count == 1 ? "entry" : "entries")")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                if openCount > 0 || openOnly {
                    Chip(title: openOnly ? "Open only" : "\(openCount) open", symbol: "basket", selected: openOnly) {
                        withAnimation(.snappy) { openOnly.toggle() }
                    }
                    .frame(minHeight: 44)
                    .accessibilityLabel(openOnly ? "Show all expenses" : "Show \(openCount) open purchases")
                }
            }
            if months.isEmpty {
                Card {
                    EmptyPanel(
                        title: openOnly ? "All purchases claimed" : "No expenses yet",
                        message: openOnly ? "Turn off the open filter to see everything." : "Add the first shared expense and Split does the math.",
                        symbol: openOnly ? "checkmark.seal" : "receipt",
                        actionTitle: openOnly ? "Show all" : "Add an expense"
                    ) {
                        if openOnly { openOnly = false } else { present(.expense(group)) }
                    }
                }
            } else {
                ForEach(months, id: \.0) { month, monthEntries in
                    VStack(alignment: .leading, spacing: 8) {
                        MonthHeader(date: monthDate(month), total: monthTotal(monthEntries, group: group))
                        Card(padding: 0) {
                            VStack(spacing: 0) {
                                ForEach(Array(monthEntries.enumerated()), id: \.element.id) { index, entry in
                                    Button { present(.receipt(entry)) } label: {
                                        EntryRow(entry: entry, group: group, currentUserID: store.currentUserID)
                                            .padding(.horizontal, 14)
                                            .padding(.vertical, 12)
                                    }
                                    .buttonStyle(.plain)
                                    if index < monthEntries.count - 1 {
                                        Divider().overlay(Palette.line).padding(.leading, 66)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private func monthDate(_ month: String) -> Date {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM"
        return formatter.date(from: month) ?? Date()
    }
    private func monthTotal(_ entries: [LedgerEntry], group: ExpenseGroup) -> String? {
        let total = entries.map(\.settling).filter { $0.currency == group.currency && $0.kind == "expense" }.reduce(0) { $0 + $1.amount }
        return total == 0 ? nil : Money.text(total, group.currency)
    }
}

struct GroupBalancesView: View {
    var groupID: String
    @EnvironmentObject private var store: ExpenseStore
    @EnvironmentObject private var fx: FXStore
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss
    @State private var settling: Transfer?

    private var group: ExpenseGroup? { store.group(groupID) }
    private var entries: [LedgerEntry] { group.map { store.entries(in: $0) } ?? [] }
    private var currencies: [String] { group.map { Analytics.currencies(in: $0, entries: entries) } ?? [] }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if let group {
                        if let error = store.error { InlineError(text: error) }
                        if currencies.contains(where: { $0 != fx.display }) { convertedSection(group) }
                        ForEach(currencies, id: \.self) { currency in
                            currencySection(group, currency: currency)
                        }
                        Text("Balances are simplified within this group, separately for each currency. Recording a payment does not move money.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        ContentUnavailableView("Group unavailable", systemImage: "person.2.slash")
                    }
                }
                .padding(16)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .background(AppBackground())
            .ledgerDestinations()
            .navigationTitle(group?.name ?? "Balances")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .refreshable { await store.sync() }
            .sheet(item: $settling) { transfer in
                if let group { SettleUpView(group: group, transfer: transfer) }
            }
        }
    }

    private func currencySection(_ group: ExpenseGroup, currency: String) -> some View {
        let values = Ledger.balances(entries, currency: currency)
        let rows = group.members.compactMap { member -> (Person, Int64)? in
            let value = values[member.id] ?? 0
            return value == 0 ? nil : (member, value)
        }.sorted { abs($0.1) > abs($1.1) }
        let transfers = group.simplify == false
            ? Ledger.directPlan(values, currency: currency)
            : Ledger.plan(values, currency: currency)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(currency).font(.headline)
                Spacer()
                Text("\(rows.count) \(rows.count == 1 ? "balance" : "balances")").font(.caption).foregroundStyle(.secondary)
            }
            Card(padding: 0) {
                if rows.isEmpty {
                    HStack(spacing: 10) {
                        Image(systemName: "checkmark.seal.fill").foregroundStyle(Palette.evergreen)
                        Text("Everyone’s square.").font(.subheadline).foregroundStyle(.secondary)
                        Spacer()
                    }.padding(14)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.element.0.id) { index, row in
                            NavigationLink(value: LedgerRoute.member(group: group.id, seat: row.0.id)) {
                                HStack(spacing: 10) {
                                    Avatar(name: row.0.userID == store.currentUserID ? "You" : row.0.name, size: 36)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(row.0.userID == store.currentUserID ? "You" : row.0.name).font(.subheadline.weight(.semibold))
                                        Text(row.1 > 0 ? "gets back" : "owes").font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text(Money.text(abs(row.1), currency))
                                        .font(.splitAmount(15))
                                        .foregroundStyle(row.1 > 0 ? Palette.positive : Palette.negative)
                                    Image(systemName: "chevron.right")
                                        .font(.caption2.weight(.bold))
                                        .foregroundStyle(.tertiary)
                                }
                                .padding(.horizontal, 14)
                                .padding(.vertical, 11)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            if index < rows.count - 1 { Divider().overlay(Palette.line).padding(.leading, 62) }
                        }
                    }
                }
            }
            if !transfers.isEmpty {
                Card {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Suggested payments").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        ForEach(transfers) { transfer in
                            Button { settling = transfer } label: {
                                HStack(spacing: 10) {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text("\(name(transfer.from, group)) → \(name(transfer.to, group))")
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(Palette.ink)
                                        Text(Money.text(transfer.amount, currency)).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text("Settle").font(.caption.weight(.bold)).foregroundStyle(Palette.evergreen)
                                }
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Settle \(name(transfer.from, group)) to \(name(transfer.to, group)) \(Money.text(transfer.amount, currency))")
                            if transfer.id != transfers.last?.id { Divider().overlay(Palette.line) }
                        }
                    }
                }
            }
        }
    }

    private func name(_ id: String, _ group: ExpenseGroup) -> String {
        let person = group.members.first { $0.id == id }
        return person?.userID == store.currentUserID ? "You" : (person?.name ?? "Member")
    }

    /// Every currency folded into the "Show in" currency at today's rate, per person.
    private func convertedSection(_ group: ExpenseGroup) -> some View {
        let perCurrency = Dictionary(uniqueKeysWithValues: currencies.map { ($0, Ledger.balances(entries, currency: $0)) })
        let rows = group.members.compactMap { member -> (Person, Int64)? in
            var amounts: [String: Int64] = [:]
            for (currency, values) in perCurrency { if let v = values[member.id], v != 0 { amounts[currency] = v } }
            guard !amounts.isEmpty else { return nil }
            let result = fx.total(amounts, in: fx.display)
            return result.missing.isEmpty ? (member, result.amount) : nil
        }.sorted { abs($0.1) > abs($1.1) }
        let all = perCurrency.mapValues { $0.values.filter { $0 > 0 }.reduce(0, +) }
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("All currencies").font(.headline)
                Spacer()
                ShowInMenu()
            }
            Card(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.0.id) { index, row in
                        HStack(spacing: 10) {
                            Avatar(name: row.0.userID == store.currentUserID ? "You" : row.0.name, size: 32)
                            Text(row.0.userID == store.currentUserID ? "You" : row.0.name).font(.subheadline.weight(.semibold))
                            Spacer()
                            Text("≈ " + Money.text(abs(row.1), fx.display))
                                .font(.splitAmount(15))
                                .foregroundStyle(row.1 > 0 ? Palette.positive : row.1 < 0 ? Palette.negative : Palette.ink)
                            Text(row.1 > 0 ? "gets back" : row.1 < 0 ? "owes" : "square").font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .accessibilityElement(children: .combine)
                        if index < rows.count - 1 { Divider().overlay(Palette.line).padding(.leading, 56) }
                    }
                    Divider().overlay(Palette.line)
                    ApproxTotal(amounts: all, positive: "owed in total", negative: "owed in total", showsMenu: false)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                }
            }
        }
    }
}

struct SettleUpView: View {
    var group: ExpenseGroup
    var transfer: Transfer? = nil
    var embedded = false
    @EnvironmentObject private var store: ExpenseStore
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss
    @State private var from = ""
    @State private var to = ""
    @State private var amount = ""
    @State private var currency = ""
    @State private var note = ""
    @State private var error: String?
    @State private var saving = false
    @State private var initialized = false
    @State private var payQuote: Exchange?
    @State private var payRateText = ""
    @State private var payManual = false
    @State private var payRateError: String?
    @EnvironmentObject private var fx: FXStore

    /// Paying in a currency the group has no balances in converts the payment to the group currency.
    private var converts: Bool { !currency.isEmpty && currency != currentGroup.currency && !currencies.contains(currency) }
    private var payExchange: Exchange? {
        guard converts else { return nil }
        if payManual { return Exchange.units(payRateText).map { Exchange(target: currentGroup.currency, rateE8: $0, date: String(ISO8601DateFormatter().string(from: Date()).prefix(10)), source: "Manual") } }
        return payQuote
    }

    private var entries: [LedgerEntry] { store.entries(in: store.group(group.id) ?? group) }
    private var currentGroup: ExpenseGroup { store.group(group.id) ?? group }
    private var currencies: [String] { Analytics.currencies(in: currentGroup, entries: entries) }
    private var suggestions: [Transfer] {
        currencies.flatMap { currency in
            let values = Ledger.balances(entries, currency: currency)
            return currentGroup.simplify == false
                ? Ledger.directPlan(values, currency: currency)
                : Ledger.plan(values, currency: currency)
        }
    }
    private var me: Person? { Analytics.me(in: currentGroup, userID: session.userID) }
    private var recipient: Person? { currentGroup.members.first { $0.id == to } }
    private var fromPerson: Person? { currentGroup.members.first { $0.id == from } }

    var body: some View {
        Group {
            if embedded { content } else { NavigationStack { content } }
        }
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if suggestions.isEmpty && transfer == nil {
                    Card {
                        HStack(spacing: 12) {
                            Image(systemName: "checkmark.seal.fill").foregroundStyle(Palette.evergreen)
                            Text("You’re all settled up in this group.").font(.subheadline.weight(.medium))
                            Spacer()
                        }
                    }
                }
                if let transfer {
                    Card {
                        HStack(spacing: 10) {
                            Text("\(name(transfer.from)) pays \(name(transfer.to))").font(.headline).foregroundStyle(Palette.ink)
                            Spacer()
                            Text(Money.text(transfer.amount, transfer.currency)).font(.splitAmount(16))
                        }
                    }
                }
                formCard
                if transfer == nil && !suggestions.isEmpty {
                    suggestionsCard
                }
                if let error { InlineError(text: error) }
                Button { save() } label: {
                    Label(saving ? "Recording…" : "Record payment", systemImage: "checkmark")
                }
                .buttonStyle(SolidButton())
                .disabled(saving)
                Text("Record a payment you’ve already made. Split won’t transfer money.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
            .padding(16)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .background(AppBackground())
        .navigationTitle("Settle up")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !embedded {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .onAppear(perform: initialize)
        .onChange(of: group.id) { _, _ in initialize() }
    }

    private var formCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Who’s paying?").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Picker("From", selection: $from) {
                        ForEach(currentGroup.members) { member in
                            Text(member.id == me?.id ? "You" : member.name).tag(member.id)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                HStack {
                    Image(systemName: "arrow.down")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Palette.evergreen)
                    Text("to").font(.caption).foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Who gets it?").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Picker("To", selection: $to) {
                        ForEach(currentGroup.members.filter { $0.id != from }) { member in
                            Text(member.id == me?.id ? "You" : member.name).tag(member.id)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                Divider().overlay(Palette.line)
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    TextField("0.00", text: $amount)
                        .font(.splitAmount(28))
                        .keyboardType(.decimalPad)
                        .accessibilityLabel("Payment amount")
                        .accessibilityIdentifier("settle-amount")
                    Picker("Currency", selection: $currency) {
                        ForEach(Money.currencies, id: \.self) { Text($0).tag($0) }
                    }
                    .labelsHidden()
                    .accessibilityLabel("Currency")
                }
                if converts { paymentConversion }
                TextField("Note (optional)", text: $note, axis: .vertical)
                    .lineLimit(1...3)
                    .accessibilityLabel("Payment note")
                    .accessibilityIdentifier("settle-note")
                if let recipient {
                    PaymentActions(member: recipient, currency: currency, amount: amount)
                }
            }
        }
    }

    private var paymentConversion: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let exchange = payExchange {
                let converted = Money.parse(amount).flatMap { FXMath.convert($0, rateE8: exchange.rateE8) }
                Text("≈ " + (converted.map { Money.text($0, currentGroup.currency) } ?? currentGroup.currency + " —"))
                    .font(.splitAmount(17, weight: .semibold))
                    .foregroundStyle(Palette.ink)
                Text("at 1 \(currency) = \(FXMath.rateText(exchange.rateE8)) \(currentGroup.currency) (\(exchange.source == "Manual" ? "your rate" : exchange.source == "BCRA" ? "BCRA official" : "Frankfurter"), \(FXQuote.shortDay(exchange.date))). Settles \(currentGroup.currency) balances.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let payRateError, !payManual {
                Text(payRateError).font(.caption).foregroundStyle(Palette.coral)
            } else if !payManual {
                HStack(spacing: 8) { ProgressView(); Text("Getting today’s rate…").font(.caption).foregroundStyle(.secondary) }
            }
            if payManual {
                HStack {
                    Text("1 \(currency) =").font(.subheadline).foregroundStyle(.secondary)
                    TextField("Rate", text: $payRateText).keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                        .accessibilityLabel("Exchange rate, one \(currency) in \(currentGroup.currency)")
                    Text(currentGroup.currency).font(.subheadline).foregroundStyle(.secondary)
                }
            }
            Button(payManual ? "Use published rate" : "Edit rate") {
                if !payManual, let payQuote { payRateText = NSDecimalNumber(decimal: payQuote.rate).stringValue }
                payManual.toggle()
            }
            .font(.caption.weight(.semibold))
        }
        .task(id: currency) {
            payQuote = nil; payRateError = nil; payManual = false
            guard converts else { return }
            do { payQuote = try await fx.quote(base: currency, target: currentGroup.currency, date: String(ISO8601DateFormatter().string(from: Date()).prefix(10))).exchange }
            catch { payRateError = "No published rate right now. Edit the rate to enter your own." }
        }
    }

    private var suggestionsCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Text("Suggested payments").font(.headline).foregroundStyle(Palette.ink)
                ForEach(suggestions) { suggestion in
                    Button { apply(suggestion) } label: {
                        HStack(spacing: 10) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text("\(name(suggestion.from)) → \(name(suggestion.to))").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
                                Text(Money.text(suggestion.amount, suggestion.currency)).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "arrow.up.left").font(.caption.weight(.bold)).foregroundStyle(Palette.evergreen)
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if suggestion.id != suggestions.last?.id { Divider().overlay(Palette.line) }
                }
            }
        }
    }

    private func initialize() {
        guard !initialized else { return }
        initialized = true
        currency = transfer?.currency ?? group.currency
        from = transfer?.from ?? me?.id ?? currentGroup.members.first?.id ?? ""
        to = transfer?.to ?? currentGroup.members.first { $0.id != from }?.id ?? ""
        if let transfer { amount = Money.input(transfer.amount) }
        else if let suggestion = suggestions.first(where: { $0.from == from }) ?? suggestions.first {
            amount = Money.input(suggestion.amount)
            from = suggestion.from; to = suggestion.to; currency = suggestion.currency
        }
    }

    private func apply(_ suggestion: Transfer) {
        from = suggestion.from; to = suggestion.to; amount = Money.input(suggestion.amount); currency = suggestion.currency; error = nil
    }

    private func name(_ id: String) -> String {
        let person = currentGroup.members.first { $0.id == id }
        return person?.userID == session.userID ? "You" : (person?.name ?? "Member")
    }

    private func save() {
        guard !saving else { return }
        guard from != to else { error = "Choose two different people."; return }
        guard let value = Money.parse(amount), value > 0 else { error = "Enter a payment greater than zero."; return }
        guard currentGroup.members.contains(where: { $0.id == from }), currentGroup.members.contains(where: { $0.id == to }) else {
            error = "Choose both people."; return
        }
        if converts && payExchange == nil { error = "Wait for the rate, or edit it to enter your own."; return }
        saving = true; error = nil
        let cleanNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        let entry = LedgerEntry(
            id: UUID().uuidString,
            groupID: group.id,
            title: "Settle-up payment",
            amount: value,
            currency: currency,
            paidBy: from,
            splits: [Portion(memberID: to, amount: value)],
            kind: "settlement",
            splitMode: .exact,
            notes: cleanNote.isEmpty ? nil : cleanNote
        )
        var payment = entry
        payment.exchange = payExchange
        Task {
            defer { saving = false }
            do { try store.add(payment); dismiss() }
            catch { self.error = error.localizedDescription }
        }
    }
}
