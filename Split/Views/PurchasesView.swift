import SwiftUI

struct PurchasesSection:View {
    let entry:LedgerEntry
    let group:ExpenseGroup
    let bill:ReceiptBill
    @EnvironmentObject var store:ExpenseStore
    @EnvironmentObject var session:SessionStore
    var assign:(Purchase?)->Void

    private func claimers(_ item: Purchase) -> String {
        item.memberIDs.compactMap { id in group.members.first { $0.id == id }?.name }.joined(separator: ", ")
    }
    private var canClose: Bool {
        let payer = group.members.first { $0.id == entry.paidBy }
        return !bill.closed && (payer?.userID == session.userID || (payer?.userID == nil && (store.isDemo || entry.editable == true)))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: bill.closed ? "Purchases · closed" : "Purchases", subtitle: bill.closed ? "Claims are locked" : "Tap a line to claim it")
            VStack(spacing: 0) {
                ForEach(Array(bill.items.enumerated()), id: \.element.id) { index, item in
                    Button { assign(item) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: item.memberIDs.isEmpty ? "circle.dashed" : "checkmark.circle.fill")
                                .font(.system(size: 18, weight: .semibold))
                                .foregroundStyle(item.memberIDs.isEmpty ? Palette.amber : Palette.evergreen)
                                .frame(width: 24)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(item.title)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Palette.ink)
                                Text(item.memberIDs.isEmpty ? "Open · claim purchase" : claimers(item))
                                    .font(.caption)
                                    .foregroundStyle(item.memberIDs.isEmpty ? Palette.amber : .secondary)
                                    .lineLimit(2)
                            }
                            Spacer(minLength: 8)
                            Text(Money.text(item.amount, entry.currency))
                                .font(.splitAmount(14))
                                .foregroundStyle(Palette.ink)
                            Image(systemName: "chevron.right")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.tertiary)
                        }
                        .frame(minHeight: 48)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(bill.closed)
                    if index < bill.items.count - 1 { Divider().overlay(Palette.line).padding(.leading, 34) }
                }
            }
            if bill.tax > 0 || bill.tip > 0 || bill.openCount > 0 {
                Rectangle().fill(Palette.line).frame(height: 1)
            }
            if bill.tax > 0 { totalRow("Tax", value: Money.text(bill.tax, entry.currency)) }
            if bill.tip > 0 { totalRow("Tip", value: Money.text(bill.tip, entry.currency)) }
            if bill.openCount > 0 {
                totalRow("Open total", value: Money.text(bill.openTotal, entry.currency), strong: true)
                Text("Open purchases stay with the payer until claimed. The open total includes proportional tax and tip.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if canClose {
                Button { assign(nil) } label: {
                    Label("Close receipt", systemImage: "lock")
                }
                .buttonStyle(GhostButton())
            }
        }
    }
    private func totalRow(_ title: String, value: String, strong: Bool = false) -> some View {
        HStack {
            Text(title).font(.subheadline.weight(strong ? .bold : .medium)).foregroundStyle(strong ? Palette.ink : .secondary)
            Spacer()
            Text(value).font(.splitAmount(14, weight: strong ? .bold : .medium)).foregroundStyle(Palette.ink)
        }
    }
}
struct ClaimSheet:View {
    let entry:LedgerEntry; let group:ExpenseGroup; let item:Purchase?
    @EnvironmentObject var store:ExpenseStore
    @Environment(\.dismiss) var dismiss
    @State private var selected=Set<String>()
    @State private var error:String?
    @State private var working=false
    var body:some View {
        NavigationStack { Form {
            Section {
                ForEach(group.members) { person in
                    Button {
                        if selected.contains(person.id) { selected.remove(person.id) } else { selected.insert(person.id) }
                    } label: {
                        HStack { Text(person.name).foregroundStyle(.primary); Spacer(); Image(systemName:selected.contains(person.id) ? "checkmark.circle.fill" : "circle") }
                    }.accessibilityValue(selected.contains(person.id) ? "Selected" : "Unselected")
                }
            } header: { Text(item?.title ?? "Who covers the remaining items?") }
            footer: { Text(item == nil ? "The remaining items will be divided evenly among these people. Closing locks the claims." : "Choose everyone sharing this purchase. Clear the selection to leave it open.") }
            if let error { ErrorText(text:error) }
        }.navigationTitle(item == nil ? "Close receipt" : "Claim purchase").navigationBarTitleDisplayMode(.inline)
            .onAppear { selected=Set(item?.memberIDs ?? group.members.map(\.id)) }
            .toolbar {
                ToolbarItem(placement:.cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement:.confirmationAction) { Button(item == nil ? "Close" : "Save") { Task {
                    working=true; defer { working=false }
                    do { try await store.claim(entry,item:item,people:group.members.filter{selected.contains($0.id)}.map(\.id)); dismiss() }
                    catch { self.error=error.localizedDescription }
                } }.disabled(working || (item==nil && selected.isEmpty)) }
            }
        }
    }
}
struct ReceiptGallery:View {
    var entry:String
    var ids:[String]
    @EnvironmentObject var store:ExpenseStore
    var viewPhoto:(ReceiptPresentation)->Void
    @State private var loaded:[String:UIImage]=[:]
    @State private var failed=Set<String>()
    @State private var attempt=0
    var body:some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Receipts", subtitle: "\(ids.count) \(ids.count == 1 ? "photo" : "photos")")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Array(ids.enumerated()), id: \.element) { index, id in
                        Button {
                            if loaded[id] != nil {
                                viewPhoto(ReceiptPresentation(images: ids.compactMap { loaded[$0] }, index: ids.prefix(index).filter { loaded[$0] != nil }.count))
                            } else { attempt += 1 }
                        } label: {
                            Group {
                                if let image = loaded[id] { Image(uiImage: image).resizable().scaledToFill() }
                                else if failed.contains(id) { Image(systemName: "arrow.clockwise") }
                                else { ProgressView() }
                            }
                            .frame(width: 72, height: 88)
                            .background(Palette.raised)
                            .clipped()
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Palette.line, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("View receipt photo \(index + 1)")
                        .task(id: attempt) {
                            guard loaded[id] == nil else { return }
                            do {
                                let data = try await store.image(entry: entry, id: id)
                                guard let image = UIImage(data: data) else { throw LedgerError.invalid("Invalid photo.") }
                                loaded[id] = image
                            } catch { failed.insert(id) }
                        }
                    }
                }
            }
        }
    }
}
struct ReceiptPresentation:Identifiable {
    let id=UUID()
    let images:[UIImage]
    let index:Int
}
struct ReceiptViewer:View {
    let photos:ReceiptPresentation
    @Environment(\.dismiss) var dismiss
    @State private var page:Int
    init(_ photos:ReceiptPresentation) { self.photos=photos; _page=State(initialValue:photos.index) }
    var body:some View {
        NavigationStack { TabView(selection:$page) {
            ForEach(photos.images.indices,id:\.self) { index in
                Image(uiImage:photos.images[index]).resizable().scaledToFit().tag(index).accessibilityLabel("Receipt page "+String(index+1))
            }
        }.tabViewStyle(.page).background(Color.black).navigationTitle("Receipt photo").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement:.confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
