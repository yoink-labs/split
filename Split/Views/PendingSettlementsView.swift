import SwiftUI

struct PendingSettlementsView: View {
    @EnvironmentObject private var fx: FXStore
    var groupID: String? = nil
    @EnvironmentObject private var store: ExpenseStore
    @State private var busy = false
    @State private var error: String?

    private var payments: [LedgerEntry] {
        store.pendingSettlements.filter { groupID == nil || $0.groupID == groupID }
    }

    private var unsentPayments: [LedgerEntry] {
        store.unsentPayments.filter { groupID == nil || $0.groupID == groupID }
    }

    var body: some View {
        if !payments.isEmpty {
            Card {
                VStack(alignment: .leading, spacing: 12) {
                    SectionHeader(title: "Payments awaiting approval", subtitle: "Balances update after the recipient confirms.")
                    ForEach(payments) { payment in
                        if let group = store.group(payment.groupID) {
                            paymentRow(payment, group: group)
                            if payment.id != payments.last?.id { Divider() }
                        }
                    }
                    if let error { InlineError(text: error) }
                }
            }
        }
        if !unsentPayments.isEmpty {
            Card {
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeader(title: "Unsent older payments", subtitle: "Ask the payer to request approval for these payments.")
                    ForEach(unsentPayments) { payment in
                        let group = store.group(payment.groupID)
                        let payer = group?.members.first { $0.id == payment.paidBy }?.name ?? "Payer"
                        let recipient = group?.members.first { $0.id == payment.splits.first?.memberID }?.name ?? "Recipient"
                        Text("\(payer) → \(recipient) · \(fx.entryText(payment))")
                            .font(.subheadline)
                    }
                }
            }
        }
    }

    private func paymentRow(_ payment: LedgerEntry, group: ExpenseGroup) -> some View {
        let payer = group.members.first { $0.id == payment.paidBy }
        let recipient = group.members.first { $0.id == payment.splits.first?.memberID }
        let incoming = recipient?.userID == store.currentUserID && recipient?.userID != nil
        return VStack(alignment: .leading, spacing: 8) {
            Text(incoming ? "\(payer?.name ?? "A member") paid you" : "You paid \(recipient?.name ?? "a member")")
                .font(.subheadline.weight(.semibold))
            Text(fx.entryText(payment))
                .font(.title3.weight(.semibold).monospacedDigit())
            if payment.currency != fx.home {
                Text("Payment sent as \(Money.text(payment.amount, payment.currency))")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text([groupID == nil ? group.name : nil, LedgerDate.short(payment.createdAt)].compactMap { $0 }.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(.secondary)
            if let note = payment.notes { Text(note).font(.subheadline) }
            if incoming {
                ActionBar {
                    SplitActionButton(title: "Confirm received", symbol: "checkmark", prominent: true) { submit(.approve, payment) }
                    SplitActionButton(title: "Decline", symbol: "xmark") { submit(.decline, payment) }
                }
                .disabled(busy)
            } else {
                if recipient?.userID == nil {
                    Text("Waiting for the recipient to join").font(.caption).foregroundStyle(.secondary)
                }
                Button("Cancel request", role: .destructive) { submit(.cancel, payment) }
                    .frame(minHeight: HitTarget.minimum)
                    .disabled(busy)
            }
        }
        .padding(.vertical, 4)
    }

    private func submit(_ response: SettlementResponse, _ payment: LedgerEntry) {
        guard !busy else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do { try await store.respond(to: payment, with: response) }
            catch { self.error = error.localizedDescription }
        }
    }
}
