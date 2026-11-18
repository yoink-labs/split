import SwiftUI

struct FriendsView: View {
    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.horizontalSizeClass) private var size
    @State private var selection: String?
    @State private var showCreate = false
    @State private var query = ""

    private var rows: [PersonBalance] {
        let all = Analytics.allPeople(groups: store.groups, entries: store.entries, userID: store.currentUserID)
        guard !query.trimmingCharacters(in: .whitespaces).isEmpty else { return all }
        return all.filter { $0.name.localizedCaseInsensitiveContains(query) }
    }
    private var openCount: Int { rows.filter(\.hasBalance).count }

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Section {
                    HStack(alignment: .top, spacing: 10) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Friends")
                                .font(.splitDisplay(30))
                                .foregroundStyle(Palette.ink)
                                .accessibilityAddTraits(.isHeader)
                            Text("\(rows.count) \(rows.count == 1 ? "person" : "people")\(openCount > 0 ? " · \(openCount) with a balance" : "")")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }
                    .listRowInsets(EdgeInsets(top: 10, leading: 12, bottom: 8, trailing: 12))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                }
                Section {
                    if store.isDemo { Label("Sample people · changes stay here", systemImage: "sparkles").font(.caption).foregroundStyle(.secondary).listRowBackground(Color.clear) }
                }
                Section {
                    if rows.isEmpty {
                        EmptyPanel(
                            title: query.isEmpty ? "No friends yet" : "No matches",
                            message: query.isEmpty ? "Add someone to start a one-to-one tab, or share a group." : "Try a different name.",
                            symbol: "person.2"
                        )
                        .listRowBackground(Color.clear)
                    }
                    ForEach(rows) { person in
                        Button { selection = person.key } label: {
                            FriendSidebarRow(person: person)
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(selection == person.key ? Palette.lime.opacity(0.20) : Color.clear)
                        .tag(person.key)
                        .accessibilityLabel(accessibility(person))
                    }
                }
            }
            .adaptiveSidebarListStyle()
            .scrollContentBackground(.hidden)
            .background(AppBackground())
            .navigationSplitViewColumnWidth(min: 300, ideal: 340, max: 400)
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showCreate = true } label: { Label("Add friend", systemImage: "person.badge.plus") }
                        .accessibilityLabel("Add friend")
                }
            }
            .searchable(text: $query, placement: .sidebar, prompt: "Search people")
            .refreshable { await store.sync() }
        } detail: {
            if let selection, let person = rows.first(where: { $0.key == selection }) {
                FriendDetail(balance: person)
            } else {
                FriendPlaceholder(showCreate: $showCreate)
            }
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $showCreate) { CreateGroupView(friend: true) }
        .onAppear {
            if selection == nil, size == .regular, let first = rows.first?.key { selection = first }
        }
    }

    private func accessibility(_ person: PersonBalance) -> String {
        guard person.hasBalance else { return "\(person.name), settled up" }
        let amounts = person.currencies.map { currency in
            let value = person.amount(currency)
            return (value > 0 ? "they owe you " : "you owe them ") + Money.text(abs(value), currency)
        }.joined(separator: ", ")
        return "\(person.name), \(amounts)"
    }
}

