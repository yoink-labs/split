import SwiftUI
import PhotosUI

struct ReceiptPhotoPicker: View {
    @Binding var photos: [ReceiptPhoto]
    @Binding var processing: Bool
    var existing = 0
    var onScan: ((ReceiptBill) -> Void)? = nil
    @State private var picks: [PhotosPickerItem] = []
    @State private var camera = false
    @State private var error: String?
    @State private var gallery: ReceiptPresentation?
    private var remaining: Int { max(0, 4 - existing - photos.count) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Receipt", subtitle: remaining > 0 ? "Up to \(remaining) more \(remaining == 1 ? "photo" : "photos")" : "Photo limit reached")
            if remaining > 0 && !processing {
                FlowLayout(spacing: 8) {
                    PhotosPicker(selection: $picks, maxSelectionCount: remaining, matching: .images) {
                        Label("Choose photos", systemImage: "photo.on.rectangle")
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
                                    try await capture(data)
                                }
                            } catch { self.error = error.localizedDescription }
                        }
                    }
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button { camera = true } label: { Label("Take photo", systemImage: "camera") }
                            .buttonStyle(GhostButton())
                    }
                }
            }
            if processing {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(onScan == nil ? "Preparing photo…" : "Reading receipt…").font(.subheadline).foregroundStyle(.secondary)
                }
                .frame(minHeight: 44, alignment: .leading)
            }
            if !photos.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(photos.enumerated()), id: \.element.id) { index, photo in
                            if let image = UIImage(data: photo.data) {
                                thumbnail(image, photo: photo, index: index)
                            }
                        }
                    }
                }
            }
            if let error { InlineError(text: error) }
        }
        .fullScreenCover(item: $gallery) { ReceiptViewer($0) }
        .sheet(isPresented: $camera) {
            ReceiptCamera { data in
                camera = false
                guard let data else { return }
                Task {
                    processing = true
                    defer { processing = false }
                    do { try await capture(data) } catch { self.error = error.localizedDescription }
                }
            }
            .ignoresSafeArea()
        }
    }

    private func thumbnail(_ image: UIImage, photo: ReceiptPhoto, index: Int) -> some View {
        Button {
            let images = photos.compactMap { UIImage(data: $0.data) }
            let page = photos.prefix(index).compactMap { UIImage(data: $0.data) }.count
            gallery = ReceiptPresentation(images: images, index: page)
        } label: {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 68, height: 82)
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Palette.line))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("View receipt photo \(index + 1)")
        .overlay(alignment: .topTrailing) {
            Button { photos.removeAll { $0.id == photo.id } } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 20))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .black.opacity(0.65))
                    .frame(width: 44, height: 44, alignment: .topTrailing)
                    .padding(2)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(processing)
            .accessibilityLabel("Remove receipt photo \(index + 1)")
        }
    }

    private func capture(_ data: Data) async throws {
        error = nil
        if let onScan {
            let (photo, suggestion) = try await Task.detached(priority: .userInitiated) {
                try ReceiptReader.scan(data)
            }.value
            photos.append(photo)
            onScan(suggestion)
        } else {
            let photo = try await Task.detached(priority: .userInitiated) {
                try ReceiptReader.photo(data)
            }.value
            photos.append(photo)
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
