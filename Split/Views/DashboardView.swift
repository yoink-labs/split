import SwiftUI

struct DashboardView: View {
    @EnvironmentObject private var store: ExpenseStore
    @EnvironmentObject private var session: SessionStore
    @Environment(\.horizontalSizeClass) private var size
    @AppStorage("split.balanceReminders") private var balanceReminders = true
    @State private var inspecting: LedgerEntry?
    @State private var showNewExpense = false
    @State private var showNewPayment = false
    @State private var showSearch = false
    @State private var showCreateGroup = false
    @State private var showJoin = false
    @State private var showImport = false
    @State private var showConverter = false
    @State private var showTipJar = TipJarStore.opensOnLaunch

    var body: some View {
        let dashboard = store.dashboard
        let reminderPeople = dashboard.people.filter(\.hasBalance)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.section) {
                    DashboardPosition(model: dashboard)
                    quickActions(canSettle: !dashboard.owe.isEmpty)
                    PendingSettlementsView()
                    if balanceReminders, !reminderPeople.isEmpty { reminderCard(people: reminderPeople) }
                    if store.isDemo {
                        Label("Sample data · changes stay in this preview", systemImage: "sparkles")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if store.pending > 0 || !store.online {
                        Label(store.online ? "\(store.pending) changes waiting to sync" : "Offline · new expenses are saved here", systemImage: store.online ? "arrow.triangle.2.circlepath" : "wifi.slash")
                            .font(.caption)
                            .foregroundStyle(Palette.evergreen)
                    }
                    if let error = store.error {
                        VStack(alignment: .leading, spacing: 8) {
                            InlineError(text: error)
                            Button("Retry sync") { Task { await store.sync() } }.font(.caption.bold())
                        }
                    }
                    DashboardSections(model: dashboard, inspect: { inspecting = $0 }, create: { showCreateGroup = true }, loadComplete: store.hasLoaded)
                }
                .padding(.horizontal, Spacing.page)
                .padding(.vertical, Spacing.m)
                .frame(maxWidth: 980)
                .frame(maxWidth: .infinity)
            }
            .background(AppBackground())
            .refreshable { await store.sync() }
            .navigationTitle("Home")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                TipTheDevsToolbarItem { showTipJar = true }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { showSearch = true } label: { Label("Search everything", systemImage: "magnifyingglass") }
                    Menu {
                        Button { showNewExpense = true } label: { Label("Add expense", systemImage: "plus") }
                        Button { showNewPayment = true } label: { Label("Settle up", systemImage: "arrow.left.arrow.right") }
                            .disabled(dashboard.owe.isEmpty)
                        Divider()
                        Button { showCreateGroup = true } label: { Label("New group", systemImage: "person.3") }
                        Button { showJoin = true } label: { Label("Join with code or link", systemImage: "link") }
                        Button { showImport = true } label: { Label("Import from Splitwise", systemImage: "arrow.down.doc") }
                        Divider()
                        Button { showConverter = true } label: { Label("Currency converter", systemImage: "dollarsign.arrow.circlepath") }
                    } label: {
                        Label("Add", systemImage: "plus")
                    }
                    .accessibilityIdentifier("home-add-menu")
                }
            }
            .ledgerDestinations()
            .sheet(item: $inspecting) { entry in EntrySheet(entry: entry) }
            .sheet(isPresented: $showNewExpense) { NewExpenseSheet() }
            .sheet(isPresented: $showNewPayment) { NewSettlementSheet() }
            .sheet(isPresented: $showSearch) { NavigationStack { SearchView() } }
            .sheet(isPresented: $showCreateGroup) { CreateGroupView(friend: false) }
            .sheet(isPresented: $showJoin) { JoinGroupView { store.joinedGroupID = $0 } }
            .sheet(isPresented: $showImport) { SplitwiseImportView() }
            .sheet(isPresented: $showConverter) { ConverterView() }
            .sheet(isPresented: $showTipJar) { TipJarView(store: .shared) }
            .onChange(of: store.joinedGroupID) { _, id in if id != nil { showNewExpense = false } }
        }
    }

    private func quickActions(canSettle: Bool) -> some View {
        ActionBar {
            SplitActionButton(title: "Add expense", symbol: "plus", prominent: true) {
                showNewExpense = true
            }
            SplitActionButton(title: "Settle up", symbol: "arrow.left.arrow.right") {
                showNewPayment = true
            }
            .disabled(!canSettle)
        }
    }

    private func reminderCard(people: [PersonBalance]) -> some View {
        Card(padding: 14) {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: "bell.badge")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(width: 38, height: 38)
                    .background(Palette.amber.opacity(0.14))
                    .foregroundStyle(Palette.amber)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(people.count) \(people.count == 1 ? "balance" : "balances") still open")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Text(size == .regular ? "Send a friendly summary of who owes what." : "Send a friendly summary.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 4)
                ShareLink(item: reminderText(people: people)) {
                    if size == .regular {
                        Label("Send", systemImage: "square.and.arrow.up")
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 13)
                            .frame(minHeight: 42)
                            .foregroundStyle(Palette.ink)
                    } else {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(size: 15, weight: .semibold))
                            .frame(width: 42, height: 42)
                            .foregroundStyle(Palette.ink)
                    }
                }
                .buttonStyle(.plain)
                .glassCapsule(tint: Palette.card.opacity(0.40))
                .accessibilityLabel("Share a balance reminder")
            }
        }
    }

    private func reminderText(people: [PersonBalance]) -> String {
        let lines = people.prefix(6).map { person -> String in
            let amounts = person.currencies.filter { person.amount($0) != 0 }.map { currency in
                let value = person.amount(currency)
                return (value < 0 ? "you owe them " : "they owe you ") + Money.text(abs(value), currency)
            }.joined(separator: ", ")
            return "\(person.name): \(amounts)"
        }
        return "Split balance check\n\n" + lines.joined(separator: "\n") + "\n\nOpen Split to settle up."
    }

}

