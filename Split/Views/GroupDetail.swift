import SwiftUI
struct GroupDetail: View {
    var groupID: String
    @EnvironmentObject var store: ExpenseStore
    @EnvironmentObject var session: SessionStore
    @State private var tools=false
    @State private var adding = false
    @State private var inviting = false
    @State private var inspecting: LedgerEntry?
    @State private var openOnly = false
    @State private var section = 0
    @State private var settlement: Transfer?
    var body: some View {
        Group {
            if let group = store.group(groupID) {
                ScrollView {
                    VStack(alignment:.leading,spacing:10) {
                        HStack {
                            Label("\(group.members.count) \(group.members.count==1 ? "person" : "people") · \(group.currency)",systemImage:group.symbol).font(.subheadline).foregroundStyle(.secondary)
                            Spacer(); Button { inviting=true } label:{ Label("People",systemImage:"person.2") }.buttonStyle(.bordered)
                        }
                        if store.isDemo { Label("Sample group",systemImage:"sparkles").font(.caption).foregroundStyle(.secondary) }
                        if store.pending > 0 { Label("\(store.pending) pending · saved on this device",systemImage:"arrow.triangle.2.circlepath").font(.caption).foregroundStyle(.secondary) }
                        if let error=store.error { ErrorText(text:error) }
                        Picker("View",selection:$section) { Text("Expenses").tag(0); Text("Balances").tag(1) }.pickerStyle(.segmented)
                        if section == 0 {
                            if store.entries(in:group).isEmpty { ContentUnavailableView("No expenses yet",systemImage:"receipt",description:Text("Add your first shared expense.")) }
                            let entries=store.entries(in:group)
                            let openCount=entries.compactMap(\.bill).reduce(0){$0+$1.openCount}
                            if openCount>0 || openOnly {
                                Button { openOnly.toggle() } label: {
                                    HStack { Label(openOnly ? "Showing open purchases" : "\(openCount) open \(openCount==1 ? "purchase" : "purchases")",systemImage:"basket")
                                        Spacer(); Text(openOnly ? "Show all" : "Filter").font(.caption.bold()) }
                                }.font(.subheadline).frame(minHeight:44)
                            }
                            if openOnly && openCount==0 { Text("All purchases have been claimed.").font(.subheadline).foregroundStyle(.secondary) }
                            ForEach(entries.filter { !openOnly || ($0.bill?.openCount ?? 0)>0 }) { e in
                                Button { inspecting=e } label: { Card { EntryRow(entry:e,group:group) } }.buttonStyle(.plain)
                            }
                        } else { balances(group) }
                    }.padding(16).frame(maxWidth:680)
                }.frame(maxWidth:.infinity).background(Palette.background).safeAreaInset(edge:.bottom) { Button { adding=true } label: { Label("Add an expense",systemImage:"plus") }.buttonStyle(SolidButton()).padding(.horizontal,16).padding(.vertical,6).background(.ultraThinMaterial) }
                .toolbar {ToolbarItem(placement:.topBarTrailing){Button("Group settings",systemImage:"slider.horizontal.3"){tools=true}}}
                .sheet(isPresented:$tools){GroupTools(group:group)}
                .sheet(isPresented:$adding) { AddExpenseView(group:group) }
                .sheet(isPresented:$inviting) { InviteView(group:group) }
                .sheet(item:$inspecting) { entry in EntryDetails(entry:entry,group:group) }
                .sheet(item:$settlement) { transfer in SettlementView(group:group,transfer:transfer) }
                .refreshable { await store.sync() }
            } else { ContentUnavailableView("Group unavailable",systemImage:"person.2.slash") }
        }.navigationTitle(Text(verbatim:store.group(groupID)?.name ?? "Group")).navigationBarTitleDisplayMode(.inline)
    }
    @ViewBuilder private func balances(_ group: ExpenseGroup) -> some View {
        let entries = store.entries(in:group).map(\.settling)
        let currencies = Set([group.currency]+entries.map(\.currency)).sorted()
        if currencies.isEmpty { ContentUnavailableView("All clear",systemImage:"checkmark.circle",description:Text("Balances appear after your first expense.")) }
        ForEach(currencies,id:\.self) { currency in
            SpendingCard(entries:entries,group:group,currency:currency)
            SettlementSuggestions(group:group,currency:currency,values:Ledger.balances(entries,currency:currency)) { settlement=$0 }

        }
        Text("Balances are simplified within this group, separately for each currency. Recording a payment doesn’t move money.").font(.caption).foregroundStyle(.secondary)
    }
}
private struct SettlementSuggestions:View {
    let group:ExpenseGroup
    let currency:String
    let values:[String:Int64]
    let select:(Transfer)->Void
    @State private var checking=false
    @State private var verified:[Transfer]?
    private func name(_ id:String)->String { group.members.first{$0.id==id}?.name ?? "Member" }
    var body:some View {
        let transfers=verified ?? Ledger.plan(values,currency:currency)
            Card {
                VStack(alignment:.leading,spacing:10) {
                    Text(transfers.isEmpty ? "Everyone’s square." : "Suggested payments").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    if values.filter({$0.value != 0}).count>16 && !transfers.isEmpty {
                        if verified != nil { Text("Minimum transfer count verified").font(.caption) }
                        else { Button(checking ? "Cancel minimum search" : "Find minimum transfers") { checking.toggle() }.font(.caption) }
                    }
                    ForEach(transfers) { transfer in
                        Button { select(transfer) } label: { HStack { VStack(alignment:.leading,spacing:4) { Text("\(name(transfer.from)) → \(name(transfer.to))").font(.subheadline.weight(.medium)); Text(Money.text(transfer.amount,currency)).font(.caption).foregroundStyle(.secondary) }; Spacer(); Text("Settle up").font(.caption.weight(.semibold)) } }.accessibilityLabel("Settle \(name(transfer.from)) to \(name(transfer.to)) \(Money.text(transfer.amount,currency))")
                    }
                }
            }
            .onChange(of:values) { verified=nil;checking=false }
            .task(id:checking) {
                guard checking else{return}
                let inputs=values,code=currency
                let job=Task.detached(priority:.utility){try Ledger.minimumPlan(inputs,currency:code)}
                let result=await withTaskCancellationHandler {try? await job.value} onCancel: {job.cancel()}
                if !Task.isCancelled {verified=result;checking=false}
            }
    }
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
        if let recipient=group.members.first(where:{$0.id==transfer.to}) {PaymentActions(member:recipient,currency:transfer.currency,amount:amount)}
        Section { Button("Record payment") {
            guard let value=Money.parse(amount),value>0,value<=transfer.amount else { error="Enter an amount up to the outstanding balance.";return }
            do { try store.add(LedgerEntry(groupID:group.id,title:"Settle-up payment",amount:value,currency:transfer.currency,paidBy:transfer.from,splits:[Portion(memberID:transfer.to,amount:value)],kind:"settlement",splitMode:.exact)); dismiss() } catch { self.error=error.localizedDescription }
        } }
    }.navigationTitle("Settle up").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement:.cancellationAction) { Button("Cancel") { dismiss() } } }.onAppear { amount=Money.input(transfer.amount) } } }
}
