import SwiftUI

struct GroupReceiptsView: View {
    let group: ExpenseGroup
    let entries: [LedgerEntry]
    var addExpense: () -> Void
    var openExpense: (LedgerEntry) -> Void
    var continueDraft: (ReceiptDraft) -> Void

    @EnvironmentObject private var store: ExpenseStore
    @State private var editingDraft: ReceiptDraft?
    @State private var pendingDraft: ReceiptDraft?
    @State private var query = ""

    private var drafts: [ReceiptDraft] { store.receiptDrafts(in: group.id) }
    private var receipts: [LedgerEntry] { entries.filter(\.hasReceipt) }
    private var search: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ActionBar {
                SplitActionButton(title: "Capture receipt", symbol: "camera", prominent: true) {
                    editingDraft = ReceiptDraft(groupID: group.id)
                }
                SplitActionButton(title: "Add expense", symbol: "plus", action: addExpense)
            }

            if receipts.isEmpty && drafts.isEmpty {
                Card {
                    EmptyPanel(title: "No receipts yet", message: "Capture and name a photo to save it for later, or add a receipt to an expense.", symbol: "receipt")
                }
            } else {
                TextField("Find a receipt", text: $query)
                    .padding(.horizontal, 12)
                    .frame(minHeight: HitTarget.minimum)
                    .background(Palette.card, in: RoundedRectangle(cornerRadius: Radius.badge))
                    .overlay(RoundedRectangle(cornerRadius: Radius.badge).strokeBorder(Palette.line))
                    .accessibilityLabel("Find a receipt")

                let matchingDrafts = drafts.filter { matches($0.title) }
                let matchingReceipts = receipts.filter { matches($0.title) }
                if !matchingDrafts.isEmpty {
                    SectionHeader(title: "Drafts", subtitle: "Saved on this device")
                    Card(padding: 0) {
                        ForEach(matchingDrafts) { draft in
                            Button { editingDraft = draft } label: {
                                LedgerRow(title: draft.title, detail: draft.capturedAt.formatted(date: .abbreviated, time: .omitted),
                                          value: draft.photos.count == 1 ? "1 photo" : "\(draft.photos.count) photos") {
                                    Image(systemName: "photo.on.rectangle")
                                        .foregroundStyle(Palette.evergreen)
                                        .frame(width: 34)
                                        .accessibilityHidden(true)
                                }
                                .padding(12)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            if draft.id != matchingDrafts.last?.id { RowDivider() }
                        }
                    }
                }

                receiptSection("Open receipts", matchingReceipts.filter { $0.bill?.closed == false })
                receiptSection("Closed receipts & photos", matchingReceipts.filter { $0.bill?.closed != false })

                if matchingDrafts.isEmpty && matchingReceipts.isEmpty {
                    ContentUnavailableView.search(text: search)
                }
            }
        }
        .sheet(item: $editingDraft, onDismiss: {
            if let draft = pendingDraft {
                pendingDraft = nil
                continueDraft(draft)
            }
        }) { draft in
            ReceiptDraftView(group: group, draft: draft) {
                pendingDraft = $0
                editingDraft = nil
            }
        }
    }

    private func matches(_ title: String) -> Bool {
        search.isEmpty || title.localizedStandardContains(search)
    }

    @ViewBuilder private func receiptSection(_ title: String, _ items: [LedgerEntry]) -> some View {
        if !items.isEmpty {
            SectionHeader(title: title)
            Card(padding: 0) {
                ForEach(items) { entry in
                    Button { openExpense(entry) } label: {
                        EntryRow(entry: entry, group: group, currentUserID: store.currentUserID, showDate: true)
                            .padding(12)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if entry.id != items.last?.id { RowDivider() }
                }
            }
        }
    }
}
