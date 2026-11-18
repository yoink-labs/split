import SwiftUI
import PhotosUI

struct PriceField: View {
    var title: String
    @Binding var cents: Int64
    @State private var input = ""
    var body: some View {
        TextField(title, text: $input)
            .keyboardType(.decimalPad)
            .multilineTextAlignment(.trailing)
            .frame(maxWidth: 110)
            .accessibilityLabel(title)
            .onAppear { input = cents == 0 ? "" : Money.input(cents) }
            .onChange(of: input) { _, value in cents = Money.parse(value) ?? 0 }
            .onChange(of: cents) { _, amount in
                if amount != (Money.parse(input) ?? 0) { input = Money.input(amount) }
            }
    }
}

struct ReceiptComposer: View {
    @Binding var bill: ReceiptBill
    @Binding var photos: [ReceiptPhoto]
    @Binding var itemized: Bool
    @Binding var processing: Bool
    var existing: Int
    var mustItemize: Bool
    @State private var picks: [PhotosPickerItem] = []
    @State private var camera = false
    @State private var message: String?
    private var remaining: Int { max(0, 4 - existing - photos.count) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Receipt", subtitle: remaining > 0 ? "Up to \(remaining) more \(remaining == 1 ? "photo" : "photos")" : "Photo limit reached")
            if remaining > 0 && !processing {
                HStack(spacing: 8) {
                    PhotosPicker(selection: $picks, maxSelectionCount: remaining, matching: .images) {
                        Label("Add photos", systemImage: "photo.on.rectangle")
                    }
                    .buttonStyle(GhostButton())
                    .onChange(of: picks) { _, items in
                        guard !items.isEmpty else { return }
                        Task {
                            processing = true
                            defer { processing = false; picks = [] }
                            do {
                                for pick in items {
                                    guard let data = try await pick.loadTransferable(type: Data.self) else {
                                        throw LedgerError.invalid("Couldn’t load this photo.")
                                    }
                                    try await append(data)
                                }
                            } catch { message = error.localizedDescription }
                        }
                    }
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button { camera = true } label: { Label("Camera", systemImage: "camera") }
                            .buttonStyle(GhostButton())
                    }
                    Spacer(minLength: 0)
                }
            }
            if processing {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Reading receipt…").font(.subheadline).foregroundStyle(.secondary)
                }
                .frame(minHeight: 44, alignment: .leading)
            }
            if !photos.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(photos) { photo in
                            if let image = UIImage(data: photo.data) {
                                VStack(spacing: 4) {
                                    Image(uiImage: image)
                                        .resizable()
                                        .scaledToFill()
                                        .frame(width: 68, height: 82)
                                        .clipped()
                                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                                    Button("Remove") { photos.removeAll { $0.id == photo.id } }
                                        .font(.caption2)
                                        .buttonStyle(.plain)
                                        .foregroundStyle(Palette.negative)
                                }
                            }
                        }
                    }
                }
            }
            if let message {
                Text(message).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if !mustItemize {
                Toggle("Split by line item", isOn: $itemized)
                    .tint(Palette.evergreen)
                    .font(.subheadline.weight(.medium))
            }
        }
        .sheet(isPresented: $camera) {
            ReceiptCamera { data in
                camera = false
                guard let data else { return }
                Task {
                    processing = true
                    defer { processing = false }
                    do { try await append(data) } catch { message = error.localizedDescription }
                }
            }
            .ignoresSafeArea()
        }
        if itemized {
            VStack(alignment: .leading, spacing: 10) {
                Rectangle().fill(Palette.line).frame(height: 1)
                Text("Line items").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
                ForEach($bill.items) { $item in
                    HStack(spacing: 8) {
                        TextField("Item name", text: $item.title)
                            .textFieldStyle(.plain)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .background(Palette.raised)
                            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(Palette.line, lineWidth: 1))
                        PriceField(title: "Item price", cents: $item.amount)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 8)
                            .background(Palette.raised)
                            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(Palette.line, lineWidth: 1))
                        Button { bill.items.removeAll { $0.id == item.id } } label: {
                            Image(systemName: "minus.circle")
                                .frame(width: 36, height: 36)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Palette.negative)
                        .accessibilityLabel("Remove " + item.title)
                    }
                }
                if bill.items.count < 50 {
                    Button { bill.items.append(Purchase(title: "", amount: 0)) } label: {
                        Label("Add line item", systemImage: "plus")
                    }
                    .buttonStyle(GhostButton())
                }
                HStack {
                    Text("Tax").font(.subheadline)
                    Spacer()
                    PriceField(title: "Tax amount", cents: $bill.tax)
                }
                HStack {
                    Text("Tip").font(.subheadline)
                    Spacer()
                    PriceField(title: "Tip amount", cents: $bill.tip)
                }
                Text("Check the prices before saving. Tax and tip follow each item’s price. People can claim purchases after you save.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func append(_ data: Data) async throws {
        let (photo, suggestion) = try await Task.detached(priority: .userInitiated) { try ReceiptReader.scan(data) }.value
        photos.append(photo)
        if !bill.closed {
            itemized = true
            bill.items.append(contentsOf: suggestion.items.prefix(50 - bill.items.count))
            bill.tax += suggestion.tax
            bill.tip += suggestion.tip
            message = suggestion.items.isEmpty ? "No prices recognized. Add items by hand or turn off line-item splitting." : "Review the suggested items and prices."
        }
    }
}

private struct ReceiptCamera: UIViewControllerRepresentable {
    var complete: (Data?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(complete) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let complete: (Data?) -> Void
        init(_ complete: @escaping (Data?) -> Void) { self.complete = complete }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { complete(nil) }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            complete((info[.originalImage] as? UIImage)?.jpegData(compressionQuality: 0.9))
        }
    }
}
