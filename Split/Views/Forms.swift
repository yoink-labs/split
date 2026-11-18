import SwiftUI
struct CreateGroupView: View {
    var friend: Bool
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var store: ExpenseStore
    @Environment(\.dismiss) var dismiss
    @State private var name = ""
    @State private var people: [MemberDraft] = []
    @State private var choosing = false
    @State private var kind = "trip"
    @State private var currency = Money.currencies.contains(Locale.current.currency?.identifier ?? "") ? Locale.current.currency!.identifier : "USD"
    @State private var error: String?
    var body: some View { NavigationStack { Form {
        Section(friend ? "Friend" : "Group") {
            TextField(friend ? "Friend’s name" : "Group name",text:$name).accessibilityIdentifier("group-name")
            if !friend { Picker("Type",selection:$kind) { Text("Trip").tag("trip"); Text("Home").tag("home") } }
            Picker("Currency",selection:$currency) { ForEach(Money.currencies,id:\.self) { Text($0).tag($0) } }
        }
        Section {
            ForEach(people,id:\.id) { person in
                HStack { Text(person.name); Spacer(); Button(role:.destructive) { people.removeAll { $0.id==person.id } }
                    label: { Image(systemName:"minus.circle") }.accessibilityLabel("Remove "+person.name) }
            }
            if !friend || people.isEmpty { Button { choosing=true } label: { Label(friend ? "Choose friend" : "Add person",systemImage:"person.badge.plus") } }
        } footer: { Text(friend ? "Choose a Split user, or enter a name to invite your friend later." : "You’re included. People can also join later by link or code.") }
        if let error { ErrorText(text:error) }

    }.navigationTitle(friend ? "New friend" : "New group").navigationBarTitleDisplayMode(.inline).toolbar {
        ToolbarItem(placement:.cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement:.confirmationAction) { Button("Create") { save() }.disabled(name.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty) }
    }.sheet(isPresented:$choosing) {
        MemberEditor { draft in
            if let id=draft.userID, people.contains(where:{$0.userID==id}) { throw LedgerError.invalid("This person is already included.") }
            people.append(draft); if friend { name=draft.name }
        }
    } } }
    private func save() {
        let clean=name.trimmingCharacters(in:.whitespacesAndNewlines)
        let participants = friend && people.isEmpty ? [MemberDraft(name:clean)] : people
        guard !clean.isEmpty, clean.count<=80, participants.count<=49, participants.allSatisfy({$0.name.count<=60}), let id=session.userID else { error="Use a shorter name and up to 49 other people."; return }
        do { try store.create(name:clean,kind:friend ? "friend" : kind,currency:currency,people:participants,userID:id,displayName:session.displayName); dismiss() } catch { self.error=error.localizedDescription }
    }
}
struct AddExpenseView: View {
    var group: ExpenseGroup
    var original: LedgerEntry? = nil
    @State private var choosing = false
    @State private var initialized = false
    @State private var saving = false
    @State private var category = ""
    @State private var bill = ReceiptBill()
    @State private var photos:[ReceiptPhoto] = []
    @State private var itemized = false
    @State private var reading = false
    @State private var entryID = UUID().uuidString
    @State private var entryDate = ISO8601DateFormatter().string(from:Date())
    @FocusState private var amountFocused: Bool
    private var current: ExpenseGroup { store.group(group.id) ?? group }
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
    private var people: [String] { current.members.filter { selected.contains($0.id) }.map(\.id) }
    private var portions: [Portion]? { guard let total=Money.parse(amount) else{return nil};return try? Ledger.split(total:total,people:people,mode:mode,values:values) }
    var body: some View { NavigationStack { Form {
        Section {
            HStack {
                if itemized { Text(Money.input(bill.total)).font(.title2.weight(.semibold)).accessibilityLabel("Receipt total " + Money.input(bill.total)); Spacer() } else { TextField("0.00",text:$amount).font(.title2.weight(.semibold)).keyboardType(.decimalPad)
                    .focused($amountFocused).accessibilityLabel("Amount").accessibilityIdentifier("expense-amount") }
                Picker("Currency",selection:$currency) { ForEach(Money.currencies,id:\.self) { Text($0).tag($0) } }
                    .labelsHidden().accessibilityLabel("Currency")
            }
            TextField("Description (optional)",text:$title).accessibilityIdentifier("expense-title")

        }
        Section { Picker("Category",selection:$category) {
            Text("Uncategorized").tag("")
            ForEach(Array(Set(["Dining","Groceries","Travel","Lodging","Shopping","Entertainment","Utilities","Other"] + (category.isEmpty ? [] : [category]))).sorted(),id:\.self) { Text($0).tag($0) }
        }
        Picker("Paid by",selection:$payer) { ForEach(current.members) { Text($0.userID == session.userID ? "You" : $0.name).tag($0.id) } } }
        ReceiptComposer(bill:$bill,photos:$photos,itemized:$itemized,processing:$reading,existing:original?.receiptIDs?.count ?? 0,mustItemize:original?.bill != nil)
        if !itemized { Section {
            Picker("Split",selection:Binding(get:{mode},set:{mode=$0; values=[:]; error=nil})) { ForEach(SplitMode.allCases,id:\.self) { Text($0.title).tag($0) } }.pickerStyle(.menu)
            ForEach(current.members) { person in
                HStack(spacing:12) {
                    Button { if selected.contains(person.id) { selected.remove(person.id) } else { selected.insert(person.id) } } label: {
                        HStack(spacing:10) {
                            Image(systemName:selected.contains(person.id) ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(selected.contains(person.id) ? Palette.green : .secondary)
                            Text(person.userID == session.userID ? "You" : person.name).font(.subheadline).foregroundStyle(.primary)
                        }.frame(minHeight:44).contentShape(Rectangle())
                    }.buttonStyle(.borderless).accessibilityLabel("Include \(person.name)").accessibilityValue(selected.contains(person.id) ? "Yes" : "No")
                    Spacer()
                    if selected.contains(person.id) {
                        if mode == .equal { Text(portions?.first{$0.memberID==person.id}.map{Money.text($0.amount,currency)} ?? "—").font(.caption).foregroundStyle(.secondary) }
                        else { TextField(mode == .percent ? "%" : mode == .shares ? "Shares" : "0.00",text:Binding(get:{values[person.id] ?? ""},set:{values[person.id]=$0})).keyboardType(.decimalPad).multilineTextAlignment(.trailing).frame(width:100).accessibilityLabel("\(person.name) \(mode.title)") }
                    }
                }
            }
            Button { choosing=true } label: { Label("Add person",systemImage:"person.badge.plus") }
        } header: { Text("How to split it") } footer: { Text(mode == .equal ? "Any extra cents go to the first people in the list." : mode == .exact ? "Amounts must match the total exactly." : mode == .percent ? "Percentages must add up to 100%." : "Use relative shares, like 2 for a couple and 1 for one person.") }
        if mode != .equal, let portions { Section("Preview") { ForEach(portions,id:\.memberID) { p in HStack { Text(current.members.first{$0.id==p.memberID}?.name ?? ""); Spacer(); Text(Money.text(p.amount,currency)) } } } }
        }
        if let error { Section { ErrorText(text:error) } }
    }.navigationTitle(original == nil ? "New expense" : "Edit expense").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement:.cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement:.confirmationAction) {
                Button("Save") { Task { await save() } }.disabled(saving || reading || (itemized ? bill.total == 0 : amount.isEmpty)).accessibilityIdentifier("save-expense")
            }
        }
        .sheet(isPresented:$choosing) {
            MemberEditor { draft in
                let id=try await store.addMember(groupID:group.id,draft:draft)
                selected.insert(id)
            }
        }
        .onAppear {
            guard !initialized else { return }
            initialized=true
            currency=original?.currency ?? group.currency
            payer=original?.paidBy ?? current.members.first{$0.userID==session.userID}?.id ?? current.members.first?.id ?? ""
            selected=Set(original?.splits.map(\.memberID) ?? current.members.map(\.id))
            if let original {
                category=original.category ?? ""; bill=original.bill ?? ReceiptBill(); itemized=original.bill != nil
                title=original.title; amount=Money.input(original.amount)
                mode=original.splitMode == .equal ? .equal : .exact
                values=Dictionary(uniqueKeysWithValues:original.splits.map { ($0.memberID,Money.input($0.amount)) })
            } else { amountFocused=true }
        }
    } }
    private func save() async {
        guard !saving else { return }
        saving=true; defer { saving=false }
        do {
            guard title.count<=120 else { throw LedgerError.invalid("Give this expense a short description.") }
            guard let total=itemized ? bill.total : Money.parse(amount),total>0 else { throw LedgerError.invalid("Enter an amount greater than zero, with up to two decimal places.") }
            let splits=itemized ? try bill.split(payer:payer) : try Ledger.split(total:total,people:people,mode:mode,values:values)
            let description=title.trimmingCharacters(in:.whitespacesAndNewlines)
            var entry=LedgerEntry(id:entryID,groupID:group.id,title:description.isEmpty ? "Shared expense" : description,amount:total,currency:currency,paidBy:payer,splits:splits,category:category.isEmpty ? nil : category,bill:itemized ? bill : nil,receiptIDs:original?.receiptIDs,splitMode:itemized ? .exact : mode,createdAt:entryDate)
            if let original {
                entry.id=original.id; entry.createdAt=original.createdAt; entry.editable=original.editable
                if !itemized && entry.splits==original.splits { entry.splitMode=original.splitMode }
            }
            try await store.saveReceipted(entry,original:original,photos:photos)
            dismiss()
        } catch { self.error=error.localizedDescription }
    }
}