struct FriendSidebarRow: View {
    var person: PersonBalance
    private var shown: [String] { Array(person.currencies.prefix(2)) }
    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Avatar(name: person.name, size: 38)
            VStack(alignment: .leading, spacing: 3) {
                Text(person.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                if person.hasBalance {
                    ForEach(shown, id: \.self) { currency in
                        let amount = person.amount(currency)
                        HStack(spacing: 4) {
                            Text(Money.text(abs(amount), currency))
                                .font(.splitAmount(12))
                                .foregroundStyle(amount < 0 ? Palette.negative : Palette.positive)
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                            Text(amount < 0 ? "you owe" : "owes you")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    if person.currencies.count > 2 {
                        Text("+\(person.currencies.count - 2) more currencies")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                } else {
                    Text("Settled up")
                        .font(.caption2)
                        .foregroundStyle(Palette.evergreen)
                }
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
    }
}

private struct FriendHistoryRow: View {
    var entry: LedgerEntry
    var group: ExpenseGroup
    var currentUserID: String?
    private var net: Int64 {
        guard let me = Analytics.me(in: group, userID: currentUserID) else { return 0 }
        return Ledger.net(entry, for: me.id)
    }
    private var date: String {
        guard let date = ISO8601DateFormatter().date(from: entry.createdAt) else { return String(entry.createdAt.prefix(10)) }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            CategoryBadge(category: entry.category, size: 36)
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
                Text("\(entry.isSettlement ? "Payment" : (entry.category ?? "Expense")) · \(group.name) · \(date)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 2) {
                AmountText(minor: entry.amount, currency: entry.currency, size: 14)
                if entry.kind == "expense" && net != 0 {
                    Text(net > 0 ? "you lent \(Money.text(net, entry.currency))" : "you owe \(Money.text(abs(net), entry.currency))")
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
        ScrollView {
            VStack(spacing: 22) {
                Image(systemName: "person.2.circle.fill")
                    .font(.system(size: 58, weight: .light))
                    .foregroundStyle(Palette.evergreen)
                VStack(spacing: 8) {
                    Text("Pick a person")
                        .font(.splitDisplay(28))
                        .foregroundStyle(Palette.ink)
                    Text("Friends bring their balances together from every group you share.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                SplitActionButton(title: "Add a friend", symbol: "person.badge.plus", prominent: true) { showCreate = true }
            }
            .padding(28)
            .frame(maxWidth: 500)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(AppBackground())
    }
}

struct FriendDetail: View {
    var balance: PersonBalance
    @EnvironmentObject private var store: ExpenseStore
    @EnvironmentObject private var session: SessionStore
    @State private var newExpenseGroup: ExpenseGroup?
    @State private var settlingGroup: ExpenseGroup?
    @State private var showSettlePicker = false
    @State private var inspecting: LedgerEntry?
    @State private var error: String?
    @State private var creating = false

    private var person: PersonBalance {
        Analytics.allPeople(groups: store.groups, entries: store.entries, userID: store.currentUserID)
            .first { $0.key == balance.key } ?? balance
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
    private var months: [(String, [LedgerEntry])] {
        let grouped = Dictionary(grouping: history) { String($0.createdAt.prefix(7)) }
        return grouped.keys.sorted(by: >).map { ($0, grouped[$0]?.sorted { $0.createdAt > $1.createdAt } ?? []) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                if let error { InlineError(text: error) }
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
        .sheet(isPresented: $showSettlePicker) { FriendSettleSheet(groups: sharedGroups) { settlingGroup = $0 } }
        .sheet(item: $inspecting) { entry in EntrySheet(entry: entry) }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 14) {
                    Avatar(name: person.name, size: 52, tint: Palette.lime)
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
                if person.hasBalance {
                    FlowLayout(spacing: 18, lineSpacing: 8) {
                        ForEach(person.currencies, id: \.self) { currency in
                            let amount = person.amount(currency)
                            if amount != 0 {
                                HStack(alignment: .firstTextBaseline, spacing: 6) {
                                    Text(Money.text(abs(amount), currency))
                                        .font(.splitAmount(person.currencies.count > 1 ? 20 : 26, weight: .bold))
                                        .foregroundStyle(amount > 0 ? Palette.lime : Color(red: 1, green: 0.72, blue: 0.60))
                                        .contentTransition(.numericText())
                                    Text(amount > 0 ? "owes you" : "you owe")
                                        .font(.caption.weight(.medium)).foregroundStyle(Palette.onHero.opacity(0.65))
                                }
                                .accessibilityElement(children: .combine)
                            }
                        }
                    }
                } else {
                    Label("Settled up", systemImage: "checkmark.circle.fill")
                        .font(.headline)
                        .foregroundStyle(Palette.lime)
                }
            }
            .padding(18)
            .background(
                LinearGradient(colors: [Palette.hero, Palette.hero.opacity(0.94)], startPoint: .topLeading, endPoint: .bottomTrailing),
                in: RoundedRectangle(cornerRadius: 24, style: .continuous)
            )
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(Palette.lime.opacity(0.16), lineWidth: 1))
            HStack(spacing: 9) {
                SplitActionButton(title: "Add expense", symbol: "plus", prominent: true) { addExpense() }
                SplitActionButton(title: "Settle up", symbol: "arrow.left.arrow.right") { settle() }
                Spacer(minLength: 0)
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
                            VStack(spacing: 0) {
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
        guard let userID = session.userID, let sourcePerson else {
            error = "Add this person to a group first."; return
        }
        creating = true; error = nil
        defer { creating = false }
        let draft = MemberDraft(name: sourcePerson.name, email: sourcePerson.email, phone: sourcePerson.phone, userID: sourcePerson.userID)
        let currency = sharedGroups.first?.currency ?? (Money.currencies.contains(Locale.current.currency?.identifier ?? "") ? Locale.current.currency!.identifier : "USD")
        do {
            try store.create(name: sourcePerson.name, kind: "friend", currency: currency, people: [draft], userID: userID, displayName: session.displayName)
            if let created = store.groups.first(where: { $0.isFriend && $0.members.contains { Analytics.key($0) == person.key } }) {
                newExpenseGroup = created
            }
        } catch { self.error = error.localizedDescription }
    }

    private func settle() {
        if let friendGroup { settlingGroup = friendGroup }
        else if sharedGroups.isEmpty { error = "No shared expenses yet." }
        else { showSettlePicker = true }
    }

    private func monthDate(_ month: String) -> Date {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM"
        return formatter.date(from: month) ?? Date()
    }
}

struct FriendSettleSheet: View {
    var groups: [ExpenseGroup]
    var onPick: (ExpenseGroup) -> Void
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 10) {
                    Text("Choose a group to settle in.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.bottom, 4)
                    ForEach(groups) { group in
                        Button { dismiss(); onPick(group) } label: {
                            Card {
                                HStack {
                                    Image(systemName: group.symbol).foregroundStyle(Palette.evergreen)
                                    Text(group.name).font(.headline).foregroundStyle(Palette.ink)
                                    Spacer()
                                    Text(group.currency).font(.caption).foregroundStyle(.secondary)
                                    Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(.tertiary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(16)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .background(AppBackground())
            .navigationTitle("Settle up")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}
