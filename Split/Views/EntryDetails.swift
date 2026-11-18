import SwiftUI

struct EntryDetails: View {
    private var initial: LedgerEntry
    var entry: LedgerEntry { store.state.snapshot.entries.first { $0.id==initial.id } ?? initial }
    init(entry: LedgerEntry, group: ExpenseGroup) { self.initial=entry; self.group=group }
    var group: ExpenseGroup
    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.dismiss) private var dismiss
    private struct Assignment:Identifiable { let id=UUID(); let item:Purchase? }
    @State private var assignment:Assignment?
    @State private var gallery:ReceiptPresentation?
    @State private var editing = false
    @State private var deleting = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(entry.title).font(.headline)
                    Text(Money.text(entry.amount,entry.currency)).font(.title2.bold())
                    LabeledContent("Paid by",value:name(entry.paidBy))
                }
                if let category=entry.category { LabeledContent("Category",value:category) }
                if let ids=entry.receiptIDs, !ids.isEmpty { ReceiptGallery(entry:entry.id,ids:ids) { gallery=$0 } }
                if let bill=entry.bill { PurchasesSection(entry:entry,group:group,bill:bill) { assignment=Assignment(item:$0) } }
                Section(entry.kind == "settlement" ? "Paid to" : "Individual amounts") {
                    ForEach(entry.splits,id:\.memberID) { split in
                        LabeledContent(name(split.memberID),value:Money.text(split.amount,entry.currency))
                    }
                }
                if entry.editable == true || store.isDemo {
                    Section {
                        if entry.kind == "expense" && entry.bill?.closed != true { Button("Edit expense") { editing=true } }
                        Button("Delete entry",role:.destructive) { deleting=true }
                    }
                }
                if let error { ErrorText(text:error) }
            }
            .navigationTitle(entry.kind == "settlement" ? "Payment" : "Expense").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement:.confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(item:$assignment) { ClaimSheet(entry:entry,group:group,item:$0.item) }
            .fullScreenCover(item:$gallery) { ReceiptViewer($0) }
            .sheet(isPresented:$editing) { AddExpenseView(group:group, original:entry) }
            .refreshable { await store.sync() }
            .onChange(of:store.state.snapshot.entries) { _,entries in
                if !entries.contains(where:{$0.id==initial.id}) { dismiss() }
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
