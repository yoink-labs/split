import SwiftUI

struct MemberEditor: View {
    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.dismiss) private var dismiss
    var save: (MemberDraft) async throws -> Void
    @State private var placeholder = false
    @State private var query = ""
    @State private var name = ""
    @State private var email = ""
    @State private var phone = ""
    @State private var results: [SplitUser]?
    @State private var busy = false
    @State private var error: String?
    private var cleanName: String { name.trimmingCharacters(in:.whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Picker("Member type", selection:$placeholder) {
                    Text("Split user").tag(false)
                    Text("Placeholder").tag(true)
                }.pickerStyle(.segmented)
                if placeholder {
                    Section {
                        TextField("Name", text:$name).textContentType(.name)
                        TextField("Email (optional)", text:$email).textContentType(.emailAddress)
                            .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                        TextField("Phone (optional)", text:$phone).textContentType(.telephoneNumber).keyboardType(.phonePad)
                    } footer: { Text("Include them in expenses now. They can claim their history with a personal invite or a matching verified email.") }
                } else {
                    Section {
                        TextField("Name, email, or @username", text:$query)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .submitLabel(.search).onSubmit { search() }
                        Button("Search",action:search).disabled(query.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
                    } footer: { Text("Use an exact email or username. You can also find people from your groups by name.") }
                    if let results {
                        Section {
                            if results.isEmpty {
                                Text("No matches").font(.headline)
                                Button("Add a placeholder instead") { placeholder = true }
                            }
                            ForEach(results) { user in
                                Button { add(MemberDraft(name:user.name,userID:user.userID)) } label: {
                                    HStack { Avatar(name:user.name); VStack(alignment:.leading) {
                                        Text(user.name).foregroundStyle(.primary)
                                        if let handle=user.username { Text("@"+handle).font(.caption).foregroundStyle(.secondary) }
                                    }; Spacer(); Image(systemName:"plus.circle") }
                                }.accessibilityLabel("Add " + user.name)
                            }
                        }
                    }
                }
                if busy { ProgressView() }
                if let error { ErrorText(text:error) }
            }
            .navigationTitle("Add person").navigationBarTitleDisplayMode(.inline)
            .disabled(busy)
            .toolbar {
                ToolbarItem(placement:.cancellationAction) { Button("Cancel") { dismiss() } }
                if placeholder {
                    ToolbarItem(placement:.confirmationAction) {
                        Button("Add") { add(MemberDraft(name:cleanName,email:email.isEmpty ? nil : email,phone:phone.isEmpty ? nil : phone)) }
                            .disabled(cleanName.isEmpty || cleanName.count > 60 || busy)
                    }
                }
            }.onChange(of:query) { _,_ in results=nil; error=nil }
        }
    }

    private func search() {
        guard !busy else { return }
        let submitted=query
        busy=true; error=nil
        Task {
            defer { busy=false }
            do { let found=try await store.search(submitted); if submitted==query { results=found } }
            catch { self.error=error.localizedDescription }
        }
    }
    private func add(_ draft: MemberDraft) {
        guard !busy else { return }
        if let email=draft.email, email.range(of:#"^[^\s@]+@[^\s@]+\.[^\s@]+$"#,options:.regularExpression)==nil {
            error="Enter a valid email address."; return
        }
        if let phone=draft.phone, phone.range(of:#"^[+0-9() .-]{3,32}$"#,options:.regularExpression)==nil {
            error="Enter a phone number including its area code."; return
        }
        busy=true; error=nil
        Task { defer {busy=false}; do { try await save(draft); dismiss() } catch { self.error=error.localizedDescription } }
    }
}

struct JoinGroupView: View {
    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.dismiss) private var dismiss
    @State private var input = ""
    @State private var working = false
    @State private var error: String?
    var joined: (String) -> Void
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Invite code or link", text:$input, axis:.vertical)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                } footer: { Text("Ask someone in the group to share an invitation from People.") }
                if let error { ErrorText(text:error) }
                if working { ProgressView("Joining…") }
            }.navigationTitle("Join group").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement:.cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement:.confirmationAction) {
                        Button("Join") {
                            guard let token=ExpenseStore.inviteToken(input) else { error="Enter the full code or Split invite link."; return }
                            working=true; error=nil
                            Task {
                                defer { working=false }
                                do { let id=try await store.accept(token); dismiss(); if let id { joined(id) } }
                                catch { self.error=error.localizedDescription }
                            }
                        }.disabled(input.isEmpty || working)
                    }
                }
        }
    }
}
