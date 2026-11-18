import SwiftUI

enum LedgerRoute: Hashable {
    case group(String)
    case member(group: String, seat: String)
    case account(String)
    case entry(group: String, id: String)
}

extension View {
    func ledgerDestinations() -> some View {
        navigationDestination(for: LedgerRoute.self) { LedgerDestination(route: $0) }
    }
}

private struct LedgerDestination: View {
    let route: LedgerRoute
    @EnvironmentObject var store: ExpenseStore

    var body: some View {
        switch route {
        case .group(let id):
            GroupDetail(groupID: id)
        case .account(let user):
            MemberCharges(user: user, groupID: "", seatID: "")
        case .member(let group, let seat):
            MemberCharges(user: store.group(group)?.members.first { $0.id == seat }?.userID,
                          groupID: group, seatID: seat)
        case .entry(let groupID, let id):
            if let group = store.group(groupID),
               let entry = store.state.snapshot.entries.first(where: { $0.groupID == groupID && $0.id == id }) {
                EntryDetails(entry: entry, group: group, embedded: true)
            } else {
                ContentUnavailableView("Entry unavailable", systemImage: "receipt")
            }
        }
    }
}

extension Snapshot {
    func memberships(user: String?, groupID: String, seatID: String) -> [(ExpenseGroup, Person)] {
        groups.compactMap { group in
            let member = group.members.first { person in
                if let user { return person.userID == user }
                return group.id == groupID && person.id == seatID
            }
            return member.map { (group, $0) }
        }
    }

    func charges(group: String, seat: String) -> [LedgerEntry] {
        entries.filter { entry in
            entry.groupID == group && (entry.paidBy == seat || entry.splits.contains { $0.memberID == seat })
        }.sorted { ($0.createdAt, $0.id) > ($1.createdAt, $1.id) }
    }
}

/// A member's statement: who they are and where they stand, then every charge
/// they are part of, grouped by trip or group. Rows open the receipt.
struct MemberCharges: View {
    let user: String?
    let groupID: String
    let seatID: String
    @State private var scope: String?
    @State private var scoped = false
    @State private var kind: Kind = .charges
    @EnvironmentObject var store: ExpenseStore
    @EnvironmentObject var session: SessionStore

    enum Kind: String, CaseIterable, Identifiable {
        case charges = "Charges", payments = "Payments"
        var id: String { rawValue }
    }

    private struct Statement: Identifiable {
        var group: ExpenseGroup
        var person: Person
        var charges: [LedgerEntry]
        var payments: [LedgerEntry]
        var id: String { group.id }
    }

