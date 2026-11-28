import SwiftUI

struct ReceiptPeopleSheet: View {
    private enum Change: String, CaseIterable {
        case keep = "Keep as is"
        case add = "Add"
        case remove = "Remove"
    }

    let entry: LedgerEntry
    let group: ExpenseGroup

    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.dismiss) private var dismiss
    @State private var changes: [String: Change] = [:]
    @State private var saving = false
    @State private var error: String?

    private var people: [Person] {
        group.members.filter { person in
            person.removed != true || entry.splits.contains { $0.memberID == person.id }
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(people) { person in
                        Picker(person.name, selection: Binding(
                            get: { changes[person.id] ?? .keep },
                            set: { changes[person.id] = $0 }
                        )) {
                            ForEach(Change.allCases.filter { person.removed != true || $0 != .add }, id: \.self) {
                                Text($0.rawValue).tag($0)
                            }
                        }
                    }
                } header: {
                    Text(entry.title)
                } footer: {
                    if entry.bill != nil {
                        Text("Changes apply to every item. Open the receipt to edit individual items.")
                    } else {
                        Text("Changing people gives everyone an equal share.")
                    }
                }
                if let error {
                    Text(error).foregroundStyle(.red)
                }
            }
            .navigationTitle("Edit people")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(saving || changes.values.allSatisfy { $0 == .keep })
                }
            }
            .interactiveDismissDisabled(saving)
        }
    }

    private func save() async {
        saving = true
        error = nil
        defer { saving = false }
        let add = people.map(\.id).filter { changes[$0] == .add }
        let remove = people.map(\.id).filter { changes[$0] == .remove }
        do {
            try await store.editReceiptPeople(entry, add: add, remove: remove)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
