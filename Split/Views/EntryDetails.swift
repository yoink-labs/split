import SwiftUI

struct EntryDetails: View {
    var entry: LedgerEntry
    var group: ExpenseGroup
    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.dismiss) private var dismiss
    @State private var editing = false
    @State private var deleting = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(entry.title).font(.title2.weight(.semibold))
                    Text(Money.text(entry.amount,entry.currency)).font(.largeTitle.bold())
                    LabeledContent("Paid by",value:name(entry.paidBy))
                }
                Section(entry.kind == "settlement" ? "Paid to" : "Individual amounts") {
                    ForEach(entry.splits,id:\.memberID) { split in
                        LabeledContent(name(split.memberID),value:Money.text(split.amount,entry.currency))
                    }
                }
                if entry.editable == true || store.isDemo {
                    Section {
                        if entry.kind == "expense" { Button("Edit expense") { editing=true } }
                        Button("Delete entry",role:.destructive) { deleting=true }
                    }
                }
                if let error { ErrorText(text:error) }
            }
            .navigationTitle(entry.kind == "settlement" ? "Payment" : "Expense").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement:.confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented:$editing) { AddExpenseView(group:group, original:entry) }
            .onChange(of:store.state.snapshot.entries) { _,entries in
                if entries.first(where:{$0.id==entry.id}) != entry { dismiss() }
            }
            .confirmationDialog("Delete this entry and update balances?",isPresented:$deleting,titleVisibility:.visible) {
                Button("Delete entry",role:.destructive) {
                    Task { do { try await store.change(entry,to:nil); dismiss() } catch { self.error=error.localizedDescription } }
                }
            }
        }
    }
    private func name(_ id:String) -> String { group.members.first { $0.id==id }?.name ?? "Group member" }
}
