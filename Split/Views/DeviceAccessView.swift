import SwiftUI

private struct ConnectedComputer: Decodable, Identifiable {
    let id: String
    let name: String
    let last_used: Double?
}

struct DeviceAccessView: View {
    @EnvironmentObject private var store: ExpenseStore
    @State private var computers: [ConnectedComputer] = []
    @State private var code = ""
    @State private var reviewedName: String?
    @State private var revoke: ConnectedComputer?
    @State private var busy = false
    @State private var message = ""

    private func perform(_ action: @escaping () async throws -> Void) {
        guard !busy else { return }
        busy = true
        message = ""
        Task { @MainActor in
            defer { busy = false }
            do { try await action() } catch { message = error.localizedDescription }
        }
    }

    private func refresh() async throws {
        let data = try await store.request(path: "/v1/device/tokens")
        computers = try JSONDecoder().decode([ConnectedComputer].self, from: data)
    }

    var body: some View {
        Form {
            // Device access is a live-account screen; the background matches the rest of the app.

            Section("Connect a computer") {
                Text("Run split login on your computer and enter its code here.")
                TextField("Device code", text: $code)
                    .textInputAutocapitalization(.characters).autocorrectionDisabled()
                    .accessibilityIdentifier("device-code")
                    .onChange(of: code) { reviewedName = nil }
                if let reviewedName {
                    Text("Allow \(reviewedName) to read and change your Split groups and expenses?")
                    Button("Approve computer") {
                        perform {
                            _ = try await store.request(path: "/v1/device/approve", body: JSONEncoder().encode(["code":code]))
                            self.reviewedName = nil
                            code = ""
                            message = "Approved. Return to your terminal."
                            try await refresh()
                        }
                    }
                } else {
                    Button("Review computer") {
                        perform {
                            let submitted = code
                            let data = try await store.request(path: "/v1/device/review", body: JSONEncoder().encode(["code":submitted]))
                            if code == submitted { reviewedName = try JSONDecoder().decode([String:String].self, from: data)["name"] }
                        }
                    }.disabled(code.filter { !$0.isWhitespace && $0 != "-" }.count != 8)
                }
            }
            if !message.isEmpty { Text(message) }
            Section("Authorized computers") {
                if computers.isEmpty { Text("No connected computers").foregroundStyle(.secondary) }
                ForEach(computers) { computer in
                    VStack(alignment: .leading) {
                        Text(computer.name)
                        if let used = computer.last_used {
                            Text("Last used \(Date(timeIntervalSince1970: used/1000).formatted())").font(.caption)
                        }
                        Button("Revoke access", role: .destructive) { revoke = computer }
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(AppBackground())
        .disabled(busy)
        .navigationTitle("Connected computers")
        .task { do { try await refresh() } catch { message = error.localizedDescription } }
        .refreshable { do { try await refresh() } catch { message = error.localizedDescription } }
        .alert("Revoke computer access?", isPresented: Binding(get: { revoke != nil }, set: { if !$0 { revoke = nil } }), presenting: revoke) { device in
            Button("Revoke", role: .destructive) {
                perform {
                    _ = try await store.request(path: "/v1/device/revoke", body: JSONEncoder().encode(["id":device.id]))
                    try await refresh()
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { device in Text("\(device.name) will need a new code to reconnect.") }
    }
}
