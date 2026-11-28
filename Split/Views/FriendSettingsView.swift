import SwiftUI

struct FriendSettingsView: View {
    @EnvironmentObject private var store: ExpenseStore
    @State private var friends: [SplitUser] = []
    @State private var shared: [SplitUser] = []
    @State private var email = ""
    @State private var selectedUser = ""
    @State private var notice: String?
    @State private var error: String?
    @State private var working = false

    private var candidates: [SplitUser] {
        shared.filter { person in !friends.contains { $0.userID == person.userID } }
    }

    var body: some View {
        Form {
            Group {
            Section("Send a friend request") {
                TextField("Full email address", text: $email)
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
            Section("Your friends") {
                if friends.isEmpty { Text("Accepted requests appear here.").foregroundStyle(.secondary) }
                ForEach(friends) { friend in
                    HStack {
                        Avatar(name: friend.name)
                        Text(friend.name)
                        Spacer()
                        Button("Remove", role: .destructive) {
                            perform {
                                try await store.removeFriend(friend.userID)
                                await load()
                            }
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Remove \(friend.name)")
                    }
                }
            }
            if let error { InlineError(text: error) }
            }
            .listRowBackground(Palette.card)
        }
        .scrollContentBackground(.hidden)
        .background(AppBackground())
        .disabled(working)
        .navigationTitle("Friends")
        .task { await load() }
        .refreshable { await load() }
    }

    private func showRequestNotice() {
        notice = "If this person can receive your request, it will appear in their invitation inbox."
    }

    private func load() async {
        do {
            async let friendList = store.friends()
            async let sharedList = store.sharedPeople()
            (friends, shared) = try await (friendList, sharedList)
        } catch { self.error = error.localizedDescription }
    }

    private func perform(_ operation: @escaping () async throws -> Void) {
        working = true
        error = nil
        notice = nil
        Task {
            defer { working = false }
            do { try await operation() }
            catch { self.error = error.localizedDescription }
        }
    }
}
