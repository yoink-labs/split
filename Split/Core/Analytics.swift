import Foundation

struct PersonBalance: Identifiable, Equatable {
    var key: String
    var name: String
    var memberIDs: [String]
    var groupIDs: [String]
    var amounts: [String: Int64]
    var id: String { key }
    var currencies: [String] { amounts.keys.sorted() }
    var hasBalance: Bool { amounts.values.contains { $0 != 0 } }
    func amount(_ currency: String) -> Int64 { amounts[currency] ?? 0 }
}

struct GroupSummary: Identifiable {
    var group: ExpenseGroup
    var mine: [String: Int64]
    var currencies: [String]
    var totalSpend: [String: Int64]
    var entryCount: Int
    var lastActivity: String?
    var id: String { group.id }
    var isSettled: Bool { mine.values.allSatisfy { $0 == 0 } }
}

struct PersonSpend: Identifiable {
    var person: Person
    var paid: Int64
    var share: Int64
    var net: Int64
    var id: String { person.id }
}

struct MonthTotal: Identifiable, Equatable {
    var month: String
    var amount: Int64
    var id: String { month }
    var label: String {
        let formatter = DateFormatter()
        formatter.locale = Locale.current
        formatter.dateFormat = "yyyy-MM"
        guard let date = formatter.date(from: month) else { return month }
        formatter.dateFormat = "MMM"
        return formatter.string(from: date)
    }
}

struct CategoryTotal: Identifiable, Equatable {
    var category: String
    var amount: Int64
    var id: String { category }
    var meta: CategoryMeta { CategoryMeta.named(category) }
}

