import SwiftUI

/// Records a refund of an expense, or a standalone credit, and resolves a pending
/// expense into a refund. Credits default to each person's remaining share by
/// largest remainder, so the amounts stay exact to the cent.
struct RefundComposer: View {
    var group: ExpenseGroup
    /// The expense being refunded. Nil records a standalone credit.
    var original: LedgerEntry?
    /// Resolve the original's pending state and record the refund together.
    var resolving = false

    @EnvironmentObject private var store: ExpenseStore
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss

    @State private var initialized = false
    @State private var title = ""
    @State private var amount = ""
    @State private var receiver = ""
    @State private var selected = Set<String>()
    @State private var custom = false
    @State private var values: [String: String] = [:]
    /// Refund specific receipt items: each person gets back exactly what those items cost them.
    @State private var byItems = false
    @State private var itemIDs: [String] = []
    @State private var pending = false
    @State private var pendingNote = ""
    @State private var saving = false
    @State private var error: String?

    private var current: ExpenseGroup { store.group(group.id) ?? group }
    private var currency: String { original?.currency ?? current.currency }
    private var others: [LedgerEntry] { original.map { Refunds.linked(to: $0, in: store.entries) } ?? [] }
    private var remainingShares: [Portion] { original.map { Refunds.remainingShares(of: $0, refunds: others) } ?? [] }
    private var remaining: Int64? { original.map { Refunds.remaining(of: $0, refunds: others) } }
    /// People who can be credited: those with a remaining share of the original, or every active member.
    private var eligible: [Person] {
        if original != nil {
            let ids = remainingShares.map(\.memberID)
            return ids.compactMap { id in current.members.first { $0.id == id } }
        }
        return current.members.filter { $0.removed != true }
    }
    private var people: [String] { eligible.map(\.id).filter(selected.contains) }

    /// Receipt items of the original not yet given back by another refund.
    private var refundable: [ItemConsumption] {
        guard let original, let bill = original.bill, let use = try? Consumption.bill(bill, payer: original.paidBy) else { return [] }
        let done = Refunds.refundedItems(others)
        return use.items.filter { !done.contains($0.id) }
    }
    private var itemCredit: (amount: Int64, splits: [Portion])? {
        guard byItems, let original, !itemIDs.isEmpty else { return nil }
        return try? Consumption.itemRefund(original, itemIDs: itemIDs)
    }
    private var total: Int64? {
        if byItems { return itemCredit.flatMap { $0.amount > 0 ? $0.amount : nil } }
        return Money.parse(amount).flatMap { $0 > 0 ? $0 : nil }
    }

    private func credits() throws -> [Portion] {
        if byItems {
            guard let itemCredit, itemCredit.amount > 0 else { throw LedgerError.invalid("Choose the items that were refunded.") }
            return itemCredit.splits
        }
        if custom {
            let portions = try people.map { id -> Portion in
                guard let value = Money.parse(values[id] ?? "0") else { throw LedgerError.invalid("Use a number with up to two decimal places for each credit.") }
                return Portion(memberID: id, amount: value)
            }.filter { $0.amount > 0 }
            guard !portions.isEmpty else { throw LedgerError.invalid("Enter a credit for at least one person.") }
            return portions
        }
        guard let total else { throw LedgerError.invalid("Enter an amount greater than zero.") }
        guard !people.isEmpty else { throw LedgerError.invalid("Choose who gets the credit.") }
        if let original { return try Refunds.proportional(total, original: original, refunds: others, people: people) }
        return try Ledger.split(total: total, people: people, mode: .equal, values: [:])
    }
    private var preview: [Portion] { (try? credits()) ?? [] }

