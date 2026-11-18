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

struct MemberCharges: View {
    let user: String?
    let groupID: String
    let seatID: String
    @State private var selected: String?
    @EnvironmentObject var store: ExpenseStore
    @EnvironmentObject var session: SessionStore

    var body: some View {
        let snapshot = store.state.snapshot
        let memberships = snapshot.memberships(user: user, groupID: groupID, seatID: seatID)
        if let (group, person) = memberships.first(where: { $0.0.id == (selected ?? groupID) }) ?? memberships.first {
            let entries = snapshot.charges(group: group.id, seat: person.id)
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header(group: group, person: person, memberships: memberships)
                    chargesSection("Charges", entries.filter { $0.kind == "expense" }, person: person, group: group)
                    let payments = entries.filter { $0.kind == "settlement" }
                    if !payments.isEmpty {
                        chargesSection("Payments", payments, person: person, group: group)
                    }
                }
                .padding(16)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .background(AppBackground())
            .navigationTitle(person.userID == session.userID ? "Your activity" : person.name)
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await store.sync() }
        } else {
            ContentUnavailableView("No shared groups", systemImage: "person.2", description: Text("Charges appear here once you share a group."))
                .background(AppBackground())
        }
    }

    private func header(group: ExpenseGroup, person: Person, memberships: [(ExpenseGroup, Person)]) -> some View {
        let expenses = store.entries(in: group).filter { $0.kind == "expense" && $0.settling.currency == group.currency }
        let paid = expenses.filter { $0.paidBy == person.id }.reduce(Int64(0)) { $0 + $1.settling.amount }
        let share = expenses.reduce(Int64(0)) { sum, entry in
            sum + (entry.settling.splits.first { $0.memberID == person.id }?.amount ?? 0)
        }
        let count = store.state.snapshot.charges(group: group.id, seat: person.id).count
        let label = person.userID == session.userID ? "You" : person.name
        return VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 14) {
                Avatar(name: person.name, size: 52, tint: Palette.lime)
                VStack(alignment: .leading, spacing: 3) {
                    Text(label)
                        .font(.splitDisplay(24))
                        .foregroundStyle(Palette.onHero)
                        .lineLimit(2)
                    Text(person.userID == nil ? "Placeholder · \(group.name)" : "Group member · \(group.name)")
                        .font(.caption)
                        .foregroundStyle(Palette.lime.opacity(0.65))
                }
                Spacer(minLength: 0)
            }
            if memberships.count > 1 {
                Menu {
                    ForEach(memberships.indices, id: \.self) { index in
                        let membership = memberships[index]
                        Button {
                            selected = membership.0.id
                        } label: {
                            if membership.0.id == group.id {
                                Label(membership.0.name, systemImage: "checkmark")
                            } else {
                                Text(membership.0.name)
                            }
                        }
                    }
                } label: {
                    Label(group.name, systemImage: "chevron.up.chevron.down")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 13)
                        .frame(minHeight: 42)
                        .foregroundStyle(Palette.hero)
                        .background(Palette.lime, in: Capsule())
                }
                .accessibilityLabel("Choose a group statement")
            }
            HStack(spacing: 0) {
                stat("\(count)", label: "Entries")
                divider
                stat(Money.text(paid, group.currency), label: "Paid")
                divider
                stat(Money.text(share, group.currency), label: "Share")
            }
            .padding(.vertical, 10)
            .background(Palette.onHero.opacity(0.06), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(count) entries, paid \(Money.text(paid, group.currency)), share \(Money.text(share, group.currency))")
        }
        .padding(18)
        .background(
            LinearGradient(colors: [Palette.hero, Palette.hero.opacity(0.94)], startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: 24, style: .continuous)
        )
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(Palette.lime.opacity(0.16), lineWidth: 1))
    }

    private func stat(_ value: String, label: String) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.splitAmount(15))
                .foregroundStyle(Palette.onHero)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(label)
                .font(.caption2)
                .foregroundStyle(Palette.lime.opacity(0.62))
        }
        .frame(maxWidth: .infinity)
    }

    private var divider: some View {
        Rectangle().fill(Palette.lime.opacity(0.16)).frame(width: 1, height: 30)
    }

    private func chargesSection(_ title: String, _ entries: [LedgerEntry], person: Person, group: ExpenseGroup) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: title, subtitle: entries.isEmpty ? "Nothing here yet" : "\(entries.count) \(entries.count == 1 ? "entry" : "entries")")
            Card(padding: 0) {
                if entries.isEmpty {
                    HStack(spacing: 10) {
                        Image(systemName: "checkmark.seal.fill").foregroundStyle(Palette.evergreen)
                        Text("No \(title.lowercased()) in \(group.name).").font(.subheadline).foregroundStyle(.secondary)
                        Spacer()
                    }
                    .padding(14)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                            NavigationLink(value: LedgerRoute.entry(group: group.id, id: entry.id)) {
                                row(entry, person: person, group: group)
                            }
                            .buttonStyle(.plain)
                            if index < entries.count - 1 { Divider().overlay(Palette.line).padding(.leading, 64) }
                        }
                    }
                }
            }
        }
    }

    private func row(_ entry: LedgerEntry, person: Person, group: ExpenseGroup) -> some View {
        let payer = group.members.first { $0.id == entry.paidBy }
        let payerName = payer?.userID == session.userID ? "You" : (payer?.name ?? "Group member")
        let share = entry.splits.first { $0.memberID == person.id }?.amount ?? 0
        return HStack(alignment: .top, spacing: 11) {
            CategoryBadge(category: entry.category, size: 38)
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
                Text("\(payerName) \(entry.kind == "settlement" ? "settled" : "paid") · \(entry.createdAt.prefix(10))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if entry.kind == "expense" {
                    Text("Share \(Money.text(share, entry.currency))")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Palette.evergreen)
                }
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 3) {
                AmountText(minor: entry.amount, currency: entry.currency, size: 14)
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
