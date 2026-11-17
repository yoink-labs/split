import SwiftUI
struct CreateGroupView: View {
    var friend: Bool
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var store: ExpenseStore
    @Environment(\.dismiss) var dismiss
    @State private var name = ""
    @State private var people = ""
    @State private var kind = "trip"
    @State private var currency = "ARS"
    @State private var error: String?
    var body: some View { NavigationStack { Form {
        Section { Text(friend ? "A little tab for two." : "Make room for everyone.").font(.title2.weight(.semibold)); Text(friend ? "Add your friend’s name. You can send them an invitation once the tab is created." : "Name the plan and add the people. Invite them after you create the group.").foregroundStyle(.secondary) }
        Section(friend ? "Friend" : "The group") {
            TextField(friend ? "Friend’s name" : "Group name",text:$name).accessibilityIdentifier("group-name")
            if !friend { Picker("For",selection:$kind) { Text("A trip").tag("trip"); Text("Our home").tag("home") }; TextField("Names, separated by commas",text:$people).accessibilityIdentifier("group-members"); Text("You’re already included.").font(.caption).foregroundStyle(.secondary) }
            Picker("Default currency",selection:$currency) { ForEach(Money.currencies,id:\.self) { Text($0).tag($0) } }
        }
        if let error { ErrorText(text:error) }
        Section { Button(friend ? "Add friend" : "Create group") { save() }.disabled(name.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty) }
    }.navigationTitle(friend ? "New friend" : "New group").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement:.cancellationAction) { Button("Cancel") { dismiss() } } } } }
    private func save() {
        let clean=name.trimmingCharacters(in:.whitespacesAndNewlines)
        let names=friend ? [clean] : people.split(separator:",").map { $0.trimmingCharacters(in:.whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard !clean.isEmpty, clean.count<=80, names.count<=49, names.allSatisfy({$0.count<=60}),let id=session.userID else { error="Use a shorter name and up to 49 other people."; return }
        do { try store.create(name:clean,kind:friend ? "friend" : kind,currency:currency,names:names,userID:id,displayName:session.displayName); dismiss() } catch { self.error=error.localizedDescription }
    }
}
struct AddExpenseView: View {
    var group: ExpenseGroup
    @EnvironmentObject var store: ExpenseStore
    @EnvironmentObject var session: SessionStore
    @Environment(\.dismiss) var dismiss
    @State private var title = ""
    @State private var amount = ""
    @State private var currency = ""
    @State private var payer = ""
    @State private var mode: SplitMode = .equal
    @State private var selected = Set<String>()
    @State private var values: [String:String] = [:]
    @State private var error: String?
    private var people: [String] { group.members.filter { selected.contains($0.id) }.map(\.id) }
    private var portions: [Portion]? { guard let total=Money.parse(amount) else{return nil};return try? Ledger.split(total:total,people:people,mode:mode,values:values) }
    var body: some View { NavigationStack { Form {
        Section {
            TextField("What was it for?",text:$title).font(.title3.weight(.medium)).accessibilityIdentifier("expense-title")
            HStack { TextField("0.00",text:$amount).font(.system(size:36,weight:.medium,design:.rounded)).keyboardType(.decimalPad).accessibilityIdentifier("expense-amount"); Picker("Currency",selection:$currency) { ForEach(Money.currencies,id:\.self) { Text($0).tag($0) } }.labelsHidden().accessibilityLabel("Currency") }
        }
        Section { Picker("Paid by",selection:$payer) { ForEach(group.members) { Text($0.userID == session.userID ? "You" : $0.name).tag($0.id) } } }
        Section {
            Picker("Split",selection:$mode) { ForEach(SplitMode.allCases,id:\.self) { Text($0.title).tag($0) } }.pickerStyle(.segmented)
            ForEach(group.members) { person in
                HStack(spacing:12) {
                    Button { if selected.contains(person.id) { selected.remove(person.id) } else { selected.insert(person.id) } } label: { Image(systemName:selected.contains(person.id) ? "checkmark.circle.fill" : "circle").foregroundStyle(selected.contains(person.id) ? Palette.green : .secondary) }.buttonStyle(.borderless).accessibilityLabel("Include \(person.name)").accessibilityValue(selected.contains(person.id) ? "Yes" : "No")
                    Text(person.userID == session.userID ? "You" : person.name).font(.subheadline)
                    Spacer()
                    if selected.contains(person.id) {
                        if mode == .equal { Text(portions?.first{$0.memberID==person.id}.map{Money.text($0.amount,currency)} ?? "—").font(.caption).foregroundStyle(.secondary) }
                        else { TextField(mode == .percent ? "%" : mode == .shares ? "Shares" : "0.00",text:Binding(get:{values[person.id] ?? ""},set:{values[person.id]=$0})).keyboardType(.decimalPad).multilineTextAlignment(.trailing).frame(width:100).accessibilityLabel("\(person.name) \(mode.title)") }
                    }
                }.padding(.vertical,4)
            }
        } header: { Text("How to split it") } footer: { Text(mode == .equal ? "Any extra cents go to the first people in the list." : mode == .exact ? "Amounts must match the total exactly." : mode == .percent ? "Percentages must add up to 100%." : "Use relative shares, like 2 for a couple and 1 for one person.") }
        if mode != .equal, let portions { Section("Preview") { ForEach(portions,id:\.memberID) { p in HStack { Text(group.members.first{$0.id==p.memberID}?.name ?? ""); Spacer(); Text(Money.text(p.amount,currency)) } } } }
        if let error { Section { ErrorText(text:error) } }
        Section { Button { save() } label: { Text(store.online ? "Save expense" : "Save offline").frame(maxWidth:.infinity).font(.headline) }.accessibilityIdentifier("save-expense") }
    }.navigationTitle("Add an expense").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement:.cancellationAction) { Button("Cancel") { dismiss() } } }.onAppear { currency=group.currency; payer=group.members.first{$0.userID==session.userID}?.id ?? group.members[0].id; selected=Set(group.members.map(\.id)) }.onChange(of:mode) { _,_ in values=[:];error=nil } } }
    private func save() {
        do {
            guard !title.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,title.count<=120 else { throw LedgerError.invalid("Give this expense a short description.") }
            guard let total=Money.parse(amount),total>0 else { throw LedgerError.invalid("Enter an amount greater than zero, with up to two decimal places.") }
            let splits=try Ledger.split(total:total,people:people,mode:mode,values:values)
            try store.add(LedgerEntry(groupID:group.id,title:title.trimmingCharacters(in:.whitespacesAndNewlines),amount:total,currency:currency,paidBy:payer,splits:splits,splitMode:mode)); dismiss()
        } catch { self.error=error.localizedDescription }
    }
}
