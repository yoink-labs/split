import SwiftUI

struct GroupTransactionsView: View {
    let group: ExpenseGroup
    let entries: [LedgerEntry]
    let open: (LedgerEntry) -> Void
    let exportPDF: () -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .subheadline) private var amountWidth = 126.0

    var body: some View {
        if entries.isEmpty {
            ContentUnavailableView("No transactions yet", systemImage: "list.bullet.rectangle",
                                   description: Text("Recorded expenses and payments appear here."))
        } else {
            HStack {
                Text("\(entries.count) \(entries.count == 1 ? "transaction" : "transactions")")
                    .font(.headline)
                    .foregroundStyle(Palette.ink)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Button(action: exportPDF) {
                    Text("Export PDF")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Palette.evergreen)
                        .frame(minHeight: HitTarget.minimum)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            table
        }
    }

    private var table: some View {
        let names = Dictionary(group.members.map { ($0.id, $0.name) }, uniquingKeysWith: { name, _ in name })
        return LazyVStack(spacing: 0) {
            if !dynamicTypeSize.isAccessibilitySize {
                HStack(spacing: 10) {
                    Text("Transaction").frame(maxWidth: .infinity, alignment: .leading)
                    Text("Amount").frame(width: amountWidth, alignment: .trailing)
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .padding(.trailing, 17)
                .accessibilityHidden(true)
                RowDivider(inset: 14)
            }
            ForEach(entries) { entry in
                Button { open(entry) } label: {
                    row(entry, names: names)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .frame(minHeight: HitTarget.minimum)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityHint("Shows who paid and how the amount was split")
                if entry.id != entries.last?.id { RowDivider(inset: 14) }
            }
        }
        .background(Palette.card, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.line).allowsHitTesting(false))
    }

    private func row(_ entry: LedgerEntry, names: [String: String]) -> some View {
        let category = (entry.isSettlement ? "Payment" : entry.isRefund ? "Refund" : CategoryMeta.named(entry.category).name)
            + (entry.isPending ? " · Pending" : "")
        let date = Exchange.date(fromDay: entry.day)?.formatted(date: .abbreviated, time: .omitted) ?? entry.day
        let payers = entry.allPayers
        let payer = names[payers.first?.memberID ?? entry.paidBy] ?? "Former member"
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 5))
            : AnyLayout(HStackLayout(spacing: 10))
        return layout {
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
                Text("\(date) · \(category)")
                Text(entry.isRefund ? "Refund to \(payer)" : payers.count > 1 ? "\(payers.count) payers" : "\(payer) paid")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 7) {
                Text(Money.text(entry.signedAmount, entry.currency))
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                    .foregroundStyle(entry.isRefund ? Palette.positive : Palette.ink)
                    .multilineTextAlignment(.trailing)
                    .frame(width: dynamicTypeSize.isAccessibilitySize ? nil : amountWidth,
                           alignment: .trailing)
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .frame(width: 10)
                    .accessibilityHidden(true)
            }
        }
    }
}
