import SwiftUI

struct GroupsView: View {
    @EnvironmentObject private var fx: FXStore
    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.horizontalSizeClass) private var size
    @State private var selection: String?
    @State private var showCreate = false
    @State private var joining = false
    @State private var importing = false
    @State private var inbox = false
    @State private var findingPeople = false
    @State private var presentedSheet: GroupDetailSheet?
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
                GroupDetail(groupID: group.id) { presentedSheet = $0 }
            } else {
                GroupDetailPlaceholder(showCreate: $showCreate, joining: $joining)
            }
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $showCreate) { CreateGroupView(friend: false) }
        .sheet(isPresented: $joining) { JoinGroupView { id in selection = id } }
        .sheet(isPresented: $importing) { SplitwiseImportView() }
        .sheet(isPresented: $inbox) { InvitationsView { id in selection = id } }
        .sheet(isPresented: $findingPeople) { PeopleSearchView() }
        // The split view can recreate its detail column as the device folds.
        .sheet(item: $presentedSheet) { $0.content }
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
                if store.isDemo {
                    Label("Sample groups · changes stay here", systemImage: "sparkles")
                        .font(.caption).foregroundStyle(.secondary)
                        .listRowBackground(Color.clear)
                }
                if store.pending > 0 || !store.online {
                    Label(store.online ? "\(store.pending) changes waiting to sync" : "Offline · new expenses are saved here", systemImage: store.online ? "arrow.triangle.2.circlepath" : "wifi.slash")
                        .font(.caption).foregroundStyle(Palette.evergreen)
                }
                if store.invitationCount > 0 {
                    Button { inbox = true } label: {
                        Label {
                            Text(store.invitationCount == 1 ? "1 group invitation" : "\(store.invitationCount) group invitations")
                                .font(.subheadline.weight(.semibold))
                        } icon: { Image(systemName: "tray.and.arrow.down.fill") }
                        .foregroundStyle(Palette.evergreen)
                        .frame(minHeight: HitTarget.minimum)
                    }
                    .accessibilityIdentifier("groups-invitations-banner")
                    .listRowBackground(Palette.lime.opacity(0.22))
                }
                if let error = store.error {
                    VStack(alignment: .leading, spacing: 6) {
                        InlineError(text: error)
                        Button("Retry sync") { Task { await store.sync() } }.font(.caption.bold())
                    }
                }
            }
            Section {
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
            if !archived.isEmpty {
                Section {
                    Button {
                        withAnimation(.snappy) { showArchived.toggle() }
                    } label: {
                        Label(showArchived ? "Hide archived groups" : "Show \(archived.count) archived \(archived.count == 1 ? "group" : "groups")", systemImage: "archivebox")
                            .font(.subheadline)
                            .frame(minHeight: HitTarget.minimum)
                    }
                    .foregroundStyle(Palette.evergreen)
                    .listRowBackground(Color.clear)
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
        .navigationTitle("Groups")
        .navigationBarTitleDisplayMode(.large)
        .overlay {
            if summaries.isEmpty {
                if !store.hasLoaded {
                    ProgressView()
                } else if query.isEmpty {
                    VStack(spacing: Spacing.s) {
                        EmptyStateView(title: "No groups yet", message: "Start a trip or a home, join with an invite code, or bring your groups from Splitwise.", symbol: "person.3", actionTitle: "New group") { showCreate = true }
                        Button { importing = true } label: { Label("Import from Splitwise", systemImage: "arrow.down.doc") }
                            .buttonStyle(.splitSecondary)
                            .fixedSize()
                            .accessibilityIdentifier("groups-empty-import")
                    }
                } else {
                    ContentUnavailableView.search
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { findingPeople = true } label: { Image(systemName: "person.crop.circle.badge.plus") }
                    .accessibilityLabel("Find people")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { inbox = true } label: { Image(systemName: store.invitationCount > 0 ? "tray.full" : "tray") }
                    .badge(store.invitationCount)
                    .accessibilityLabel(store.invitationCount > 0 ? "Invitations, \(store.invitationCount) pending" : "Invitations")
                    .accessibilityIdentifier("groups-invitations")
            }
            ToolbarItem(placement: .topBarTrailing) {
                GroupAddMenu(create: { showCreate = true }, join: { joining = true }, importSplitwise: { importing = true })
            }
        }
        .searchable(text: $query, placement: .sidebar, prompt: "Search groups")
        .refreshable { await store.sync() }
    }

    private func accessibility(_ summary: GroupSummary) -> String {
        if summary.isSettled { return "\(summary.group.name), settled up" }
        return "\(summary.group.name), net balance \(fx.homeTotalText(summary.mine, signed: true))"
    }
}

struct GroupSidebarRow: View {
    var summary: GroupSummary
    private var kind: String {
        summary.group.kind == "trip" ? "Trip" : summary.group.kind == "home" ? "Home" : "Group"
    }
    var body: some View {
        HStack(alignment: .center, spacing: Spacing.s) {
            Image(systemName: summary.group.symbol)
                .font(.body.weight(.semibold))
                .frame(width: 40, height: 40)
                .background(Palette.lime.opacity(0.55), in: RoundedRectangle(cornerRadius: Radius.badge))
                .foregroundStyle(Palette.ink)
                .accessibilityHidden(true)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Spacing.s) {
                    identity.fixedSize(horizontal: true, vertical: false)
                    Spacer(minLength: 0)
                    balance(alignment: .trailing).fixedSize(horizontal: true, vertical: false)
                }
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    identity
                    balance(alignment: .leading)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .padding(.vertical, Spacing.xxs)
        .frame(minHeight: HitTarget.minimum)
        .contentShape(Rectangle())
    }

    private var identity: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(summary.group.name)
                .font(.body.weight(.semibold))
                .foregroundStyle(Palette.ink)
            Text("\(summary.group.members.count) people · \(kind)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func balance(alignment: HorizontalAlignment) -> some View {
        BalanceLabel(amounts: summary.mine, positive: "you’re owed", negative: "you owe", alignment: alignment)
    }
}

struct GroupDetailPlaceholder: View {
    @Binding var showCreate: Bool
    @Binding var joining: Bool
    var body: some View {
        EmptyStateView(title: "Pick a group", message: "Choose a group from the list, or start a new one with the + button.", symbol: "person.3", actionTitle: "New group") { showCreate = true }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(AppBackground())
    }
}

/// The single place to start or join a group, shown as a toolbar "+".
struct GroupAddMenu: View {
    var create: () -> Void
    var join: () -> Void
    var importSplitwise: (() -> Void)? = nil
    var body: some View {
        Menu {
            Button(action: create) { Label("New group", systemImage: "person.3") }
            Button(action: join) { Label("Join with code or link", systemImage: "link") }
            if let importSplitwise {
                Divider()
                Button(action: importSplitwise) { Label("Import from Splitwise", systemImage: "arrow.down.doc") }
            }
        } label: {
            Label("Add group", systemImage: "plus")
        }
        .accessibilityIdentifier("groups-add-menu")
    }
}
