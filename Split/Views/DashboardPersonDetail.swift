import SwiftUI

struct DashboardPersonDetail: View {
    var name: String
    var personID: String
    @EnvironmentObject private var store: ExpenseStore
    @State private var settling: DashboardTransfer?

    var body: some View {
        let lines = store.dashboard.transfers[personID, default: []]
        List(lines) { line in
            VStack(alignment: .leading, spacing: Spacing.xs) {
                NavigationLink {
                    GroupDetail(groupID: line.group.id)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(line.group.name).font(.headline)
                        Text(line.amount < 0 ? "You owe \(name)" : "\(name) owes you")
                            .font(.subheadline)
                        Text(Money.text(abs(line.amount), line.transfer.currency))
                            .font(.subheadline.weight(.semibold).monospacedDigit())
                    }
                }
                if line.amount < 0 && line.person.removed != true {
                    Button("Settle up") { settling = line }
                        .buttonStyle(.splitSecondary)
                }
            }
        }
        .overlay {
            if lines.isEmpty { ContentUnavailableView("Settled up", systemImage: "checkmark.seal") }
        }
        .navigationTitle(name)
        .sheet(item: $settling) { line in
            SettleUpView(group: line.group, transfer: line.transfer)
        }
    }
}
