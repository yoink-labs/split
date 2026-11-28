import SwiftUI

struct FriendsView: View {
    @EnvironmentObject private var fx: FXStore
    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.horizontalSizeClass) private var size
    @State private var selection: String?
    @State private var showCreate = false
    @State private var managingFriends = false
    @State private var query = ""
    @State private var friends: [SplitUser] = []
    @State private var requestCount = 0
    @State private var directoryError: String?

    private var friendByKey: [String: SplitUser] {
        Dictionary(uniqueKeysWithValues: friends.map { ("u:" + $0.userID, $0) })
    }

    private var rows: [PersonBalance] {
        let people = Analytics.allPeople(groups: store.groups, entries: store.entries, userID: store.currentUserID)
        let balances = Dictionary(uniqueKeysWithValues: people.map { ($0.key, $0) })
        let accepted = friends.map { friend in
            let key = "u:" + friend.userID
            var balance = balances[key] ?? PersonBalance(key: key, name: friend.name, memberIDs: [], groupIDs: [], amounts: [:])
            balance.name = friend.name
            return balance
        }
        let all = accepted + people.filter { friendByKey[$0.key] == nil }
        let search = query.trimmingCharacters(in: .whitespaces)
        return search.isEmpty ? all : all.filter { $0.name.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Section {
                    if store.isDemo { Label("Sample people · changes stay here", systemImage: "sparkles").font(.caption).foregroundStyle(.secondary).listRowBackground(Color.clear) }
                }
                Section("Your friends") {
                    if let directoryError { InlineError(text: directoryError) }
                    if friends.isEmpty && query.isEmpty {
                        Text("Accepted requests appear here.").foregroundStyle(.secondary)
                    }
                    ForEach(rows.filter { friendByKey[$0.key] != nil }) { person in
                        sidebarRow(person)
                    }
                }
                Section("Requests") {
                    Button {
                        managingFriends = true
                    } label: {
                        Label(requestCount == 0 ? "Manage requests" : "Manage requests (\(requestCount))",
                              systemImage: "tray")
                    }
                }
                let others = rows.filter { friendByKey[$0.key] == nil }
                if !others.isEmpty {
                    Section("People in your groups") {
                        ForEach(others) { person in sidebarRow(person) }
                    }
                }
            }
            .adaptiveSidebarListStyle()
            .scrollContentBackground(.hidden)
            .background(AppBackground())
            .navigationSplitViewColumnWidth(min: 300, ideal: 340, max: 400)
            .navigationTitle("Friends")
            .navigationBarTitleDisplayMode(.large)
            .overlay {
                if rows.isEmpty && !query.isEmpty { ContentUnavailableView.search }
            }
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { managingFriends = true } label: { Label("Manage friends and send requests", systemImage: "person.crop.circle.badge.plus") }
                    Button { showCreate = true } label: { Label("New balance tab", systemImage: "plus") }
                }
            }
            .searchable(text: $query, placement: .sidebar, prompt: "Search people")
            .refreshable {
                await store.sync()
                await loadDirectory()
            }
        } detail: {
            if let selection, let person = rows.first(where: { $0.key == selection }) {
                FriendDetail(balance: person, friend: friendByKey[person.key])
            } else {
                FriendPlaceholder(showCreate: $showCreate)
            }
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $showCreate) { CreateGroupView(friend: true) }
        .sheet(isPresented: $managingFriends, onDismiss: { Task { await loadDirectory() } }) {
            NavigationStack {
                FriendSettingsView()
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { managingFriends = false } } }
            }
        }
        .task { await loadDirectory() }
    }

    private func loadDirectory() async {
        do {
            async let friendList = store.friends()
            async let invitations = store.invitations()
            async let sent = store.sentFriendRequests()
            let (loaded, incoming, outgoing) = try await (friendList, invitations, sent)
            friends = loaded
            requestCount = incoming.filter { $0.kind == "friend" }.count + outgoing.count
            directoryError = nil
            if selection == nil, size == .regular { selection = rows.first?.key }
        } catch {
            directoryError = error.localizedDescription
        }
    }

    private func sidebarRow(_ person: PersonBalance) -> some View {
        let avatar = friendByKey[person.key]?.avatarURL
        return Button { selection = person.key } label: {
            FriendSidebarRow(person: person, avatarURL: avatar)
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 6, leading: 14, bottom: 6, trailing: 14))
        .listRowBackground(selection == person.key && size == .regular ? Palette.lime.opacity(0.22) : Color.clear)
        .tag(person.key)
        .accessibilityLabel(accessibility(person))
    }

    private func accessibility(_ person: PersonBalance) -> String {
        guard person.hasBalance else { return "\(person.name), settled up" }
        return "\(person.name), net balance \(fx.homeTotalText(person.amounts, signed: true))"
    }
}

