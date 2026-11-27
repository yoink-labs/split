import SwiftUI

struct PurchasesSection:View {
    @EnvironmentObject private var fx: FXStore
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
            ReceiptSummaryRail(bill: bill, currency: entry.currency, openLabel: "open", entry: entry)
            if !bill.closed && bill.openCount > 0 && !store.isDemo {
                ShareLink(item: reminder) {
                    Label("Share claim reminder", systemImage: "square.and.arrow.up")
                        .font(.subheadline.weight(.semibold))
                }
                .buttonStyle(GhostButton())
            }
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
            if bill.tax > 0 { totalRow("Tax", value: fx.entryText(entry, amount: bill.tax)) }
            if bill.tip > 0 { totalRow("Tip", value: fx.entryText(entry, amount: bill.tip)) }
            if bill.openCount > 0 {
                totalRow("Open total", value: fx.entryText(entry, amount: bill.openTotal), strong: true)
                Text("Open items stay with \(payerName) until someone claims them. The open total includes each item’s share of tax and tip.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var reminder: String {
        var link = URLComponents(string: "https://split.yoinklabs.dev")!
        link.path = "/g/\(group.id)"
        link.queryItems = [URLQueryItem(name: "tab", value: "receipts"), URLQueryItem(name: "receipt", value: entry.id)]
        let titles = bill.items.filter { $0.memberIDs.isEmpty }.map { "• " + $0.title }
        return (["Please claim your purchases on \(entry.title) in \(group.name).",
                 "\(Money.text(bill.openTotal, entry.currency)) unclaimed, including tax and tip."] + titles
                + [link.url?.absoluteString ?? ""]).joined(separator: "\n")
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
                    Text(fx.entryText(entry, amount: item.amount))
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
        .accessibilityLabel("\(item.title), \(fx.entryText(entry, amount: item.amount))")
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
    @EnvironmentObject private var fx: FXStore
    let entry:LedgerEntry; let group:ExpenseGroup; let item:Purchase?
    @EnvironmentObject var store:ExpenseStore
    @EnvironmentObject var session:SessionStore
    @Environment(\.dismiss) var dismiss
    @State private var selected = Set<String>()
    @State private var editedWeights: [String: Int64] = [:]
    private let shareSteps: [Int64] = [50, 100, 150, 200, 250, 300, 400]
    @State private var error:String?
    @State private var working=false

    private func label(_ person: Person) -> String {
        person.userID != nil && person.userID == session.userID ? "You" : person.name
    }
    private var payerName: String {
        guard let payer = group.members.first(where: { $0.id == entry.paidBy }) else { return "the payer" }
        return label(payer)
    }
    private var eligiblePeople: [Person] {
        group.members.filter { $0.removed != true || item?.memberIDs.contains($0.id) == true }
    }

    private var selectedIDs: [String] {
        let original = item?.memberIDs ?? []
        return original.filter { selected.contains($0) }
            + eligiblePeople.map(\.id).filter { selected.contains($0) && !original.contains($0) }
    }

    private var amounts: [String: Int64] {
        guard var item, let bill = entry.bill,
              let index = bill.items.firstIndex(where: { $0.id == item.id }),
              let gross = try? bill.gross() else { return [:] }
        if selectedIDs != item.memberIDs || !editedWeights.isEmpty {
            item.roundingSeats = nil
            item.roundingWeights = nil
        }
        item.memberIDs = selectedIDs
        var weights = item.shares ?? [:]
        weights.merge(editedWeights) { _, new in new }
        item.shares = weights
        let portions = (try? item.portions(gross: gross[index], payer: entry.paidBy)) ?? []
        return Dictionary(portions.map { ($0.memberID, $0.amount) }, uniquingKeysWith: +)
    }

    private func nextWeight(_ value: Int64, direction: Int) -> Int64 {
        if let index = shareSteps.firstIndex(of: value) {
            return shareSteps[min(max(index + direction, 0), shareSteps.count - 1)]
        }
        return min(max(value + Int64(direction) * 50, 1), 100_000)
    }

    private func shareRow(_ person: Person, amount: Int64?) -> some View {
        let weight = editedWeights[person.id] ?? item?.shares?[person.id] ?? 100
        return HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label(person)).font(.subheadline.weight(.semibold))
                if let amount {
                    Text(fx.entryText(entry, amount: amount)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 2)
            if item?.roundingSeats == nil {
                Button {
                    editedWeights[person.id] = nextWeight(weight, direction: -1)
                } label: {
                    Image(systemName: "minus").frame(minWidth: HitTarget.minimum, minHeight: HitTarget.minimum)
                }
                .disabled(nextWeight(weight, direction: -1) == weight)
                .accessibilityLabel("Decrease share for \(label(person))")
                Text((Decimal(weight) / 100).formatted(.number.precision(.fractionLength(0...2))) + "×")
                    .font(.caption.monospacedDigit())
                    .accessibilityLabel("Share multiplier")
                Button {
                    editedWeights[person.id] = nextWeight(weight, direction: 1)
                } label: {
                    Image(systemName: "plus").frame(minWidth: HitTarget.minimum, minHeight: HitTarget.minimum)
                }
                .disabled(nextWeight(weight, direction: 1) == weight)
                .accessibilityLabel("Increase share for \(label(person))")
            }
        }
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
                            let everyone = Set(eligiblePeople.map(\.id))
                            Button(selected == everyone ? "Clear" : "Everyone") {
                                selected = selected == everyone ? [] : everyone
                            }
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Palette.evergreen)
                            .frame(minHeight: 44)
                        }
                        FlowLayout(spacing: 8, lineSpacing: 6) {
                            ForEach(eligiblePeople) { person in
                                PersonChip(name: person.name, label: label(person), selected: selected.contains(person.id)) {
                                    if selected.contains(person.id) { selected.remove(person.id) } else { selected.insert(person.id) }
                                }
                            }
                        }
                        if item != nil && !selected.isEmpty {
                            let amounts = amounts
                            ForEach(eligiblePeople.filter { selected.contains($0.id) }) { person in
                                shareRow(person, amount: amounts[person.id])
                            }
                            .buttonStyle(.borderless)
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
            .onAppear { selected = Set(item?.memberIDs ?? eligiblePeople.map(\.id)) }
            .toolbar {
                ToolbarItem(placement:.cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement:.confirmationAction) {
                    Button(item == nil ? "Close" : "Save") { Task {
                        working=true; defer { working=false }
                        do {
                            let weights = editedWeights.filter { selected.contains($0.key) }
                            let people = item == nil && entry.openPurchaseCount == 0 ? [] : selectedIDs
                            try await store.claim(entry, item: item, people: people, shares: weights)
                            dismiss()
                        }
                        catch { self.error=error.localizedDescription }
                    } }
                    .disabled(working || (item == nil && entry.openPurchaseCount > 0 && selected.isEmpty))
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var footnote: String {
        if item == nil {
            return entry.openPurchaseCount > 0
                ? "The remaining open items are divided evenly among these people. Closing locks every claim."
                : "All items are claimed. Closing locks every claim."
        }
        if selected.isEmpty { return "Nobody selected. The item stays open and goes to \(payerName)." }
        return "Shares include tax and tip."
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
                Text(item.map { fx.entryText(entry, amount: $0.amount) + " before tax and tip" }
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
struct ReceiptViewer: View {
    let photos: ReceiptPresentation
    @Environment(\.dismiss) private var dismiss
    @State private var page: Int
    @State private var zoom = 1
    private let maxZoom = 4

    init(_ photos: ReceiptPresentation) {
        self.photos = photos
        _page = State(initialValue: photos.index)
    }

    var body: some View {
        NavigationStack {
            TabView(selection: $page) {
                ForEach(photos.images.indices, id: \.self) { index in
                    photoPage(photos.images[index], index: index)
                        .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .background(.black)
            .navigationTitle("Receipt photo")
            .navigationBarTitleDisplayMode(.inline)
            .onChange(of: page) { zoom = 1 }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 16) { pageControls; zoomControls }
                    VStack(spacing: 4) { pageControls; zoomControls }
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 12)
                .background(.bar)
            }
        }
    }

    @ViewBuilder private func photoPage(_ image: UIImage, index: Int) -> some View {
        if zoom == 1 || page != index {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .accessibilityLabel("Receipt page \(index + 1)")
        } else {
            GeometryReader { proxy in
                let fit = min(proxy.size.width / image.size.width, proxy.size.height / image.size.height)
                ScrollView([.horizontal, .vertical]) {
                    Image(uiImage: image)
                        .resizable()
                        .frame(width: image.size.width * fit * CGFloat(zoom),
                               height: image.size.height * fit * CGFloat(zoom))
                        .frame(minWidth: proxy.size.width, minHeight: proxy.size.height)
                        .accessibilityLabel("Receipt page \(index + 1)")
                }
                .defaultScrollAnchor(.center)
            }
        }
    }

    @ViewBuilder private var pageControls: some View {
        if photos.images.count > 1 {
            HStack(spacing: 4) {
                photoControl("Previous page", symbol: "chevron.left", disabled: page == 0) { page -= 1 }
                Text("\(page + 1) of \(photos.images.count)").font(.caption.monospacedDigit())
                photoControl("Next page", symbol: "chevron.right", disabled: page == photos.images.count - 1) { page += 1 }
            }
        }
    }

    private var zoomControls: some View {
        HStack(spacing: 4) {
            photoControl("Zoom out", symbol: "minus.magnifyingglass", disabled: zoom == 1) { zoom -= 1 }
            Button("\(zoom * 100)%") { zoom = 1 }
                .font(.caption.monospacedDigit())
                .frame(minHeight: HitTarget.minimum)
                .accessibilityLabel("Reset zoom")
                .accessibilityValue("\(zoom * 100) percent")
            photoControl("Zoom in", symbol: "plus.magnifyingglass", disabled: zoom == maxZoom) { zoom += 1 }
        }
    }

    private func photoControl(_ title: String, symbol: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).frame(minWidth: HitTarget.minimum, minHeight: HitTarget.minimum)
        }
        .disabled(disabled)
        .accessibilityLabel(title)
    }
}