enum Analytics {
    /// One person across groups. Account-backed members merge by user ID;
    /// placeholders merge by a normalized name.
    static func key(_ person: Person) -> String {
        if let userID = person.userID, !userID.isEmpty { return "u:" + userID }
        return "n:" + person.name.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    static func me(in group: ExpenseGroup, userID: String?) -> Person? {
        if let userID, let member = group.members.first(where: { $0.userID == userID }) { return member }
        return group.members.first
    }

    static func currencies(in group: ExpenseGroup, entries: [LedgerEntry]) -> [String] {
        var values = Set(entries.map(\.settling.currency))
        values.insert(group.currency)
        return values.sorted()
    }

    static func groupSummaries(groups: [ExpenseGroup], entries: [LedgerEntry], userID: String?, includeArchived: Bool = false) -> [GroupSummary] {
        let byGroup = Dictionary(grouping: entries, by: \.groupID)
        return groups.filter { includeArchived || !($0.archived ?? false) }.map { group in
            let groupEntries = byGroup[group.id] ?? []
            let currencies = currencies(in: group, entries: groupEntries)
            let meID = me(in: group, userID: userID)?.id
            var mine: [String: Int64] = [:]
            var spend: [String: Int64] = [:]
            for currency in currencies {
                let balances = Ledger.balances(groupEntries, currency: currency)
                if let meID, let amount = balances[meID] { mine[currency] = amount }
                spend[currency] = groupEntries.map(\.settling).filter { $0.currency == currency && $0.isSpending }.reduce(0) { $0 + $1.signedAmount }
            }
            return GroupSummary(
                group: group,
                mine: mine,
                currencies: currencies,
                totalSpend: spend,
                entryCount: groupEntries.count,
                lastActivity: groupEntries.map(\.createdAt).max()
            )
        }.sorted { left, right in
            if left.isSettled != right.isSettled { return !left.isSettled }
            return (left.lastActivity ?? "") > (right.lastActivity ?? "")
        }
    }

    static func personBalances(groups: [ExpenseGroup], entries: [LedgerEntry], userID: String?) -> [PersonBalance] {
        allPeople(groups: groups, entries: entries, userID: userID).filter(\.hasBalance)
    }

    /// Every person you share a group with, including settled ones.
    static func allPeople(groups: [ExpenseGroup], entries: [LedgerEntry], userID: String?) -> [PersonBalance] {
        var people: [String: PersonBalance] = [:]
        for group in groups where !(group.archived ?? false) {
            let groupEntries = entries.filter { $0.groupID == group.id }
            let meID = me(in: group, userID: userID)?.id
            for currency in currencies(in: group, entries: groupEntries) {
                // A person's amount is what they owe you (positive) or you owe
                // them (negative), taken from the suggested payments that involve
                // you. Their own group balance is not a debt to you: in a group
                // of four, someone who owes the group may owe somebody else.
                let values = Ledger.balances(groupEntries, currency: currency)
                let transfers = group.simplify == false
                    ? Ledger.directPlan(values, currency: currency)
                    : Ledger.plan(values, currency: currency)
                for member in group.members {
                    if member.id == meID { continue }
                    let memberKey = key(member)
                    let amount = transfers.reduce(Int64(0)) { sum, transfer in
                        if transfer.from == member.id && transfer.to == meID { return sum + transfer.amount }
                        if transfer.from == meID && transfer.to == member.id { return sum - transfer.amount }
                        return sum
                    }
                    var row = people[memberKey] ?? PersonBalance(key: memberKey, name: member.name, memberIDs: [], groupIDs: [], amounts: [:])
                    row.name = member.name
                    if !row.memberIDs.contains(member.id) { row.memberIDs.append(member.id) }
                    if !row.groupIDs.contains(group.id) { row.groupIDs.append(group.id) }
                    if amount != 0 { row.amounts[currency, default: 0] += amount }
                    people[memberKey] = row
                }
            }
        }
        return people.values.sorted { left, right in
            let leftMax = left.amounts.values.map { abs($0) }.max() ?? 0
            let rightMax = right.amounts.values.map { abs($0) }.max() ?? 0
            if leftMax != rightMax { return leftMax > rightMax }
            return left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
        }
    }

    /// Groups settle independently. Keep amounts owed and owing separate before converting.
    static func balanceDirections(_ groupBalances: [[String: Int64]]) -> (owed: [String: Int64], owe: [String: Int64]) {
        var owed: [String: Int64] = [:]
        var owe: [String: Int64] = [:]
        for balances in groupBalances {
            for (currency, amount) in balances {
                if amount > 0 { owed[currency, default: 0] += amount }
                if amount < 0 { owe[currency, default: 0] -= amount }
            }
        }
        return (owed, owe)
    }

    static func entries(with person: PersonBalance, groups: [ExpenseGroup], entries: [LedgerEntry], userID: String?) -> [LedgerEntry] {
        let groupIDs = Set(person.groupIDs)
        let memberIDs = Set(person.memberIDs)
        return entries.filter { entry in
            guard groupIDs.contains(entry.groupID) else { return false }
            if memberIDs.contains(entry.paidBy) { return true }
            if entry.allPayers.contains(where: { memberIDs.contains($0.memberID) }) { return true }
            return entry.splits.contains { memberIDs.contains($0.memberID) }
        }.sorted { $0.createdAt > $1.createdAt }
    }

    static func sharedGroups(with person: PersonBalance, groups: [ExpenseGroup]) -> [ExpenseGroup] {
        let ids = Set(person.groupIDs)
        return groups.filter { ids.contains($0.id) }
    }

    static func personSpend(_ group: ExpenseGroup, entries: [LedgerEntry], currency: String, people: [Person]) -> [PersonSpend] {
        let expenses = entries.map(\.settling).filter { $0.isSpending && $0.currency == currency }
        let balances = Ledger.balances(entries, currency: currency)
        return people.map { person in
            let paid = expenses.reduce(Int64(0)) { $0 + Ledger.paid($1, by: person.id) }
            let share = expenses.reduce(Int64(0)) { $0 + Ledger.share($1, of: person.id) }
            return PersonSpend(person: person, paid: paid, share: share, net: balances[person.id] ?? 0)
        }.sorted { abs($0.paid) + abs($1.share) > abs($1.paid) + abs($0.share) }
    }

    static func monthly(_ entries: [LedgerEntry], currency: String) -> [MonthTotal] {
        var totals: [String: Int64] = [:]
        for entry in entries.map(\.settling) where entry.currency == currency && entry.isSpending {
            totals[String(entry.createdAt.prefix(7)), default: 0] += entry.signedAmount
        }
        return totals.keys.sorted().suffix(6).map { MonthTotal(month: $0, amount: totals[$0] ?? 0) }
    }

    static func categories(_ entries: [LedgerEntry], currency: String) -> [CategoryTotal] {
        var totals: [String: Int64] = [:]
        for entry in entries.map(\.settling) where entry.currency == currency && entry.isSpending {
            totals[entry.category ?? "General", default: 0] += entry.signedAmount
        }
        return totals.map { CategoryTotal(category: $0.key, amount: $0.value) }.sorted { $0.amount > $1.amount }
    }

    static func monthlyTotal(_ entries: [LedgerEntry], currency: String) -> Int64 {
        entries.map(\.settling).filter { $0.currency == currency && $0.isSpending }.reduce(0) { $0 + $1.signedAmount }
    }

    static func lastActivity(_ entries: [LedgerEntry]) -> String? { entries.map(\.createdAt).max() }
}

struct SearchResults {
    var groups: [ExpenseGroup] = []
    var people: [PersonBalance] = []
    var entries: [LedgerEntry] = []
    var isEmpty: Bool { groups.isEmpty && people.isEmpty && entries.isEmpty }
}

enum Search {
    static func run(_ query: String, groups: [ExpenseGroup], entries: [LedgerEntry], people: [PersonBalance]) -> SearchResults {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        guard needle.count >= 1 else { return SearchResults() }
        func matches(_ values: [String?]) -> Bool {
            values.compactMap { $0 }.contains { value in
                value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current).contains(needle)
            }
        }
        let activeGroups = groups.filter { !($0.archived ?? false) }
        let activeIDs = Set(activeGroups.map(\.id))
        let groupMatches = activeGroups.filter { matches([$0.name] + $0.members.map(\.name)) }
        let peopleMatches = people.filter { matches([$0.name]) }
        let memberNames: [String: [String]] = Dictionary(uniqueKeysWithValues: activeGroups.map { group in
            (group.id, group.members.map(\.name))
        })
        let entryMatches = entries.filter { entry in
            activeIDs.contains(entry.groupID) &&
            matches([entry.title, entry.notes, entry.category, entry.currency, Money.input(entry.amount)] + (memberNames[entry.groupID] ?? []))
        }.sorted { $0.createdAt > $1.createdAt }
        return SearchResults(groups: groupMatches, people: peopleMatches, entries: Array(entryMatches.prefix(60)))
    }
}

