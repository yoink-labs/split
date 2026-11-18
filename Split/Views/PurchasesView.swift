import SwiftUI

struct PurchasesSection:View {
    let entry:LedgerEntry
    let group:ExpenseGroup
    let bill:ReceiptBill
    @EnvironmentObject var store:ExpenseStore
    @EnvironmentObject var session:SessionStore
    var assign:(Purchase?)->Void
    var body: some View {
        Section {
            ForEach(bill.items) { item in
                Button { assign(item) } label: {
                    LabeledContent {
                        Text(Money.text(item.amount,entry.currency)).monospacedDigit()
                    } label: {
                        Text(item.title).foregroundStyle(.primary)
                        Text(item.memberIDs.isEmpty ? "Open · claim purchase" : item.memberIDs.compactMap { id in group.members.first{$0.id==id}?.name }.joined(separator:", "))
                            .font(.caption).foregroundStyle(item.memberIDs.isEmpty ? Palette.green : .secondary)
                    }
                }.disabled(bill.closed)
            }
            if bill.tax>0 { LabeledContent("Tax",value:Money.text(bill.tax,entry.currency)) }
            if bill.tip>0 { LabeledContent("Tip",value:Money.text(bill.tip,entry.currency)) }
            if bill.openCount>0 { LabeledContent("Open total",value:Money.text(bill.openTotal,entry.currency)).fontWeight(.semibold) }
            let payer=group.members.first { $0.id==entry.paidBy }
            if !bill.closed && (payer?.userID==session.userID || (payer?.userID==nil && (store.isDemo || entry.editable==true))) {
                Button("Close receipt") { assign(nil) }
            }
        } header: { Text(bill.closed ? "Purchases · closed" : "Purchases") }
        footer: { if bill.openCount>0 { Text("Open purchases stay with the payer until claimed. The open total includes proportional tax and tip.") } }

    }
}
struct ClaimSheet:View {
    let entry:LedgerEntry; let group:ExpenseGroup; let item:Purchase?
    @EnvironmentObject var store:ExpenseStore
    @Environment(\.dismiss) var dismiss
    @State private var selected=Set<String>()
    @State private var error:String?
    @State private var working=false
    var body:some View {
        NavigationStack { Form {
            Section {
                ForEach(group.members) { person in
                    Button {
                        if selected.contains(person.id) { selected.remove(person.id) } else { selected.insert(person.id) }
                    } label: {
                        HStack { Text(person.name).foregroundStyle(.primary); Spacer(); Image(systemName:selected.contains(person.id) ? "checkmark.circle.fill" : "circle") }
                    }.accessibilityValue(selected.contains(person.id) ? "Selected" : "Unselected")
                }
            } header: { Text(item?.title ?? "Who covers the remaining items?") }
            footer: { Text(item == nil ? "The remaining items will be divided evenly among these people. Closing locks the claims." : "Choose everyone sharing this purchase. Clear the selection to leave it open.") }
            if let error { ErrorText(text:error) }
        }.navigationTitle(item == nil ? "Close receipt" : "Claim purchase").navigationBarTitleDisplayMode(.inline)
            .onAppear { selected=Set(item?.memberIDs ?? group.members.map(\.id)) }
            .toolbar {
                ToolbarItem(placement:.cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement:.confirmationAction) { Button(item == nil ? "Close" : "Save") { Task {
                    working=true; defer { working=false }
                    do { try await store.claim(entry,item:item,people:group.members.filter{selected.contains($0.id)}.map(\.id)); dismiss() }
                    catch { self.error=error.localizedDescription }
                } }.disabled(working || (item==nil && selected.isEmpty)) }
            }
        }
    }
}
struct ReceiptGallery:View {
    var entry:String
    var ids:[String]
    @EnvironmentObject var store:ExpenseStore
    var viewPhoto:(ReceiptPresentation)->Void
    @State private var loaded:[String:UIImage]=[:]
    @State private var failed=Set<String>()
    @State private var attempt=0
    var body:some View {
        Section("Receipts") {
            ScrollView(.horizontal) { HStack {
                ForEach(Array(ids.enumerated()),id:\.element) { index,id in
                    Button { if loaded[id] != nil { viewPhoto(ReceiptPresentation(images:ids.compactMap { loaded[$0] },index:ids.prefix(index).filter { loaded[$0] != nil }.count)) } else { attempt+=1 } } label: {
                        Group {
                            if let image=loaded[id] { Image(uiImage:image).resizable().scaledToFill() }
                            else if failed.contains(id) { Image(systemName:"arrow.clockwise") }
                            else { ProgressView() }
                        }.frame(width:68,height:82).clipped().clipShape(RoundedRectangle(cornerRadius:7))
                    }.buttonStyle(.plain).accessibilityLabel("View receipt photo \(index+1)").task(id:attempt) {
                        guard loaded[id]==nil else { return }
                        do {
                            let data=try await store.image(entry:entry,id:id)
                            guard let image=UIImage(data:data) else { throw LedgerError.invalid("Invalid photo.") }
                            loaded[id]=image
                        } catch { failed.insert(id) }
                    }
                }
            } }
        }
    }
}
struct ReceiptPresentation:Identifiable {
    let id=UUID()
    let images:[UIImage]
    let index:Int
}
struct ReceiptViewer:View {
    let photos:ReceiptPresentation
    @Environment(\.dismiss) var dismiss
    @State private var page:Int
    init(_ photos:ReceiptPresentation) { self.photos=photos; _page=State(initialValue:photos.index) }
    var body:some View {
        NavigationStack { TabView(selection:$page) {
            ForEach(photos.images.indices,id:\.self) { index in
                Image(uiImage:photos.images[index]).resizable().scaledToFit().tag(index).accessibilityLabel("Receipt page "+String(index+1))
            }
        }.tabViewStyle(.page).background(Color.black).navigationTitle("Receipt photo").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement:.confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
