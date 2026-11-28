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
            entry.groupID == group && (entry.allPayers.contains { $0.memberID == seat } || entry.splits.contains { $0.memberID == seat })
        }.sorted { ($0.createdAt, $0.id) > ($1.createdAt, $1.id) }
    }
}

/// A member's statement: who they are and where they stand, then every charge
/// they are part of, grouped by trip or group. Rows open the receipt.
struct MemberCharges: View {
    @EnvironmentObject private var fx: FXStore
    let user: String?
    let groupID: String
    let seatID: String
    @State private var scope: String?
    @State private var scoped = false
    @State private var kind: Kind = .balance
    /// How many rows each group section shows; long statements grow a page at a time.
    @State private var limits: [String: Int] = [:]
    @EnvironmentObject var store: ExpenseStore
    @EnvironmentObject var session: SessionStore

    enum Kind: String, CaseIterable, Identifiable {
        case balance = "Breakdown", charges = "Charges", payments = "Payments"
        var singular: String {
            switch self {
            case .balance: "entry"
            case .charges: "charge"
            case .payments: "payment"
            }
        }
        var plural: String { self == .balance ? "entries" : singular + "s" }
        var id: String { rawValue }
    }

    private struct Statement: Identifiable {
        var group: ExpenseGroup
        var person: Person
        var charges: [LedgerEntry]
        var payments: [LedgerEntry]
        var balance: [LedgerEntry] = []
        func entries(_ kind: Kind) -> [LedgerEntry] {
            switch kind {
            case .balance: balance
            case .charges: charges
            case .payments: payments
            }
        }
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
                                 payments: all.filter { $0.kind == "settlement" },
                                 balance: all.reversed().filter { Ledger.net($0.settling, for: person.id) != 0 })
            }
        if let first = statements.first ?? memberships.first.map({ Statement(group: $0.0, person: $0.1, charges: [], payments: []) }) {
            let isMe = first.person.userID != nil && first.person.userID == session.userID
            let name = isMe ? "You" : first.person.name
            let sections = statements.filter { !$0.entries(kind).isEmpty }
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.section) {
                    header(name: name, isMe: isMe, person: first.person, statements: statements, memberships: memberships)
                    if memberships.count > 1 { groupPicker(memberships, selected: selected) }
                    ForEach(statements.filter { !$0.person.availablePaymentMethods.isEmpty }) { statement in
                        VStack(alignment: .leading, spacing: 8) {
                            SectionHeader(title: "Payment methods", subtitle: statements.count > 1 ? statement.group.name : nil)
                            Card {
                                PaymentOptions(methods: statement.person.availablePaymentMethods)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    if !statements.isEmpty {
                        Picker("Show", selection: $kind) {
                            ForEach(Kind.allCases) { Text($0.rawValue).tag($0) }
                        }
                        .pickerStyle(.segmented)
                    }
                    if sections.isEmpty {
                        EmptyStateView(title: "No \(kind.plural) to show",
                                       message: kind == .balance ? "Entries that affect the balance appear here." : "Recorded \(kind.plural) appear here.",
                                       symbol: "receipt")
                    }
                    ForEach(sections) { statement in
                        section(statement, entries: statement.entries(kind), kind: kind, isMe: isMe)
                    }
                }
                .padding(.horizontal, Spacing.page)
                .padding(.vertical, Spacing.m)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
                .animation(.snappy, value: kind)
            }
            .background(AppBackground())
            .navigationTitle(isMe ? "Your statement" : first.person.name)
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
        var paid: Int64 = 0
        var share: Int64 = 0
        var missing = false
        var approximate = false
        for statement in statements {
            let entries = store.entries(in: statement.group)
            for currency in Set(entries.map(\.settling.currency)) {
                net[currency, default: 0] += Ledger.balances(entries, currency: currency)[statement.person.id] ?? 0
            }
            for original in statement.charges {
                approximate = approximate || original.currency != fx.home
                guard let entry = fx.homeEntry(original) else { missing = true; continue }
                paid += Ledger.paid(entry, by: statement.person.id)
                share += Ledger.share(entry, of: statement.person.id)
            }
        }
        let count = statements.reduce(0) { $0 + $1.charges.count }
        let subtitle: String = {
            if statements.count == 1, let group = statements.first?.group {
                return (person.userID == nil ? "Placeholder · " : "") + group.name
            }
            return "\(statements.count) shared groups"
        }()
        func text(_ amount: Int64) -> String {
            missing ? "Rate unavailable" : (approximate ? "≈ " : "") + Money.text(amount, fx.home)
        }
        return HeroHeader(title: name, subtitle: subtitle) {
            Avatar(name: person.name, size: 52, tint: Palette.lime)
        } footer: {
            HeroBalances(balances: net.keys.sorted().map { ($0, net[$0] ?? 0) },
                         positive: isMe ? "you’re owed" : "gets back",
                         negative: isMe ? "you owe" : "owes")
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
            .padding(.trailing, Spacing.l)
        }
        .trailingScrollFade()
        .accessibilityLabel("Choose a group")
    }

    // MARK: Rows

    private func section(_ statement: Statement, entries: [LedgerEntry], kind: Kind, isMe: Bool) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader(title: statement.group.name,
                          subtitle: "\(entries.count) \(entries.count == 1 ? kind.singular : kind.plural)")
            let key = statement.group.id + "|" + kind.rawValue
            let limit = limits[key] ?? BoundedList.page
            let visible = Array(entries.prefix(limit))
            Card(padding: 0) {
                LazyVStack(spacing: 0) {
                    ForEach(Array(visible.enumerated()), id: \.element.id) { index, entry in
                        NavigationLink(value: LedgerRoute.entry(group: statement.group.id, id: entry.id)) {
                            if kind == .balance {
                                balanceRow(entry, statement: statement)
                            } else {
                                row(entry, statement: statement, isMe: isMe)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Opens the receipt")
                        if index < visible.count - 1 { RowDivider() }
                    }
                }
            }
            ShowMoreButton(shown: visible.count, total: entries.count) { limits[key] = limit + BoundedList.page }
            if kind == .balance {
                let totals = Dictionary(grouping: entries.map(\.settling), by: \.currency).mapValues { lines in
                    lines.reduce(Int64(0)) { $0 + Ledger.net($1, for: statement.person.id) }
                }
                Text("Balance · " + totals.keys.sorted().map { Money.text(totals[$0] ?? 0, $0, signed: true) }.joined(separator: " · "))
                    .font(.subheadline.weight(.semibold))
            }
        }
    }

    private func memberName(_ id: String, in group: ExpenseGroup) -> String {
        guard let person = group.members.first(where: { $0.id == id }) else { return "Someone" }
        return person.userID != nil && person.userID == session.userID ? "You" : person.name
    }

    private func balanceRow(_ entry: LedgerEntry, statement: Statement) -> some View {
        let settled = entry.settling
        let amount = Ledger.net(settled, for: statement.person.id)
        let payer = entry.allPayers.map { memberName($0.memberID, in: statement.group) }.joined(separator: ", ")
        let detail: String
        if entry.isSettlement {
            let payee = entry.splits.map { memberName($0.memberID, in: statement.group) }.joined(separator: ", ")
            detail = "Payment · \(payer) → \(payee)"
        } else if entry.isRefund {
            let original = entry.refundOf.flatMap { id in store.entries(in: statement.group).first { $0.id == id } }
            detail = "\(entry.refundOf == nil ? "Credit" : "Refund") from \(payer)" + (original.map { " · Refund of \($0.title)" } ?? "")
        } else {
            detail = "Expense paid by \(payer)"
        }
        return LedgerRow(title: entry.title,
                         detail: detail + (entry.isPending ? " · Pending" : ""),
                         value: Money.text(amount, settled.currency, signed: true),
                         valueTint: amount > 0 ? Palette.positive : Palette.negative, detailLineLimit: 3) {
            EntryBadge(title: entry.title, category: entry.category, size: 40)
        }
    }

    @ViewBuilder private func row(_ entry: LedgerEntry, statement: Statement, isMe: Bool) -> some View {
        let date = LedgerDate.short(entry.createdAt)
        if entry.kind == "settlement" {
            let to = entry.splits.first.map { memberName($0.memberID, in: statement.group) } ?? "Someone"
            LedgerRow(title: "\(memberName(entry.paidBy, in: statement.group)) → \(to)",
                      detail: date,
                      value: fx.entryText(entry, amount: entry.amount),
                      valueCaption: entry.currency == fx.home ? "payment" : "Sent " + Money.text(entry.amount, entry.currency)) {
                Image(systemName: "arrow.left.arrow.right")
                    .font(.body.weight(.semibold))
                    .frame(width: 40, height: 40)
                    .foregroundStyle(Palette.evergreen)
                    .background(Palette.evergreen.opacity(0.12), in: RoundedRectangle(cornerRadius: Radius.badge))
                    .accessibilityHidden(true)
            }
        } else if entry.isRefund {
            let credit = -Ledger.share(entry, of: statement.person.id)
            LedgerRow(title: entry.title,
                      detail: "\(date) · \(entry.refundOf == nil ? "Credit from" : "Refund to") \(memberName(entry.paidBy, in: statement.group))"
                        + (entry.isPending ? " · Pending" : ""),
                      value: entry.paidBy == statement.person.id
                        ? "Owe " + fx.entryText(entry, amount: entry.amount - credit)
                        : credit == 0 ? fx.portionText(entry, memberID: statement.person.id) : "−" + fx.portionText(entry, memberID: statement.person.id),
                      valueCaption: entry.paidBy == statement.person.id
                        ? (entry.refundOf == nil ? "credit \(isMe ? "you’re" : "they’re") giving" : "refund \(isMe ? "you" : "they") received for others")
                        : "refund of \(fx.entryText(entry, amount: entry.amount))",
                      valueTint: entry.paidBy == statement.person.id ? Palette.negative : credit == 0 ? Color.secondary : Palette.positive) {
                Image(systemName: "arrow.uturn.backward")
                    .font(.body.weight(.semibold))
                    .frame(width: 40, height: 40)
                    .foregroundStyle(Palette.positive)
                    .background(Palette.positive.opacity(0.12), in: RoundedRectangle(cornerRadius: Radius.badge))
                    .accessibilityHidden(true)
            }
        } else {
            let share = Ledger.share(entry, of: statement.person.id)
            let payers = entry.allPayers.map { memberName($0.memberID, in: statement.group) }
            LedgerRow(title: entry.title,
                      detail: "\(date) · \(payers.count > 1 ? "\(payers.count) people" : payers.first ?? "Someone") paid" + (entry.isPending ? " · Pending" : ""),
                      value: fx.portionText(entry, memberID: statement.person.id),
                      valueCaption: "of \(fx.entryText(entry, amount: entry.amount))",
                      valueTint: share == 0 ? Color.secondary : Palette.ink) {
                EntryBadge(title: entry.title, category: entry.category, size: 40)
            }
            .accessibilityValue("\(isMe ? "Your" : "Their") share \(fx.portionText(entry, memberID: statement.person.id)) of \(fx.entryText(entry, amount: entry.amount))")
        }
    }
}
