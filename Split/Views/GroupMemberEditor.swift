import SwiftUI

struct GroupMemberEditor: View {
    let groupID: String
    let member: Person
    let isMe: Bool
    var onChange: () async -> Void

    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.dismiss) private var dismiss
    @State var claimEmail: String
    @State var inviteEmail: String
    @State private var candidates: [SplitUser] = []
    @State private var selectedUser = ""
    @State private var confirmLink = false
    @State private var busy = false
    @State private var confirmArchive = false
    @State private var confirmDelete = false
    @State private var notice: String?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if member.removed != true {
                    if member.userID == nil {
                        Section {
                            if candidates.isEmpty {
                                Text("Add a friend or join a shared group to link an account.").foregroundStyle(.secondary)
                            } else {
                                Picker("Existing account", selection: $selectedUser) {
                                    Text("Choose a person").tag("")
                                    ForEach(candidates) { Text($0.name).tag($0.userID) }
                                }
                                Button("Link placeholder") { confirmLink = true }.disabled(selectedUser.isEmpty)
                            }
                        } header: { Text("Link to an account") } footer: {
                            Text("Their expense history will merge with the selected account, and Split will notify them.")
                        }
                        if !store.isDemo {
                            Section {
                                emailField("Claim email", text: $claimEmail)
                                Button("Save claim email") {
                                    run {
                                        try await store.updateClaimEmail(groupID: groupID, memberID: member.id, email: clean(claimEmail))
                                        notice = "Claim email updated."
                                        await onChange()
                                    }
                                }
                            } footer: {
                                Text("This address can claim the placeholder automatically after sign-in. Clear it to remove that access.")
                            }
                            Section {
                                emailField("Recipient email", text: $inviteEmail)
                                Button("Send invite email") {
                                    run {
                                        let address = clean(inviteEmail)
                                        try await store.sendMemberEmail(groupID: groupID, memberID: member.id, email: address)
                                        notice = "Invitation sent to \(address)."
                                        await onChange()
                                    }
                                }
                                .disabled(clean(inviteEmail).isEmpty)
                            } footer: {
                                Text("The recipient signs in with this email and opens the link to claim the placeholder.")
                            }
                        }
                    } else {
                        Section {
                            Button("Send sign-in email") {
                                run {
                                    try await store.sendMemberEmail(groupID: groupID, memberID: member.id)
                                    notice = "Sign-in reminder sent."
                                }
                            }
                        } footer: {
                            Text("Sends a reminder to the member’s verified sign-in address.")
                        }
                    }
                }
                if !isMe && !store.isDemo {
                    Section {
                        if member.removed == true {
                            Button("Restore member") { changeMembership("restore") }
                        } else {
                            Button("Archive member", role: .destructive) { confirmArchive = true }
                        }
                        Button("Delete member", role: .destructive) { confirmDelete = true }
                    }
                }
                if busy { ProgressView() }
                if let notice { Label(notice, systemImage: "checkmark.circle") }
                if let error { InlineError(text: error) }
            }
            .disabled(busy)
            .navigationTitle(member.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.disabled(busy) } }
            .interactiveDismissDisabled(busy)
            .task {
                if member.userID == nil && member.removed != true {
                    do { candidates = try await store.knownPeople() }
                    catch { self.error = error.localizedDescription }
                }
            }
            .alert("Link \(member.name)?", isPresented: $confirmLink) {
                Button("Link placeholder") {
                    guard let person = candidates.first(where: { $0.userID == selectedUser }) else { return }
                    run {
                        try await store.linkMember(groupID: groupID, memberID: member.id, person: person)
                        await onChange()
                        dismiss()
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This permanently merges the placeholder’s expenses and balances with the selected account.")
            }
            .alert("Archive \(member.name)?", isPresented: $confirmArchive) {
                Button("Archive member", role: .destructive) { changeMembership("archive") }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Their past expenses and balances will stay in the group.")
            }
            .alert("Delete \(member.name)?", isPresented: $confirmDelete) {
                Button("Delete member", role: .destructive) { changeMembership("delete") }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Only members with no expenses can be deleted. This action is permanent.")
            }
        }
    }

    private func emailField(_ title: String, text: Binding<String>) -> some View {
        TextField(title, text: text)
            .textContentType(.emailAddress)
            .keyboardType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
    }

    private func clean(_ email: String) -> String {
        email.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func changeMembership(_ mode: String) {
        run {
            _ = try await store.groupAction(groupID, "members/\(member.id)/remove", ["mode": mode])
            await onChange()
            dismiss()
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        guard !busy else { return }
        busy = true
        notice = nil
        error = nil
        Task {
            defer { busy = false }
            do { try await action() }
            catch { self.error = error.localizedDescription }
        }
    }
}
