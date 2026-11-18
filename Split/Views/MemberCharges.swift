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
                EntryDetails(entry: entry, group: group)
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

    var body: some View {
        let snapshot = store.state.snapshot
        let memberships = snapshot.memberships(user: user, groupID: groupID, seatID: seatID)
        if let (group, person) = memberships.first(where: { $0.0.id == (selected ?? groupID) }) ?? memberships.first {
            let entries = snapshot.charges(group: group.id, seat: person.id)
            List {
                Section {
                    HStack(spacing: 10) {
                        Avatar(name: person.name, size: 36)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(person.name).font(.headline)
                            Text(person.userID == nil ? "Placeholder" : "Group member").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if memberships.count > 1 {
                        Picker("Group", selection: Binding(get: { group.id }, set: { selected = $0 })) {
                            ForEach(memberships.map { $0.0 }) { g in Text(g.name).tag(g.id) }
                        }
                    } else { LabeledContent("Group", value: group.name) }
                }
                section("Charges", entries.filter { $0.kind == "expense" }, person, group)
                let payments = entries.filter { $0.kind == "settlement" }
                if !payments.isEmpty { section("Payments", payments, person, group) }
            }.navigationTitle("Member activity").navigationBarTitleDisplayMode(.inline)
                .refreshable { await store.sync() }
        } else {
            ContentUnavailableView("No shared groups", systemImage: "person.2", description: Text("Charges appear here once you share a group."))
        }
    }

    private func section(_ title: String, _ entries: [LedgerEntry], _ person: Person, _ group: ExpenseGroup) -> some View {
        Section {
            if entries.isEmpty { Text("No charges in this group yet.").foregroundStyle(.secondary) }
            ForEach(entries) { entry in
                let payer = group.members.first { $0.id == entry.paidBy }?.name ?? "Group member"
                let share = entry.splits.first { $0.memberID == person.id }?.amount ?? 0
                NavigationLink(value: LedgerRoute.entry(group: group.id, id: entry.id)) {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(entry.title).font(.subheadline.weight(.semibold))
                            Spacer()
                            Text(Money.text(entry.amount, entry.currency)).font(.subheadline.weight(.medium)).monospacedDigit()
                        }
                        Text("Paid by " + payer + " · " + String(entry.createdAt.prefix(10))).font(.caption).foregroundStyle(.secondary)
                        if entry.kind == "expense" {
                            Text("Share " + Money.text(share, entry.currency)).font(.caption.weight(.semibold)).foregroundStyle(Palette.green)
                        }
                    }.padding(.vertical, 2)
                }
            }
        } header: { Text(title) }
    }
}