struct DashboardTransfer: Identifiable {
    var group: ExpenseGroup
    var person: Person
    var transfer: Transfer
    var amount: Int64
    var id: String { group.id + "/" + transfer.id }
}

struct DashboardTransaction: Identifiable {
    var entry: LedgerEntry
    var group: ExpenseGroup
    var paid: Int64
    var share: Int64
    var direction: Int64
    var id: String { entry.id }
}

struct DashboardModel {
    var owed: [String: Int64]
    var owe: [String: Int64]
    var people: [PersonBalance]
    var transfers: [String: [DashboardTransfer]]
    var groups: [GroupSummary]
    var transactions: [DashboardTransaction]
    var seats: [String: String]

    init(groups: [ExpenseGroup], entries: [LedgerEntry], userID: String?) {
        let active = groups.filter { group in
            guard let userID else { return false }
            return group.members.contains { $0.userID == userID && $0.removed != true }
        }
        let seats = Dictionary(uniqueKeysWithValues: active.compactMap { group in
            group.members.first { $0.userID == userID && $0.removed != true }.map { (group.id, $0.id) }
        })
        self.seats = seats
        let byGroup = Dictionary(grouping: entries, by: \.groupID)
        self.groups = Analytics.groupSummaries(groups: active, entries: entries, userID: userID, includeArchived: true)
        let totals = Analytics.balanceDirections(self.groups.map(\.mine))
        owed = totals.owed
        owe = totals.owe

        var people: [String: PersonBalance] = [:]
        var transfers: [String: [DashboardTransfer]] = [:]
        var transactions: [DashboardTransaction] = []
        for group in active {
            guard let seat = seats[group.id] else { continue }
            let entries = byGroup[group.id] ?? []
            let members = Dictionary(uniqueKeysWithValues: group.members.map { ($0.id, $0) })
            for currency in Analytics.currencies(in: group, entries: entries) {
                let values = Ledger.balances(entries, currency: currency)
                guard values[seat, default: 0] != 0 else { continue }
                let plan = group.simplify == false ? Ledger.directPlan(values, currency: currency) : Ledger.plan(values, currency: currency)
                for transfer in plan where transfer.from == seat || transfer.to == seat {
                    let outgoing = transfer.from == seat
                    guard let person = members[outgoing ? transfer.to : transfer.from] else { continue }
                    let key = person.userID.map { "u:" + $0 } ?? "m:" + person.id
                    let amount = outgoing ? -transfer.amount : transfer.amount
                    transfers[key, default: []].append(DashboardTransfer(group: group, person: person, transfer: transfer, amount: amount))
                    var row = people[key] ?? PersonBalance(key: key, name: person.name, memberIDs: [], groupIDs: [], amounts: [:])
                    if !row.memberIDs.contains(person.id) { row.memberIDs.append(person.id) }
                    if !row.groupIDs.contains(group.id) { row.groupIDs.append(group.id) }
                    row.amounts[currency, default: 0] += amount
                    people[key] = row
                }
            }
            for entry in entries {
                let paid = SpendAnalytics.paid(entry, by: seat)
                let share = SpendAnalytics.share(entry, of: seat)
                guard paid > 0 || share > 0 else { continue }
                let direction = Ledger.net(entry.settling, for: seat)
                transactions.append(DashboardTransaction(entry: entry, group: group, paid: paid, share: share, direction: direction))
            }
        }
        self.people = people.values.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        self.transfers = transfers
        self.transactions = transactions.sorted {
            $0.entry.createdAt == $1.entry.createdAt ? $0.id > $1.id : $0.entry.createdAt > $1.entry.createdAt
        }
    }
}

extension ExpenseStore {
    var dashboard: DashboardModel {
        DashboardModel(groups: groups, entries: entries, userID: currentUserID)
    }

    func summary(for group: ExpenseGroup) -> GroupSummary {
        Analytics.groupSummaries(groups: [group], entries: entries, userID: currentUserID, includeArchived: true).first
            ?? GroupSummary(group: group, mine: [:], currencies: [group.currency], totalSpend: [:], entryCount: 0, lastActivity: nil)
    }

    func personBalance(for member: Person, in group: ExpenseGroup) -> Int64 {
        Ledger.balances(entries(in: group), currency: group.currency)[member.id] ?? 0
    }
}
