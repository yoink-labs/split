import SwiftUI

/// Global search across groups, people and the ledger. Free, like everything else.
struct SearchView: View {
    var showsClose = true
    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var inspecting: EntryHit?
    @FocusState private var focused: Bool

    private struct EntryHit: Identifiable {
        var entry: LedgerEntry
        var group: ExpenseGroup
        var id: String { entry.id }
    }

    private var trimmedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var results: SearchResults {
        let people = Analytics.allPeople(groups: store.groups, entries: store.entries, userID: store.currentUserID)
        return Search.run(query, groups: store.groups, entries: store.entries, people: people)
    }

    private var entryHits: [EntryHit] {
        results.entries.compactMap { entry in
            store.group(entry.groupID).map { EntryHit(entry: entry, group: $0) }
        }
    }

    private var suggestions: [String] {
        var values: [String] = []
        var seen = Set<String>()
        func add(_ value: String) {
            let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !clean.isEmpty, seen.insert(clean.lowercased()).inserted else { return }
            values.append(clean)
        }
        for group in store.groups
            .filter({ !($0.archived ?? false) })
            .sorted(by: { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }) {
            add(group.name)
        }
        for category in Set(store.entries.compactMap(\.category)).sorted() {
            add(category)
        }
        return Array(values.prefix(8))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                searchField
                if trimmedQuery.isEmpty {
                    idleState
                } else if results.isEmpty {
                    noResultsState
                } else {
                    resultSections
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: 900)
            .frame(maxWidth: .infinity)
        }
        .background(AppBackground())
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Search")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if showsClose {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .sheet(item: $inspecting) { hit in
            EntryDetails(entry: hit.entry, group: hit.group)
        }
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.body.weight(.semibold))
                .foregroundStyle(Palette.evergreen)
                .accessibilityHidden(true)
            TextField("Groups, people, expenses", text: $query)
                .textFieldStyle(.plain)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused($focused)
                .accessibilityLabel("Search groups, people and expenses")
            if !query.isEmpty {
                Button {
                    query = ""
                    focused = true
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, query.isEmpty ? 16 : 4)
        .padding(.vertical, 4)
        .frame(minHeight: 54)
        .background(Palette.card)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(focused ? Palette.evergreen.opacity(0.6) : Palette.line, lineWidth: 1)
        )
        .onTapGesture { focused = true }
    }

    private var idleState: some View {
        VStack(alignment: .leading, spacing: 18) {
            Card {
                EmptyPanel(
                    title: "Search all of Split",
                    message: "Find a group by name or member, a person you share tabs with, or an expense by title, note, category or amount.",
                    symbol: "magnifyingglass"
                )
            }
            if !suggestions.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader(title: "Try a search", subtitle: "A group or category from your ledger")
                    FlowLayout(spacing: 8) {
                        ForEach(suggestions, id: \.self) { suggestion in
                            Chip(title: suggestion, symbol: "arrow.up.left") {
                                query = suggestion
                            }
                        }
                    }
                }
            }
        }
    }

    private var noResultsState: some View {
        Card {
            EmptyPanel(
                title: "No matches for “\(trimmedQuery)”",
                message: "Try a shorter word, a person’s name, or an amount like 42.50.",
                symbol: "questionmark.circle",
                actionTitle: "Clear search"
            ) {
                query = ""
                focused = true
            }
        }
    }

    @ViewBuilder
    private var resultSections: some View {
        if !results.groups.isEmpty {
            groupSection
        }
        if !results.people.isEmpty {
            peopleSection
        }
        if !entryHits.isEmpty {
            entrySection
        }
    }

    private var groupSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(
                title: "Groups",
                subtitle: "\(results.groups.count) \(results.groups.count == 1 ? "group" : "groups")"
            )
            Card(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(Array(results.groups.enumerated()), id: \.element.id) { index, group in
                        NavigationLink {
                            GroupDetail(groupID: group.id)
                        } label: {
                            groupRow(group)
                        }
                        .buttonStyle(.plain)
                        if index < results.groups.count - 1 {
                            Divider().overlay(Palette.line).padding(.leading, 62)
                        }
                    }
                }
            }
        }
    }

    private var peopleSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(
                title: "People",
                subtitle: "\(results.people.count) \(results.people.count == 1 ? "person" : "people")"
            )
            Card(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(Array(results.people.enumerated()), id: \.element.id) { index, person in
                        NavigationLink {
                            FriendDetail(balance: person)
                        } label: {
                            PersonBalanceRow(person: person)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 12)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        if index < results.people.count - 1 {
                            Divider().overlay(Palette.line).padding(.leading, 68)
                        }
                    }
                }
            }
        }
    }

    private var entrySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(
                title: "Expenses and payments",
                subtitle: "\(entryHits.count) \(entryHits.count == 1 ? "entry" : "entries")"
            )
            Card(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(Array(entryHits.enumerated()), id: \.element.id) { index, hit in
                        Button {
                            inspecting = hit
                        } label: {
                            EntryRow(
                                entry: hit.entry,
                                group: hit.group,
                                currentUserID: store.currentUserID,
                                showGroup: true,
                                showDate: true
                            )
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Shows details for this entry")
                        if index < entryHits.count - 1 {
                            Divider().overlay(Palette.line).padding(.leading, 66)
                        }
                    }
                }
            }
        }
    }

    private func groupRow(_ group: ExpenseGroup) -> some View {
        let summary = store.summary(for: group)
        return HStack(spacing: 12) {
            Image(systemName: group.symbol)
                .font(.system(size: 17, weight: .semibold))
                .frame(width: 42, height: 42)
                .background(group.isFriend ? Palette.raised : Palette.lime.opacity(0.55))
                .foregroundStyle(group.isFriend ? Palette.evergreen : Palette.ink)
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(group.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                Text("\(group.members.count) \(group.members.count == 1 ? "person" : "people") · \(group.currency)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            groupBalance(summary)
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the group")
    }

    @ViewBuilder
    private func groupBalance(_ summary: GroupSummary) -> some View {
        if summary.isSettled {
            Text("Settled")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Palette.evergreen)
        } else if let currency = summary.currencies.first(where: { (summary.mine[$0] ?? 0) != 0 }) {
            let amount = summary.mine[currency] ?? 0
            Text(Money.text(abs(amount), currency))
                .font(.splitAmount(14))
                .foregroundStyle(amount > 0 ? Palette.positive : Palette.negative)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
    }

}
