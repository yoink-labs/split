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

    private var dashboard: DashboardModel { store.dashboard }
    private var visibleGroups: [GroupSummary] { Array(dashboard.groups.prefix(4)) }
    private var visiblePeople: [PersonBalance] { Array(dashboard.people.prefix(5)) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.section) {
                    BalanceHero(net: dashboard.net, owed: dashboard.owed, owe: dashboard.owe, subtitle: "Your balance across \(dashboard.groups.count) \(dashboard.groups.count == 1 ? "group" : "groups")")
                    quickActions
                    if balanceReminders, !dashboard.people.isEmpty { reminderCard }
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
                    adaptiveGrid
                    footer
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
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { showSearch = true } label: { Label("Search everything", systemImage: "magnifyingglass") }
                    Menu {
                        Button { showNewExpense = true } label: { Label("Add expense", systemImage: "plus") }
                        Button { showNewPayment = true } label: { Label("Settle up", systemImage: "arrow.left.arrow.right") }
                            .disabled(dashboard.people.isEmpty)
                        Divider()
                        Button { showCreateGroup = true } label: { Label("New group", systemImage: "person.3") }
                        Button { showJoin = true } label: { Label("Join with code or link", systemImage: "link") }
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
            .onChange(of: store.joinedGroupID) { _, id in if id != nil { showNewExpense = false } }
        }
    }

    private var quickActions: some View {
        ActionBar {
            SplitActionButton(title: "Add expense", symbol: "plus", prominent: true) {
                showNewExpense = true
            }
            SplitActionButton(title: "Settle up", symbol: "arrow.left.arrow.right") {
                showNewPayment = true
            }
            .disabled(dashboard.people.isEmpty)
        }
    }

    private var reminderCard: some View {
        Card(padding: 14) {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: "bell.badge")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(width: 38, height: 38)
                    .background(Palette.amber.opacity(0.14))
                    .foregroundStyle(Palette.amber)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(dashboard.people.count) \(dashboard.people.count == 1 ? "balance" : "balances") still open")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Text(size == .regular ? "A short nudge keeps the ledger moving. Split is free, so reminders are too." : "Nudge the group and keep the ledger moving.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 4)
                ShareLink(item: reminderText) {
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

    private var reminderText: String {
        let lines = dashboard.people.prefix(6).map { person -> String in
            let amounts = person.currencies.map { currency in
                let value = person.amount(currency)
                return (value < 0 ? "you owe them " : "they owe you ") + Money.text(abs(value), currency)
            }.joined(separator: ", ")
            return "\(person.name): \(amounts)"
        }
        return "Split balance check\n\n" + lines.joined(separator: "\n") + "\n\nOpen Split to settle up."
    }

    private var adaptiveGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 340), spacing: 18, alignment: .top)], alignment: .leading, spacing: 20) {
            peopleSection
            groupsSection
            activitySection
            insightsCard
        }
    }

    @ViewBuilder private var peopleSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "People", subtitle: dashboard.people.isEmpty ? "No open balances" : "Tap someone to see the full tab", actionTitle: dashboard.people.isEmpty ? nil : "All", action: nil)
            Card(padding: 0) {
                if visiblePeople.isEmpty {
                    EmptyPanel(title: "Everyone’s square", message: "When you share an expense, the balance lands here.", symbol: "checkmark.seal")
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(visiblePeople.enumerated()), id: \.element.id) { index, person in
                            NavigationLink {
                                FriendDetail(balance: person)
                            } label: {
                                PersonBalanceRow(person: person)
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 12)
                            }
                            .buttonStyle(.plain)
                            if index < visiblePeople.count - 1 {
                                Divider().overlay(Palette.line).padding(.leading, 68)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private var groupsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Groups", subtitle: "Trips, homes and shared tabs", actionTitle: visibleGroups.isEmpty ? nil : "See all", action: nil)
            if visibleGroups.isEmpty {
                Card {
                    EmptyPanel(title: "Start a group", message: "A trip, a home, or a running tab with a friend.", symbol: "person.3", actionTitle: "New group") { showCreateGroup = true }
                }
            } else {
                ForEach(visibleGroups) { summary in
                    NavigationLink {
                        GroupDetail(groupID: summary.group.id)
                    } label: {
                        GroupCard(summary: summary, currentUserID: store.currentUserID)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    @ViewBuilder private var activitySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Recent activity", subtitle: "Everything you and your people changed")
            Card(padding: 0) {
                if dashboard.recent.isEmpty {
                    EmptyPanel(title: "Nothing to catch up on", message: "Expenses and payments appear here as you add them.", symbol: "clock")
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(dashboard.recent.prefix(5).enumerated()), id: \.element.id) { index, entry in
                            if let group = store.group(entry.groupID) {
                                Button { inspecting = entry } label: {
                                    EntryRow(entry: entry, group: group, currentUserID: store.currentUserID, showGroup: true, showDate: true)
                                        .padding(.horizontal, 14)
                                        .padding(.vertical, 11)
                                }
                                .buttonStyle(.plain)
                                if index < min(5, dashboard.recent.count) - 1 {
                                    Divider().overlay(Palette.line).padding(.leading, 66)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private var insightsCard: some View {
        NavigationLink {
            InsightsView()
        } label: {
            Card {
                HStack(spacing: 14) {
                    Image(systemName: "chart.bar.xaxis")
                        .font(.system(size: 20, weight: .semibold))
                        .frame(width: 46, height: 46)
                        .background(Palette.lime.opacity(0.45))
                        .foregroundStyle(Palette.ink)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Insights").font(.headline).foregroundStyle(Palette.ink)
                        Text("Spending by month, category and person — free, like everything else.").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(.tertiary)
                }
            }
            .buttonStyle(.plain)
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Split is free. No ads, no Pro tier, no subscription.")
                .font(.caption)
                .foregroundStyle(.secondary)
            if !dashboard.settled {
                Text("Balances are simplified within each group, separately for every currency.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.top, 4)
    }
}

struct EntrySheet: View {
    var entry: LedgerEntry
    @EnvironmentObject private var store: ExpenseStore
    var body: some View {
        if let group = store.group(entry.groupID) {
            EntryDetails(entry: entry, group: group)
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
        ScrollView {
            LazyVStack(spacing: 10) {
                if store.dashboard.groups.isEmpty {
                    EmptyPanel(title: "No groups yet", message: "Create a group before adding an expense.", symbol: "person.3")
                }
                ForEach(store.dashboard.groups) { summary in
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