    var body: some View {
        NavigationStack {
            Form {
                Group {
                if let original {
                    Section {
                        LabeledContent("Original", value: original.title)
                        LabeledContent("Expense total", value: Money.text(original.amount, original.currency))
                        if let remaining {
                            LabeledContent("Can still be refunded", value: Money.text(remaining, original.currency))
                        }
                    } footer: {
                        Text("A refund lowers the shares of the people it credits. It can’t be more than the original or anyone’s share.")
                    }
                }
                Section("Refund") {
                    TextField("Description", text: $title)
                        .accessibilityIdentifier("refund-title")
                    if !refundable.isEmpty {
                        Picker("Refund", selection: $byItems.animation(.snappy)) {
                            Text("Amount").tag(false)
                            Text("Items").tag(true)
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("refund-mode")
                    }
                    if byItems {
                        LabeledContent("Amount") {
                            Text(total.map { Money.text($0, currency) } ?? "Choose items")
                                .font(.splitAmount(20))
                                .foregroundStyle(total == nil ? Color.secondary : Palette.ink)
                        }
                        .accessibilityIdentifier("refund-amount")
                    } else if !custom {
                        HStack {
                            Text(currency).foregroundStyle(.secondary)
                            TextField("0.00", text: $amount)
                                .keyboardType(.decimalPad)
                                .font(.splitAmount(20))
                                .accessibilityIdentifier("refund-amount")
                        }
                        if let remaining, remaining > 0 {
                            Button("Refund everything left (\(Money.text(remaining, currency)))") {
                                amount = Money.input(remaining)
                                selected = Set(remainingShares.map(\.memberID))
                            }
                            .font(.subheadline)
                        }
                    }
                    Picker(original == nil ? "Credit from" : "Received by", selection: $receiver) {
                        ForEach(current.members.filter { $0.removed != true }) { person in
                            Text(name(person)).tag(person.id)
                        }
                    }
                    .accessibilityIdentifier("refund-receiver")
                }
                if byItems {
                    Section {
                        ForEach(refundable) { item in
                            Button { toggle(item.id) } label: {
                                HStack(alignment: .firstTextBaseline) {
                                    Image(systemName: itemIDs.contains(item.id) ? "checkmark.circle.fill" : "circle")
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(item.title)
                                        Text(item.open ? "Unclaimed" : item.portions.map { claimant($0.memberID) }.joined(separator: ", "))
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text(Money.text(item.gross, currency)).font(.splitAmount(15))
                                }
                                .foregroundStyle(Palette.ink)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("refund-item-\(item.id)")
                        }
                    } header: {
                        Text("Items refunded")
                    } footer: {
                        Text("Each person gets back what the item cost them, tax and tip included.")
                    }
                }
                Section {
                    if !byItems { Toggle("Enter each credit", isOn: $custom.animation(.snappy)) }
                    ForEach(byItems ? eligible.filter { person in preview.contains { $0.memberID == person.id } } : eligible) { person in
                        HStack {
                            Button {
                                if selected.contains(person.id) { selected.remove(person.id) } else { selected.insert(person.id) }
                            } label: {
                                Label(name(person), systemImage: byItems || selected.contains(person.id) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(Palette.ink)
                            }
                            .buttonStyle(.plain)
                            .disabled(byItems)
                            Spacer()
                            if custom && !byItems && selected.contains(person.id) {
                                TextField("0.00", text: Binding(get: { values[person.id] ?? "" }, set: { values[person.id] = $0 }))
                                    .keyboardType(.decimalPad).multilineTextAlignment(.trailing).frame(maxWidth: 110)
                            } else if let credit = preview.first(where: { $0.memberID == person.id }) {
                                Text(Money.text(credit.amount, currency)).font(.splitAmount(15)).foregroundStyle(Palette.positive)
                            }
                            if let share = remainingShares.first(where: { $0.memberID == person.id }) {
                                Text("of \(Money.text(share.amount, currency))").font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                } header: {
                    Text("Credit to")
                } footer: {
                    Text(original == nil
                         ? "Each person’s balance goes up by their credit, and the person giving it owes the total."
                         : byItems ? (itemIDs.isEmpty ? "Choose the items that were refunded." : "Exactly what the chosen items cost each person.")
                         : "Split in proportion to what each person paid toward the original, to the cent.")
                }
                if !resolving {
                    Section {
                        Toggle("Pending", isOn: $pending).tint(Palette.amber)
                        if pending { TextField("Why is it pending? (optional)", text: $pendingNote) }
                    }
                }
                if let error { Section { InlineError(text: error) } }
                }
                .listRowBackground(Palette.card)
            }
            .scrollContentBackground(.hidden)
            .background(AppBackground())
            .navigationTitle(resolving ? "Turn into refund" : original == nil ? "Record a credit" : "Record a refund")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(saving)
                        .accessibilityIdentifier("refund-save")
                }
            }
            .onAppear(perform: setUp)
        }
    }

    private func name(_ person: Person) -> String { person.userID == session.userID ? "You" : person.name }
    private func claimant(_ id: String) -> String { current.members.first { $0.id == id }.map(name) ?? "Someone" }

    /// Adds or removes an item, keeping a default "Refund: …" title in step with the chosen items.
    private func toggle(_ id: String) {
        if let index = itemIDs.firstIndex(of: id) { itemIDs.remove(at: index) } else { itemIDs.append(id) }
        guard let original, title.hasPrefix("Refund") else { return }
        let names = (original.bill?.items ?? []).filter { itemIDs.contains($0.id) }.map(\.title).joined(separator: ", ")
        title = String("Refund: \(names.isEmpty ? original.title : names)".prefix(120))
    }

    private func setUp() {
        guard !initialized else { return }
        initialized = true
        let me = current.members.first { $0.userID == session.userID }
        receiver = original?.paidBy ?? me?.id ?? current.members.first?.id ?? ""
        title = original.map { "Refund: \($0.title)" } ?? "Credit"
        selected = Set(eligible.map(\.id).filter { original != nil || $0 != receiver })
    }

    private func save() async {
        guard !saving else { return }
        saving = true
        error = nil
        defer { saving = false }
        do {
            let portions = try credits()
            let clean = title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard clean.count <= 120 else { throw LedgerError.invalid("Use a description of 120 characters or fewer.") }
            let label = clean.isEmpty ? (original == nil ? "Credit" : "Refund") : clean
            var refund: LedgerEntry
            if let original {
                refund = Refunds.make(original: original, title: label, credits: portions, receiver: receiver)
                if byItems { refund.refundItems = itemIDs }
            } else {
                refund = LedgerEntry(groupID: current.id, title: label, amount: portions.reduce(0) { $0 + $1.amount }, currency: currency,
                                     paidBy: receiver, splits: portions, kind: "refund", splitMode: custom ? .exact : .equal)
            }
            let note = pendingNote.trimmingCharacters(in: .whitespacesAndNewlines)
            if pending && !resolving {
                guard note.count <= 500 else { throw LedgerError.invalid("Write a pending note of up to 500 characters.") }
                refund.pending = true
                refund.pendingNote = note.isEmpty ? nil : note
            }
            try Refunds.validate(refund, original: original, others: others)
            if resolving, let original {
                try await store.resolve(original, .refund(refund))
            } else {
                refund.editable = true
                try store.add(refund)
            }
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Marks an entry pending with an optional reason.
struct PendingSheet: View {
    var entry: LedgerEntry
    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Group {
                Section {
                    TextField("Why is it pending? (optional)", text: $note, axis: .vertical)
                        .lineLimit(2...5)
                        .accessibilityIdentifier("pending-note")
                } footer: {
                    Text("Pending entries still count toward balances. Everyone sees balances with and without them, and settling up warns first.")
                }
                if let error { Section { InlineError(text: error) } }
                }
                .listRowBackground(Palette.card)
            }
            .scrollContentBackground(.hidden)
            .background(AppBackground())
            .navigationTitle("Mark as pending")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            saving = true
                            defer { saving = false }
                            do { try await store.setPending(entry, pending: true, note: note); dismiss() }
                            catch { self.error = error.localizedDescription }
                        }
                    }
                    .disabled(saving)
                }
            }
            .onAppear { note = entry.pendingNote ?? "" }
        }
        .presentationDetents([.medium])
    }
}

