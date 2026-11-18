import SwiftUI
import PhotosUI

struct PriceField: View {
    var title:String
    @Binding var cents:Int64
    @State private var input=""
    var body: some View {
        TextField(title,text:$input).keyboardType(.decimalPad).multilineTextAlignment(.trailing)
            .frame(maxWidth:110).accessibilityLabel(title)
            .onAppear { input=cents == 0 ? "" : Money.input(cents) }
            .onChange(of:input) { _,value in cents=Money.parse(value) ?? 0 }
            .onChange(of:cents) { _,amount in
                if amount != (Money.parse(input) ?? 0) { input=Money.input(amount) }
            }
    }
}
struct ReceiptComposer: View {
    @Binding var bill:ReceiptBill
    @Binding var photos:[ReceiptPhoto]
    @Binding var itemized:Bool
    @Binding var processing:Bool
    var existing:Int
    var mustItemize:Bool
    @State private var picks:[PhotosPickerItem]=[]
    @State private var camera=false
    @State private var message:String?
    private var remaining:Int { max(0,4-existing-photos.count) }
    var body: some View {
        Section("Receipt") {
            if remaining>0 && !processing {
                PhotosPicker(selection:$picks,maxSelectionCount:remaining,matching:.images) {
                    Label("Add receipt photos",systemImage:"photo.on.rectangle")
                }.onChange(of:picks) { _,items in
                    guard !items.isEmpty else { return }
                    Task {
                        processing=true
                        defer { processing=false; picks=[] }
                        do { for pick in items {
                            guard let data=try await pick.loadTransferable(type:Data.self) else { throw LedgerError.invalid("Couldn’t load this photo.") }
                            try await append(data)
                        } } catch { message=error.localizedDescription }
                    }
                }
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button { camera=true } label: { Label("Take receipt photo",systemImage:"camera") }
                }
            }
            if processing { ProgressView("Reading receipt…") }
            if !photos.isEmpty {
                ScrollView(.horizontal) { HStack {
                    ForEach(photos) { photo in
                        if let image=UIImage(data:photo.data) {
                            VStack { Image(uiImage:image).resizable().scaledToFill().frame(width:62,height:72).clipped().clipShape(RoundedRectangle(cornerRadius:6))
                                Button("Remove") { photos.removeAll { $0.id==photo.id } }.font(.caption).buttonStyle(.borderless)
                            }
                        }
                    }
                } }
            }
            if let message { Text(message).font(.footnote).foregroundStyle(.secondary) }
            if !mustItemize { Toggle("Split by line item",isOn:$itemized) }
        }.sheet(isPresented:$camera) { ReceiptCamera { data in
            camera=false
            guard let data else { return }
            Task { processing=true; defer { processing=false }; do { try await append(data) } catch { message=error.localizedDescription } }
        }.ignoresSafeArea() }
        if itemized {
            Section { ForEach($bill.items) { $item in
                HStack {
                    TextField("Item name",text:$item.title)
                    PriceField(title:"Item price",cents:$item.amount)
                    Button { bill.items.removeAll { $0.id==item.id } } label:{ Image(systemName:"minus.circle") }
                        .buttonStyle(.borderless).accessibilityLabel("Remove "+item.title)
                }
            }
                if bill.items.count<50 { Button("Add line item",systemImage:"plus") { bill.items.append(Purchase(title:"",amount:0)) } }
                LabeledContent("Tax") { PriceField(title:"Tax amount",cents:$bill.tax) }
                LabeledContent("Tip") { PriceField(title:"Tip amount",cents:$bill.tip) }
            } header: { Text("Line items") } footer: { Text("Check the prices before saving. Tax and tip follow each item’s price. People can claim purchases after you save.") }
        }
    }
    private func append(_ data:Data) async throws {
        let (photo,suggestion)=try await Task.detached(priority:.userInitiated) { try ReceiptReader.scan(data) }.value
        photos.append(photo)
        if !bill.closed {
            itemized=true
            bill.items.append(contentsOf:suggestion.items.prefix(50-bill.items.count))
            bill.tax+=suggestion.tax; bill.tip+=suggestion.tip
            message=suggestion.items.isEmpty ? "No prices recognized. Add items by hand or turn off line-item splitting." : "Review the suggested items and prices."
        }
    }
}
private struct ReceiptCamera:UIViewControllerRepresentable {
    var complete:(Data?)->Void
    func makeCoordinator()->Coordinator { Coordinator(complete) }
    func makeUIViewController(context:Context)->UIImagePickerController {
        let picker=UIImagePickerController(); picker.sourceType = .camera; picker.delegate=context.coordinator; return picker
    }
    func updateUIViewController(_ uiViewController:UIImagePickerController,context:Context) {}
    final class Coordinator:NSObject,UIImagePickerControllerDelegate,UINavigationControllerDelegate {
        let complete:(Data?)->Void
        init(_ complete:@escaping(Data?)->Void) { self.complete=complete }
        func imagePickerControllerDidCancel(_ picker:UIImagePickerController) { complete(nil) }
        func imagePickerController(_ picker:UIImagePickerController,didFinishPickingMediaWithInfo info:[UIImagePickerController.InfoKey:Any]) { complete((info[.originalImage] as? UIImage)?.jpegData(compressionQuality:0.9)) }
    }
}