struct EntrySheet: View {
    var entry: LedgerEntry
    var showsBreakdownFirst = false
    @EnvironmentObject private var store: ExpenseStore
    var body: some View {
        if let group = store.group(entry.groupID) {
            EntryDetails(entry: entry, group: group, showsBreakdownFirst: showsBreakdownFirst)
        } else {
            ContentUnavailableView("Expense unavailable", systemImage: "receipt")
        }
    }
}

struct NewExpenseSheet: View {
    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.dismiss) private var dismiss
    @State private var selection: String?

    var body: some View {
        NavigationStack {
            GroupPickerList(title: "Add an expense", selection: $selection)
                .navigationTitle("Add an expense")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
                .navigationDestination(item: $selection) { id in
                    if let group = store.group(id) { AddExpenseView(group: group) }
                }
        }
    }
}

struct NewSettlementSheet: View {
    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.dismiss) private var dismiss
    @State private var selection: String?

    var body: some View {
        NavigationStack {
            GroupPickerList(title: "Settle up", selection: $selection)
                .navigationTitle("Settle up")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
                .navigationDestination(item: $selection) { id in
                    if let group = store.group(id) { SettleUpView(group: group, embedded: true) }
                }
        }
    }
}

struct GroupPickerList: View {
    var title: String
    @Binding var selection: String?
    @EnvironmentObject private var store: ExpenseStore

    var body: some View {
        let summaries = Analytics.groupSummaries(groups: store.groups, entries: store.entries, userID: store.currentUserID)
        return ScrollView {
            LazyVStack(spacing: 10) {
                if summaries.isEmpty {
                    EmptyPanel(title: "No groups yet", message: "Create a group before adding an expense.", symbol: "person.3")
                }
                ForEach(summaries) { summary in
                    Button { selection = summary.group.id } label: {
                        GroupCard(summary: summary, currentUserID: store.currentUserID)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(16)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .background(AppBackground())
    }
}
