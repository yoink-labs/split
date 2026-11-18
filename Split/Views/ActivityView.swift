import SwiftUI

/// The shared ledger feed: every group, grouped by month, newest first.
struct ActivityFeedView: View {
    @EnvironmentObject private var store: ExpenseStore
    @State private var filter: ActivityFilter = .all
    @State private var groupID: String?
    @State private var inspecting: ActivitySelection?
    @State private var showSearch = false
    @State private var liking: Set<String> = []

    private enum ActivityFilter: String, CaseIterable, Identifiable {
        case all, expenses, payments
        var id: String { rawValue }
        var title: String {
            switch self {
            case .all: "All"
            case .expenses: "Expenses"
            case .payments: "Payments"
            }
        }
        var symbol: String {
            switch self {
            case .all: "rectangle.stack"
            case .expenses: "receipt"
            case .payments: "arrow.left.arrow.right"
            }
        }
    }

    private struct ActivitySelection: Identifiable {
        var entry: LedgerEntry
        var group: ExpenseGroup
        var id: String { entry.id }
    }

    private struct MonthSection: Identifiable {
        var id: String
        var date: Date
        var entries: [LedgerEntry]
    }

    private static let monthParser: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM"
        return formatter
    }()

    private var visibleGroupIDs: Set<String> {
        Set(store.groups.filter { !($0.archived ?? false) }.map(\.id))
    }

    private var filteredEntries: [LedgerEntry] {
        store.entries.filter { entry in
            guard visibleGroupIDs.contains(entry.groupID) else { return false }
            if let groupID, entry.groupID != groupID { return false }
            switch filter {
            case .all: return true
            case .expenses: return !entry.isSettlement
            case .payments: return entry.isSettlement
            }
        }
    }

    private var sections: [MonthSection] {
        let grouped = Dictionary(grouping: filteredEntries) { String($0.createdAt.prefix(7)) }
        return grouped.keys.sorted(by: >).map { month in
            MonthSection(
                id: month,
                date: Self.monthParser.date(from: month) ?? Date(),
                entries: grouped[month] ?? []
            )
        }
    }

    private var groupsWithEntries: [ExpenseGroup] {
        let ids = Set(store.entries.map(\.groupID))
        return store.groups
            .filter { ids.contains($0.id) && !($0.archived ?? false) }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private var activeGroupName: String? {
        groupID.flatMap { store.group($0)?.name }
    }

    private var hasFilters: Bool { filter != .all || groupID != nil }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    header
                    statusLine
                    if !filteredEntries.isEmpty { statRail }
                    filterChips
                    if let error = store.error { InlineError(text: error) }
                    if sections.isEmpty {
                        emptyState
                    } else {
                        ForEach(sections) { section in
                            monthSection(section)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .frame(maxWidth: 900)
                .frame(maxWidth: .infinity)
            }
            .background(AppBackground())
            .refreshable { await store.sync() }
            .toolbar(.hidden, for: .navigationBar)
            .ledgerDestinations()
            .sheet(isPresented: $showSearch) {
                NavigationStack { SearchView() }
            }
            .sheet(item: $inspecting) { selection in
                EntryDetails(entry: selection.entry, group: selection.group)
            }
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Activity")
                    .font(.splitDisplay(30))
                    .foregroundStyle(Palette.ink)
                    .accessibilityAddTraits(.isHeader)
                Text("Expenses, payments and the story around them")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Button { showSearch = true } label: {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .foregroundStyle(Palette.ink)
            }
            .buttonStyle(.plain)
            .glassCapsule(tint: Palette.card.opacity(0.40))
            .accessibilityLabel("Search everything")
            filterMenu
        }
    }

    /// A compact count rail. Counts are currency-free so mixed groups stay honest.
    private var statRail: some View {
        let expenses = filteredEntries.filter { !$0.isSettlement }.count
        let payments = filteredEntries.count - expenses
        let comments = filteredEntries.reduce(0) { $0 + ($1.commentCount ?? 0) }
        let open = filteredEntries.compactMap(\.bill).reduce(0) { $0 + $1.openCount }
        return HStack(spacing: 0) {
            stat("\(expenses)", expenses == 1 ? "expense" : "expenses")
            divider
            stat("\(payments)", payments == 1 ? "payment" : "payments")
            divider
            stat("\(comments)", comments == 1 ? "comment" : "comments")
            if open > 0 {
                divider
                stat("\(open)", "open items", tint: Palette.amber)
            }
        }
        .padding(.vertical, 10)
        .glassSurface(cornerRadius: 16, tint: Palette.card.opacity(0.45))
        .accessibilityElement(children: .combine)
    }

    private var divider: some View {
        Rectangle().fill(Palette.line).frame(width: 1, height: 26)
    }

    private func stat(_ value: String, _ label: String, tint: Color = Palette.ink) -> some View {
        VStack(spacing: 1) {
            Text(value).font(.splitAmount(18, weight: .bold)).foregroundStyle(tint).contentTransition(.numericText())
            Text(label).font(.caption2).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity)
    }

    private var statusLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Label(statusText, systemImage: statusSymbol)
                .font(.caption)
                .foregroundStyle(statusTint)
            Spacer(minLength: 8)
        }
        .accessibilityElement(children: .combine)
    }

    private var statusText: String {
        if store.isDemo { return "Sample activity · changes stay in this preview" }
        if !store.online { return "Offline · new changes are saved on this device" }
        if store.syncing { return "Syncing your ledger…" }
        if let error = store.error, !error.isEmpty { return "Sync needs attention" }
        if store.pending > 0 { return "\(store.pending) \(store.pending == 1 ? "change" : "changes") waiting to sync" }
        return "Up to date"
    }

    private var statusSymbol: String {
        if store.isDemo { return "sparkles" }
        if !store.online { return "wifi.slash" }
        if store.syncing { return "arrow.triangle.2.circlepath" }
        if store.error != nil { return "exclamationmark.circle" }
        if store.pending > 0 { return "arrow.triangle.2.circlepath" }
        return "checkmark.circle"
    }

    private var statusTint: Color {
        if store.isDemo { return .secondary }
        if !store.online || store.pending > 0 { return Palette.amber }
        if store.error != nil { return Palette.negative }
        return Palette.evergreen
    }

    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(ActivityFilter.allCases) { value in
                    Chip(
                        title: value.title,
                        symbol: value.symbol,
                        selected: filter == value
                    ) {
                        filter = value
                    }
                }
                if let activeGroupName {
                    Chip(
                        title: activeGroupName,
                        symbol: "person.3",
                        selected: true
                    ) {
                        groupID = nil
                    }
                    .accessibilityLabel("Clear the \(activeGroupName) group filter")
                }
            }
            .padding(.vertical, 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Activity filters")
    }

    private var filterMenu: some View {
        Menu {
            Picker("Group", selection: $groupID) {
                Text("All groups").tag(nil as String?)
                ForEach(groupsWithEntries) { group in
                    Text(group.name).tag(group.id as String?)
                }
            }
            Divider()
            Picker("Type", selection: $filter) {
                ForEach(ActivityFilter.allCases) { value in
                    Text(value.title).tag(value)
                }
            }
            if hasFilters {
                Divider()
                Button("Clear filters", role: .destructive) {
                    filter = .all
                    groupID = nil
                }
            }
        } label: {
            Image(systemName: "line.3.horizontal.decrease.circle")
                .font(.system(size: 16, weight: .semibold))
                .frame(width: 44, height: 44)
                .foregroundStyle(hasFilters ? Palette.evergreen : Palette.ink)
                .glassCapsule(tint: hasFilters ? Palette.lime.opacity(0.55) : Palette.card.opacity(0.40))
        }
        .accessibilityLabel("Filter activity")
    }

    private func monthSection(_ section: MonthSection) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            MonthHeader(
                date: section.date,
                total: "\(section.entries.count) \(section.entries.count == 1 ? "entry" : "entries")"
            )
            Card(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(Array(section.entries.enumerated()), id: \.element.id) { index, entry in
                        if let group = store.group(entry.groupID) {
                            entryRow(entry: entry, group: group, isLast: index == section.entries.count - 1)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func entryRow(entry: LedgerEntry, group: ExpenseGroup, isLast: Bool) -> some View {
        VStack(spacing: 0) {
            Button {
                inspecting = ActivitySelection(entry: entry, group: group)
            } label: {
                EntryRow(
                    entry: entry,
                    group: group,
                    currentUserID: store.currentUserID,
                    showGroup: true,
                    showDate: true,
                    showSocial: false
                )
                .padding(.horizontal, 14)
                .padding(.top, 12)
                .padding(.bottom, 2)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Shows details for this entry")

            HStack(spacing: 14) {
                Button {
                    like(entry)
                } label: {
                    Label(likeTitle(for: entry), systemImage: entry.likedByMe == true ? "hand.thumbsup.fill" : "hand.thumbsup")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(entry.likedByMe == true ? Palette.evergreen : Color.secondary)
                        .padding(.horizontal, 8)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(liking.contains(entry.id))
                .accessibilityLabel(entry.likedByMe == true ? "Remove your like" : "Like this entry")
                .accessibilityValue(entry.likeCount.map { "\($0) \($0 == 1 ? "like" : "likes")" } ?? "No likes yet")

                if let comments = entry.commentCount, comments > 0 {
                    Label("\(comments)", systemImage: "bubble.left")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("\(comments) \(comments == 1 ? "comment" : "comments")")
                }

                Spacer(minLength: 0)
            }
            .padding(.leading, 58)
            .padding(.trailing, 10)
            .padding(.top, -6)

            if !isLast {
                Divider().overlay(Palette.line).padding(.leading, 66)
            }
        }
    }

    private func likeTitle(for entry: LedgerEntry) -> String {
        guard let count = entry.likeCount, count > 0 else { return "Like" }
        return "\(count)"
    }

    private func like(_ entry: LedgerEntry) {
        guard !liking.contains(entry.id) else { return }
        liking.insert(entry.id)
        Task { @MainActor in
            defer { liking.remove(entry.id) }
            do { try await store.toggleLike(entry) }
            catch { store.error = error.localizedDescription }
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        Card {
            if store.entries.isEmpty {
                EmptyPanel(
                    title: "Nothing to catch up on",
                    message: "Expenses and payments appear here as your groups start spending.",
                    symbol: "clock",
                    actionTitle: "Refresh"
                ) {
                    Task { await store.sync() }
                }
            } else {
                EmptyPanel(
                    title: "No entries match",
                    message: hasFilters
                        ? "Try another type, or show every group again."
                        : "There is nothing to show right now.",
                    symbol: "line.3.horizontal.decrease.circle",
                    actionTitle: hasFilters ? "Show everything" : nil
                ) {
                    filter = .all
                    groupID = nil
                }
            }
        }
    }
}
