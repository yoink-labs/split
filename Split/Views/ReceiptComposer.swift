import SwiftUI

struct PriceField: View {
    var title: String
    @Binding var cents: Int64
    @State private var input = ""
    var body: some View {
        TextField("0.00", text: $input)
            .keyboardType(.decimalPad)
            .multilineTextAlignment(.trailing)
            .frame(maxWidth: 110)
            .accessibilityLabel(title)
            .onAppear { input = cents == 0 ? "" : Money.input(cents) }
            .onChange(of: input) { _, value in cents = Money.parse(value) ?? 0 }
            .onChange(of: cents) { _, amount in
                if amount != (Money.parse(input) ?? 0) { input = Money.input(amount) }
            }
    }
}

struct ReceiptComposer: View {
    @Binding var bill: ReceiptBill
    @Binding var photos: [ReceiptPhoto]
    @Binding var itemized: Bool
    @Binding var processing: Bool
    var existing: Int
    var mustItemize: Bool
    /// Group members who can be marked as sharing a line item.
    var members: [Person] = []
    /// The member who absorbs unassigned items (the first payer).
    var payerID: String = ""
    var currentUserID: String? = nil
    var currency: String = ""
    /// A saved receipt with claims is read-only here; claims are adjusted on
    /// the saved expense so the Worker's stale-claim check cannot reject a
    /// price or item edit.
    var chipsEditable: Bool = true
    @State private var message: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ReceiptPhotoPicker(photos: $photos, processing: $processing, existing: existing, onScan: applyScan)
            if let message {
                Text(message).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if !mustItemize {
                Toggle("Split by line item", isOn: $itemized)
                    .tint(Palette.evergreen)
                    .font(.subheadline.weight(.medium))
            }
        }
        if itemized {
            VStack(alignment: .leading, spacing: 12) {
                Rectangle().fill(Palette.line).frame(height: 1)
                HStack(alignment: .firstTextBaseline) {
                    Text("Who had what").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
                    Spacer(minLength: 8)
                    if chipsEditable, !members.isEmpty, !bill.items.isEmpty {
                        Menu {
                            Button("Everyone shares every item") { assignAll(members.map(\.id)) }
                            Button("Clear all assignments", role: .destructive) { assignAll([]) }
                        } label: {
                            Label("Assign", systemImage: "person.2.badge.gearshape")
                                .font(.caption.weight(.semibold))
                                .frame(minHeight: 44)
                        }
                        .foregroundStyle(Palette.evergreen)
                        .accessibilityIdentifier("receipt-assign-menu")
                    }
                }
                if !chipsEditable {
                    Text("Claims have already been made. Adjust who had an item from the saved expense.")
                        .font(.caption)
                        .foregroundStyle(Palette.amber)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !bill.items.isEmpty {
                    ReceiptSummaryRail(bill: bill, currency: currency)
                }
                ForEach($bill.items) { $item in
                    lineItem($item)
                }
                if bill.items.count < 50 {
                    Button { bill.items.append(Purchase(title: "", amount: 0)) } label: {
                        Label("Add line item", systemImage: "plus")
                    }
                    .buttonStyle(GhostButton())
                    .fixedSize()
                }
                HStack(spacing: 10) {
                    extraField("Tax", cents: $bill.tax)
                    extraField("Tip", cents: $bill.tip)
                }
                Text("Tax and tip follow each item’s price. Tap people to mark who shared an item. Unassigned items stay with \(payerLabel). People can still claim items after you save.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var payerLabel: String {
        guard let payer = members.first(where: { $0.id == payerID }) else { return "the payer" }
        return payer.userID != nil && payer.userID == currentUserID ? "you" : payer.name
    }

    private func label(_ person: Person) -> String {
        person.userID != nil && person.userID == currentUserID ? "You" : person.name
    }

    private func assignAll(_ ids: [String]) {
        for index in bill.items.indices {
            bill.items[index].memberIDs = ids
            bill.items[index].roundingSeats = nil
            bill.items[index].roundingWeights = nil
            bill.items[index].shares = nil
        }
    }

    private func toggle(_ id: String, in item: Binding<Purchase>) {
        var ids = item.wrappedValue.memberIDs
        if let index = ids.firstIndex(of: id) { ids.remove(at: index) } else { ids.append(id) }
        // Keep the group's member order so the chips and saved claims are stable.
        let order = members.map(\.id)
        item.wrappedValue.memberIDs = ids.sorted { (order.firstIndex(of: $0) ?? .max) < (order.firstIndex(of: $1) ?? .max) }
        item.wrappedValue.roundingSeats = nil
        item.wrappedValue.roundingWeights = nil
        item.wrappedValue.shares = item.wrappedValue.shares?.filter { ids.contains($0.key) }
    }

    @ViewBuilder private func lineItem(_ item: Binding<Purchase>) -> some View {
        let value = item.wrappedValue
        let assigned = !value.memberIDs.isEmpty
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: assigned ? "checkmark.circle.fill" : "circle.dashed")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(assigned ? Palette.evergreen : Palette.amber)
                    .frame(width: 22)
                    .accessibilityHidden(true)
                TextField("Item name", text: item.title)
                    .font(.subheadline.weight(.semibold))
                    .textFieldStyle(.plain)
                    .frame(minHeight: 36)
                PriceField(title: "Item price", cents: item.amount)
                    .font(.splitAmount(15))
                    .padding(.horizontal, 8)
                    .frame(minHeight: 36)
                    .background(Palette.raised, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                Button { bill.items.removeAll { $0.id == value.id } } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Remove " + (value.title.isEmpty ? "line item" : value.title))
            }
            if !members.isEmpty {
                FlowLayout(spacing: 6, lineSpacing: 6) {
                    ForEach(members) { person in
                        PersonChip(
                            name: person.name,
                            label: label(person),
                            selected: value.memberIDs.contains(person.id),
                            compact: true,
                            action: chipsEditable ? { toggle(person.id, in: item) } : nil
                        )
                    }
                }
                .padding(.leading, 30)
                .accessibilityElement(children: .contain)
                .accessibilityLabel("People sharing \(value.title.isEmpty ? "this item" : value.title)")
                if !assigned {
                    Text("Unassigned · goes to \(payerLabel)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Palette.amber)
                        .padding(.leading, 30)
                } else if value.memberIDs.count > 1 {
                    Text("Split \(value.memberIDs.count) ways")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.leading, 30)
                }
            }
        }
        .padding(10)
        .background(Palette.card.opacity(0.55), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(assigned ? Palette.line : Palette.amber.opacity(0.35), lineWidth: 1)
        )
    }

    private func extraField(_ title: String, cents: Binding<Int64>) -> some View {
        HStack(spacing: 6) {
            Text(title).font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
            Spacer(minLength: 4)
            PriceField(title: "\(title) amount", cents: cents)
                .font(.splitAmount(15))
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 44)
        .background(Palette.raised.opacity(0.7), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .frame(maxWidth: .infinity)
    }

    private func applyScan(_ suggestion: ReceiptBill) {
        if !suggestion.items.isEmpty { itemized = true }
        bill.items.append(contentsOf: suggestion.items.prefix(50 - bill.items.count))
        bill.tax += suggestion.tax
        bill.tip += suggestion.tip
        message = suggestion.items.isEmpty ? "No prices recognized. Turn on line-item splitting to enter items by hand." : "Review the suggested items and prices."
    }
}
