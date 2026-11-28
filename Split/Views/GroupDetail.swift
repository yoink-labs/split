import SwiftUI

enum GroupDetailSheet: Identifiable {
    case expense(ExpenseGroup)
    case draft(ExpenseGroup, ReceiptDraft)
    case settlement(ExpenseGroup)
    case balances(ExpenseGroup)
    case receipt(LedgerEntry)
    case transaction(LedgerEntry)
    case credit(ExpenseGroup)

    var id: String {
        switch self {
        case .expense(let group): "expense-\(group.id)"
        case .draft(_, let draft): "draft-\(draft.id)"
        case .settlement(let group): "settlement-\(group.id)"
        case .balances(let group): "balances-\(group.id)"
        case .receipt(let entry): "receipt-\(entry.id)"
        case .transaction(let entry): "transaction-\(entry.id)"
        case .credit(let group): "credit-\(group.id)"
        }
    }

    @ViewBuilder var content: some View {
        switch self {
        case .expense(let group): AddExpenseView(group: group)
        case .draft(let group, let draft): AddExpenseView(group: group, draft: draft)
        case .settlement(let group): SettleUpView(group: group)
        case .balances(let group): GroupBalancesView(groupID: group.id)
        case .receipt(let entry): EntrySheet(entry: entry)
        case .transaction(let entry): EntrySheet(entry: entry, showsBreakdownFirst: true)
        case .credit(let group): RefundComposer(group: group)
        }
    }
}

