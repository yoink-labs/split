import SwiftUI

/// A receipt-like expense detail with the payment breakdown, itemized purchases,
/// shares, notes, reactions and comments. Reads the live entry from the store so
/// edits, claims and likes appear immediately.
struct EntryDetails: View {
    private let initial: LedgerEntry
    var group: ExpenseGroup
    var embedded = false

    @EnvironmentObject private var store: ExpenseStore
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss

    private struct Assignment: Identifiable {
        let id = UUID()
        let item: Purchase?
    }

    @State private var assignment: Assignment?
    @State private var gallery: ReceiptPresentation?
    @State private var editing = false
    @State private var deleting = false
    @State private var working = false
    @State private var repeatWorking = false
    @State private var error: String?
    @State private var optimisticLike: Bool?
    @State private var liking = false
    @State private var likeError: String?

    init(entry: LedgerEntry, group: ExpenseGroup, embedded: Bool = false) {
        self.initial = entry
        self.group = group
        self.embedded = embedded
    }

    private var entry: LedgerEntry {
        store.state.snapshot.entries.first { $0.id == initial.id } ?? initial
    }
    private var liveGroup: ExpenseGroup { store.group(group.id) ?? group }
    private var me: Person? { Analytics.me(in: liveGroup, userID: session.userID) }
    private var editable: Bool { entry.editable == true || store.isDemo }
    private var canEdit: Bool { editable && entry.kind == "expense" && entry.bill?.closed != true }
    private var repeatAllowed: Bool {
        guard editable, !store.isDemo else { return false }
        return entry.kind == "expense" && entry.bill == nil && entry.exchange == nil
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
        let names = entry.allPayers.map { displayName($0.memberID) }
        guard let first = names.first else { return "No payer recorded" }
        if names.count == 1 { return "\(first) paid" }
        if names.count == 2 { return "\(first) and \(names[1]) paid" }
        return "\(first) and \(names.count - 1) others paid"
    }
    private var splitSubtitle: String? {
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
                NavigationStack {
                    content.ledgerDestinations()
                }
            }
        }
    }

    private var content: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 16) {
                    hero
                    if entry.exchange != nil { settlementCard }
                    if let ids = entry.receiptIDs, !ids.isEmpty { receiptCard(ids) }
                    if let bill = entry.bill { purchasesCard(bill) }
                    payerCard
                    splitCard
                    if let notes = entry.notes, !notes.isEmpty { notesCard(notes) }
                    reactionsCard
                    Card {
                        CommentsView(entryID: entry.id) {
                            withAnimation(.snappy) { proxy.scrollTo("comments", anchor: .bottom) }
                        }
                    }
                    .id("comments")
                    if editable { actionsCard }
                    if let error { InlineError(text: error) }
                }
                .padding(16)
                .frame(maxWidth: 680)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background(AppBackground())
        .navigationTitle(entry.kind == "settlement" ? "Payment" : "Expense")
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
        .sheet(isPresented: $editing) {
            AddExpenseView(group: liveGroup, original: entry)
        }
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

    private var hero: some View {
        Card(padding: 20) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top, spacing: 12) {
                    CategoryBadge(category: entry.category, size: 48)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(entry.kind == "settlement" ? "Payment" : (entry.category ?? "Expense"))
                            .font(.splitEyebrow)
                            .foregroundStyle(.secondary)
                        Text(entry.title)
                            .font(.splitDisplay(23, weight: .semibold))
                            .foregroundStyle(Palette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 8)
                }
                AmountText(minor: entry.amount, currency: entry.currency, size: 34)
                    .accessibilityLabel("Amount \(Money.text(entry.amount, entry.currency))")
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
                            Text("\(Money.text(entry.amount, entry.currency)) total")
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
        if entry.kind == "settlement" {
            Text("Recorded")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Palette.evergreen)
        } else if let me {
            let net = Ledger.net(entry, for: me.id)
            Text(net > 0
                 ? "You lent \(Money.text(net, entry.currency))"
                 : net < 0
                 ? "You owe \(Money.text(abs(net), entry.currency))"
                 : "Not involved")
                .font(.caption.weight(.semibold))
                .foregroundStyle(net > 0 ? Palette.positive : net < 0 ? Palette.negative : Palette.muted)
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Money and receipt

    private var settlementCard: some View {
        let settled = entry.settling
        return Card {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "Settlement value", subtitle: entry.exchange?.target)
                HStack {
                    Text(settled.currency)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    AmountText(minor: settled.amount, currency: settled.currency, size: 22)
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

    private func receiptCard(_ ids: [String]) -> some View {
        Card {
            ReceiptGallery(entry: entry.id, ids: ids) { presentation in
                gallery = presentation
            }
        }
        .tint(Palette.evergreen)
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
                    title: entry.kind == "settlement" ? "Paid" : "Paid by",
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
                                    Text("paid \(Money.text(payer.amount, entry.currency))")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            AmountText(minor: payer.amount, currency: entry.currency, size: 15)
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
                    title: entry.isSettlement ? "Paid to" : "Split",
                    subtitle: entry.isSettlement ? nil : splitSubtitle
                )
                ForEach(entry.splits, id: \.memberID) { portion in
                    NavigationLink(value: LedgerRoute.member(group: liveGroup.id, seat: portion.memberID)) {
                        HStack(spacing: 10) {
                            Avatar(name: personName(portion.memberID), size: 32)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(displayName(portion.memberID))
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(Palette.ink)
                                if entry.kind == "expense",
                                   let payer = entry.allPayers.first(where: { $0.memberID == portion.memberID }) {
                                    Text("paid \(Money.text(payer.amount, entry.currency))")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            AmountText(minor: portion.amount, currency: entry.currency, size: 15)
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
                    Text("\(bill.openCount) open \(bill.openCount == 1 ? "purchase" : "purchases") · \(Money.text(bill.openTotal, entry.currency)) still with the payer.")
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
                SectionHeader(title: "This entry", subtitle: "Only the person who recorded it can change it.")
                FlowLayout(spacing: 8) {
                if canEdit {
                    Button { editing = true } label: {
                        Label("Edit expense", systemImage: "pencil")
                    }
                    .buttonStyle(GhostButton())
                    .accessibilityIdentifier("entry-edit")
                    .accessibilityLabel("Edit this expense")
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

    private func deleteEntry() async {
        guard !working else { return }
        working = true
        error = nil
        defer { working = false }
        do {
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
