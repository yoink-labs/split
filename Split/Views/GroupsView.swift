import SwiftUI

struct GroupsView: View {
    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.horizontalSizeClass) private var size
    @State private var selection: String?
    @State private var showCreate = false
    @State private var joining = false
    @State private var query = ""
    @State private var showArchived = false

    private var summaries: [GroupSummary] {
        let all = store.dashboard.groups.filter { !$0.group.isFriend }
        guard !query.trimmingCharacters(in: .whitespaces).isEmpty else { return all }
        return all.filter { $0.group.name.localizedCaseInsensitiveContains(query) || $0.group.members.contains { $0.name.localizedCaseInsensitiveContains(query) } }
    }
    private var openCount: Int { summaries.filter { !$0.isSettled }.count }
    private var archived: [ExpenseGroup] { store.groups.filter { $0.archived == true && !$0.isFriend } }

    var body: some View {
        NavigationSplitView {
            sidebar
        } detail: {
            if let selection, let group = store.group(selection) {
                GroupDetail(groupID: group.id)
            } else {
                GroupDetailPlaceholder(showCreate: $showCreate, joining: $joining)
            }
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $showCreate) { CreateGroupView(friend: false) }
        .sheet(isPresented: $joining) { JoinGroupView { id in selection = id } }
        .onChange(of: store.joinedGroupID) { _, id in
            if let id { selection = id; store.joinedGroupID = nil }
        }
        .onAppear {
            if selection == nil, size == .regular, let first = summaries.first?.group.id { selection = first }
        }
    }

    private var sidebar: some View {
        List(selection: $selection) {
            Section {
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Groups")
                            .font(.splitDisplay(30))
                            .foregroundStyle(Palette.ink)
                            .accessibilityAddTraits(.isHeader)
                        Text("\(summaries.count) \(summaries.count == 1 ? "group" : "groups")\(openCount > 0 ? " · \(openCount) open" : "")")
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
                if store.isDemo {
                    Label("Sample groups · changes stay here", systemImage: "sparkles")
                        .font(.caption).foregroundStyle(.secondary)
                        .listRowBackground(Color.clear)
                }
                if store.pending > 0 || !store.online {
                    Label(store.online ? "\(store.pending) changes waiting to sync" : "Offline · new expenses are saved here", systemImage: store.online ? "arrow.triangle.2.circlepath" : "wifi.slash")
                        .font(.caption).foregroundStyle(Palette.evergreen)
                }
                if let error = store.error {
                    VStack(alignment: .leading, spacing: 6) {
                        InlineError(text: error)
                        Button("Retry sync") { Task { await store.sync() } }.font(.caption.bold())
                    }
                }
            }
            Section {
                if summaries.isEmpty {
                    EmptyPanel(title: query.isEmpty ? "No groups yet" : "No matches", message: query.isEmpty ? "Create a trip, a home, or join a group with a code." : "Try a different name.", symbol: "person.3", actionTitle: query.isEmpty ? "New group" : nil) { showCreate = true }
                        .listRowBackground(Color.clear)
                }
                ForEach(summaries) { summary in
                    Button { selection = summary.group.id } label: {
                        GroupSidebarRow(summary: summary)
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets(top: 5, leading: 10, bottom: 5, trailing: 10))
                    .listRowSeparator(.hidden)
                    .listRowBackground(selection == summary.group.id ? Palette.lime.opacity(0.22) : Color.clear)
                    .tag(summary.group.id)
                    .accessibilityLabel(accessibility(summary))
                }
            }
            if showArchived, !archived.isEmpty {
                Section("Archived") {
                    ForEach(archived) { group in
                        Button { selection = group.id } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "archivebox").foregroundStyle(.secondary)
                                Text(group.name).font(.subheadline.weight(.medium)).foregroundStyle(Palette.ink)
                                Spacer()
                                Text("\(group.members.count) people").font(.caption).foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 4)
                        }
                        .buttonStyle(.plain)
                        .tag(group.id)
                    }
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
            ToolbarItemGroup(placement: .topBarTrailing) {
                Menu {
                    Toggle(isOn: $showArchived) { Label("Show archived", systemImage: "archivebox") }
                    if let first = summaries.first {
                        NavigationLink {
                            InsightsView(group: first.group)
                        } label: {
                            Label("Insights", systemImage: "chart.bar.xaxis")
                        }
                    }
                } label: {
                    Label("More", systemImage: "ellipsis")
                }
                .accessibilityLabel("Group options")
                Menu {
                    Button { showCreate = true } label: { Label("New group", systemImage: "plus") }
                    Button { joining = true } label: { Label("Join with a code", systemImage: "link") }
                } label: {
                    Label("Add group", systemImage: "plus")
                }
                .accessibilityLabel("Group actions")
            }
        }
        .searchable(text: $query, placement: .sidebar, prompt: "Search groups")
        .refreshable { await store.sync() }
    }

    private func accessibility(_ summary: GroupSummary) -> String {
        if summary.isSettled { return "\(summary.group.name), settled up" }
        let amounts = summary.currencies.compactMap { currency -> String? in
            let value = summary.mine[currency] ?? 0
            guard value != 0 else { return nil }
            return (value > 0 ? "you are owed " : "you owe ") + Money.text(abs(value), currency)
        }.joined(separator: ", ")
        return "\(summary.group.name), \(amounts)"
    }
}

struct GroupSidebarRow: View {
    var summary: GroupSummary
    private var balances: [(String, Int64)] {
        summary.currencies.compactMap { currency in
            let amount = summary.mine[currency] ?? 0
            return amount == 0 ? nil : (currency, amount)
        }
    }
    var body: some View {
        HStack(alignment: .center, spacing: 11) {
            Image(systemName: summary.group.symbol)
                .font(.system(size: 17, weight: .semibold))
                .frame(width: 40, height: 40)
                .background(summary.group.isFriend ? Palette.raised : Palette.lime.opacity(0.55))
                .foregroundStyle(summary.group.isFriend ? Palette.evergreen : Palette.ink)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(summary.group.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                Text("\(summary.group.members.count) people · \(summary.group.kind == "trip" ? "Trip" : summary.group.kind == "home" ? "Home" : "Group")")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if summary.isSettled {
                    Text("Settled up")
                        .font(.caption2)
                        .foregroundStyle(Palette.evergreen)
                } else {
                    ForEach(Array(balances.prefix(2)), id: \.0) { balance in
                        HStack(spacing: 4) {
                            Text(Money.text(abs(balance.1), balance.0))
                                .font(.splitAmount(12))
                                .foregroundStyle(balance.1 > 0 ? Palette.positive : Palette.negative)
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                            Text(balance.1 > 0 ? "owed" : "you owe")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
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

struct GroupDetailPlaceholder: View {
    @Binding var showCreate: Bool
    @Binding var joining: Bool
    @EnvironmentObject private var store: ExpenseStore
    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                Image("SplitLogo")
                    .resizable()
                    .frame(width: 76, height: 76)
                    .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                VStack(spacing: 8) {
                    Text("Pick a group")
                        .font(.splitDisplay(28))
                        .foregroundStyle(Palette.ink)
                    Text("Or start something new. Trips, homes, and two-person tabs all live here.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                HStack(spacing: 10) {
                    SplitActionButton(title: "New group", symbol: "plus", prominent: true) { showCreate = true }
                    SplitActionButton(title: "Join group", symbol: "link") { joining = true }
                }
                if store.dashboard.groups.isEmpty {
                    EmptyPanel(title: "Nothing here yet", message: "Your first group starts with a name and a couple of people.", symbol: "person.3")
                }
            }
            .padding(28)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(AppBackground())
    }
}
