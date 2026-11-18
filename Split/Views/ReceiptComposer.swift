import SwiftUI
import PhotosUI

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
    @State private var picks: [PhotosPickerItem] = []
    @State private var camera = false
    @State private var message: String?
    private var remaining: Int { max(0, 4 - existing - photos.count) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Receipt", subtitle: remaining > 0 ? "Up to \(remaining) more \(remaining == 1 ? "photo" : "photos")" : "Photo limit reached")
            if remaining > 0 && !processing {
                HStack(spacing: 8) {
                    PhotosPicker(selection: $picks, maxSelectionCount: remaining, matching: .images) {
                        Label("Add photos", systemImage: "photo.on.rectangle")
                    }
                    .buttonStyle(GhostButton())
                    .onChange(of: picks) { _, items in
                        guard !items.isEmpty else { return }
                        Task {
                            processing = true
                            defer { processing = false; picks = [] }
                            do {
                                for pick in items {
                                    guard let data = try await pick.loadTransferable(type: Data.self) else {
                                        throw LedgerError.invalid("Couldn’t load this photo.")
                                    }
                                    try await append(data)
                                }
                            } catch { message = error.localizedDescription }
                        }
                    }
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button { camera = true } label: { Label("Camera", systemImage: "camera") }
                            .buttonStyle(GhostButton())
                    }
                    Spacer(minLength: 0)
                }
            }
            if processing {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Reading receipt…").font(.subheadline).foregroundStyle(.secondary)
                }
                .frame(minHeight: 44, alignment: .leading)
            }
            if !photos.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(photos) { photo in
                            if let image = UIImage(data: photo.data) {
                                Image(uiImage: image)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: 68, height: 82)
                                    .clipped()
                                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Palette.line, lineWidth: 1))
                                    .overlay(alignment: .topTrailing) {
                                        Button { photos.removeAll { $0.id == photo.id } } label: {
                                            Image(systemName: "xmark.circle.fill")
                                                .font(.system(size: 20))
                                                .symbolRenderingMode(.palette)
                                                .foregroundStyle(.white, .black.opacity(0.55))
                                                .frame(width: 44, height: 44, alignment: .topTrailing)
                                                .padding(2)
                                                .contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain)
                                        .accessibilityLabel("Remove receipt photo")
                                    }
                            }
                        }
                    }
                }
            }
            if let message {
                Text(message).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if !mustItemize {
                Toggle("Split by line item", isOn: $itemized)
                    .tint(Palette.evergreen)
                    .font(.subheadline.weight(.medium))
            }
        }
        .sheet(isPresented: $camera) {
            ReceiptCamera { data in
                camera = false
                guard let data else { return }
                Task {
                    processing = true
                    defer { processing = false }
                    do { try await append(data) } catch { message = error.localizedDescription }
                }
            }
            .ignoresSafeArea()
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
        }
    }

    private func toggle(_ id: String, in item: Binding<Purchase>) {
        var ids = item.wrappedValue.memberIDs
        if let index = ids.firstIndex(of: id) { ids.remove(at: index) } else { ids.append(id) }
        // Keep the group's member order so the chips and saved claims are stable.
        let order = members.map(\.id)
        item.wrappedValue.memberIDs = ids.sorted { (order.firstIndex(of: $0) ?? .max) < (order.firstIndex(of: $1) ?? .max) }
        item.wrappedValue.roundingSeats = nil
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
                FlowLayout(spacing: 6, lineSpacing: 0) {
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

    private func append(_ data: Data) async throws {
        let (photo, suggestion) = try await Task.detached(priority: .userInitiated) { try ReceiptReader.scan(data) }.value
        photos.append(photo)
        if !bill.closed {
            itemized = true
            bill.items.append(contentsOf: suggestion.items.prefix(50 - bill.items.count))
            bill.tax += suggestion.tax
            bill.tip += suggestion.tip
            message = suggestion.items.isEmpty ? "No prices recognized. Add items by hand or turn off line-item splitting." : "Review the suggested items and prices."
        }
    }
}

private struct ReceiptCamera: UIViewControllerRepresentable {
    var complete: (Data?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(complete) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let complete: (Data?) -> Void
        init(_ complete: @escaping (Data?) -> Void) { self.complete = complete }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { complete(nil) }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            complete((info[.originalImage] as? UIImage)?.jpegData(compressionQuality: 0.9))
        }
    }
}
