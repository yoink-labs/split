import SwiftUI

/// Pending invitations to groups the account has not joined yet.
struct InvitationsView: View {
    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.dismiss) private var dismiss
    var showsClose = true
    var joined: (String) -> Void = { _ in }
    @State private var invitations: [GroupInvitation]?
    @State private var working: String?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if let error { Section { InlineError(text: error) } }
                if let invitations {
                    if invitations.isEmpty {
                        ContentUnavailableView {
                            Label("You’re all caught up", systemImage: "tray")
                        } description: {
                            Text("Invitations appear here when someone invites you in Split or emails an invite to your sign-in address.")
                        }
                        .listRowBackground(Color.clear)
                    }
                    ForEach(invitations) { invitation in
                        InvitationCard(invitation: invitation, working: working) { accept in
                            Task { await answer(invitation, accept: accept) }
                        }
                        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                    }
                } else if error == nil {
                    ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppBackground())
            .navigationTitle("Invitations")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if showsClose { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            }
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func load() async {
        do { invitations = try await store.invitations(); error = nil }
        catch { self.error = error.localizedDescription }
    }

    private func answer(_ invitation: GroupInvitation, accept: Bool) async {
        working = invitation.id; error = nil
        defer { working = nil }
        do {
            let groupID = try await store.answer(invitation, accept: accept)
            invitations?.removeAll { $0.id == invitation.id }
            if let groupID { dismiss(); joined(groupID) }
        } catch { self.error = error.localizedDescription }
    }
}

private struct InvitationCard: View {
    var invitation: GroupInvitation
    var working: String?
    var respond: (Bool) -> Void

    private var kindLabel: String {
        switch invitation.groupKind { case "trip": "Trip"; case "home": "Home"; default: "Group" }
    }
    private var source: String {
        invitation.kind == "email" ? "Sent to your verified email"
            : invitation.inviterName.map { "\($0) invited you" } ?? "You were invited"
    }

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: invitation.groupKind == "trip" ? "airplane" : "house")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(width: 40, height: 40)
                        .background(Palette.lime.opacity(0.35), in: RoundedRectangle(cornerRadius: 12))
                        .foregroundStyle(Palette.evergreen)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(kindLabel.uppercased()).font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                        Text(invitation.groupName).font(.headline).foregroundStyle(Palette.ink)
                        Text("\(source) · \(invitation.memberCount) \(invitation.memberCount == 1 ? "member" : "members")")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                if let member = invitation.memberName {
                    Text("You’ll take over **\(member)**’s place, with their expenses and balances.")
                        .font(.footnote)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Palette.lime.opacity(0.18), in: RoundedRectangle(cornerRadius: 10))
                }
                HStack(spacing: 10) {
                    Text("Expires \(invitation.expirationDate.formatted(date: .abbreviated, time: .omitted))")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Decline") { respond(false) }
                        .buttonStyle(.bordered)
                        .tint(Palette.ink)
                        .accessibilityLabel("Decline invitation to \(invitation.groupName)")
                    Button(working == invitation.id ? "Joining…" : "Accept") { respond(true) }
                        .buttonStyle(.borderedProminent)
                        .tint(Palette.evergreen)
                        .accessibilityLabel("Accept invitation to \(invitation.groupName)")
                }
                .disabled(working != nil)
            }
        }
    }
}

/// Look up people who use Split, then view a minimal profile or invite them to a group.
struct PeopleSearchView: View {
    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.dismiss) private var dismiss
    var showsClose = true
    @State private var query = ""
    @State private var results: [SplitUser]?
    @State private var searching = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Full email or first 3 letters of a name", text: $query)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .submitLabel(.search).onSubmit(search)
                    Button("Search", action: search)
                        .disabled(query.trimmingCharacters(in: .whitespacesAndNewlines).count < 3 || searching)
                } footer: {
                    Text("Split shows names only. Email addresses and phone numbers stay private, and people can turn off being found.")
                }
                if searching { ProgressView() }
                if let error { ErrorText(text: error) }
                if let results {
                    Section {
                        if results.isEmpty { Text("No one matched.").foregroundStyle(.secondary) }
                        ForEach(results) { person in
                            NavigationLink { PersonProfileView(person: person) } label: {
                                HStack(spacing: 12) { Avatar(name: person.name, size: 36); Text(person.name) }
                            }
                        }
                    } footer: { Text("Up to 10 people per search.") }
                }
            }
            .navigationTitle("Find people")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if showsClose { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            }
            .onChange(of: query) { _, _ in results = nil; error = nil }
        }
    }

    private func search() {
        guard !searching else { return }
        let submitted = query
        searching = true; error = nil
        Task {
            defer { searching = false }
            do { let found = try await store.search(submitted); if submitted == query { results = found } }
            catch { self.error = error.localizedDescription }
        }
    }
}

struct PersonProfileView: View {
    @EnvironmentObject private var store: ExpenseStore
    @EnvironmentObject private var session: SessionStore
    var person: SplitUser
    @State private var profile: PersonProfile?
    @State private var groupID = ""
    @State private var sending = false
    @State private var notice: String?
    @State private var error: String?

    private var invitable: [ExpenseGroup] {
        store.groups.filter { group in
            group.archived != true && !group.isFriend
                && group.members.contains { $0.userID == session.userID && $0.removed != true }
                && !group.members.contains { $0.userID == person.userID && $0.removed != true }
        }
    }

    var body: some View {
        Form {
            Section {
                HStack(spacing: 16) {
                    Avatar(name: person.name, size: 64)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(person.name).font(.title2.bold())
                        if let profile {
                            Text(profile.sharedGroups.isEmpty ? "You don’t share any groups yet" : "In \(profile.sharedGroups.count) of your groups")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(.vertical, 6)
            }
            if let shared = profile?.sharedGroups, !shared.isEmpty {
                Section("Shared groups") { ForEach(shared) { Text($0.name) } }
            }
            Section {
                if invitable.isEmpty {
                    Text("No groups to invite \(person.name) to yet.").foregroundStyle(.secondary)
                } else {
                    Picker("Group", selection: $groupID) {
                        ForEach(invitable) { Text($0.name).tag($0.id) }
                    }
                    Button(sending ? "Sending…" : "Send invitation", action: send).disabled(sending || groupID.isEmpty)
                }
                if let notice { Label(notice, systemImage: "paperplane.fill").foregroundStyle(Palette.evergreen) }
                if let error { ErrorText(text: error) }
            } header: { Text("Invite to a group") } footer: {
                Text("\(person.name) sees the invitation in Split and can accept or decline it.")
            }
        }
        .navigationTitle(person.name)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if groupID.isEmpty { groupID = invitable.first?.id ?? "" }
            do { profile = try await store.profile(person.userID) } catch { self.error = error.localizedDescription }
        }
    }

    private func send() {
        guard let group = invitable.first(where: { $0.id == groupID }) else { return }
        sending = true; error = nil; notice = nil
        Task {
            defer { sending = false }
            do {
                try await store.inviteUser(groupID: group.id, userID: person.userID)
                notice = "Invitation sent for \(group.name)."
            } catch { self.error = error.localizedDescription }
        }
    }
}