struct GroupDetail: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.horizontalSizeClass) private var sizeClass
    @EnvironmentObject private var fx: FXStore
    var groupID: String
    var onPresentSheet: ((GroupDetailSheet) -> Void)? = nil
    @EnvironmentObject private var store: ExpenseStore
    @EnvironmentObject private var session: SessionStore
    @State private var presentedSheet: GroupDetailSheet?
    @State private var settings = false
    @State private var insights = false
    @State private var combining = false
    @State private var exportingPDF = false
    @State private var section: Section = .overview
    @State private var statsWidth: CGFloat = 600
    @State private var filter: LedgerFilter = .all
    @State private var query = ""
    @State private var category = ""
    @State private var payer = ""
    @State private var participant = ""
    @State private var mine: Involvement = .everyone

    private enum Section: String, CaseIterable {
        case overview = "Overview", transactions = "Transactions", ledger = "Ledger", receipts = "Receipts", members = "Members"
    }

    private enum LedgerFilter: String, CaseIterable {
        case all = "All entries", receipt = "With receipts", open = "Open purchases", recurring = "Recurring",
             pending = "Pending", refunds = "Refunds and credits"

        func includes(_ entry: LedgerEntry) -> Bool {
            switch self {
            case .all: true
            case .receipt: entry.hasReceipt
            case .open: entry.openPurchaseCount > 0
            case .recurring: entry.recurrence != nil && entry.recurrence != "off"
            case .pending: entry.isPending
            case .refunds: entry.isRefund
            }
        }
    }

    /// The web ledger's "I’m involved" and "I owe" toggles.
    private enum Involvement: String, CaseIterable {
        case everyone = "Everyone", involved = "I’m involved", owe = "I owe"
    }

    private var group: ExpenseGroup? { store.group(groupID) }
    @State private var showingDailyCosts = false
    private var entries: [LedgerEntry] { group.map { store.entries(in: $0) } ?? [] }
    private var summary: GroupSummary? { group.map { store.summary(for: $0) } }
    private var openCount: Int { entries.reduce(0) { $0 + $1.openPurchaseCount } }

    private func matches(_ involvement: Involvement, _ entry: LedgerEntry, me: String?) -> Bool {
        guard involvement != .everyone else { return true }
        let position = LedgerPosition(entry, memberID: me)
        return involvement == .involved ? position.involved : position.net < 0
    }

    private func ledgerSections(_ group: ExpenseGroup) -> [(String, [LedgerEntry])] {
        let me = Analytics.me(in: group, userID: store.currentUserID)
        let search = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let filtered = entries.filter { entry in
            filter.includes(entry)
                && (category.isEmpty || (entry.category ?? "Other") == category)
                && (payer.isEmpty || entry.allPayers.contains { $0.memberID == payer })
                && (participant.isEmpty || entry.splits.contains { $0.memberID == participant }
                    || entry.allPayers.contains { $0.memberID == participant })
                && (search.isEmpty || [entry.title, entry.notes, entry.category]
                    .compactMap { $0 }.contains { $0.localizedStandardContains(search) })
                && matches(mine, entry, me: me?.id)
        }
        let grouped = Dictionary(grouping: filtered) { String($0.createdAt.prefix(group.kind == "trip" ? 10 : 7)) }
        return grouped.keys.sorted(by: >).map { ($0, grouped[$0] ?? []) }
    }

    var body: some View {
        Group {
            if let group {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        header(group)
                        if store.pending > 0 { Label("\(store.pending) pending · saved on this device", systemImage: "arrow.triangle.2.circlepath").font(.caption).foregroundStyle(.secondary) }
                        if let error = store.error { InlineError(text: error) }
                        workspacePicker
                            .accessibilityIdentifier("group-workspace")
                            .frame(minHeight: HitTarget.minimum)
                        switch section {
                        case .overview:
                            overview(group)
                            Button { showingDailyCosts = true } label: {
                                Label("Daily costs", systemImage: "calendar")
                                    .frame(minHeight: HitTarget.minimum)
                            }
                        case .transactions:
                            let canCombine = group.members.contains(where: { $0.userID == store.currentUserID && $0.userID != nil && $0.removed != true })
                            GroupTransactionsView(group: group, entries: entries,
                                                  open: { present(.transaction($0)) },
                                                  exportPDF: { exportingPDF = true },
                                                  combine: canCombine ? { combining = true } : nil)
                        case .ledger:
                            expensesSection(group)
                        case .members:
                            InviteView(group: group).id(group.id)
                        case .receipts:
                            GroupReceiptsView(group: group, entries: entries) {
                                present(.expense(group))
                            } openExpense: { present(.receipt($0)) }
                            continueDraft: { present(.draft(group, $0)) }
                        }
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
                        Menu {
                            Button { present(.credit(group)) } label: { Label("Record a credit", systemImage: "arrow.uturn.backward") }
                            Button { insights = true } label: { Label("Analytics", systemImage: "chart.bar.xaxis") }
                            Button { settings = true } label: { Label("Group settings", systemImage: "slider.horizontal.3") }
                        } label: {
                            Label("More", systemImage: "ellipsis.circle")
                        }
                    }
                }
                .sheet(isPresented: $showingDailyCosts) {
                    DailyCostsView(scope: AnalyticsScope(group: group, allGroups: [group], allEntries: entries, currentUserID: store.currentUserID))
                }
                .sheet(isPresented: $combining) { ExpenseCombinationsView(group: group) }
                .sheet(isPresented: $settings) { GroupTools(group: group) }
                .sheet(isPresented: $exportingPDF) {
                    NavigationStack {
                        GroupPDFExportView(groupID: group.id)
                            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { exportingPDF = false } } }
                    }
                }
                .sheet(isPresented: $insights) {
                    NavigationStack {
                        AnalyticsView(groupID: group.id)
                            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { insights = false } } }
                    }
                }
                .sheet(item: $presentedSheet) { $0.content }
            } else {
                ContentUnavailableView("Group unavailable", systemImage: "person.2.slash")
                    .background(AppBackground())
            }
        }
        .onChange(of: groupID) {
            section = .overview
            clearLedgerFilters()
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

    /// The segmented control where all five tabs fit; otherwise a row of
    /// scrolling pills, so every tab stays visible instead of hiding in a menu.
    @ViewBuilder private var workspacePicker: some View {
        ViewThatFits(in: .horizontal) {
            sectionPicker.pickerStyle(.segmented).frame(minWidth: 440)
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Spacing.xs) {
                        ForEach(Section.allCases, id: \.self) { tab in
                            Chip(title: tab.rawValue, selected: section == tab) {
                                withAnimation(.snappy(duration: 0.25)) { section = tab }
                            }
                            .id(tab)
                        }
                    }
                    .padding(.vertical, 2)
                    .padding(.trailing, Spacing.l)
                }
                .trailingScrollFade()
                .onChange(of: section) { _, tab in withAnimation(.snappy) { proxy.scrollTo(tab, anchor: .center) } }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Group workspace")
        }
    }

    private var sectionPicker: some View {
        Picker("Group workspace", selection: $section) {
            ForEach(Section.allCases, id: \.self) { tab in Text(tab.rawValue).tag(tab) }
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
        let people = group.members.filter { $0.removed != true }
        let kind = group.kind == "trip" ? "Trip" : group.kind == "home" ? "Home" : "Friends"
        let meta = [kind, group.currency, "\(people.count) \(people.count == 1 ? "person" : "people")", tripDates(group)]
            .compactMap { $0 }.joined(separator: " · ")
        return HStack(alignment: .center, spacing: Spacing.s) {
            Image(systemName: group.symbol)
                .font(.system(size: 20, weight: .semibold))
                .frame(width: 48, height: 48)
                .background(Palette.lime.opacity(0.55), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .foregroundStyle(Palette.ink)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(group.name)
                    .font(.splitDisplay(24))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
                    .minimumScaleFactor(0.85)
                    .accessibilityAddTraits(.isHeader)
                Text(meta)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                if let description = group.description {
                    Text(description).font(.subheadline).foregroundStyle(.tertiary).lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
    }

    private func expenseActions(_ group: ExpenseGroup) -> some View {
        ActionBar {
            SplitActionButton(title: "Add expense", symbol: "plus", prominent: true) { present(.expense(group)) }
                .accessibilityIdentifier("group-add-expense")
            SplitActionButton(title: "Settle up", symbol: "arrow.left.arrow.right") { present(.settlement(group)) }
        }
    }

    private func tripDates(_ group: ExpenseGroup) -> String? {
        let start = group.startDate.flatMap(Exchange.date(fromDay:))
        let end = group.endDate.flatMap(Exchange.date(fromDay:))
        switch (start, end) {
        case let (start?, end?):
            let formatter = DateIntervalFormatter()
            formatter.dateStyle = .medium
            formatter.timeStyle = .none
            return formatter.string(from: start, to: end)
        case let (start?, nil): return "Starts " + start.formatted(date: .abbreviated, time: .omitted)
        case let (nil, end?): return "Ends " + end.formatted(date: .abbreviated, time: .omitted)
        case (nil, nil): return nil
        }
    }

    /// Your position in the group, the one thing to act on, in the ink card
    /// shared with Home; the two everyday actions sit right under it.
    private func positionCard(_ group: ExpenseGroup) -> some View {
        let balances = summary?.mine ?? [:]
        let net = fx.total(balances, in: fx.home)
        let settled = balances.values.allSatisfy { $0 == 0 }
        let wide = sizeClass == .regular && !dynamicTypeSize.isAccessibilitySize
        let caption = !net.missing.isEmpty ? "Some exchange rates are unavailable"
            : settled ? "Nobody owes you and you owe nobody"
            : net.amount > 0 ? "you’re owed in this group" : "you owe in this group"
        let figure = VStack(alignment: .leading, spacing: 4) {
            Text("Your balance")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Palette.onHero.opacity(0.75))
            if settled {
                Label("Settled up", systemImage: "checkmark.circle.fill")
                    .font(.splitAmount(30, weight: .bold))
                    .foregroundStyle(Palette.lime)
            } else {
                Text(fx.homeTotalText(balances, magnitude: true))
                    .font(.splitAmount(wide ? 36 : 30, weight: .bold))
                    .foregroundStyle(net.missing.isEmpty && net.amount < 0 ? Palette.heroNegative : Palette.lime)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .contentTransition(.numericText())
            }
            Button { present(.balances(group)) } label: {
                HStack(spacing: 4) {
                    Text(caption)
                    Image(systemName: "chevron.right").font(.caption2.weight(.bold))
                }
                .font(.subheadline)
                .foregroundStyle(Palette.onHero.opacity(0.75))
                .frame(minHeight: 28)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(caption). Show everyone’s balances")
        }
        let add = SplitActionButton(title: "Add expense", symbol: "plus", prominent: true) { present(.expense(group)) }
            .accessibilityIdentifier("group-add-expense")
        let settle = SplitActionButton(title: "Settle up", symbol: "arrow.left.arrow.right") { present(.settlement(group)) }
            .environment(\.colorScheme, .dark)
        let stacked = VStack(alignment: .leading, spacing: Spacing.m) {
            figure
            ActionBar { add; settle }
        }
        return Group {
            if wide {
                // Side by side only when both buttons keep their full titles.
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .center, spacing: Spacing.xl) {
                        figure.fixedSize(horizontal: true, vertical: false)
                        Spacer(minLength: 0)
                        HStack(spacing: Spacing.xs) {
                            add.fixedSize(horizontal: true, vertical: false)
                            settle.fixedSize(horizontal: true, vertical: false)
                        }
                    }
                    stacked
                }
            } else {
                stacked
            }
        }
        .padding(wide ? Spacing.xl : 18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            LinearGradient(colors: [Palette.hero, Palette.hero.opacity(0.92)], startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: Radius.header + 4, style: .continuous)
        )
        .overlay(RoundedRectangle(cornerRadius: Radius.header + 4, style: .continuous).strokeBorder(Palette.lime.opacity(0.14)))
    }

    /// Group-wide figures in one strip instead of a grid of wrapping cards.
    private func overviewTotals(_ group: ExpenseGroup) -> some View {
        let me = group.members.filter { $0.userID == store.currentUserID && $0.userID != nil }
        let expenses = entries.filter(\.isSpending)
        let projected = expenses.compactMap(fx.homeEntry)
        let spending = Analytics.personSpend(group, entries: projected, currency: fx.home, people: me).first
        let share = projected.count == expenses.count
            ? (expenses.contains { $0.currency != fx.home } ? "≈ " : "") + Money.text(spending?.share ?? 0, fx.home)
            : "Rate unavailable"
        let cells = Group {
            Button { insights = true } label: {
                statistic("Group spend", value: fx.spendingText(expenses), detail: "\(expenses.count) \(expenses.count == 1 ? "expense" : "expenses")", chevron: true)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens spending insights")
            statDivider
            statistic("Your share", value: share, detail: "What you consumed")
            statDivider
            Button { section = .receipts } label: {
                statistic("Unclaimed items", value: String(openCount), detail: openCount > 0 ? "Waiting on receipts" : "All claimed",
                          tint: openCount > 0 ? Palette.amber : Palette.ink, chevron: openCount > 0)
            }
            .buttonStyle(.plain)
            .disabled(openCount == 0)
            .accessibilityHint("Opens receipts")
        }
        return Group {
            if dynamicTypeSize.isAccessibilitySize || statsWidth < 520 {
                VStack(alignment: .leading, spacing: 0) { cells }
            } else {
                HStack(alignment: .top, spacing: 0) { cells }
            }
        }
        .padding(.vertical, statsWidth < 520 ? Spacing.xxs : Spacing.s)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { statsWidth = $0 }
        .background(Palette.card, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.line))
    }

    @ViewBuilder private var statDivider: some View {
        if dynamicTypeSize.isAccessibilitySize || statsWidth < 520 {
            Divider().overlay(Palette.line).padding(.leading, Spacing.m)
        } else {
            Rectangle().fill(Palette.line).frame(width: 1).padding(.vertical, 4).accessibilityHidden(true)
        }
    }

    private func statistic(_ label: String, value: String, detail: String, tint: Color = Palette.ink, chevron: Bool = false) -> some View {
        let caption = HStack(spacing: 4) {
            Text(label).font(.footnote.weight(.medium)).foregroundStyle(.secondary).lineLimit(1)
            if chevron && statsWidth >= 520 {
                Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(.tertiary)
            }
        }
        let figure = Text(value)
            .font(.splitAmount(sizeClass == .regular ? 20 : 17, weight: .semibold))
            .foregroundStyle(tint)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
        return Group {
            if statsWidth < 520 && !dynamicTypeSize.isAccessibilitySize {
                HStack(spacing: Spacing.s) {
                    VStack(alignment: .leading, spacing: 1) {
                        caption
                        Text(detail).font(.caption).foregroundStyle(.tertiary).lineLimit(1)
                    }
                    Spacer(minLength: Spacing.xs)
                    figure.layoutPriority(1)
                    if chevron {
                        Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(.tertiary)
                    }
                }
                .padding(.vertical, 10)
            } else {
                VStack(alignment: .leading, spacing: 3) {
                    caption
                    figure
                    Text(detail).font(.caption).foregroundStyle(.tertiary).lineLimit(1)
                }
            }
        }
        .padding(.horizontal, Spacing.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func overview(_ group: ExpenseGroup) -> some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            positionCard(group)
            overviewTotals(group)
            PendingSettlementsView(groupID: group.id)
            SectionHeader(title: "Recent activity", actionTitle: entries.isEmpty ? nil : "See all") {
                clearLedgerFilters()
                section = .ledger
            }
            .padding(.top, Spacing.xxs)
            if entries.isEmpty {
                Card {
                    EmptyPanel(title: "No expenses yet", message: "Add a shared expense or save a receipt for later.", symbol: "receipt")
                }
            } else {
                entryList(Array(entries.prefix(5)), group: group, showDate: true)
            }
        }
    }

    private func expensesSection(_ group: ExpenseGroup) -> some View {
        let sections = ledgerSections(group)
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                TextField("Search ledger", text: $query)
                    .padding(.leading, 34)
                    .padding(.trailing, 12)
                    .overlay(alignment: .leading) {
                        Image(systemName: "magnifyingglass").foregroundStyle(.secondary).padding(.leading, 12).accessibilityHidden(true)
                    }
                    .frame(minHeight: HitTarget.minimum)
                    .background(Palette.card, in: RoundedRectangle(cornerRadius: Radius.badge))
                    .overlay(RoundedRectangle(cornerRadius: Radius.badge).strokeBorder(Palette.line))
                    .accessibilityLabel("Search ledger")
                Menu {
                    Picker("Show", selection: $mine) {
                        ForEach(Involvement.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    Picker("Status", selection: $filter) {
                        ForEach(LedgerFilter.allCases, id: \.self) { option in Text(option.rawValue).tag(option) }
                    }
                    Picker("Category", selection: $category) {
                        Text("All categories").tag("")
                        ForEach(Set(entries.map { $0.category ?? "Other" }).sorted(), id: \.self) { Text($0).tag($0) }
                    }
                    Picker("Payer", selection: $payer) {
                        Text("Any payer").tag("")
                        ForEach(group.members) { Text($0.name).tag($0.id) }
                    }
                    Picker("Participant", selection: $participant) {
                        Text("Any person").tag("")
                        ForEach(group.members) { Text($0.name).tag($0.id) }
                    }
                    if hasLedgerFilters { Button("Clear filters", action: clearLedgerFilters) }
                } label: {
                    Label("Filter", systemImage: hasLedgerFilters ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease")
                        .frame(minWidth: HitTarget.minimum, minHeight: HitTarget.minimum)
                        .labelStyle(.iconOnly)
                }
                .accessibilityValue(filter.rawValue)
                Button { present(.expense(group)) } label: {
                    Image(systemName: "plus")
                        .font(.body.weight(.semibold))
                        .frame(width: HitTarget.minimum, height: HitTarget.minimum)
                        .foregroundStyle(Palette.hero)
                        .glassCapsule(tint: Palette.lime)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Add expense")
            }

            if hasLedgerFilters || !query.isEmpty {
                let shown = sections.reduce(0) { $0 + $1.1.count }
                Text("\(shown) of \(entries.count) entries")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityAddTraits(.updatesFrequently)
            }
            if mine == .owe {
                Text("Shows expenses where your share is more than you paid, leaving out expenses marked handled. Settle up shows what you owe after payments.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if sections.isEmpty {
                ContentUnavailableView("No matching entries", systemImage: "magnifyingglass")
            } else {
                ForEach(sections, id: \.0) { key, items in
                    VStack(alignment: .leading, spacing: 8) {
                        if group.kind == "trip" {
                            let day = Exchange.date(fromDay: key)
                            SectionHeader(title: day?.formatted(date: .abbreviated, time: .omitted) ?? key,
                                          subtitle: monthTotal(items))
                        } else {
                            MonthHeader(date: monthDate(key), total: monthTotal(items))
                        }
                        entryList(items, group: group)
                    }
                }
            }
        }
    }

    private var hasLedgerFilters: Bool {
        filter != .all || !category.isEmpty || !payer.isEmpty || !participant.isEmpty || mine != .everyone
    }

    private func clearLedgerFilters() {
        filter = .all
        category = ""
        payer = ""
        participant = ""
        mine = .everyone
        query = ""
    }

    private func entryList(_ items: [LedgerEntry], group: ExpenseGroup, showDate: Bool = false) -> some View {
        Card(padding: 0) {
            ForEach(items) { entry in
                Button { present(.receipt(entry)) } label: {
                    EntryRow(entry: entry, group: group, currentUserID: store.currentUserID, showDate: showDate)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if entry.id != items.last?.id { RowDivider() }
            }
        }
    }

    private func monthDate(_ month: String) -> Date {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM"
        return formatter.date(from: month) ?? Date()
    }
    private func monthTotal(_ entries: [LedgerEntry]) -> String? {
        entries.contains(where: \.isSpending) ? fx.spendingText(entries) : nil
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
                        convertedSection(group)
                        ForEach(currencies, id: \.self) { currency in
                            pendingSection(group, currency: currency)
                        }
                        ForEach(currencies, id: \.self) { currency in
                            currencySection(group, currency: currency)
                        }
                        Text("Balance estimates use available exchange rates. Record each payment in the currency sent.")
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
        let transfers = group.simplify == false
            ? Ledger.directPlan(values, currency: currency)
            : Ledger.plan(values, currency: currency)
        return Group {
            if !transfers.isEmpty {
                Card {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Suggested payments · \(currency)").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        ForEach(transfers) { transfer in
                            Button { settling = transfer } label: {
                                HStack(spacing: 10) {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text("\(name(transfer.from, group)) → \(name(transfer.to, group))")
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(Palette.ink)
                                        Text(fx.homeText(transfer.amount, currency: currency)).font(.subheadline.weight(.semibold))
                                        if currency != fx.home {
                                            Text("Pay \(Money.text(transfer.amount, currency))")
                                                .font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer()
                                    if group.members.contains(where: { $0.id == transfer.from && $0.userID == store.currentUserID }) {
                                        Text("Settle").font(.caption.weight(.bold)).foregroundStyle(Palette.evergreen)
                                    }
                                }
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(!group.members.contains { $0.id == transfer.from && $0.userID == store.currentUserID && $0.removed != true })
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

    /// Balances with and without pending entries, so the group can see what is confirmed.
    @ViewBuilder private func pendingSection(_ group: ExpenseGroup, currency: String) -> some View {
        let pending = Ledger.pendingEntries(entries, currency: currency)
        if !pending.isEmpty {
            let all = Ledger.balances(entries, currency: currency)
            let confirmed = Ledger.balances(entries, currency: currency, includePending: false)
            let ids = group.members.map(\.id).filter { (all[$0] ?? 0) != 0 || (confirmed[$0] ?? 0) != 0 }
            Card {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        PendingBadge(note: nil)
                        Text("\(pending.count) pending · \(Money.text(pending.reduce(0) { $0 + $1.settling.signedAmount }, currency))")
                            .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    }
                    Text("Balances include pending entries. The confirmed column leaves them out.")
                        .font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Text("Person").frame(maxWidth: .infinity, alignment: .leading)
                        Text("With pending").frame(width: 110, alignment: .trailing)
                        Text("Confirmed").frame(width: 100, alignment: .trailing)
                    }
                    .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    ForEach(ids, id: \.self) { id in
                        HStack {
                            Text(name(id, group)).font(.subheadline.weight(.medium)).frame(maxWidth: .infinity, alignment: .leading)
                            Text(Money.text(all[id] ?? 0, currency, signed: true)).font(.splitAmount(14))
                                .foregroundStyle((all[id] ?? 0) < 0 ? Palette.negative : Palette.positive)
                                .frame(width: 110, alignment: .trailing)
                            Text(Money.text(confirmed[id] ?? 0, currency, signed: true)).font(.splitAmount(14))
                                .foregroundStyle(.secondary)
                                .frame(width: 100, alignment: .trailing)
                        }
                        .lineLimit(1).minimumScaleFactor(0.7)
                        .accessibilityElement(children: .combine)
                    }
                    ForEach(pending) { entry in
                        NavigationLink(value: LedgerRoute.entry(group: group.id, id: entry.id)) {
                            HStack {
                                Text(entry.title).font(.caption.weight(.medium)).foregroundStyle(Palette.ink).lineLimit(1)
                                Spacer()
                                EntryAmount(entry: entry, size: 13)
                                Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(.tertiary)
                            }
                            .frame(minHeight: 36).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .accessibilityIdentifier("pending-balances-\(currency)")
        }
    }

    private func convertedSection(_ group: ExpenseGroup) -> some View {
        let perCurrency = Dictionary(uniqueKeysWithValues: currencies.map { ($0, Ledger.balances(entries, currency: $0)) })
        let rows = group.members.compactMap { member -> (Person, [String: Int64])? in
            let amounts = perCurrency.mapValues { $0[member.id] ?? 0 }
            return amounts.values.contains { $0 != 0 } ? (member, amounts) : nil
        }
        return VStack(alignment: .leading, spacing: 10) {
            Text("Balances · \(fx.home)").font(.headline)
            Card(padding: 0) {
                if rows.isEmpty {
                    Label("Everyone’s square", systemImage: "checkmark.seal.fill")
                        .font(.subheadline).foregroundStyle(.secondary).padding(14)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.element.0.id) { index, row in
                            NavigationLink(value: LedgerRoute.member(group: group.id, seat: row.0.id)) {
                                HStack(spacing: 10) {
                                    Avatar(name: name(row.0.id, group), size: 32)
                                    Text(name(row.0.id, group)).font(.subheadline.weight(.semibold))
                                    Spacer()
                                    BalanceLabel(amounts: row.1)
                                    Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(.tertiary)
                                }
                                .padding(.horizontal, 14)
                                .padding(.vertical, 10)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            if index < rows.count - 1 { Divider().overlay(Palette.line).padding(.leading, 56) }
                        }
                    }
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
    @State private var paymentID = UUID().uuidString
    @State private var paymentDate = ISO8601DateFormatter().string(from: Date())
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
    @State private var confirmingPending = false
    @State private var acknowledgedPending = false
    @EnvironmentObject private var fx: FXStore
    /// The currency this payment settles, and the pending entries that may still change it.
    private var settleCurrency: String { converts ? currentGroup.currency : currency }
    private var pendingForPayment: [LedgerEntry] { Ledger.pendingEntries(entries, currency: settleCurrency) }

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
        }.filter { transfer in transfer.from == from && activeMembers.contains { $0.id == transfer.to } }
    }
    private var me: Person? { Analytics.me(in: currentGroup, userID: session.userID) }
    private var recipient: Person? { currentGroup.members.first { $0.id == to } }
    private var activeMembers: [Person] { currentGroup.members.filter { $0.removed != true } }
    private var from: String { me?.id ?? "" }

    var body: some View {
        Group {
            if embedded { content } else { NavigationStack { content } }
        }
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                PendingSettlementsView(groupID: group.id)
                if !pendingForPayment.isEmpty {
                    Card {
                        VStack(alignment: .leading, spacing: 6) {
                            PendingBadge(note: nil)
                            Text("\(pendingForPayment.count) pending \(pendingForPayment.count == 1 ? "entry" : "entries") in \(settleCurrency) may still change. These suggestions include them.")
                                .font(.subheadline).foregroundStyle(Palette.ink)
                                .fixedSize(horizontal: false, vertical: true)
                            ForEach(pendingForPayment) { entry in
                                Text("• \(entry.title)\(entry.pendingNote.map { " — " + $0 } ?? "")")
                                    .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }
                        }
                    }
                    .accessibilityIdentifier("settle-pending-warning")
                }
                if suggestions.isEmpty && transfer == nil {
                    Card {
                        HStack(spacing: 12) {
                            Image(systemName: "checkmark.seal.fill").foregroundStyle(Palette.evergreen)
                            Text("No suggested payments from you.").font(.subheadline.weight(.medium))
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
                if transfer == nil && !suggestions.isEmpty {
                    suggestionsCard
                }
                formCard
                if let error { InlineError(text: error) }
                Button { save() } label: {
                    Label(saving ? "Sending…" : "Request approval", systemImage: "checkmark")
                }
                .buttonStyle(SolidButton())
                .disabled(saving || from.isEmpty || to.isEmpty)
                Text("Request approval for a payment you already made. The recipient confirms it before balances update.")
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
        .alert("Settle up while entries are pending?", isPresented: $confirmingPending) {
            Button("Settle anyway") { acknowledgedPending = true; save() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(pendingForPayment.count) pending \(pendingForPayment.count == 1 ? "entry" : "entries") (\(Money.text(pendingForPayment.reduce(0) { $0 + $1.settling.signedAmount }, settleCurrency))) may still change. If one is refunded or adjusted later, balances will move again.")
        }
    }

    private var formCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: Spacing.s) {
                    VStack(spacing: 4) {
                        Avatar(name: session.displayName, size: 44)
                        Text("You").font(.caption.weight(.semibold)).foregroundStyle(Palette.ink)
                    }
                    .frame(minWidth: 64)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Paid by you")
                    Image(systemName: "arrow.right")
                        .font(.headline)
                        .foregroundStyle(Palette.evergreen)
                        .frame(maxWidth: .infinity)
                        .accessibilityHidden(true)
                    Menu {
                        Picker("Who gets it?", selection: $to) {
                            ForEach(activeMembers.filter { $0.id != from }) { member in
                                Text(member.name).tag(member.id)
                            }
                        }
                    } label: {
                        VStack(spacing: 4) {
                            Avatar(name: recipient?.name ?? "?", size: 44)
                            HStack(spacing: 3) {
                                Text(recipient?.name ?? "Choose").font(.caption.weight(.semibold)).lineLimit(1)
                                Image(systemName: "chevron.up.chevron.down").font(.caption2.weight(.bold))
                            }
                            .foregroundStyle(Palette.ink)
                        }
                        .frame(minWidth: 64, maxWidth: 180)
                        .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Who gets it?")
                    .accessibilityValue(recipient?.name ?? "Nobody chosen")
                }
                .padding(.vertical, Spacing.xxs)
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
                if currency != fx.home, let paid = Money.parse(amount), paid > 0 {
                    Text(fx.homeText(paid, currency: currency))
                        .font(.caption)
                        .foregroundStyle(.secondary)
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
        .task(id: [currency, fx.home]) { await fx.refresh(currencies: [currency], into: fx.home) }
        .task(id: currency) {
            payQuote = nil; payRateError = nil; payManual = false
            guard converts else { return }
            do { payQuote = try await fx.quote(base: currency, target: currentGroup.currency, date: String(ISO8601DateFormatter().string(from: Date()).prefix(10))).exchange }
            catch { payRateError = "No published rate right now. Edit the rate to enter your own." }
        }
    }

    private var suggestionsCard: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader(title: "Suggested", subtitle: "The fewest payments that square you up. Tap one to fill it in.")
            Card(padding: 0) {
                ForEach(suggestions) { suggestion in
                    let chosen = to == suggestion.to && currency == suggestion.currency && Money.parse(amount) == suggestion.amount
                    Button { withAnimation(.snappy) { apply(suggestion) } } label: {
                        HStack(spacing: Spacing.s) {
                            Avatar(name: name(suggestion.to), size: 36)
                            Text("Pay \(name(suggestion.to))")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Palette.ink)
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Text(Money.text(suggestion.amount, suggestion.currency))
                                .font(.splitAmount(15))
                                .foregroundStyle(Palette.ink)
                                .fixedSize()
                            Image(systemName: chosen ? "checkmark.circle.fill" : "circle")
                                .font(.title3)
                                .foregroundStyle(chosen ? Palette.evergreen : Color.secondary.opacity(0.5))
                                .contentTransition(.symbolEffect(.replace))
                                .accessibilityHidden(true)
                        }
                        .padding(.horizontal, Spacing.m)
                        .padding(.vertical, 10)
                        .frame(minHeight: 52)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(chosen ? .isSelected : [])
                    if suggestion.id != suggestions.last?.id { RowDivider(inset: Spacing.m + 36 + Spacing.s) }
                }
            }
        }
    }

    private func initialize() {
        guard !initialized else { return }
        initialized = true
        currency = transfer?.currency ?? group.currency
        to = transfer?.to ?? activeMembers.first { $0.id != from }?.id ?? ""
        if let transfer { amount = Money.input(transfer.amount) }
        else if let suggestion = suggestions.first {
            amount = Money.input(suggestion.amount)
            to = suggestion.to; currency = suggestion.currency
        }
    }

    private func apply(_ suggestion: Transfer) {
        to = suggestion.to; amount = Money.input(suggestion.amount); currency = suggestion.currency; error = nil
    }

    private func name(_ id: String) -> String {
        let person = currentGroup.members.first { $0.id == id }
        return person?.userID == session.userID ? "You" : (person?.name ?? "Member")
    }

    private func save() {
        guard !saving else { return }
        guard from != to else { error = "Choose two different people."; return }
        guard let value = Money.parse(amount), value > 0 else { error = "Enter a payment greater than zero."; return }
        guard activeMembers.contains(where: { $0.id == from }), activeMembers.contains(where: { $0.id == to }) else {
            error = "Choose both people."; return
        }
        if converts && payExchange == nil { error = "Wait for the rate, or edit it to enter your own."; return }
        if !acknowledgedPending && !pendingForPayment.isEmpty { confirmingPending = true; return }
        saving = true; error = nil
        let cleanNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        let entry = LedgerEntry(
            id: paymentID,
            groupID: group.id,
            title: "Settle-up payment",
            amount: value,
            currency: currency,
            paidBy: from,
            splits: [Portion(memberID: to, amount: value)],
            kind: "settlement",
            splitMode: .exact,
            createdAt: paymentDate,
            notes: cleanNote.isEmpty ? nil : cleanNote
        )
        var payment = entry
        payment.exchange = payExchange
        Task {
            defer { saving = false }
            do { try await store.requestSettlement(payment); dismiss() }
            catch { self.error = error.localizedDescription }
        }
    }
}
