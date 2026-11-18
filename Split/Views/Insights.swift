import SwiftUI

struct SpendingCard:View {
    var entries:[LedgerEntry]
    var group:ExpenseGroup
    var currency:String
    private var expenses:[LedgerEntry] { entries.filter { $0.kind=="expense" && $0.currency==currency } }
    var body:some View {
        Card { VStack(alignment:.leading,spacing:10) {
            HStack(alignment:.firstTextBaseline) {
                Text("Total spent").font(.subheadline); Spacer()
                Text(Money.text(expenses.reduce(0){$0+$1.amount},currency)).font(.headline).monospacedDigit()
            }
            Divider()
            ForEach(group.members) { person in
                let paid=expenses.filter{$0.paidBy==person.id}.reduce(0){$0+$1.amount}
                let share=expenses.compactMap{$0.splits.first(where:{$0.memberID==person.id})?.amount}.reduce(0,+)
                let net=Ledger.balances(entries,currency:currency)[person.id] ?? 0
                NavigationLink(value:LedgerRoute.member(group:group.id,seat:person.id)) {
                    VStack(alignment:.leading,spacing:3) {
                        HStack { Text(person.name).font(.subheadline.bold()); Spacer()
                            Text(net==0 ? "All square" : (net>0 ? "Owed " : "Owes ")+Money.text(abs(net),currency)).font(.caption.weight(.medium)).foregroundStyle(Palette.green)
                            Image(systemName:"chevron.right").font(.caption2).foregroundStyle(.secondary)
                        }
                        Text("Paid \(Money.text(paid,currency)) · Share \(Money.text(share,currency))").font(.caption).foregroundStyle(.secondary)
                    }.frame(minHeight:44).contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
            totals("By category",key:{ $0.category ?? "Uncategorized" })
            totals("By month",key:{ String($0.createdAt.prefix(7)) })
        } }
    }
    private func totals(_ title:String,key:@escaping(LedgerEntry)->String)->some View {
        let buckets=Dictionary(grouping:expenses,by:key).mapValues{$0.reduce(Int64(0)){$0+$1.amount}}
        return DisclosureGroup(title) {
            ForEach(buckets.keys.sorted(),id:\.self) { key in LabeledContent(key,value:Money.text(buckets[key] ?? 0,currency)).font(.subheadline).padding(.vertical,4) }
        }.font(.subheadline.weight(.medium))
    }
}
