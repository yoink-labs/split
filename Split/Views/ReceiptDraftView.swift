import SwiftUI

struct ReceiptDraftView: View {
    let group: ExpenseGroup
    @State var draft: ReceiptDraft
    var onContinue: (ReceiptDraft) -> Void

    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.dismiss) private var dismiss
    @State private var processing = false
    @State private var deleting = false
    @State private var error: String?

    private var title: String { draft.title.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSave: Bool { !processing && !title.isEmpty && title.count <= 120 && !draft.photos.isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Card {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionHeader(title: "Receipt name", subtitle: group.name)
                            TextField("e.g. Dinner at Don Julio", text: $draft.title)
                                .padding(12)
                                .background(Palette.raised, in: RoundedRectangle(cornerRadius: 10))
                                .accessibilityLabel("Receipt name")
                                .onChange(of: draft.title) { _, value in
                                    if value.count > 120 { draft.title = String(value.prefix(120)) }
                                }
                        }
                    }
                    Card { ReceiptPhotoPicker(photos: $draft.photos, processing: $processing) }
                    Text("Drafts are saved on this device. Turn a draft into an expense to share its photos with this group.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if let error { InlineError(text: error) }
                    Button("Continue to expense", systemImage: "arrow.right") { save(continueToExpense: true) }
                        .buttonStyle(GhostButton())
                        .disabled(!canSave)
                    if store.receiptDrafts(in: group.id).contains(where: { $0.id == draft.id }) {
                        Button("Delete draft", role: .destructive) { deleting = true }
                            .disabled(processing)
                            .frame(minHeight: HitTarget.minimum)
                    }
                }
                .padding(Spacing.page)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(AppBackground())
            .navigationTitle("Receipt draft")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(processing)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save draft") { save(continueToExpense: false) }.disabled(!canSave)
                }
            }
            .interactiveDismissDisabled(processing)
            .confirmationDialog("Delete this receipt draft?", isPresented: $deleting, titleVisibility: .visible) {
                Button("Delete draft", role: .destructive) {
                    do {
                        try store.removeReceiptDraft(draft.id)
                        dismiss()
                    } catch {
                        self.error = error.localizedDescription
                    }
                }
            }
        }
    }

    private func save(continueToExpense: Bool) {
        guard canSave else { return }
        draft.title = title
        do {
            try store.saveReceiptDraft(draft)
            if continueToExpense { onContinue(draft) }
            else { dismiss() }
        } catch {
            self.error = error.localizedDescription
        }
    }
}
