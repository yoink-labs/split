import SwiftUI
import UniformTypeIdentifiers

struct CSVFile:FileDocument {
    static var readableContentTypes:[UTType] { [.commaSeparatedText,.plainText] }
    var data:Data
    init(_ text:String){data=Data(text.utf8)}
    init(configuration:ReadConfiguration)throws {data=configuration.file.regularFileContents ?? Data()}
    func fileWrapper(configuration:WriteConfiguration)throws->FileWrapper { FileWrapper(regularFileWithContents:data) }
}
struct GroupTools:View {
    var group:ExpenseGroup
    @EnvironmentObject var store:ExpenseStore
    @EnvironmentObject var session:SessionStore
    @Environment(\.dismiss) var dismiss
    @State private var weights:[String:String]=[:]
    @State private var payment:[String:String]=[:]
    @State private var choose=false
    @State private var exporting=false
    @State private var busy=false
    @State private var pending:[CSVExpense]=[]
    @State private var message:String?
    @State private var error:String?
    private let fields=[("venmo","Venmo username"),("paypal","PayPal.Me username"),("mercado","Mercado Pago payment link"),("alias","Argentine alias or CVU")]
    var body:some View { NavigationStack { Form {
        Section { LabeledContent("Settlement currency",value:group.currency) }
        Section {
            ForEach(group.members) { m in
                LabeledContent(m.name) { TextField("1",text:Binding(get:{weights[m.id] ?? ""},set:{weights[m.id]=$0})).multilineTextAlignment(.trailing).keyboardType(.numberPad).accessibilityLabel(m.name+" default shares") }
            }
            Button("Save default split") { run {
                var w:[String:Int]=[:]
                for m in group.members {
                    guard let value=Int(weights[m.id]?.isEmpty==false ? weights[m.id]! : "1"),(0...1000).contains(value) else {throw LedgerError.invalid("Enter a whole number from 0 to 1000.")}
                    if value>0 {w[m.id]=value}
                }
                guard !w.isEmpty else {throw LedgerError.invalid("Include at least one person.")}
                _ = try await store.groupAction(group.id,"default-split",["weights":w.values.allSatisfy{$0==1} && w.count==group.members.count ? [:] : w])
                message="Default split saved."
            } }
        } header:{Text("Default shares")} footer:{Text("Use 2 shares for a couple or 0 to exclude someone. You can change the split on each expense.")}
        Section {
            ForEach(fields,id:\.0) { field in TextField(field.1,text:Binding(get:{payment[field.0] ?? ""},set:{payment[field.0]=$0})).textInputAutocapitalization(.never).autocorrectionDisabled() }
            Button("Save payment details") { run { _ = try await store.groupAction(group.id,"payment-profile",payment);message="Payment details saved." } }
        } header:{Text("Your payment details")} footer:{Text("Visible to this group when settling a balance.")}
        Section {
            Button("Import CSV") { choose=true }
            Button("Export CSV") { exporting=true }
            if !pending.isEmpty {
                let names=Set(pending.flatMap{[$0.payer]+$0.splits.map(\.name)})
                let new=names.filter{name in !group.members.contains{$0.name.caseInsensitiveCompare(name) == .orderedSame}}.sorted()
                Text("\(pending.count) entries · \(new.isEmpty ? "All members matched" : "New placeholders: "+new.joined(separator:", "))")
                ForEach(Array(pending.prefix(5).enumerated()),id:\.offset){ _,row in LabeledContent(row.title,value:Money.text(row.amount,row.currency)).font(.caption) }
                Button("Confirm import") { run {
                    let data=try await store.groupAction(group.id,"import",["rows":try JSONSerialization.jsonObject(with:JSONEncoder().encode(pending))])
                    struct Result:Decodable {var inserted:Int}
                    let result=try JSONDecoder().decode(Result.self,from:data)
                    message="Imported \(result.inserted) entries. Skipped \(pending.count-result.inserted) duplicates.";pending=[]
                } }
                Button("Discard preview",role:.cancel){pending=[]}
            }
        } header:{ Text("Ledger CSV") } footer:{Text("Import up to 80 expenses or payments. Unmatched names become placeholders. Review the preview before applying.")}
        if let error { ErrorText(text:error) }
        if let message { Text(message).foregroundStyle(Palette.green) }
    }.navigationTitle("Group settings").navigationBarTitleDisplayMode(.inline)
        .toolbar {ToolbarItem(placement:.confirmationAction){Button("Done"){dismiss()}}}
        .onAppear {
            let defaults=group.defaultWeights ?? [:]
            weights=Dictionary(uniqueKeysWithValues:group.members.map{($0.id,String(defaults.isEmpty ? 1 : defaults[$0.id] ?? 0))})
            payment=group.members.first{$0.userID==session.userID}?.payment ?? [:]
        }
        .disabled(busy)
        .fileExporter(isPresented:$exporting,document:CSVFile(LedgerCSV.export(store.entries(in:group),group:group)),contentType:.commaSeparatedText,defaultFilename:group.name+" expenses") { if case .failure(let e)=$0 {error=e.localizedDescription} }
        .fileImporter(isPresented:$choose,allowedContentTypes:[.commaSeparatedText,.plainText]) { result in
            do {
                pending=[];error=nil;message=nil
                let url=try result.get(),access=url.startAccessingSecurityScopedResource()
                defer {if access{url.stopAccessingSecurityScopedResource()}}
                guard let size=try url.resourceValues(forKeys:[.fileSizeKey]).fileSize,size<=512000 else {throw LedgerError.invalid("Choose a file under 500 KiB.")}
                let data=try Data(contentsOf:url)
                guard let text=String(data:data,encoding:.utf8) ?? String(data:data,encoding:.utf16) else {throw LedgerError.invalid("Choose a UTF-8 or UTF-16 CSV file.")}
                pending=try LedgerCSV.parse(text,defaultCurrency:group.currency)
            } catch {self.error=error.localizedDescription}
        }
    } }
    private func run(_ work:@escaping @MainActor () async throws->Void) {
        guard !busy else{return};busy=true;error=nil;message=nil
        Task {defer{busy=false};do{try await work()}catch{self.error=error.localizedDescription}}
    }
}
struct PaymentActions:View {
    var member:Person
    var currency:String
    var amount:String
    @State private var copied=false
    var body:some View {
        if let p=member.payment,!p.isEmpty {
            Section {
                if let name=p["paypal"],let url=URL(string:"https://paypal.me/"+name+(Money.parse(amount).map{"/"+Money.input($0)+currency} ?? "")) { Link("Open PayPal · "+name,destination:url) }
                if let name=p["venmo"],let url=URL(string:"https://venmo.com/u/"+name) { Link("Open Venmo · "+name,destination:url) }
                if let link=p["mercado"],let url=URL(string:link) { Link("Open Mercado Pago",destination:url) }
                if let alias=p["alias"] {Button {UIPasteboard.general.string=alias;copied=true} label:{LabeledContent(copied ? "Copied" : "Copy alias / CVU",value:alias)} }
            } header:{Text("Pay "+member.name)} footer:{Text("Confirm the recipient and "+currency+" "+amount+" in your payment app. Return here to record the completed payment.")}
        }
    }
}
