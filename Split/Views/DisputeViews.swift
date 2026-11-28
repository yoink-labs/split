import SwiftUI

struct OpenDispute: Codable, Equatable, Identifiable {
    let id: String
    let entryID: String
    let groupID: String
    let title: String
    let canResolve: Bool
    let canWithdraw: Bool
    let actorName: String
    let comment: String
}

struct DisputesToResolve: View {
    @EnvironmentObject private var store: ExpenseStore
    @State private var selected: OpenDispute?

    var body: some View {
        let disputes = (store.state.snapshot.disputes ?? []).filter(\.canResolve)
        if !disputes.isEmpty {
            Card {
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeader(title: "Disputes to resolve")
                    ForEach(disputes) { dispute in
                        Button { selected = dispute } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(dispute.title).font(.headline)
                                    Text("\(dispute.actorName): \(dispute.comment)").foregroundStyle(.secondary)
                                }
                                Spacer()
                                PendingBadge(note: nil)
                            }
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .sheet(item: $selected) { dispute in
                if let entry = store.entries.first(where: { $0.id == dispute.entryID }),
                   let group = store.group(dispute.groupID) {
                    NavigationStack { EntryDetails(entry: entry, group: group) }
                }
            }
        }
    }
}

enum DisputeAction: String, Identifiable {
    case open, dismiss, withdraw
    var id: Self { self }
    var title: String {
        switch self {
        case .open: "Dispute"
        case .dismiss: "Dismiss dispute"
        case .withdraw: "Withdraw dispute"
        }
    }
}

struct DisputeReplySheet: View {
    var entryID: String
    var action: DisputeAction
    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.dismiss) private var dismiss
    @State private var reply = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section(action == .open ? "What should the payer review?" : "Reply to the dispute") {
                    TextField(action == .withdraw ? "Reply (optional)" : "Write a comment", text: $reply, axis: .vertical)
                        .lineLimit(3...7)
                }
                if let error { InlineError(text: error) }
            }
            .navigationTitle(action.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action.title) { Task { await submit() } }
                        .disabled(busy || reply.utf16.count > 2000 ||
                                  (action != .withdraw && reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                }
            }
            .interactiveDismissDisabled(busy)
        }
    }

    private func submit() async {
        busy = true
        defer { busy = false }
        do {
            try await store.respondToDispute(entryID, action: action.rawValue, comment: reply)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct DisputeActivity: Decodable, Identifiable {
    let id: String
    let entryID: String
    let groupID: String
    let title: String
    let action: String
    let comment: String
    let actorName: String
    let at: String

    var label: String {
        switch action {
        case "opened": "\(actorName) disputed \(title)"
        case "edited": "\(actorName) resolved \(title) by editing"
        case "dismissed": "\(actorName) dismissed the dispute on \(title)"
        default: "\(actorName) withdrew the dispute on \(title)"
        }
    }
}