struct FriendSidebarRow: View {
    var person: PersonBalance
    var avatarURL: String?
    var body: some View {
        HStack(alignment: .center, spacing: Spacing.s) {
            Avatar(name: person.name, size: 40, avatarURL: avatarURL)
            VStack(alignment: .leading, spacing: 2) {
                Text(person.name)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                BalancePhrase(amounts: person.amounts, positive: "Owes you", negative: "You owe",
                              settled: "Settled up · \(person.groupIDs.count) shared \(person.groupIDs.count == 1 ? "group" : "groups")")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, Spacing.xxs)
        .frame(minHeight: HitTarget.minimum)
        .contentShape(Rectangle())
    }
}

private struct FriendHistoryRow: View {
    @EnvironmentObject private var fx: FXStore
    var entry: LedgerEntry
    var group: ExpenseGroup
    var currentUserID: String?
    private var me: Person? { Analytics.me(in: group, userID: currentUserID) }
    private var date: String {
        guard let date = ISO8601DateFormatter().date(from: entry.createdAt) else { return String(entry.createdAt.prefix(10)) }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
    var body: some View {
        let (net, netText) = me.map { fx.entryNet(entry, for: $0.id) } ?? (0, "")
        HStack(alignment: .center, spacing: 10) {
            EntryBadge(title: entry.title, category: entry.category, size: 36)
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
                Text("\(entry.isSettlement ? "Payment" : entry.isRefund ? "Refund" : (entry.category ?? "Expense"))\(entry.isPending ? " · Pending" : "") · \(group.name) · \(date)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 2) {
                EntryAmount(entry: entry, size: 14)
                if entry.isSpending && net != 0 {
                    Text(entry.isRefund ? (net > 0 ? "you get back \(netText)" : "you owe \(netText) · \(entry.refundOf == nil ? "credit you’re giving" : "refund you received for others")")
                         : net > 0 ? "you lent \(netText)" : "you owe \(netText)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(net > 0 ? Palette.positive : Palette.negative)
                        .lineLimit(2)
                        .multilineTextAlignment(.trailing)
                }
            }
            .layoutPriority(1)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

struct FriendPlaceholder: View {
    @Binding var showCreate: Bool
    var body: some View {
        EmptyStateView(title: "Pick a person", message: "Friends bring their balances together from every group you share.", symbol: "person.2", actionTitle: "Add a friend") { showCreate = true }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(AppBackground())
    }
}

struct FriendDetail: View {
    var balance: PersonBalance
    var friend: SplitUser? = nil
    @EnvironmentObject private var store: ExpenseStore
    @EnvironmentObject private var session: SessionStore
    @State private var newExpenseGroup: ExpenseGroup?
    @State private var settlingGroup: ExpenseGroup?
    @State private var inspecting: LedgerEntry?
    @State private var error: String?
    @State private var creating = false

    private var person: PersonBalance {
        var current = Analytics.allPeople(groups: store.groups, entries: store.entries, userID: store.currentUserID)
            .first { $0.key == balance.key } ?? balance
        if let friend { current.name = friend.name }
        return current
    }
    private var sharedGroups: [ExpenseGroup] {
        person.groupIDs.compactMap { store.group($0) }.filter { !($0.archived ?? false) }
    }
    private var friendGroup: ExpenseGroup? { sharedGroups.first(where: \.isFriend) }
    private var sourcePerson: Person? {
        store.groups.flatMap(\.members).first { Analytics.key($0) == person.key }
    }
    private var history: [LedgerEntry] {
        Analytics.entries(with: person, groups: store.groups, entries: store.entries, userID: store.currentUserID)
    }
    /// History renders a page at a time so a long friendship never builds thousands of rows.
    @State private var historyLimit = BoundedList.page

    private var months: [(String, [LedgerEntry])] {
        let grouped = Dictionary(grouping: history.prefix(historyLimit)) { String($0.createdAt.prefix(7)) }
        return grouped.keys.sorted(by: >).map { ($0, grouped[$0]?.sorted { $0.createdAt > $1.createdAt } ?? []) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                if let error { InlineError(text: error) }
                if let methods = friend?.paymentMethods, !methods.isEmpty {
                    Card {
                        VStack(alignment: .leading, spacing: Spacing.s) {
                            Text("Payment methods").font(.headline)
                            PaymentOptions(methods: methods)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if store.isDemo { Label("Sample tab · changes stay in this preview", systemImage: "sparkles").font(.caption).foregroundStyle(.secondary) }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 360), spacing: 18, alignment: .top)], alignment: .leading, spacing: 18) {
                    historySection
                    sharedSection
                }
            }
            .padding(16)
            .frame(maxWidth: 920)
            .frame(maxWidth: .infinity)
        }
        .background(AppBackground())
        .navigationTitle(person.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // The ink header names the person; keep the title for the back menu only.
            ToolbarItem(placement: .principal) {
                Color.clear.frame(width: 1, height: 1).accessibilityHidden(true)
            }
        }
        .refreshable { await store.sync() }
        .sheet(item: $newExpenseGroup) { group in AddExpenseView(group: group) }
        .sheet(item: $settlingGroup) { group in SettleUpView(group: group) }
        .sheet(item: $inspecting) { entry in EntrySheet(entry: entry) }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 14) {
                    Avatar(name: person.name, size: 52, tint: Palette.lime, avatarURL: friend?.avatarURL)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(person.name)
                            .font(.splitDisplay(24))
                            .foregroundStyle(Palette.onHero)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityAddTraits(.isHeader)
                        Text("\(person.groupIDs.count) shared \(person.groupIDs.count == 1 ? "group" : "groups")\(history.isEmpty ? "" : " · \(history.count) \(history.count == 1 ? "entry" : "entries")")")
                            .font(.caption).foregroundStyle(Palette.lime.opacity(0.62))
                    }
                    Spacer(minLength: 0)
                }
                HeroBalances(balances: person.currencies.map { ($0, person.amount($0)) }, positive: "owes you", negative: "you owe")
            }
            .padding(18)
            .background(
                LinearGradient(colors: [Palette.hero, Palette.hero.opacity(0.94)], startPoint: .topLeading, endPoint: .bottomTrailing),
                in: RoundedRectangle(cornerRadius: Radius.header)
            )
            .overlay(RoundedRectangle(cornerRadius: Radius.header).stroke(Palette.lime.opacity(0.16), lineWidth: 1))
            ActionBar {
                SplitActionButton(title: "Add expense", symbol: "plus", prominent: true) { addExpense() }
                if let group = friendGroup ?? (sharedGroups.count == 1 ? sharedGroups.first : nil) {
                    SplitActionButton(title: "Settle up", symbol: "arrow.left.arrow.right") { settlingGroup = group }
                } else if !sharedGroups.isEmpty {
                    Menu("Settle up", systemImage: "arrow.left.arrow.right") {
                        ForEach(sharedGroups) { group in
                            Button(group.name, systemImage: group.symbol) { settlingGroup = group }
                        }
                    }
                    .frame(minHeight: HitTarget.minimum)
                }
            }
        }
    }

