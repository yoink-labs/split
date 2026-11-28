import SwiftUI

/// A receipt-like expense detail with the payment breakdown, itemized purchases,
/// shares, notes, reactions and comments. Reads the live entry from the store so
/// edits, claims and likes appear immediately.
struct EntryDetails: View {
    @EnvironmentObject private var fx: FXStore
    private let initial: LedgerEntry
    private let showsBreakdownFirst: Bool
    var group: ExpenseGroup
    var embedded = false

    @EnvironmentObject private var store: ExpenseStore
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss

    private struct Assignment: Identifiable {
        let id = UUID()
        let item: Purchase?
    }

    @State private var path: [LedgerRoute] = []
    @State private var assignment: Assignment?
    @State private var gallery: ReceiptPresentation?
    @State private var editing = false
    @State private var disputeAction: DisputeAction?
    @State private var chargeHistory: [ChargedAmountChange] = []
    @State private var deleting = false
    @State private var working = false
    @State private var repeatWorking = false
    @State private var error: String?
    @State private var optimisticLike: Bool?
    @State private var liking = false
    @State private var likeError: String?
    @State private var refunding = false
    @State private var resolvingRefund = false
    @State private var markingPending = false
    @State private var adjusting = false
    @State private var restoring = false
    @State private var attaching = false
    @State private var moving: String?
    @State private var receiptWorking = false
    @State private var receiptError: String?

    init(entry: LedgerEntry, group: ExpenseGroup, embedded: Bool = false, showsBreakdownFirst: Bool = false) {
        self.initial = entry
        self.group = group
        self.embedded = embedded
        self.showsBreakdownFirst = showsBreakdownFirst
    }

    private var entry: LedgerEntry {
        store.state.snapshot.entries.first { $0.id == initial.id } ?? initial
    }
    private var liveGroup: ExpenseGroup { store.group(group.id) ?? group }
    private var me: Person? { Analytics.me(in: liveGroup, userID: session.userID) }
    private var editable: Bool { entry.combinedCount == nil && (entry.editable == true || store.isDemo) }
    /// Author or an active payer (the receiver, for a refund) can mark pending and resolve, as on the Worker.
    private var canResolve: Bool {
        guard entry.combinedCount == nil, entry.isSpending, me?.removed != true else { return false }
        return editable || entry.allPayers.contains { payer in
            liveGroup.members.contains { $0.id == payer.memberID && $0.userID == session.userID && $0.removed != true }
        }
    }
    private var refunds: [LedgerEntry] { entry.kind == "expense" ? Refunds.linked(to: entry, in: store.entries) : [] }
    private var refundOriginal: LedgerEntry? { entry.refundOf.flatMap { id in store.entries.first { $0.id == id } } }
    private var canRefund: Bool {
        entry.kind == "expense" && entry.combinedCount == nil && me != nil && me?.removed != true && Refunds.remaining(of: entry, refunds: refunds) > 0
    }
    private var canSetHandled: Bool {
        entry.kind == "expense" && entry.combinedCount == nil && !entry.isPending && entry.allPayers.contains { payer in
            liveGroup.members.contains { $0.id == payer.memberID && $0.userID == session.userID && $0.removed != true }
        }
    }
    private var dispute: OpenDispute? { store.state.snapshot.disputes?.first { $0.entryID == entry.id } }
    private var canDispute: Bool {
        guard !store.isDemo, dispute == nil, entry.kind == "expense", entry.combinedCount == nil,
              let me, me.removed != true else { return false }
        return entry.splits.contains { $0.memberID == me.id }
    }
    private var canEdit: Bool { entry.kind == "expense" && (dispute?.canResolve ?? editable) }
    private var repeatAllowed: Bool {
        guard editable, !store.isDemo else { return false }
        return entry.kind == "expense" && entry.bill == nil && entry.exchange == nil && entry.spread == nil
    }
    private var liked: Bool { optimisticLike ?? (entry.likedByMe == true) }
    private var likeCount: Int {
        let base = entry.likeCount ?? 0
        guard let optimisticLike else { return base }
        let actual = entry.likedByMe == true
        if optimisticLike == actual { return base }
        return max(0, base + (optimisticLike ? 1 : -1))
    }
    private var commentCount: Int {
        if let loaded = store.comments(for: entry.id) {
            return max(loaded.count, entry.commentCount ?? 0)
        }
        return entry.commentCount ?? 0
    }
    private var paidByText: String {
        if entry.isRefund {
            let receiver = displayName(entry.paidBy)
            return entry.refundOf == nil ? "Credit from \(receiver)" : "\(receiver) received the refund"
        }
        let names = entry.allPayers.map { displayName($0.memberID) }
        guard let first = names.first else { return "No payer recorded" }
        if names.count == 1 { return "\(first) paid" }
        if names.count == 2 { return "\(first) and \(names[1]) paid" }
        return "\(first) and \(names.count - 1) others paid"
    }
    private var splitSubtitle: String? {
        if entry.usesNights { return "Split by nights" }
        if entry.bill != nil { return "Receipt items · \(entry.splitMode.title)" }
        if entry.splitMode == .equal { return "Split equally" }
        return entry.splitMode.title
    }
    private var dateText: String {
        guard let date = ISO8601DateFormatter().date(from: entry.createdAt) else {
            return String(entry.createdAt.prefix(10))
        }
        return date.formatted(.dateTime.month(.wide).day().year())
    }

