import SwiftUI

struct DashboardTransactionRow: View {
    var row: DashboardTransaction

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.s) {
            EntryBadge(title: row.entry.title, category: row.entry.category, size: 34)
                .accessibilityHidden(true)
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
                    title.fixedSize(horizontal: true, vertical: false)
                    Spacer(minLength: 4)
                    amounts.fixedSize(horizontal: true, vertical: false)
                }
                VStack(alignment: .leading, spacing: 4) {
                    title
                    amounts
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: HitTarget.minimum, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var title: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(row.entry.title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
            Text("\(row.group.name) · \(LedgerDate.short(row.entry.createdAt))").font(.caption).foregroundStyle(.secondary)
        }
    }

    private var amounts: some View {
        VStack(alignment: .leading, spacing: 2) {
            if row.paid > 0 {
                let label = row.entry.isRefund ? "Received" : row.entry.isSettlement ? "Sent" : "Paid"
                Text("\(label) \(Money.text(row.paid, row.entry.currency))")
            }
            if row.share > 0 {
                let label = row.entry.isSettlement ? "Received" : "Your share"
                Text("\(label) \(Money.text(row.entry.sign * row.share, row.entry.currency))")
            }
        }
        .font(.caption.monospacedDigit())
        .foregroundStyle(Palette.ink)
    }
}