/// Resolves a pending expense with a new total. Shares and payers rescale to the cent.
struct AdjustAmountSheet: View {
    var entry: LedgerEntry
    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.dismiss) private var dismiss
    @State private var amount = ""
    @State private var saving = false
    @State private var error: String?

    private var refunded: Int64 { Refunds.refundedTotal(Refunds.linked(to: entry, in: store.entries)) }
    private var preview: LedgerEntry? { Money.parse(amount).flatMap { try? Refunds.adjusted(entry, to: $0) } }

    var body: some View {
        NavigationStack {
            Form {
                Group {
                Section {
                    HStack {
                        Text(entry.currency).foregroundStyle(.secondary)
                        TextField(Money.input(entry.amount), text: $amount)
                            .keyboardType(.decimalPad)
                            .font(.splitAmount(20))
                            .accessibilityIdentifier("adjust-amount")
                    }
                } header: {
                    Text("Final amount")
                } footer: {
                    Text("Was \(Money.text(entry.amount, entry.currency)). Everyone’s share changes in proportion, and the expense is confirmed.")
                }
                if let preview {
                    Section("New shares") {
                        ForEach(preview.splits, id: \.memberID) { portion in
                            LabeledContent(store.group(entry.groupID)?.members.first { $0.id == portion.memberID }?.name ?? "Someone",
                                           value: Money.text(portion.amount, entry.currency))
                        }
                    }
                }
                if let error { Section { InlineError(text: error) } }
                }
                .listRowBackground(Palette.card)
            }
            .scrollContentBackground(.hidden)
            .background(AppBackground())
            .navigationTitle("Adjust amount")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Confirm") { Task { await save() } }.disabled(saving)
                }
            }
        }
    }

    private func save() async {
        saving = true
        error = nil
        defer { saving = false }
        do {
            guard let value = Money.parse(amount), value > 0 else { throw LedgerError.invalid("Enter an amount greater than zero.") }
            let next = try Refunds.adjusted(entry, to: value)
            let refunds = Refunds.linked(to: entry, in: store.entries)
            if !refunds.isEmpty {
                var credited: [String: Int64] = [:]
                for refund in refunds { for credit in refund.splits { credited[credit.memberID, default: 0] += credit.amount } }
                guard value >= refunded, credited.allSatisfy({ $0.value <= Ledger.share(next, of: $0.key) }) else {
                    throw LedgerError.invalid("This expense has refunds. Keep each share at or above what was refunded.")
                }
            }
            try await store.resolve(entry, .adjust(value))
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
