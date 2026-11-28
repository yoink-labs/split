import Foundation

/// Everything one Analytics screen covers: the groups, their expenses, and the
/// people in them. One group keys people by member ID, like the web; every
/// group at once merges a person's seats with `Analytics.key`.
struct AnalyticsScope {
    struct Member: Identifiable, Hashable {
        var key: String
        var name: String
        var removed: Bool
        var id: String { key }
    }

    var group: ExpenseGroup?
    var groups: [ExpenseGroup]
    /// Newest first, like every other list in the app.
    var entries: [LedgerEntry]
    var members: [Member]
    private var keys: [String: [String: String]]

    init(group: ExpenseGroup?, allGroups: [ExpenseGroup], allEntries: [LedgerEntry], currentUserID: String?) {
        self.group = group
        let groups = group.map { [$0] } ?? allGroups.filter { !($0.archived ?? false) }
        self.groups = groups
        let ids = Set(groups.map(\.id))
        entries = allEntries.filter { ids.contains($0.groupID) }.sorted { $0.createdAt > $1.createdAt }

        var keys: [String: [String: String]] = [:]
        var members: [String: Member] = [:]
        var order: [String] = []
        var involved = Set<String>()
        for entry in entries {
            involved.insert(entry.groupID + "/" + entry.paidBy)
            for split in entry.splits { involved.insert(entry.groupID + "/" + split.memberID) }
        }
        for scope in groups {
            for person in scope.members {
                let key = group == nil ? Analytics.key(person) : person.id
                keys[scope.id, default: [:]][person.id] = key
                // The web lists removed members only when they appear in the ledger.
                if person.removed == true && !involved.contains(scope.id + "/" + person.id) { continue }
                let name = currentUserID != nil && person.userID == currentUserID ? "You" : person.name
                if var existing = members[key] {
                    existing.removed = existing.removed && person.removed == true
                    members[key] = existing
                } else {
                    members[key] = Member(key: key, name: name, removed: person.removed == true)
                    order.append(key)
                }
            }
        }
        self.keys = keys
        self.members = order.compactMap { members[$0] }
        // Every seat in the scope counts toward By person, as on the web.
        self.allKeys = groups.flatMap { scope in scope.members.compactMap { keys[scope.id]?[$0.id] } }
            .reduce(into: [String]()) { list, key in if !list.contains(key) { list.append(key) } }
    }

    /// Person keys for the By person chart, in member order.
    private(set) var allKeys: [String]

    var personKey: SpendAnalytics.PersonKey {
        let keys = keys
        return { groupID, memberID in keys[groupID]?[memberID] ?? groupID + "/" + memberID }
    }

    func name(_ key: String) -> String {
        members.first { $0.key == key }?.name ?? "Former member"
    }

    var hasExpenses: Bool { entries.contains { $0.kind == "expense" } }
    var tripRange: Bool { group?.startDate != nil || group?.endDate != nil }
    var title: String { group?.name ?? "All groups" }
}
