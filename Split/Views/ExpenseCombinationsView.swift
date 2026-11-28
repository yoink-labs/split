import SwiftUI

struct ExpenseCombinationsView: View {
    let group: ExpenseGroup
    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.dismiss) private var dismiss
    @State private var selection: Set<String> = []
    @State private var participants: Set<String> = []
    @State private var mode: SplitMode = .equal
    @State private var values: [String: String] = [:]
    @State private var title = ""
    @State private var suggestions: [CombinationSuggestion] = []
    @State private var history: [CombinationEvent] = []
    @State private var result: String?
    @State private var error: String?
    @State private var working = false

    private var entries: [LedgerEntry] { store.entries(in: group) }
    private var eligible: [LedgerEntry] { entries.filter { $0.canCombine(in: entries) } }
    private var chosen: [LedgerEntry] { eligible.filter { selection.contains($0.id) } }
    private var active: [Person] { (store.group(group.id) ?? group).members.filter { $0.removed != true } }
    private var total: Int64 { chosen.reduce(0) { $0 + $1.amount } }

    var body: some View {
        NavigationStack {
            Form {
                if let error { InlineError(text: error) }
                suggestionsSection
                selectionSection
                splitSection
                historySection
            }
            .disabled(working)
            .navigationTitle("Combine expenses")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.disabled(working) }
                if working { ToolbarItem(placement: .primaryAction) { ProgressView() } }
            }
            .task {
                participants = Set(active.map(\.id))
                await reload()
            }
            .navigationDestination(item: $result) { id in
                if let entry = entries.first(where: { $0.id == id }) {
                    EntryDetails(entry: entry, group: group, embedded: true)
                }
            }
        }
    }

    @ViewBuilder private var suggestionsSection: some View {
        if !suggestions.isEmpty {
            Section("Matching rides") {
                ForEach(suggestions) { suggestion in
                    Button {
                        combine(suggestion.entryIDs, title: "", mode: .equal, members: active.map(\.id), values: [:])
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Combine \(suggestion.title)")
                            Text("\(suggestion.entryIDs.count) rides · split equally among \(active.count) members")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }

    private var selectionSection: some View {
        Section("Choose expenses in one currency") {
            ForEach(eligible) { entry in
                let selected = selection.contains(entry.id)
                Button {
                    if selected { selection.remove(entry.id) } else { selection.insert(entry.id) }
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(entry.title).foregroundStyle(.primary)
                            Text(Money.text(entry.amount, entry.currency) + " · " + entry.day)
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                            .accessibilityHidden(true)
                    }
                    .frame(minHeight: HitTarget.minimum)
                    .contentShape(Rectangle())
                }
                .accessibilityAddTraits(selected ? .isSelected : [])
                .disabled(chosen.first.map { $0.currency != entry.currency } ?? false)
            }
            if eligible.isEmpty { Text("No available expenses").foregroundStyle(.secondary) }
        }
    }

    @ViewBuilder private var splitSection: some View {
        if let first = chosen.first {
            Section {
                TextField("Description", text: $title, prompt: Text(first.title))
                Picker("Split method", selection: $mode) {
                    Text("Equally").tag(SplitMode.equal)
                    Text("Exact amounts").tag(SplitMode.exact)
                    Text("Percentages").tag(SplitMode.percent)
                    Text("Shares").tag(SplitMode.shares)
                    Text("Equal + adjustments").tag(SplitMode.adjustment)
                }
                ForEach(active) { member in
                    Toggle(member.name, isOn: Binding(get: { participants.contains(member.id) }, set: { included in
                        if included { participants.insert(member.id) } else { participants.remove(member.id) }
                    }))
                    if participants.contains(member.id), mode != .equal {
                        TextField(valueLabel(for: member), text: Binding(get: { values[member.id] ?? "" },
                            set: { values[member.id] = $0 })).keyboardType(mode == .adjustment ? .numbersAndPunctuation : .decimalPad)
                    }
                }
                Button("Combine \(Money.text(total, first.currency))") {
                    combine(chosen.map(\.id), title: title, mode: mode,
                            members: active.filter { participants.contains($0.id) }.map(\.id), values: values)
                }
                .disabled(chosen.count < 2 || participants.isEmpty)
            } header: {
                Text("Combined expense")
            } footer: {
                Text("Paid amounts and receipt photos carry over. Item claims return when the originals are restored.")
            }
        }
    }

    @ViewBuilder private var historySection: some View {
        if !history.isEmpty {
            Section("Combination activity") {
                ForEach(history) { event in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(event.action == "combine" ? "Combined \(event.count) expenses" : "Restored \(event.count) expenses")
                        Text(event.title + " · " + String(event.at.prefix(10)))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func valueLabel(for member: Person) -> String {
        let label = mode == .exact ? "Amount" : mode == .percent ? "Percentage" : mode == .adjustment ? "Adjustment" : "Shares"
        return "\(label) for \(member.name)"
    }

    private func reload() async {
        do {
            let data = try await store.combinationInfo(group.id)
            suggestions = data.0
            history = data.1
        } catch { self.error = error.localizedDescription }
    }

    private func combine(_ ids: [String], title: String, mode: SplitMode, members: [String], values: [String: String]) {
        guard !working else { return }
        working = true
        error = nil
        Task {
            defer { working = false }
            do {
                result = try await store.combineExpenses(group: group.id, ids: ids, title: title, mode: mode, members: members, values: values)?.id
                selection = []
                await reload()
            } catch { self.error = error.localizedDescription }
        }
    }
}
