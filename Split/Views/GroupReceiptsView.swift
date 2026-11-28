import SwiftUI

struct GroupReceiptsView: View {
    let group: ExpenseGroup
    let entries: [LedgerEntry]
    var addExpense: () -> Void
    var openExpense: (LedgerEntry) -> Void
    var continueDraft: (ReceiptDraft) -> Void

    @EnvironmentObject private var store: ExpenseStore
    @EnvironmentObject private var fx: FXStore
    @EnvironmentObject private var session: SessionStore
    @State private var editingPeople: LedgerEntry?
    @State private var reopening: String?
    @State private var actionError: String?
    @State private var editingDraft: ReceiptDraft?
    @State private var pendingDraft: ReceiptDraft?
    @State private var query = ""
    @State private var uploading = false
    @State private var inboxReload = 0
    @State private var inboxCount = 0

    private var drafts: [ReceiptDraft] { store.receiptDrafts(in: group.id) }
    private var receipts: [LedgerEntry] { entries.filter(\.hasReceipt) }
    private var search: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ActionBar {
                SplitActionButton(title: "Scan receipt", symbol: "doc.viewfinder", prominent: true) {
                    editingDraft = ReceiptDraft(groupID: group.id)
                }
                SplitActionButton(title: "Save for later", symbol: "tray.and.arrow.down") { uploading = true }
            }
            ReceiptInboxSection(group: group, entries: entries, reload: inboxReload, search: search) { inboxCount = $0 }

            if receipts.isEmpty && drafts.isEmpty {
                if inboxCount == 0 {
                    Card {
                        EmptyPanel(title: "No receipts yet", message: "Upload a photo to the group inbox to pair with an expense later, or add a receipt to an expense.", symbol: "receipt")
                    }
                }
            } else {
                TextField("Find a receipt", text: $query)
                    .padding(.leading, 34)
                    .padding(.trailing, 12)
                    .overlay(alignment: .leading) {
                        Image(systemName: "magnifyingglass").foregroundStyle(.secondary).padding(.leading, 12).accessibilityHidden(true)
                    }
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

                receiptSection("Needs assignment", matchingReceipts.filter { $0.openPurchaseCount > 0 })
                receiptSection("Open", matchingReceipts.filter { $0.bill?.closed == false && $0.openPurchaseCount == 0 })
                receiptSection("Closed", matchingReceipts.filter { $0.bill?.closed == true })
                receiptSection("Paired photos", matchingReceipts.filter { $0.bill == nil })

                if matchingDrafts.isEmpty && matchingReceipts.isEmpty && !search.isEmpty {
                    ContentUnavailableView.search(text: search)
                }
            }
        }
        .sheet(item: $editingPeople) { entry in
            ReceiptPeopleSheet(entry: entry, group: group)
        }
        .alert("Could not reopen receipt", isPresented: Binding(
            get: { actionError != nil }, set: { if !$0 { actionError = nil } }
        )) {
            Button("OK", role: .cancel) { actionError = nil }
        } message: {
            Text(actionError ?? "")
        }
        .sheet(isPresented: $uploading) {
            InboxUploadView(group: group) { inboxReload += 1 }
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
                    VStack(alignment: .leading, spacing: 4) {
                        Button { openExpense(entry) } label: {
                            LedgerRow(title: entry.title, detail: receiptDetail(entry),
                                      value: fx.entryText(entry, amount: entry.amount)) {
                                Image(systemName: entry.openPurchaseCount > 0 ? "circle.dashed" : "receipt")
                                    .foregroundStyle(entry.openPurchaseCount > 0 ? Palette.amber : Palette.evergreen)
                                    .frame(width: 34)
                                    .accessibilityHidden(true)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        if canManage && (entry.bill != nil || (entry.combinedCount == nil && (store.isDemo || entry.editable == true))) {
                            FlowLayout(spacing: 8) {
                                if entry.bill?.closed == true {
                                    Button("Reopen", systemImage: "lock.open") {
                                        Task { await reopen(entry) }
                                    }
                                    .accessibilityLabel("Reopen receipt")
                                    .disabled(reopening != nil)
                                }
                                Button("Edit people", systemImage: "person.2") { editingPeople = entry }
                            }
                            .font(.subheadline.weight(.semibold))
                            .buttonStyle(GhostButton())
                        }
                    }
                    .padding(12)
                    if entry.id != items.last?.id { RowDivider() }
                }
            }
        }
    }

    private var canManage: Bool {
        store.isDemo || group.members.contains { $0.userID != nil && $0.userID == session.userID && $0.removed != true }
    }

    private func receiptDetail(_ entry: LedgerEntry) -> String {
        let people = entry.splits.compactMap { split in group.members.first { $0.id == split.memberID }?.name }
        let status = entry.openPurchaseCount > 0 ? "\(entry.openPurchaseCount) unassigned" : nil
        return ([status].compactMap { $0 } + people).joined(separator: ", ")
    }

    private func reopen(_ entry: LedgerEntry) async {
        reopening = entry.id
        defer { reopening = nil }
        do { try await store.reopenReceipt(entry) }
        catch { actionError = error.localizedDescription }
    }

}
