import SwiftUI

/// The group's receipts inbox: photos uploaded before an expense exists, waiting to be paired.
struct ReceiptInboxSection: View {
    let group: ExpenseGroup
    let entries: [LedgerEntry]
    /// Bumped by the parent after an upload so the list reloads.
    var reload: Int = 0
    var search: String = ""
    var onCount: (Int) -> Void = { _ in }

    @EnvironmentObject private var store: ExpenseStore
    @EnvironmentObject private var session: SessionStore
    @State private var receipts: [InboxReceipt] = []
    @State private var loaded = false
    @State private var pairing: InboxReceipt?
    @State private var deleting: InboxReceipt?
    @State private var gallery: ReceiptPresentation?
    @State private var working: String?
    @State private var error: String?

    private var me: Person? { Analytics.me(in: group, userID: session.userID) }
    private var visible: [InboxReceipt] {
        search.isEmpty ? receipts : receipts.filter { ($0.note ?? "").localizedStandardContains(search) || uploader($0).localizedStandardContains(search) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !visible.isEmpty || error != nil {
                SectionHeader(title: "Receipts inbox", subtitle: "Waiting for an expense · \(receipts.count) \(receipts.count == 1 ? "photo" : "photos")")
            }
            if !visible.isEmpty {
                Card(padding: 0) {
                    ForEach(visible) { receipt in
                        row(receipt)
                        if receipt.id != visible.last?.id { RowDivider() }
                    }
                }
            }
            if let error { InlineError(text: error) }
        }
        .task(id: "\(group.id)-\(reload)-\(store.entries.count)") { await load() }
        .sheet(item: $pairing) { receipt in
            ExpensePickerSheet(group: group, entries: entries, title: "Add to expense",
                               message: "Choose the expense this receipt belongs to.") { entry in
                try await store.pairInboxReceipt(groupID: group.id, id: receipt.id, to: entry)
                await load()
            }
        }
        .fullScreenCover(item: $gallery) { ReceiptViewer($0) }
        .confirmationDialog("Delete this receipt from the inbox?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                            titleVisibility: .visible, presenting: deleting) { receipt in
            Button("Delete receipt", role: .destructive) { Task { await delete(receipt) } }
        }
    }

    private func row(_ receipt: InboxReceipt) -> some View {
        HStack(spacing: 12) {
            InboxThumbnail(groupID: group.id, id: receipt.id) { image in
                gallery = ReceiptPresentation(images: [image], index: 0)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(receipt.note?.isEmpty == false ? receipt.note! : "Receipt photo")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
                Text([uploader(receipt), receipt.date?.formatted(date: .abbreviated, time: .shortened)].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if working == receipt.id {
                ProgressView().frame(width: 44, height: 44)
            } else {
                Menu {
                    Button { pairing = receipt } label: { Label("Add to expense…", systemImage: "arrow.right.doc.on.clipboard") }
                    if receipt.uploadedBy == me?.id {
                        Button(role: .destructive) { deleting = receipt } label: { Label("Delete", systemImage: "trash") }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.system(size: 20))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .foregroundStyle(Palette.evergreen)
                .accessibilityLabel("Receipt actions")
            }
        }
        .padding(12)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("inbox-receipt-\(receipt.id)")
    }

    private func uploader(_ receipt: InboxReceipt) -> String {
        guard let person = group.members.first(where: { $0.id == receipt.uploadedBy }) else { return "Someone" }
        return person.id == me?.id ? "You" : person.name
    }

    private func load() async {
        do {
            receipts = try await store.inboxReceipts(groupID: group.id)
            error = nil
        } catch {
            if !SyncFailure.isCancellation(error) { self.error = error.localizedDescription }
        }
        loaded = true
        onCount(receipts.count)
    }

    private func delete(_ receipt: InboxReceipt) async {
        working = receipt.id
        defer { working = nil }
        do {
            try await store.deleteInboxReceipt(groupID: group.id, id: receipt.id)
            await load()
        } catch { self.error = error.localizedDescription }
    }
}

/// A lazily loaded inbox photo thumbnail.
struct InboxThumbnail: View {
    let groupID: String
    let id: String
    var size = CGSize(width: 56, height: 68)
    var open: ((UIImage) -> Void)? = nil
    @EnvironmentObject private var store: ExpenseStore
    @State private var image: UIImage?
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        Button {
            if let image { open?(image) } else { failed = false; attempt += 1 }
        } label: {
            Group {
                if let image { Image(uiImage: image).resizable().scaledToFill() }
                else if failed { Image(systemName: "arrow.clockwise").foregroundStyle(.secondary) }
                else { ProgressView() }
            }
            .frame(width: size.width, height: size.height)
            .background(Palette.raised)
            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Palette.line))
        }
        .buttonStyle(.plain)
        .disabled(open == nil && image != nil)
        .accessibilityLabel(image == nil ? "Load receipt photo" : "View receipt photo")
        .task(id: attempt) {
            guard image == nil else { return }
            do {
                let data = try await store.inboxImage(groupID: groupID, id: id)
                guard let decoded = UIImage(data: data) else { throw LedgerError.invalid("Invalid photo.") }
                image = decoded
            } catch { failed = true }
        }
    }
}

