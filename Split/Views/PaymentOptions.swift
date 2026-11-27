import SwiftUI

struct PaymentOptions: View {
    let methods: [PaymentMethod]
    var amount: Int64? = nil
    var currency: String? = nil
    @State private var copied: Int?

    var body: some View {
        let ordered = methods.filter { $0.preferred == true } + methods.filter { $0.preferred != true }
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(ordered.enumerated()), id: \.offset) { index, method in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .top, spacing: 8) {
                        platformIcon(method)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(method.name).font(.subheadline.weight(.semibold))
                            if method.preferred == true {
                                Text("Preferred").font(.caption.weight(.semibold)).foregroundStyle(Palette.evergreen)
                            }
                            Text(verbatim: method.handle)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    }
                    HStack(spacing: 16) {
                        if let url = method.url(amount: amount, currency: currency) {
                            Link(destination: url) { Label("Open", systemImage: "arrow.up.right") }
                                .accessibilityLabel("Open \(method.name)")
                        }
                        Button {
                            UIPasteboard.general.string = method.handle
                            copied = index
                        } label: {
                            Label(copied == index ? "Copied" : "Copy", systemImage: copied == index ? "checkmark" : "doc.on.doc")
                        }
                        .accessibilityLabel(copied == index ? "\(method.name) handle copied" : "Copy \(method.name) handle")
                    }
                    .font(.subheadline.weight(.medium))
                    .buttonStyle(.borderless)
                    .controlSize(.regular)
                }
            }
        }
    }

    @ViewBuilder private func platformIcon(_ method: PaymentMethod) -> some View {
        if let logo = method.info?.logo {
            Image(logo)
                .resizable()
                .scaledToFit()
                .frame(width: 22, height: 22)
                .padding(4)
                .background(.white, in: .rect(cornerRadius: 6))
                .accessibilityHidden(true)
        } else {
            Image(systemName: "creditcard")
                .foregroundStyle(.secondary)
                .frame(width: 30, height: 30)
                .accessibilityHidden(true)
        }
    }
}