    var body: some View {
        Group {
            if embedded {
                content
            } else {
                NavigationStack(path: $path) {
                    content.ledgerDestinations()
                }
            }
        }
        .task(id: [entry.id, entry.exchange?.target ?? "", String(entry.exchange?.statementAmount ?? 0)]) {
            guard entry.kind == "expense" else { return }
            if let history = try? await store.chargedAmountHistory(for: entry.id), !Task.isCancelled {
                chargeHistory = history
            }
        }
    }

    private var content: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 16) {
                    hero
                    if let count = entry.combinedCount, me != nil, me?.removed != true {
                        Card {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Combined from \(count) expenses")
                                Button("Restore original expenses") { restoring = true }
                                    .buttonStyle(GhostButton())
                                    .disabled(working)
                            }
                        }
                    }
                    if entry.isPending { pendingCard }
                    if entry.isRefund { refundOfCard }
                    // Who owes what comes first; open items to claim sit right
                    // above it because they change it. Edge cases follow.
                    if let bill = entry.bill, bill.openCount > 0 { purchasesCard(bill) }
                    breakdown
                    if let bill = entry.bill, bill.openCount == 0 {
                        purchasesCard(bill)
                    } else if entry.bill == nil, let item = try? Consumption.items(entry).first {
                        Card {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Items").font(.headline)
                                HStack {
                                    Text(item.title)
                                    Spacer()
                                    Text(Money.text(item.gross, entry.currency)).monospacedDigit()
                                }
                            }
                        }
                    }
                    if let notes = entry.notes, !notes.isEmpty { notesCard(notes) }
                    if entry.kind == "expense" || entry.receiptIDs?.isEmpty == false { receiptCard(entry.receiptIDs ?? []) }
                    if entry.exchange != nil { settlementCard }
                    if entry.kind == "expense" && (!refunds.isEmpty || canRefund) { refundsCard }
                    if !chargeHistory.isEmpty { chargeHistoryCard }
                    reactionsCard
                    Card {
                        CommentsView(entryID: entry.id) {
                            withAnimation(.snappy) { proxy.scrollTo("comments", anchor: .bottom) }
                        }
                    }
                    .id("comments")
                    if editable || canSetHandled || canResolve || canDispute || dispute != nil { actionsCard }
                    if let error { InlineError(text: error) }
                }
                .padding(16)
                .frame(maxWidth: 680)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .confirmationDialog("Restore the original expenses?", isPresented: $restoring, titleVisibility: .visible) {
            Button("Restore original expenses") {
                working = true
                Task {
                    defer { working = false }
                    do {
                        try await store.uncombine(entry)
                        dismiss()
                    } catch { self.error = error.localizedDescription }
                }
            }
        }
        .background(AppBackground())
        .navigationTitle(entry.kind == "settlement" ? "Payment" : entry.isRefund ? (entry.refundOf == nil ? "Credit" : "Refund") : "Expense")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !embedded {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .refreshable { await store.sync() }
        .sheet(item: $assignment) { value in
            ClaimSheet(entry: entry, group: liveGroup, item: value.item)
        }
        .fullScreenCover(item: $gallery) { presentation in
            ReceiptViewer(presentation)
        }
        .sheet(isPresented: $attaching) {
            InboxPickerSheet(group: liveGroup, entry: entry)
        }
        .sheet(item: Binding(get: { moving.map(MovingReceipt.init) }, set: { moving = $0?.id })) { value in
            ExpensePickerSheet(group: liveGroup, entries: store.entries(in: liveGroup), title: "Move receipt",
                               message: "The photo moves to the expense you choose.", excluding: entry.id) { target in
                try await store.moveReceipt(value.id, from: entry, to: target)
            }
        }
        .sheet(isPresented: $editing) {
            AddExpenseView(group: liveGroup, original: entry, resolvingDispute: dispute?.canResolve == true)
        }
        .sheet(item: $disputeAction) { action in DisputeReplySheet(entryID: entry.id, action: action) }
        .sheet(isPresented: $refunding) { RefundComposer(group: liveGroup, original: entry) }
        .sheet(isPresented: $resolvingRefund) { RefundComposer(group: liveGroup, original: entry, resolving: true) }
        .sheet(isPresented: $markingPending) { PendingSheet(entry: entry) }
        .sheet(isPresented: $adjusting) { AdjustAmountSheet(entry: entry) }
        .confirmationDialog(
            "Delete this entry and update balances?",
            isPresented: $deleting,
            titleVisibility: .visible
        ) {
            Button("Delete entry", role: .destructive) {
                Task { await deleteEntry() }
            }
            Button("Keep entry", role: .cancel) {}
        } message: {
            Text("This removes \(entry.title) for everyone in \(liveGroup.name).")
        }
        .onChange(of: store.state.snapshot.entries) { _, entries in
            if !entries.contains(where: { $0.id == initial.id }) { dismiss() }
        }
    }

    // MARK: - Hero

    @ViewBuilder private var breakdown: some View {
        payerCard
        splitCard
    }

    private var hero: some View {
        Card(padding: 20) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top, spacing: 12) {
                    EntryBadge(title: entry.title, category: entry.category, size: 48)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(entry.kind == "settlement" ? "Payment" : entry.isRefund ? (entry.refundOf == nil ? "Credit" : "Refund") : (entry.category ?? "Expense"))
                            .font(.splitEyebrow)
                            .foregroundStyle(.secondary)
                        Text(entry.title)
                            .font(.splitDisplay(23, weight: .semibold))
                            .foregroundStyle(Palette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 8)
                }
                EntryAmount(entry: entry, size: 34)
                if entry.currency != fx.home {
                    Text("\(entry.exchange?.statementAmount == nil ? "Charged" : "Original amount") \(Money.text(entry.amount, entry.currency))")
                        .font(.caption).foregroundStyle(.secondary)
                }
                HStack(alignment: .center, spacing: 8) {
                    Label(dateText, systemImage: "calendar")
                    Spacer(minLength: 8)
                    countBadges
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                Rectangle().fill(Palette.line).frame(height: 1)
                HStack(spacing: 10) {
                    Avatar(name: personName(entry.paidBy), size: 32)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(paidByText)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Palette.ink)
                        if entry.allPayers.count > 1 {
                            Text("\(fx.entryText(entry, amount: entry.amount)) total")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 6)
                    netBadge
                }
            }
        }
    }

    private var countBadges: some View {
        HStack(spacing: 10) {
            if likeCount > 0 {
                Label("\(likeCount)", systemImage: liked ? "hand.thumbsup.fill" : "hand.thumbsup")
                    .foregroundStyle(liked ? Palette.evergreen : Palette.muted)
            }
            if commentCount > 0 {
                Label("\(commentCount)", systemImage: "bubble.left")
                    .foregroundStyle(Palette.muted)
            }
        }
    }

    @ViewBuilder
    private var netBadge: some View {
        if entry.isHandled {
            Label("Already handled", systemImage: "checkmark.circle")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Palette.positive)
        } else if entry.kind == "settlement" {
            Text("Recorded")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Palette.evergreen)
        } else if entry.isRefund, let me {
            let (net, netText) = fx.entryNet(entry, for: me.id)
            Text(net > 0 ? "You get back \(netText)"
                 : net < 0 ? "You owe \(netText) · \(entry.refundOf == nil ? "credit you’re giving" : "refund you received for others")" : "Not involved")
                .font(.caption.weight(.semibold))
                .foregroundStyle(net > 0 ? Palette.positive : net < 0 ? Palette.negative : Palette.muted)
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
        } else if let me {
            let (net, netText) = fx.entryNet(entry, for: me.id)
            Text(net > 0
                 ? "You lent \(netText)"
                 : net < 0
                 ? "You owe \(netText)"
                 : "Not involved")
                .font(.caption.weight(.semibold))
                .foregroundStyle(net > 0 ? Palette.positive : net < 0 ? Palette.negative : Palette.muted)
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Pending and refunds

    private var pendingCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    PendingBadge(note: nil)
                    Spacer()
                    Text("Counts toward balances").font(.caption).foregroundStyle(.secondary)
                }
                Text(dispute.map { "Disputed by \($0.actorName)" } ?? entry.pendingNote ?? "This cost may still change.")
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if let me {
                    let net = Ledger.net(entry.settling, for: me.id)
                    if net != 0 {
                        Text("Without it, your balance in this group changes by \(Money.text(-net, entry.settling.currency, signed: true)).")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                if canResolve && dispute == nil {
                    FlowLayout(spacing: 8) {
                        Button { Task { await confirmPending() } } label: { Label("Confirm", systemImage: "checkmark") }
                            .buttonStyle(GhostButton())
                            .disabled(working)
                            .accessibilityIdentifier("pending-confirm")
                        if entry.bill == nil && entry.kind == "expense" {
                            Button { adjusting = true } label: { Label("Adjust amount", systemImage: "plusminus") }
                                .buttonStyle(GhostButton())
                                .accessibilityIdentifier("pending-adjust")
                        }
                        if entry.kind == "expense" && canRefund {
                            Button { resolvingRefund = true } label: { Label("Turn into refund", systemImage: "arrow.uturn.backward") }
                                .buttonStyle(GhostButton())
                                .accessibilityIdentifier("pending-refund")
                        }
                    }
                }
            }
        }
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.amber.opacity(0.45)))
    }

    @ViewBuilder private var refundOfCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(title: entry.refundOf == nil ? "Standalone credit" : "Refund of")
                if let original = refundOriginal {
                    NavigationLink(value: LedgerRoute.entry(group: liveGroup.id, id: original.id)) {
                        HStack {
                            Text(original.title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
                            Spacer()
                            Text(Money.text(original.amount, original.currency)).font(.splitAmount(15))
                            Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(.tertiary)
                        }
                        .frame(minHeight: 40)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                } else {
                    Text(entry.refundOf == nil
                         ? "Gives money back without an original expense. The credited people’s balances go up."
                         : "The original expense is no longer available.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private var refundsCard: some View {
        let refunded = Refunds.refundedTotal(refunds)
        return Card {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "Refunds",
                              subtitle: "\(Money.text(refunded, entry.currency)) refunded · \(Money.text(Refunds.remaining(of: entry, refunds: refunds), entry.currency)) left",
                              actionTitle: canRefund && !entry.isPending ? "Add" : nil,
                              action: { refunding = true })
                ForEach(refunds) { refund in
                    NavigationLink(value: LedgerRoute.entry(group: liveGroup.id, id: refund.id)) {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(refund.title).font(.subheadline.weight(.medium)).foregroundStyle(Palette.ink)
                                Text(refund.splits.map { "\(displayName($0.memberID)) \(Money.text($0.amount, refund.currency))" }.joined(separator: ", "))
                                    .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                if refund.isPending { PendingBadge(note: refund.pendingNote) }
                            }
                            Spacer()
                            EntryAmount(entry: refund, size: 15)
                            Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(.tertiary)
                        }
                        .frame(minHeight: 40)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                if refunds.isEmpty {
                    Text("Nothing refunded yet.").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func confirmPending() async {
        guard !working else { return }
        working = true
        error = nil
        defer { working = false }
        do { try await store.resolve(entry, .confirm) }
        catch { self.error = error.localizedDescription }
    }

    // MARK: - Money and receipt

    private var chargeHistoryCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(title: "Charged amount history")
                ForEach(chargeHistory) { change in
                    let before = change.previousAmount.flatMap { amount in
                        change.previousCurrency.map { Money.text(amount, $0) }
                    } ?? "Exchange rate"
                    let after = change.chargedAmount.flatMap { amount in
                        change.chargedCurrency.map { Money.text(amount, $0) }
                    } ?? "Exchange rate"
                    Text("\(FXQuote.shortDay(String(change.changedAt.prefix(10)))) · \(before) → \(after)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var settlementCard: some View {
        let settled = entry.settling
        return Card {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "Settlement value", subtitle: entry.exchange?.target)
                HStack {
                    Text(entry.exchange?.statementAmount == nil ? settled.currency : "Actually charged (override)")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    AmountText(minor: settled.amount, currency: settled.currency, size: 22)
                }
                if entry.exchange?.statementAmount != nil {
                    LabeledContent("Original amount", value: Money.text(entry.amount, entry.currency))
                        .font(.subheadline)
                }
                if let exchange = entry.exchange {
                    Text(exchange.description(base: entry.currency))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text("Balances use \(settled.currency). This entry is saved in \(entry.currency).")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private struct MovingReceipt: Identifiable { let id: String }

    @ViewBuilder private func receiptCard(_ ids: [String]) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                if ids.isEmpty {
                    SectionHeader(title: "Receipts", subtitle: "No photos yet")
                } else {
                    ReceiptGallery(entry: entry.id, ids: ids) { presentation in
                        gallery = presentation
                    }
                }
                if entry.kind == "expense" && entry.combinedCount == nil {
                    FlowLayout(spacing: 8) {
                        if ids.count < receiptLimit {
                            Button { attaching = true } label: { Label("Attach from inbox", systemImage: "tray.and.arrow.up") }
                                .buttonStyle(GhostButton())
                                .accessibilityIdentifier("receipt-attach-inbox")
                        }
                        if !ids.isEmpty {
                            Menu {
                                ForEach(Array(ids.enumerated()), id: \.element) { index, id in
                                    if ids.count > 1 {
                                        Section("Photo \(index + 1)") { moveButtons(id) }
                                    } else {
                                        moveButtons(id)
                                    }
                                }
                            } label: {
                                Label("Move receipt", systemImage: "arrow.left.arrow.right")
                                    .font(.subheadline.weight(.semibold))
                                    .padding(.horizontal, 14)
                                    .frame(minHeight: 44)
                                    .background(Palette.raised)
                                    .clipShape(Capsule())
                                    .overlay(Capsule().stroke(Palette.line, lineWidth: 1))
                            }
                            .disabled(receiptWorking)
                            .accessibilityIdentifier("receipt-move")
                        }
                        if receiptWorking { ProgressView().frame(minHeight: 44) }
                    }
                }
                if let receiptError { InlineError(text: receiptError) }
            }
        }
        .tint(Palette.evergreen)
    }

    @ViewBuilder private func moveButtons(_ id: String) -> some View {
        Button { moving = id } label: { Label("To another expense…", systemImage: "arrow.right.doc.on.clipboard") }
        Button { Task { await moveToInbox(id) } } label: { Label("Back to inbox", systemImage: "tray.and.arrow.down") }
    }

    private func moveToInbox(_ id: String) async {
        guard !receiptWorking else { return }
        receiptWorking = true
        receiptError = nil
        defer { receiptWorking = false }
        do { try await store.moveReceipt(id, from: entry, to: nil) }
        catch { receiptError = error.localizedDescription }
    }

    private func purchasesCard(_ bill: ReceiptBill) -> some View {
        Card {
            PurchasesSection(entry: entry, group: liveGroup, bill: bill) { item in
                assignment = Assignment(item: item)
            }
        }
        .tint(Palette.evergreen)
    }

    private var payerCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(
                    title: entry.kind == "settlement" ? "Paid" : entry.isRefund ? (entry.refundOf == nil ? "Credit from" : "Received by") : "Paid by",
                    subtitle: entry.allPayers.count > 1 ? "Split across \(entry.allPayers.count) people" : nil
                )
                ForEach(entry.allPayers, id: \.memberID) { payer in
                    NavigationLink(value: LedgerRoute.member(group: liveGroup.id, seat: payer.memberID)) {
                        HStack(spacing: 10) {
                            Avatar(name: personName(payer.memberID), size: 34)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(displayName(payer.memberID))
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Palette.ink)
                                if entry.allPayers.count > 1 {
                                    Text("paid \(fx.portionText(entry, memberID: payer.memberID, paid: true))")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            Text(fx.portionText(entry, memberID: payer.memberID, paid: true)).font(.splitAmount(15))
                            Image(systemName: "chevron.right")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.tertiary)
                        }
                        .frame(minHeight: 40)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityElement(children: .combine)
                    .accessibilityHint("Opens this person's charges")
                }
            }
        }
    }

    private var splitCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(
                    title: entry.isSettlement ? "Paid to" : entry.isRefund ? "Credited to" : "Split with",
                    subtitle: entry.isSettlement || entry.isRefund ? nil : splitSubtitle
                )
                if let spread = entry.spread {
                    Text("First day \(spread.start) · End date \(spread.end) (excluded)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                ForEach(entry.splits, id: \.memberID) { portion in
                    NavigationLink(value: LedgerRoute.member(group: liveGroup.id, seat: portion.memberID)) {
                        HStack(spacing: 10) {
                            Avatar(name: personName(portion.memberID), size: 32)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(displayName(portion.memberID))
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(Palette.ink)
                                if let stay = portion.stay {
                                    Text("\(stay.start) to \(stay.end)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                if let nights = portion.nights {
                                    Text("\(nights) × \(Money.text(entry.nightRate, entry.currency))/night")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                if entry.kind == "expense",
                                   let payer = entry.allPayers.first(where: { $0.memberID == portion.memberID }) {
                                    Text("paid \(fx.portionText(entry, memberID: payer.memberID, paid: true))")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            Text(fx.portionText(entry, memberID: portion.memberID)).font(.splitAmount(15))
                            Image(systemName: "chevron.right")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.tertiary)
                        }
                        .frame(minHeight: 40)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityElement(children: .combine)
                    .accessibilityHint("Opens this person's charges")
                }
                if entry.splits.isEmpty {
                    Text("No shares recorded for this entry.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                if let bill = entry.bill, bill.openCount > 0 {
                    Text("\(bill.openCount) open \(bill.openCount == 1 ? "purchase" : "purchases") · \(fx.entryText(entry, amount: bill.openTotal)) still with the payer.")
                        .font(.caption)
                        .foregroundStyle(Palette.amber)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func notesCard(_ notes: String) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(title: "Notes")
                Text(notes)
                    .font(.body)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - Reactions

    private var reactionsCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 12) {
                    Button { toggleLike() } label: {
                        HStack(spacing: 6) {
                            Image(systemName: liked ? "hand.thumbsup.fill" : "hand.thumbsup")
                            Text(liked ? "Liked" : "Like")
                        }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(liked ? Palette.evergreen : Palette.ink)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 44)
                        .background(liked ? Palette.evergreen.opacity(0.12) : Palette.raised)
                        .clipShape(Capsule())
                        .overlay(Capsule().stroke(liked ? Palette.evergreen.opacity(0.28) : Palette.line, lineWidth: 1))
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .opacity(liking ? 0.65 : 1)
                    .accessibilityIdentifier("entry-like")
                    .accessibilityLabel(liked ? "Remove your like" : "Like this expense")
                    .accessibilityValue("\(likeCount) \(likeCount == 1 ? "like" : "likes")")

                    if likeCount > 0 {
                        Text("\(likeCount) \(likeCount == 1 ? "like" : "likes")")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    Label("\(commentCount)", systemImage: "bubble.left")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("\(commentCount) \(commentCount == 1 ? "comment" : "comments")")
                }
                if let likeError { InlineError(text: likeError) }
            }
        }
    }

    // MARK: - Actions

    private var actionsCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "This entry")
                FlowLayout(spacing: 8) {
                if canDispute {
                    Button("Dispute", systemImage: "flag") { disputeAction = .open }.buttonStyle(GhostButton())
                }
                if dispute?.canResolve == true {
                    Button("Dismiss dispute", systemImage: "checkmark") { disputeAction = .dismiss }.buttonStyle(GhostButton())
                }
                if dispute?.canWithdraw == true {
                    Button("Withdraw dispute", systemImage: "arrow.uturn.backward") { disputeAction = .withdraw }.buttonStyle(GhostButton())
                }
                if canEdit {
                    Button { editing = true } label: {
                        Label(dispute == nil ? "Edit expense" : "Edit and resolve", systemImage: "pencil")
                    }
                    .buttonStyle(GhostButton())
                    .accessibilityIdentifier("entry-edit")
                    .accessibilityLabel("Edit this expense")
                }
                if canResolve && !entry.isPending && !entry.isHandled {
                    Button { markingPending = true } label: {
                        Label("Mark as pending", systemImage: "clock")
                    }
                    .buttonStyle(GhostButton())
                    .accessibilityIdentifier("entry-mark-pending")
                }
                if canRefund && !entry.isPending {
                    Button { refunding = true } label: {
                        Label("Record refund", systemImage: "arrow.uturn.backward")
                    }
                    .buttonStyle(GhostButton())
                    .accessibilityIdentifier("entry-refund")
                }
                if canSetHandled {
                    Button {
                        Task { await toggleHandled() }
                    } label: {
                        Label(entry.isHandled ? "Include in balances" : "Mark as handled", systemImage: "checkmark.circle")
                    }
                    .buttonStyle(GhostButton())
                    .disabled(working)
                }
                if repeatAllowed {
                    if repeatWorking {
                        ProgressView().frame(minHeight: 44, alignment: .leading)
                    } else {
                        Menu {
                            ForEach(["off", "daily", "weekly", "monthly", "yearly"], id: \.self) { cadence in
                                Button {
                                    Task { await setRepeat(cadence) }
                                } label: {
                                    if (entry.recurrence ?? "off") == cadence {
                                        Label(cadence.capitalized, systemImage: "checkmark")
                                    } else {
                                        Text(cadence.capitalized)
                                    }
                                }
                            }
                        } label: {
                            HStack(spacing: 6) {
                                Label("Repeat", systemImage: "repeat")
                                Text((entry.recurrence ?? "off").capitalized).foregroundStyle(.secondary)
                                Image(systemName: "chevron.up.chevron.down")
                                    .font(.caption2.weight(.bold))
                            }
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Palette.ink)
                            .padding(.horizontal, 12)
                            .frame(minHeight: 44)
                            .background(Palette.raised)
                            .clipShape(Capsule())
                            .overlay(Capsule().stroke(Palette.line, lineWidth: 1))
                            .contentShape(Capsule())
                        }
                        .accessibilityLabel("Repeat schedule, \(entry.recurrence ?? "off")")
                    }
                }
                if editable && dispute == nil {
                    Button { deleting = true } label: {
                        Label("Delete entry", systemImage: "trash")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Palette.negative)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 44)
                            .background(Palette.negative.opacity(0.10))
                            .clipShape(Capsule())
                            .overlay(Capsule().stroke(Palette.negative.opacity(0.25), lineWidth: 1))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(working)
                    .accessibilityIdentifier("entry-delete")
                    .accessibilityLabel("Delete this entry")
                }
                }
            }
        }
    }

    // MARK: - Actions

    private func toggleLike() {
        guard !liking else { return }
        let next = !liked
        optimisticLike = next
        likeError = nil
        liking = true
        Task {
            defer { liking = false }
            do {
                try await store.toggleLike(entry)
                optimisticLike = nil
            } catch {
                optimisticLike = nil
                likeError = error.localizedDescription
            }
        }
    }

    private func setRepeat(_ cadence: String) async {
        guard !repeatWorking else { return }
        repeatWorking = true
        error = nil
        defer { repeatWorking = false }
        do {
            _ = try await store.groupAction(liveGroup.id, "repeat", ["entryID": entry.id, "cadence": cadence])
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func toggleHandled() async {
        guard !working else { return }
        working = true
        error = nil
        defer { working = false }
        do { try await store.setHandled(entry, handled: !entry.isHandled) }
        catch { self.error = error.localizedDescription }
    }

    private func deleteEntry() async {
        guard !working else { return }
        working = true
        error = nil
        defer { working = false }
        do {
            guard refunds.isEmpty else { throw LedgerError.invalid("Delete this expense’s refunds first.") }
            try await store.change(entry, to: nil)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: - Names

    private func personName(_ id: String) -> String {
        liveGroup.members.first { $0.id == id }?.name ?? "Someone"
    }

    private func displayName(_ id: String) -> String {
        guard let person = liveGroup.members.first(where: { $0.id == id }) else { return "Someone" }
        return person.userID == session.userID ? "You" : person.name
    }
}
