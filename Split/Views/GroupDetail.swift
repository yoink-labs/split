import SwiftUI
struct GroupDetail: View {
    var groupID: String
    @EnvironmentObject var store: ExpenseStore
    @EnvironmentObject var session: SessionStore
    @State private var adding = false
    @State private var inviting = false
    @State private var inspecting: LedgerEntry?
    @State private var section = 0
    @State private var settlement: Transfer?
    var body: some View {
        Group {
            if let group = store.group(groupID) {
                ScrollView {
                    VStack(alignment:.leading,spacing:24) {
                        VStack(alignment:.leading,spacing:14) {
                            HStack { Image(systemName:group.symbol).foregroundStyle(Palette.ink).padding(12).background(Palette.lime,in:RoundedRectangle(cornerRadius:14)); Spacer()
                                Button { inviting=true } label: { Label("People",systemImage:"person.2") }.buttonStyle(.bordered).controlSize(.large)
                            }
                            Text(group.name).font(.largeTitle.weight(.bold)).accessibilityAddTraits(.isHeader)
                            Text("\(group.members.count) \(group.members.count == 1 ? "person" : "people") · \(group.currency)").font(.subheadline).foregroundStyle(.secondary)
                        }
                        if store.isDemo { Label("Sample group",systemImage:"sparkles").font(.caption).foregroundStyle(.secondary) }
                        if store.pending > 0 { Label("\(store.pending) pending · saved on this device",systemImage:"arrow.triangle.2.circlepath").font(.caption).foregroundStyle(.secondary) }
                        if let error=store.error { ErrorText(text:error) }
                        Picker("View",selection:$section) { Text("Expenses").tag(0); Text("Balances").tag(1) }.pickerStyle(.segmented)
                        if section == 0 {
                            if store.entries(in:group).isEmpty { ContentUnavailableView("No expenses yet",systemImage:"receipt",description:Text("Add your first shared expense.")) }
                            ForEach(store.entries(in:group)) { e in
                                Button { inspecting=e } label: { Card { EntryRow(entry:e,group:group) } }.buttonStyle(.plain)
                            }
                        } else { balances(group) }
                    }.padding(24).frame(maxWidth:680)
                }.frame(maxWidth:.infinity).background(Palette.background).safeAreaInset(edge:.bottom) { Button { adding=true } label: { Label("Add an expense",systemImage:"plus") }.buttonStyle(SolidButton()).padding(.horizontal,24).padding(.vertical,12).background(.ultraThinMaterial) }
                .sheet(isPresented:$adding) { AddExpenseView(group:group) }
                .sheet(isPresented:$inviting) { InviteView(group:group) }
                .sheet(item:$inspecting) { entry in EntryDetails(entry:entry,group:group) }
                .sheet(item:$settlement) { transfer in SettlementView(group:group,transfer:transfer) }
                .refreshable { await store.sync() }
            } else { ContentUnavailableView("Group unavailable",systemImage:"person.2.slash") }
        }.navigationTitle(Text(verbatim:"")).navigationBarTitleDisplayMode(.inline)
    }
    @ViewBuilder private func balances(_ group: ExpenseGroup) -> some View {
        let entries = store.entries(in:group)
        let currencies = Set(entries.map(\.currency)).sorted()
        if currencies.isEmpty { ContentUnavailableView("All clear",systemImage:"checkmark.circle",description:Text("Balances appear after your first expense.")) }
        ForEach(currencies,id:\.self) { currency in
            let balances = Ledger.balances(entries,currency:currency)
            let transfers = Ledger.simplify(entries,currency:currency)
            Card {
                VStack(alignment:.leading,spacing:18) {
                    Text(currency).font(.headline).tracking(1)
                    ForEach(group.members) { member in
                        let value = balances[member.id] ?? 0
                        HStack { Avatar(name:member.name,size:32); Text(member.userID == session.userID ? "You" : member.name).font(.subheadline); Spacer(); VStack(alignment:.trailing,spacing:3) { Text(Money.text(abs(value),currency)).font(.subheadline.weight(.semibold)).foregroundStyle(value >= 0 ? Palette.green : .primary); Text(value == 0 ? "all square" : value > 0 ? "gets back" : "owes").font(.caption2).foregroundStyle(.secondary) } }
                    }
                    Divider()
                    Text(transfers.isEmpty ? "Everyone’s square." : "Suggested payments").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    ForEach(transfers) { transfer in
                        Button { settlement=transfer } label: { HStack { VStack(alignment:.leading,spacing:4) { Text("\(name(transfer.from,group)) → \(name(transfer.to,group))").font(.subheadline.weight(.medium)); Text(Money.text(transfer.amount,currency)).font(.caption).foregroundStyle(.secondary) }; Spacer(); Text("Settle up").font(.caption.weight(.semibold)) } }.accessibilityLabel("Settle \(name(transfer.from,group)) to \(name(transfer.to,group)) \(Money.text(transfer.amount,currency))")
                    }
                }
            }
        }
        Text("Balances are simplified within this group, separately for each currency. Recording a payment doesn’t move money.").font(.caption).foregroundStyle(.secondary)
    }
    private func name(_ id:String,_ g:ExpenseGroup)->String { g.members.first { $0.id == id }?.name ?? "Someone" }
}
struct SettlementView: View {
    var group: ExpenseGroup; var transfer: Transfer
    @EnvironmentObject var store: ExpenseStore
    @Environment(\.dismiss) var dismiss
    @State private var amount = ""
    @State private var error: String?
    var body: some View { NavigationStack { Form {
        Section { Text("\(group.members.first{$0.id==transfer.from}?.name ?? "Someone") pays \(group.members.first{$0.id==transfer.to}?.name ?? "Someone")").font(.title3.weight(.semibold)); Text("Record a payment you’ve already made. Split won’t transfer money.").foregroundStyle(.secondary) }
        Section(transfer.currency) { TextField("Amount",text:$amount).keyboardType(.decimalPad); Text("Suggested: \(Money.text(transfer.amount,transfer.currency))").font(.caption).foregroundStyle(.secondary) }
        if let error { ErrorText(text:error) }
        Section { Button("Record payment") {
            guard let value=Money.parse(amount),value>0,value<=transfer.amount else { error="Enter an amount up to the outstanding balance.";return }
            do { try store.add(LedgerEntry(groupID:group.id,title:"Settle-up payment",amount:value,currency:transfer.currency,paidBy:transfer.from,splits:[Portion(memberID:transfer.to,amount:value)],kind:"settlement",splitMode:.exact)); dismiss() } catch { self.error=error.localizedDescription }
        } }
    }.navigationTitle("Settle up").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement:.cancellationAction) { Button("Cancel") { dismiss() } } }.onAppear { amount=Money.input(transfer.amount) } } }
}
