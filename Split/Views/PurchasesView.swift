import SwiftUI

struct PurchasesSection:View {
    let entry:LedgerEntry
    let group:ExpenseGroup
    let bill:ReceiptBill
    @EnvironmentObject var store:ExpenseStore
    @EnvironmentObject var session:SessionStore
    var assign:(Purchase?)->Void

    private func claimants(_ item: Purchase) -> [Person] {
        item.memberIDs.compactMap { id in group.members.first { $0.id == id } }
    }
    private func label(_ person: Person) -> String {
        person.userID != nil && person.userID == session.userID ? "You" : person.name
    }
    private var payerName: String {
        guard let payer = group.members.first(where: { $0.id == entry.paidBy }) else { return "the payer" }
        return payer.userID != nil && payer.userID == session.userID ? "you" : payer.name
    }
    private var canClose: Bool {
        let payer = group.members.first { $0.id == entry.paidBy }
        return !bill.closed && (payer?.userID == session.userID || (payer?.userID == nil && (store.isDemo || entry.editable == true)))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(bill.closed ? "Purchases · closed" : "Purchases").font(.headline).foregroundStyle(Palette.ink)
                    Text(bill.closed ? "Claims are locked" : "Tap an item to change who had it")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                if canClose {
                    Button { assign(nil) } label: {
                        Label("Close", systemImage: "lock")
                            .font(.subheadline.weight(.semibold))
                    }
                    .buttonStyle(GhostButton())
                    .accessibilityLabel("Close receipt")
                }
            }
            ReceiptSummaryRail(bill: bill, currency: entry.currency, openLabel: "open")
            VStack(spacing: 0) {
                ForEach(Array(bill.items.enumerated()), id: \.element.id) { index, item in
                    Button { assign(item) } label: { row(item) }
                        .buttonStyle(.plain)
                        .disabled(bill.closed)
                        .accessibilityHint(bill.closed ? "" : "Opens the claim sheet")
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
                Text("Open items stay with \(payerName) until someone claims them. The open total includes each item’s share of tax and tip.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func row(_ item: Purchase) -> some View {
        let people = claimants(item)
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: people.isEmpty ? "circle.dashed" : "checkmark.circle.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(people.isEmpty ? Palette.amber : Palette.evergreen)
                .frame(width: 24)
                .padding(.top, 1)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Text(Money.text(item.amount, entry.currency))
                        .font(.splitAmount(14))
                        .foregroundStyle(Palette.ink)
                }
                if people.isEmpty {
                    Text(bill.closed ? "Unclaimed" : "Open · tap to claim")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Palette.amber)
                } else {
                    FlowLayout(spacing: 6) {
                        ForEach(people) { person in
                            PersonChip(name: person.name, label: label(person), compact: true)
                        }
                    }
                }
            }
            if !bill.closed {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.tertiary)
                    .padding(.top, 4)
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, 10)
        .frame(minHeight: 48)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.title), \(Money.text(item.amount, entry.currency))")
        .accessibilityValue(people.isEmpty ? "Open" : "Shared by " + people.map(label).joined(separator: ", "))
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
    @EnvironmentObject var session:SessionStore
    @Environment(\.dismiss) var dismiss
    @State private var selected=Set<String>()
    @State private var error:String?
    @State private var working=false

    private func label(_ person: Person) -> String {
        person.userID != nil && person.userID == session.userID ? "You" : person.name
    }
    private var payerName: String {
        guard let payer = group.members.first(where: { $0.id == entry.paidBy }) else { return "the payer" }
        return label(payer)
    }
    private var share: Int64? {
        guard let item, !selected.isEmpty, let bill = entry.bill,
              let index = bill.items.firstIndex(where: { $0.id == item.id }),
              let gross = try? bill.gross(), index < gross.count else { return nil }
        return gross[index] / Int64(selected.count)
    }

    var body:some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text(item == nil ? "Who covers the open items?" : "Who had this?")
                                .font(.headline).foregroundStyle(Palette.ink)
                            Spacer(minLength: 8)
                            Button(selected.count == group.members.count ? "Clear" : "Everyone") {
                                selected = selected.count == group.members.count ? [] : Set(group.members.map(\.id))
                            }
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Palette.evergreen)
                            .frame(minHeight: 44)
                        }
                        FlowLayout(spacing: 8, lineSpacing: 0) {
                            ForEach(group.members) { person in
                                PersonChip(name: person.name, label: label(person), selected: selected.contains(person.id)) {
                                    if selected.contains(person.id) { selected.remove(person.id) } else { selected.insert(person.id) }
                                }
                            }
                        }
                        Text(footnote)
                            .font(.caption)
                            .foregroundStyle(selected.isEmpty && item != nil ? Palette.amber : .secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(16)
                    .glassSurface(cornerRadius: 20, tint: Palette.card.opacity(0.55))
                    if let error { ErrorText(text:error) }
                }
                .padding(16)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .background(AppBackground())
            .navigationTitle(item == nil ? "Close receipt" : "Claim purchase").navigationBarTitleDisplayMode(.inline)
            .onAppear { selected=Set(item?.memberIDs ?? group.members.map(\.id)) }
            .toolbar {
                ToolbarItem(placement:.cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement:.confirmationAction) {
                    Button(item == nil ? "Close" : "Save") { Task {
                        working=true; defer { working=false }
                        do { try await store.claim(entry,item:item,people:group.members.filter{selected.contains($0.id)}.map(\.id)); dismiss() }
                        catch { self.error=error.localizedDescription }
                    } }
                    .disabled(working || (item==nil && selected.isEmpty))
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var footnote: String {
        if item == nil { return "The remaining open items are divided evenly among these people. Closing locks every claim." }
        if selected.isEmpty { return "Nobody selected. The item stays open and goes to \(payerName)." }
        if let share { return "About \(Money.text(share, entry.currency)) each, including tax and tip." }
        return "Choose everyone who shared this purchase."
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: item == nil ? "lock.fill" : "receipt")
                .font(.system(size: 18, weight: .semibold))
                .frame(width: 44, height: 44)
                .foregroundStyle(Palette.lime)
                .background(Palette.hero, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(item?.title ?? entry.title).font(.title3.weight(.semibold)).foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text(item.map { Money.text($0.amount, entry.currency) + " before tax and tip" }
                     ?? "\(entry.bill?.openCount ?? 0) open \((entry.bill?.openCount ?? 0) == 1 ? "item" : "items")")
                    .font(.subheadline).foregroundStyle(.secondary)
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
