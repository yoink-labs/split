import SwiftUI

struct PaymentSettings: View {
    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.dismiss) private var dismiss
    let groupID: String?
    @State private var inherit: Bool
    @State private var rows: [Draft]
    @State private var busy = false
    @State private var error: String?

    private struct Draft: Identifiable {
        let id = UUID()
        var choice: String
        var method: PaymentMethod

        init(_ method: PaymentMethod) {
            self.method = method
            choice = method.info?.id ?? ""
        }
    }

    init(groupID: String? = nil, initial: [PaymentMethod]?, defaults: [PaymentMethod] = []) {
        self.groupID = groupID
        _inherit = State(initialValue: groupID != nil && initial == nil)
        _rows = State(initialValue: (initial ?? defaults).map(Draft.init))
    }

    var body: some View {
        Form {
            Group {
            if groupID != nil {
                Section {
                    Toggle("Use my profile payment methods", isOn: $inherit)
                } footer: {
                    Text("Choose what this group sees in member profiles and when settling up.")
                }
            } else {
                Section {
                    Text("Active members of your groups can see these details. You can change what you share in each group.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            if !inherit {
                ForEach($rows) { $row in
                    Section {
                        Picker("Platform", selection: $row.choice) {
                            ForEach(PaymentPlatform.catalog) { platform in
                                Text(platform.name).tag(platform.id)
                            }
                            Text("Custom platform").tag("")
                        }
                        .onChange(of: row.choice) { _, choice in row.method.platform = choice }
                        if row.choice.isEmpty {
                            TextField("Platform name", text: $row.method.platform)
                        }
                        TextField("Payment handle", text: $row.method.handle,
                                  prompt: Text(row.method.info?.prompt ?? "Username, ID, or payment link"))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        let rowID = row.id
                        Toggle("Preferred", isOn: Binding(
                            get: { row.method.preferred == true },
                            set: { preferred in
                                for index in rows.indices {
                                    rows[index].method.preferred = preferred && rows[index].id == rowID ? true : nil
                                }
                            }
                        ))
                        Button("Remove payment method", role: .destructive) {
                            rows.removeAll { $0.id == rowID }
                        }
                    }
                }
                Section {
                    Button("Add payment method", systemImage: "plus") {
                        rows.append(Draft(PaymentMethod(platform: "zelle", handle: "")))
                    }
                    .disabled(rows.count >= 20)
                } footer: {
                    if groupID != nil && rows.isEmpty {
                        Text("No payment methods will be shared in this group.")
                    }
                }
            }
            if let error { Section { InlineError(text: error) } }
            }
            .listRowBackground(Palette.card)
        }
        .scrollContentBackground(.hidden)
        .background(AppBackground())
        .disabled(busy)
        .navigationTitle("Payment methods")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save", action: save)
                    .disabled(busy)
            }
        }
    }

    private func save() {
        let methods = rows.map { row in
            PaymentMethod(platform: row.method.platform.trimmingCharacters(in: .whitespacesAndNewlines),
                          handle: row.method.handle.trimmingCharacters(in: .whitespacesAndNewlines),
                          preferred: row.method.preferred)
        }
        if !inherit && methods.contains(where: {
            $0.platform.isEmpty || $0.platform.utf16.count > 60 || $0.handle.isEmpty || $0.handle.utf16.count > 500
        }) {
            error = "Enter a platform up to 60 characters and a handle up to 500 characters."
            return
        }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await store.savePaymentMethods(inherit ? nil : methods, in: groupID)
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
