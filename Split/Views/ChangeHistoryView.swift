import SwiftUI

struct ChangeHistoryView: View {
    @EnvironmentObject private var store: ExpenseStore
    let group: ExpenseGroup
    var expense: LedgerEntry?
    @State private var events: [ChangeHistoryEvent] = []
    @State private var next: Int?
    @State private var member = ""
    @State private var type = ""
    @State private var dateRange = false
    @State private var from = Date.now.addingTimeInterval(-30 * 86_400)
    @State private var through = Date.now
    @State private var error: String?
    @State private var loading = true

    private var filters: [URLQueryItem] {
        if let expense { return [URLQueryItem(name: "expense", value: expense.id)] }
        var filters: [URLQueryItem] = []
        if !member.isEmpty { filters.append(URLQueryItem(name: "member", value: member)) }
        if !type.isEmpty { filters.append(URLQueryItem(name: "type", value: type)) }
        if dateRange {
            let format = DateFormatter()
            format.calendar = Calendar(identifier: .gregorian)
            format.locale = Locale(identifier: "en_US_POSIX")
            format.dateFormat = "yyyy-MM-dd"
            filters.append(URLQueryItem(name: "from", value: format.string(from: from)))
            filters.append(URLQueryItem(name: "to", value: format.string(from: through)))
        }
        return filters
    }

    var body: some View {
        Group {
            if expense != nil {
                Card {
                    VStack(alignment: .leading, spacing: 12) {
                        SectionHeader(title: "History")
                        timeline
                    }
                }
            } else {
                List {
                    Section("Filters") {
                        Picker("Person", selection: $member) {
                            Text("Everyone").tag("")
                            ForEach(group.members) { person in Text(person.name).tag(person.id) }
                        }
                        Picker("Type", selection: $type) {
                            Text("All changes").tag("")
                            Text("Expenses").tag("expense")
                            Text("Receipts").tag("receipt")
                            Text("Refunds").tag("refund")
                            Text("Credits").tag("credit")
                            Text("Payments").tag("settlement")
                            Text("Members").tag("member")
                            Text("Group settings").tag("group")
                        }
                        Toggle("Filter by date", isOn: $dateRange)
                        if dateRange {
                            DatePicker("From", selection: $from, displayedComponents: .date)
                            DatePicker("Through", selection: $through, displayedComponents: .date)
                        }
                    }
                    timeline
                }
                .navigationTitle("Activity")
                .refreshable { await load(reset: true) }
            }
        }
        .task(id: filters) { await load(reset: true) }
        .onChange(of: expense) { _, _ in Task { await load(reset: true) } }
    }

    @ViewBuilder private var timeline: some View {
        if let error { InlineError(text: error) }
        if store.isDemo {
            Text("History is available in synced groups.").foregroundStyle(.secondary)
        } else if loading && events.isEmpty {
            ProgressView("Loading changes")
        } else if events.isEmpty && error == nil {
            Text("No changes recorded.").foregroundStyle(.secondary)
        }
        ForEach(events) { event in
            if expense == nil, let id = event.expense, store.entries.contains(where: { $0.id == id }) {
                NavigationLink(value: LedgerRoute.entry(group: group.id, id: id)) { row(event) }
            } else if expense == nil && event.type == "member" && group.members.contains(where: { $0.id == event.entity }) {
                NavigationLink(value: LedgerRoute.member(group: group.id, seat: event.entity)) { row(event) }
            } else {
                row(event)
            }
        }
        if next != nil {
            Button("Earlier changes") { Task { await load(reset: false) } }.disabled(loading)
        }
    }

    private func row(_ event: ChangeHistoryEvent) -> some View {
        let name = event.actorName ?? (event.actor == nil ? (event.action == "recurring" ? "Split" : "Unknown actor") : "Group member")
        let title = event.title ?? (event.type == "group" ? group.name : event.type)
        let amountEdit = expense != nil && event.action == "edit" && event.changes["amount"]?.before != nil
        let fields = event.changes.keys.filter { !amountEdit || $0 != "amount" }.sorted()
        return VStack(alignment: .leading, spacing: 5) {
            if amountEdit, let change = event.changes["amount"] {
                let old = display(change.before, field: "amount", event: event, after: false)
                let new = display(change.after, field: "amount", event: event, after: true)
                Text("\(name) changed the amount from \(old) to \(new).").font(.subheadline.weight(.semibold))
            } else {
                Text("\(name) \(event.verb) \(title).").font(.subheadline.weight(.semibold))
            }
            if let timestamp = try? Date(event.timestamp, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) {
                Text(timestamp, format: .dateTime.month().day().year().hour().minute())
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let reason = event.reason {
                Text("Reason: \(reason)").font(.subheadline)
            }
            ForEach(fields, id: \.self) { field in
                if let change = event.changes[field] {
                    let before = display(change.before, field: field, event: event, after: false)
                    let after = display(change.after, field: field, event: event, after: true)
                    Text(change.before == nil
                         ? "\(ChangeHistoryEvent.label(field)): \(after)"
                         : "\(ChangeHistoryEvent.label(field)): \(before) → \(after)")
                        .font(.footnote)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 5)
    }

    private func display(_ value: HistoryValue?, field: String, event: ChangeHistoryEvent, after: Bool) -> String {
        guard let value else { return "None" }
        let currencyField = field == "chargedAmount" ? "chargedCurrency" : "currency"
        let changedCurrency = event.changes[currencyField]
        let code = (after ? changedCurrency?.after : changedCurrency?.before)?.string
            ?? (field == "chargedAmount" ? event.chargedCurrency : event.currency) ?? group.currency
        func name(_ id: String) -> String { group.members.first { $0.id == id }?.name ?? id }
        switch (field, value) {
        case ("amount", .integer(let cents)), ("chargedAmount", .integer(let cents)): return Money.text(cents, code)
        case ("paidBy", .text(let id)), ("canonicalMember", .text(let id)): return name(id)
        case ("createdAt", .text(let date)): return String(date.prefix(10))
        case ("participants", .list(let ids)): return ids.map { name($0.description) }.joined(separator: ", ")
        case ("splits", .list(let parts)), ("payers", .list(let parts)):
            return parts.map { part in
                guard case .object(let fields) = part, let id = fields["memberID"]?.string,
                      case .integer(let cents) = fields["amount"] else { return part.description }
                return "\(name(id)) \(Money.text(cents, code))"
            }.joined(separator: ", ")
        default: return value.description
        }
    }

    private func load(reset: Bool) async {
        guard !store.isDemo, reset || !loading else { return }
        var query = filters
        if reset {
            events = []
            next = nil
        } else if let next {
            query.append(URLQueryItem(name: "before", value: String(next)))
        }
        loading = true
        error = nil
        defer { if !Task.isCancelled { loading = false } }
        do {
            let page = try await store.changeHistory(groupID: group.id, query: query)
            guard !Task.isCancelled, filters == query || !reset && query.dropLast().elementsEqual(filters) else { return }
            if reset { events = page.events } else { events += page.events }
            next = page.next
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }
}
