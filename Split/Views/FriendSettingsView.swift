import SwiftUI

struct FriendSettingsView: View {
    @EnvironmentObject private var store: ExpenseStore
    @State private var friends: [SplitUser] = []
    @State private var shared: [SplitUser] = []
    @State private var received: [GroupInvitation] = []
    @State private var sent: [SentFriendRequest] = []
    @State private var email = ""
    @State private var selectedUser = ""
    @State private var removing: SplitUser?
    @State private var notice: String?
    @State private var error: String?
    @State private var working = false

    private var candidates: [SplitUser] {
        shared.filter { person in !friends.contains { $0.userID == person.userID } }
    }

    var body: some View {
        Form {
            Section("Received") {
                if received.isEmpty { Text("No incoming requests.").foregroundStyle(.secondary) }
                ForEach(received) { invitation in
                    LabeledContent {
                        Menu("Respond", systemImage: "ellipsis.circle") {
                            Button("Accept", systemImage: "checkmark") { answer(invitation, accept: true) }
                            Button(role: .destructive) { answer(invitation, accept: false) } label: { Label("Decline", systemImage: "xmark") }
                        }
                        .accessibilityLabel("Respond to \(invitation.inviterName ?? "Split member")")
                    } label: {
                        Text(invitation.inviterName ?? "Split member")
                    }
                }
            }
            .listRowBackground(Palette.card)
            Section("Sent") {
                if sent.isEmpty { Text("No sent requests.").foregroundStyle(.secondary) }
                ForEach(sent) { request in
                    LabeledContent {
                        Button("Cancel request") { perform { try await store.cancelFriendRequest(request.id) } }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Cancel request to \(request.label)")
                    } label: {
                        Text(request.label)
                    }
                }
            }
            .listRowBackground(Palette.card)
            Section("Send a friend request") {
                TextField("Friend’s email", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Send by email") {
                    perform {
                        try await store.sendFriendRequest(email: email)
                        email = ""
                        showRequestNotice()
                    }
                }
                .disabled(email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if !candidates.isEmpty {
                    Picker("From shared groups", selection: $selectedUser) {
                        Text("Choose a person").tag("")
                        ForEach(candidates) { Text($0.name).tag($0.userID) }
                    }
                    .pickerStyle(.menu)
                    Button("Send to group member") {
                        perform {
                            try await store.sendFriendRequest(userID: selectedUser)
                            selectedUser = ""
                            showRequestNotice()
                        }
                    }
                    .disabled(selectedUser.isEmpty)
                }
                if let notice { Label(notice, systemImage: "checkmark.circle") }
            }
            .listRowBackground(Palette.card)
            Section("Your friends") {
                if friends.isEmpty { Text("Accepted requests appear here.").foregroundStyle(.secondary) }
                ForEach(friends) { friend in
                    LabeledContent {
                        Menu("Manage \(friend.name)", systemImage: "ellipsis.circle") {
                            Button(role: .destructive) { removing = friend } label: {
                                Label("Remove friend", systemImage: "person.crop.circle.badge.minus")
                            }
                        }
                        .labelStyle(.iconOnly)
                    } label: {
                        HStack {
                            Avatar(name: friend.name, size: 32, avatarURL: friend.avatarURL)
                            Text(friend.name)
                        }
                    }
                }
            }
            .listRowBackground(Palette.card)
            if let error { Section { InlineError(text: error) } }
        }
        .scrollContentBackground(.hidden)
        .background(AppBackground())
        .disabled(working)
        .navigationTitle("Manage friends")
        .task { await load() }
        .refreshable { await load() }
        .alert("Remove friend?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { friend in
            Button("Remove", role: .destructive) { perform { try await store.removeFriend(friend.userID) } }
            Button("Keep friend", role: .cancel) {}
        } message: { friend in
            Text("Remove \(friend.name) from your friends list?")
        }
    }

    private func showRequestNotice() {
        notice = "If this person can receive your request, it will appear in their Invitations."
    }

    private func answer(_ invitation: GroupInvitation, accept: Bool) {
        perform { _ = try await store.answer(invitation, accept: accept) }
    }

    private func load() async {
        do {
            async let friendList = store.friends()
            async let sharedList = store.sharedPeople()
            async let incoming = store.invitations()
            async let outgoing = store.sentFriendRequests()
            (friends, shared, received, sent) = try await (friendList, sharedList, incoming.filter { $0.kind == "friend" }, outgoing)
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func perform(_ operation: @escaping () async throws -> Void) {
        working = true
        error = nil
        notice = nil
        Task {
            defer { working = false }
            do {
                try await operation()
                await load()
            } catch { self.error = error.localizedDescription }
        }
    }
}