    var body: some View {
        let snapshot = store.state.snapshot
        let memberships = snapshot.memberships(user: user, groupID: groupID, seatID: seatID)
        let selected = scoped ? scope : (groupID.isEmpty ? nil : groupID)
        let statements = memberships
            .filter { selected == nil || $0.0.id == selected }
            .map { group, person in
                let all = snapshot.charges(group: group.id, seat: person.id)
                return Statement(group: group, person: person,
                                 charges: all.filter { $0.kind != "settlement" },
                                 payments: all.filter { $0.kind == "settlement" })
            }
        if let first = statements.first ?? memberships.first.map({ Statement(group: $0.0, person: $0.1, charges: [], payments: []) }) {
            let isMe = first.person.userID != nil && first.person.userID == session.userID
            let name = isMe ? "You" : first.person.name
            let hasPayments = statements.contains { !$0.payments.isEmpty }
            let shown = hasPayments ? kind : .charges
            let sections = statements.filter { !(shown == .charges ? $0.charges : $0.payments).isEmpty }
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.section) {
                    header(name: name, isMe: isMe, person: first.person, statements: statements, memberships: memberships)
                    if memberships.count > 1 { groupPicker(memberships, selected: selected) }
                    if hasPayments {
                        Picker("Show", selection: $kind) {
                            ForEach(Kind.allCases) { Text($0.rawValue).tag($0) }
                        }
                        .pickerStyle(.segmented)
                    }
                    if sections.isEmpty {
                        EmptyStateView(title: shown == .charges ? "No charges yet" : "No payments yet",
                                       message: shown == .charges ? "Expenses \(isMe ? "you’re" : "\(name) is") part of appear here." : "Recorded payments appear here.",
                                       symbol: shown == .charges ? "receipt" : "arrow.left.arrow.right")
                    }
                    ForEach(sections) { statement in
                        section(statement, entries: shown == .charges ? statement.charges : statement.payments, kind: shown, isMe: isMe)
                    }
                }
                .padding(.horizontal, Spacing.page)
                .padding(.vertical, Spacing.m)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
                .animation(.snappy, value: shown)
            }
            .background(AppBackground())
            .navigationTitle(isMe ? "Your charges" : first.person.name)
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await store.sync() }
        } else {
            ContentUnavailableView("No shared groups", systemImage: "person.2", description: Text("Charges appear here once you share a group."))
                .background(AppBackground())
        }
    }

    // MARK: Header

    private func header(name: String, isMe: Bool, person: Person, statements: [Statement], memberships: [(ExpenseGroup, Person)]) -> some View {
        var net: [String: Int64] = [:]
        var paid: [String: Int64] = [:]
        var share: [String: Int64] = [:]
        for statement in statements {
            let entries = store.entries(in: statement.group)
            for currency in Set(entries.map(\.settling.currency)) {
                net[currency, default: 0] += Ledger.balances(entries, currency: currency)[statement.person.id] ?? 0
            }
            for entry in statement.charges.map(\.settling) {
                paid[entry.currency, default: 0] += Ledger.paid(entry, by: statement.person.id)
                share[entry.currency, default: 0] += Ledger.share(entry, of: statement.person.id)
            }
        }
        let count = statements.reduce(0) { $0 + $1.charges.count }
        let subtitle: String = {
            if statements.count == 1, let group = statements.first?.group {
                return (person.userID == nil ? "Placeholder · " : "") + group.name
            }
            return "\(statements.count) shared groups"
        }()
        func text(_ values: [String: Int64]) -> String {
            let parts = values.keys.sorted().compactMap { key in values[key].flatMap { $0 == 0 ? nil : Money.text($0, key) } }
            return parts.isEmpty ? "—" : parts.joined(separator: " · ")
        }
        return HeroHeader(title: name, subtitle: subtitle) {
            Avatar(name: person.name, size: 52, tint: Palette.lime)
        } footer: {
            HeroBalances(balances: net.keys.sorted().map { ($0, net[$0] ?? 0) },
                         positive: isMe ? "you’re owed" : "gets back",
                         negative: isMe ? "you owe" : "owes")
            if net.values.contains(where: { $0 != 0 }) {
                ApproxTotal(amounts: net, onHero: true, positive: isMe ? "you’re owed" : "gets back", negative: isMe ? "you owe" : "owes")
            }
            HeroStats(items: [("Paid", text(paid)), ("Share", text(share)), ("Charges", "\(count)")])
        }
    }

    private func groupPicker(_ memberships: [(ExpenseGroup, Person)], selected: String?) -> some View {
        let binding = Binding<String?>(get: { selected }, set: { scope = $0; scoped = true })
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Spacing.xs) {
                Chip(title: "All groups", selected: selected == nil) { binding.wrappedValue = nil }
                ForEach(memberships, id: \.0.id) { group, _ in
                    Chip(title: group.name, symbol: group.symbol, selected: selected == group.id) { binding.wrappedValue = group.id }
                }
            }
            .frame(minHeight: HitTarget.minimum)
        }
        .scrollClipDisabled()
        .accessibilityLabel("Choose a group")
    }

    // MARK: Rows

    private func section(_ statement: Statement, entries: [LedgerEntry], kind: Kind, isMe: Bool) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader(title: statement.group.name,
                          subtitle: "\(entries.count) \(entries.count == 1 ? (kind == .charges ? "charge" : "payment") : (kind == .charges ? "charges" : "payments"))")
            Card(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                        NavigationLink(value: LedgerRoute.entry(group: statement.group.id, id: entry.id)) {
                            row(entry, statement: statement, isMe: isMe)
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Opens the receipt")
                        if index < entries.count - 1 { RowDivider() }
                    }
                }
            }
        }
    }

    private func memberName(_ id: String, in group: ExpenseGroup) -> String {
        guard let person = group.members.first(where: { $0.id == id }) else { return "Someone" }
        return person.userID != nil && person.userID == session.userID ? "You" : person.name
    }

    @ViewBuilder private func row(_ entry: LedgerEntry, statement: Statement, isMe: Bool) -> some View {
        let date = LedgerDate.short(entry.createdAt)
        if entry.kind == "settlement" {
            let to = entry.splits.first.map { memberName($0.memberID, in: statement.group) } ?? "Someone"
            LedgerRow(title: "\(memberName(entry.paidBy, in: statement.group)) → \(to)",
                      detail: date,
                      value: Money.text(entry.amount, entry.currency),
                      valueCaption: "payment") {
                Image(systemName: "arrow.left.arrow.right")
                    .font(.body.weight(.semibold))
                    .frame(width: 40, height: 40)
                    .foregroundStyle(Palette.evergreen)
                    .background(Palette.evergreen.opacity(0.12), in: RoundedRectangle(cornerRadius: Radius.badge))
                    .accessibilityHidden(true)
            }
        } else {
            let share = Ledger.share(entry, of: statement.person.id)
            let payers = entry.allPayers.map { memberName($0.memberID, in: statement.group) }
            LedgerRow(title: entry.title,
                      detail: "\(date) · \(payers.count > 1 ? "\(payers.count) people" : payers.first ?? "Someone") paid",
                      value: Money.text(share, entry.currency),
                      valueCaption: "of \(Money.text(entry.amount, entry.currency))",
                      valueTint: share == 0 ? Color.secondary : Palette.ink) {
                CategoryBadge(category: entry.category, size: 40)
            }
            .accessibilityValue("\(isMe ? "Your" : "Their") share \(Money.text(share, entry.currency)) of \(Money.text(entry.amount, entry.currency))")
        }
    }
}