/// Upload one or more receipt photos to the group inbox to pair with an expense later.
struct InboxUploadView: View {
    let group: ExpenseGroup
    var uploaded: () -> Void

    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.dismiss) private var dismiss
    @State private var photos: [ReceiptPhoto] = []
    @State private var note = ""
    @State private var processing = false
    @State private var uploading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Card { ReceiptPhotoPicker(photos: $photos, processing: $processing) }
                    Card {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionHeader(title: "Note", subtitle: "Optional · helps the group match it later")
                            TextField("e.g. Dinner at Don Julio", text: $note)
                                .padding(12)
                                .background(Palette.raised, in: RoundedRectangle(cornerRadius: 10))
                                .accessibilityLabel("Receipt note")
                                .onChange(of: note) { _, value in
                                    if value.count > 200 { note = String(value.prefix(200)) }
                                }
                        }
                    }
                    Text("Receipts in the inbox are shared with \(group.name). Anyone in the group can add one to an expense.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if let error { InlineError(text: error) }
                }
                .padding(Spacing.page)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(AppBackground())
            .navigationTitle("Upload receipt")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(uploading)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if uploading { ProgressView() }
                    else { Button("Upload") { Task { await upload() } }.disabled(photos.isEmpty || processing) }
                }
            }
            .interactiveDismissDisabled(uploading || processing)
        }
    }

    private func upload() async {
        uploading = true
        error = nil
        defer { uploading = false }
        do {
            for photo in photos {
                try await store.uploadInboxReceipt(groupID: group.id, photo: photo, note: note)
                photos.removeAll { $0.id == photo.id }
            }
            uploaded()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Pick one of the group's expenses, for pairing or moving a receipt.
struct ExpensePickerSheet: View {
    let group: ExpenseGroup
    let entries: [LedgerEntry]
    var title: String
    var message: String
    var excluding: String? = nil
    var choose: (LedgerEntry) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: ExpenseStore
    @State private var query = ""
    @State private var working: String?
    @State private var error: String?

    private var expenses: [LedgerEntry] {
        let search = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return entries.filter { $0.kind == "expense" && $0.id != excluding && (search.isEmpty || $0.title.localizedStandardContains(search)) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(expenses) { entry in
                        let count = entry.receiptIDs?.count ?? 0
                        Button {
                            Task { await pick(entry) }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(entry.title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
                                    Text("\(entry.day) · \(Money.text(entry.amount, entry.currency))\(count > 0 ? " · \(count)/\(receiptLimit) photos" : "")")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if working == entry.id { ProgressView() }
                                else if count >= receiptLimit { Text("Full").font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
                            }
                            .frame(minHeight: HitTarget.minimum)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(count >= receiptLimit || working != nil)
                    }
                    if expenses.isEmpty {
                        Text("No expenses to choose from.").foregroundStyle(.secondary)
                    }
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(message)
                        if let error { InlineError(text: error) }
                    }
                }
            }
            .searchable(text: $query, prompt: "Find an expense")
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(working != nil) }
            }
        }
    }

    private func pick(_ entry: LedgerEntry) async {
        working = entry.id
        error = nil
        defer { working = nil }
        do {
            try await choose(entry)
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

/// Pick an inbox receipt to attach to an expense.
struct InboxPickerSheet: View {
    let group: ExpenseGroup
    let entry: LedgerEntry

    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.dismiss) private var dismiss
    @State private var receipts: [InboxReceipt]?
    @State private var working: String?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if let receipts {
                        ForEach(receipts) { receipt in
                            Button { Task { await attach(receipt) } } label: {
                                HStack(spacing: 12) {
                                    InboxThumbnail(groupID: group.id, id: receipt.id, size: CGSize(width: 44, height: 54))
                                        .allowsHitTesting(false)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(receipt.note?.isEmpty == false ? receipt.note! : "Receipt photo")
                                            .font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
                                        Text(receipt.date?.formatted(date: .abbreviated, time: .shortened) ?? "")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if working == receipt.id { ProgressView() }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(working != nil)
                        }
                        if receipts.isEmpty {
                            Text("The inbox is empty. Upload a receipt from the group’s Receipts tab.").foregroundStyle(.secondary)
                        }
                    } else {
                        ProgressView()
                    }
                } footer: {
                    if let error { InlineError(text: error) }
                }
            }
            .navigationTitle("Attach from inbox")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(working != nil) }
            }
            .task {
                do { receipts = try await store.inboxReceipts(groupID: group.id) }
                catch { self.error = error.localizedDescription; receipts = [] }
            }
        }
    }

    private func attach(_ receipt: InboxReceipt) async {
        working = receipt.id
        error = nil
        defer { working = nil }
        do {
            try await store.pairInboxReceipt(groupID: group.id, id: receipt.id, to: entry)
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