    private var historySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "History", subtitle: history.isEmpty ? "No shared expenses yet" : "\(history.count) \(history.count == 1 ? "entry" : "entries") with \(person.name)")
            if history.isEmpty {
                Card {
                    EmptyPanel(title: "Start a tab", message: "Add an expense with \(person.name) and it will show up here.", symbol: "receipt", actionTitle: "Add expense") { addExpense() }
                }
            } else {
                ForEach(months, id: \.0) { month, entries in
                    VStack(alignment: .leading, spacing: 8) {
                        MonthHeader(date: monthDate(month))
                        Card(padding: 0) {
                            LazyVStack(spacing: 0) {
                                ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                                    if let group = store.group(entry.groupID) {
                                        Button { inspecting = entry } label: {
                                            FriendHistoryRow(entry: entry, group: group, currentUserID: store.currentUserID)
                                                .padding(.horizontal, 14)
                                                .padding(.vertical, 12)
                                        }
                                        .buttonStyle(.plain)
                                        if index < entries.count - 1 { Divider().overlay(Palette.line).padding(.leading, 66) }
                                    }
                                }
                            }
                        }
                    }
                }
                ShowMoreButton(shown: Swift.min(historyLimit, history.count), total: history.count) { historyLimit += BoundedList.page }
            }
        }
    }

    private var sharedSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Shared groups", subtitle: "Balances combine here")
            if sharedGroups.isEmpty {
                Card {
                    HStack(spacing: 12) {
                        Image(systemName: "person.2").foregroundStyle(Palette.evergreen)
                        Text("No groups yet. An expense will start a one-to-one tab.").font(.subheadline).foregroundStyle(.secondary)
                        Spacer()
                    }
                }
            } else {
                ForEach(sharedGroups) { group in
                    NavigationLink {
                        GroupDetail(groupID: group.id)
                    } label: {
                        Card {
                            HStack(spacing: 12) {
                                Image(systemName: group.symbol)
                                    .font(.system(size: 16, weight: .semibold))
                                    .frame(width: 38, height: 38)
                                    .background(group.isFriend ? Palette.raised : Palette.lime.opacity(0.45))
                                    .foregroundStyle(Palette.ink)
                                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(group.name).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
                                    Text("\(group.members.count) people · \(group.currency)").font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(.tertiary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            if friendGroup == nil {
                Text("No one-to-one tab yet. Split will make one the first time you add an expense here.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func addExpense() {
        if let friendGroup { newExpenseGroup = friendGroup; return }
        guard !creating else { return }
        guard let userID = session.userID, sourcePerson != nil || friend != nil else {
            error = "Add this person to a group first."; return
        }
        creating = true; error = nil
        defer { creating = false }
        let draft = MemberDraft(name: person.name, email: sourcePerson?.email, phone: sourcePerson?.phone, userID: friend?.userID ?? sourcePerson?.userID)
        let currency = sharedGroups.first?.currency ?? (Money.currencies.contains(Locale.current.currency?.identifier ?? "") ? Locale.current.currency!.identifier : "USD")
        do {
            try store.create(name: person.name, kind: "friend", currency: currency, people: [draft], userID: userID, displayName: session.displayName)
            if let created = store.groups.first(where: { $0.isFriend && $0.members.contains { Analytics.key($0) == person.key } }) {
                newExpenseGroup = created
            }
        } catch { self.error = error.localizedDescription }
    }

    private func monthDate(_ month: String) -> Date {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM"
        return formatter.date(from: month) ?? Date()
    }
}
