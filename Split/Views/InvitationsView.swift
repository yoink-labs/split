import SwiftUI

/// Group invitations, friend requests, and placeholder link notifications.
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
                            Text("Group invitations, friend requests, and linked placeholders appear here.")
                        }
                        .listRowBackground(Color.clear)
                    }
                    ForEach(invitations) { invitation in
                        Group {
                            if invitation.kind == "friend" || invitation.kind == "linked" {
                                peopleCard(invitation)
                            } else {
                                InvitationCard(invitation: invitation, working: working) { accept in
                                    Task { await answer(invitation, accept: accept) }
                                }
                            }
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

    private func peopleCard(_ invitation: GroupInvitation) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                if invitation.kind == "friend" {
                    HStack(spacing: 12) {
                        Avatar(name: invitation.inviterName ?? "Split member", size: 40)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(invitation.inviterName ?? "Split member").font(.headline).foregroundStyle(Palette.ink)
                            Text("Wants to add you as a friend").font(.subheadline).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 8)
                        Button("Decline") { Task { await answer(invitation, accept: false) } }
                            .buttonStyle(.bordered).buttonBorderShape(.capsule).tint(Palette.ink)
                        Button("Accept") { Task { await answer(invitation, accept: true) } }
                            .buttonStyle(.borderedProminent).buttonBorderShape(.capsule).tint(Palette.lime).foregroundStyle(Palette.hero)
                    }
                } else {
                    Label("Placeholder linked", systemImage: "link").font(.caption)
                    Text(invitation.groupName).font(.headline)
                    Text("\(invitation.inviterName ?? "A group member") linked you to \(invitation.memberName ?? "a placeholder"). Their expense history is now yours.")
                    Button("Dismiss") { Task { await answer(invitation, accept: false) } }.buttonStyle(.bordered)
                }
            }
            .disabled(working != nil)
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
                        Text(invitation.groupName).font(.headline).foregroundStyle(Palette.ink)
                        Text("\(kindLabel) · \(source) · \(invitation.memberCount) \(invitation.memberCount == 1 ? "member" : "members")")
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
                        .buttonBorderShape(.capsule)
                        .tint(Palette.ink)
                        .accessibilityLabel("Decline invitation to \(invitation.groupName)")
                    Button(working == invitation.id ? "Joining…" : "Accept") { respond(true) }
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                        .tint(Palette.lime)
                        .foregroundStyle(Palette.hero)
                        .accessibilityLabel("Accept invitation to \(invitation.groupName)")
                }
                .disabled(working != nil)
            }
        }
    }
}
