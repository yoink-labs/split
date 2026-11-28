import SwiftUI
import CoreImage.CIFilterBuiltins
import CryptoKit

struct InviteView: View {
    var group: ExpenseGroup
    @EnvironmentObject private var store: ExpenseStore
    @EnvironmentObject private var session: SessionStore
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var adding = false
    @State private var managing: Person?
    @State private var claimEmails: [String: String] = [:]
    @State private var notice: String?
    @State private var sending = false
    @State private var links: [String: URL] = [:]
    @State private var copied: String?
    @State private var busy: String?
    @State private var errors: [String: String] = [:]
    @State private var active: [ActiveInvite] = []
    @State private var inviteToRevoke: ActiveInvite?
    @State private var inviteError: String?
    @State private var revoking = false
    private var current: ExpenseGroup { store.group(group.id) ?? group }
    private var placeholders: [Person] { current.members.filter { $0.userID == nil && $0.removed != true } }
    private var joined: [Person] { current.members.filter { $0.userID != nil && $0.removed != true } }

    private var canManage: Bool {
        current.members.contains { $0.userID == session.userID && $0.userID != nil && $0.removed != true }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if sizeClass == .regular && canManage {
                HStack(alignment: .top, spacing: 20) {
                    peopleColumn
                    inviteColumn.frame(maxWidth: 380)
                }
            } else {
                peopleColumn
                if canManage { inviteColumn }
            }
        }
        .task(id: canManage) { await loadInvites() }
        .alert("Revoke this invitation?", isPresented: Binding(
            get: { inviteToRevoke != nil },
            set: { if !$0 { inviteToRevoke = nil } }
        ), presenting: inviteToRevoke) { invite in
            Button("Revoke invite", role: .destructive) { Task { await revoke(invite) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("The link and code will stop working immediately.")
        }
        .sheet(isPresented: $adding, onDismiss: { Task { await loadInvites() } }) {
            MemberEditor { draft in _ = try await store.addMember(groupID: group.id, draft: draft) }
        }
        .sheet(item: $managing) { member in
            GroupMemberEditor(groupID: group.id, member: member, isMe: member.userID == session.userID,
                              onChange: { await loadInvites() }, claimEmail: claimEmails[member.id] ?? "",
                              inviteEmail: claimEmails[member.id] ?? "")
        }
    }

    // MARK: - Group invitation

    private var inviteColumn: some View {
        VStack(alignment: .leading, spacing: 12) {
            groupInvite
            if let notice { Label(notice, systemImage: "checkmark.circle").font(.subheadline) }
            if !active.isEmpty {
                SectionHeader(title: "Active invites")
                Card {
                    ForEach(active) { invite in
                        VStack(alignment: .leading, spacing: 0) {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(invite.memberName.map { "For " + $0 } ?? "General group invite")
                                        .font(.subheadline.weight(.semibold))
                                    if let email = invite.recipientEmail {
                                        Text(email).font(.subheadline)
                                    }
                                    Text("Expires \(invite.expirationDate.formatted(date: .abbreviated, time: .omitted))")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button(role: .destructive) { inviteToRevoke = invite } label: {
                                    Image(systemName: "trash")
                                        .frame(minWidth: HitTarget.minimum, minHeight: HitTarget.minimum)
                                }
                                .accessibilityLabel(invite.memberName.map { "Revoke invite for " + $0 } ?? "Revoke group invite")
                                .disabled(revoking || sending)
                            }
                            if let email = invite.recipientEmail {
                                Button("Resend email") { Task { await resend(invite, email: email) } }
                                    .buttonStyle(GhostButton())
                                    .accessibilityLabel("Resend invitation to " + email)
                                    .disabled(sending || revoking)
                            }
                        }
                        if invite.id != active.last?.id { Divider() }
                    }
                }
            }
            if let inviteError {
                InlineError(text: inviteError)
                Button("Reload invitations") { Task { await loadInvites() } }
                    .buttonStyle(GhostButton())
            }
        }
    }

    private func loadInvites() async {
        do {
            guard canManage else {
                claimEmails = [:]
                active = []
                return
            }
            async let invitations = store.activeInvites(groupID: current.id)
            async let contacts = store.memberClaimEmails(groupID: current.id)
            let (newInvites, newContacts) = try await (invitations, contacts)
            active = newInvites
            claimEmails = newContacts
            let activeIDs = Set(newInvites.map(\.id))
            links = links.filter { activeIDs.contains(digest($0.value)) }
            inviteError = nil
        } catch where !SyncFailure.isCancellation(error) {
            inviteError = error.localizedDescription
        } catch {}
    }

    private func digest(_ url: URL) -> String {
        SHA256.hash(data: Data(url.lastPathComponent.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func resend(_ invite: ActiveInvite, email: String) async {
        guard !sending else { return }
        sending = true
        notice = nil
        defer { sending = false }
        do {
            try await store.resendInvite(invite, groupID: current.id)
            notice = "Invitation resent to " + email
            await loadInvites()
        } catch {
            inviteError = error.localizedDescription
        }
    }

    private func revoke(_ invite: ActiveInvite) async {
        guard !revoking else { return }
        revoking = true
        defer { revoking = false }
        do {
            try await store.revokeInvite(invite, groupID: current.id)
            let key = invite.memberID ?? "group"
            if let url = links[key] {
                if digest(url) == invite.id { links[key] = nil }
            }
            active.removeAll { $0.id == invite.id }
            inviteError = nil
        } catch {
            inviteError = error.localizedDescription
        }
    }

    private var groupInvite: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Image(systemName: current.symbol)
                    .font(.system(size: 18, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .foregroundStyle(Palette.hero)
                    .background(Palette.lime, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Invite to \(current.name)")
                        .font(.headline)
                        .foregroundStyle(Palette.onHero)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Anyone with the link or code can join.")
                        .font(.caption)
                        .foregroundStyle(Palette.lime.opacity(0.7))
                }
            }
            if let link = links["group"] {
                QRCodeView(text: link.absoluteString)
                    .frame(maxWidth: 220)
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel("QR code for the group invite link")
                VStack(alignment: .leading, spacing: 4) {
                    Text("Invite code")
                        .font(.splitEyebrow)
                        .foregroundStyle(Palette.lime.opacity(0.6))
                    Text(Self.display(link.lastPathComponent))
                        .font(.title3.monospaced().weight(.semibold))
                        .foregroundStyle(Palette.onHero)
                        .textSelection(.enabled)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                        .accessibilityLabel("Invite code " + link.lastPathComponent)
                }
                HStack(spacing: 8) {
                    ShareLink(item: link, subject: Text("Join \(current.name) on Split"),
                              message: Text("Join \(current.name) on Split: ")) {
                        Label("Share", systemImage: "square.and.arrow.up")
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 16)
                            .frame(minHeight: 44)
                            .foregroundStyle(Palette.hero)
                            .background(Palette.lime, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    copyButton(link, key: "group", onHero: true)
                    Spacer(minLength: 0)
                }
                Label("Expires in 7 days. Make a new one any time; older links keep working until they expire.", systemImage: "clock")
                    .font(.caption)
                    .foregroundStyle(Palette.lime.opacity(0.6))
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Create a link, QR code and short code. It works for seven days.")
                    .font(.subheadline)
                    .foregroundStyle(Palette.onHero.opacity(0.8))
                    .fixedSize(horizontal: false, vertical: true)
                createButton(key: "group", member: nil, title: "Create invite link", onHero: true)
            }
            if let error = errors["group"] { heroError(error) }
        }
        .padding(20)
        .background(Palette.hero, in: RoundedRectangle(cornerRadius: Radius.header))
        .overlay(RoundedRectangle(cornerRadius: Radius.header).stroke(Palette.lime.opacity(0.16), lineWidth: 1))
    }

    // MARK: - People

    private var peopleColumn: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                SectionHeader(title: "Members")
                Spacer()
                if canManage {
                    Button { adding = true } label: { Label("Add person", systemImage: "person.badge.plus") }
                        .buttonStyle(GhostButton())
                }
            }
            if !joined.isEmpty {
                SectionHeader(title: "Joined")
                Card {
                    ForEach(joined) { member in
                        memberRow(member)
                        if member.id != joined.last?.id { Divider() }
                    }
                }
            }
            if !placeholders.isEmpty {
                SectionHeader(title: "Placeholders")
                ForEach(placeholders) { member in placeholderRow(member) }
            }
            let archived = current.members.filter { $0.removed == true }
            if !archived.isEmpty {
                SectionHeader(title: "Archived")
                Card {
                    ForEach(archived) { member in
                        memberRow(member)
                        if member.id != archived.last?.id { Divider() }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func memberRow(_ member: Person) -> some View {
        HStack {
            NavigationLink(value: LedgerRoute.member(group: current.id, seat: member.id)) {
                HStack(spacing: 10) {
                    Avatar(name: member.name, size: 34)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(member.userID == session.userID ? "You" : member.name)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Palette.ink)
                        if let email = claimEmails[member.id] {
                            Text("Claim email \(email)").font(.caption).foregroundStyle(.secondary)
                        }
                        let addresses = Set(active.filter { $0.memberID == member.id }.compactMap(\.recipientEmail))
                        ForEach(addresses.sorted(), id: \.self) { email in
                            Text("Invited \(email)").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .frame(maxWidth: .infinity, minHeight: HitTarget.minimum, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens \(member.name)’s charges")
            if canManage && !store.isDemo {
                Button { managing = member } label: {
                    Image(systemName: "ellipsis.circle")
                        .frame(minWidth: HitTarget.minimum, minHeight: HitTarget.minimum)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Manage \(member.name)")
            }
        }
    }

    private func placeholderRow(_ member: Person) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            memberRow(member)
            if canManage && links[member.id] == nil {
                createButton(key: member.id, member: member, title: "Create personal link", onHero: false)
            }
            if let link = links[member.id] {
                HStack(spacing: 8) {
                    ShareLink(item: link, subject: Text("Your Split invite"),
                              message: Text("\(member.name), join \(current.name) on Split: ")) {
                        Label("Share", systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(GhostButton())
                    copyButton(link, key: member.id, onHero: false)
                    Spacer(minLength: 0)
                }
                Text("Only \(member.name) should open this link. It links their account to this seat and its history.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let error = errors[member.id] { InlineError(text: error).font(.caption) }
        }
        .padding(14)
        .glassSurface(cornerRadius: 16, tint: Palette.card.opacity(0.5))
    }

    // MARK: - Actions

    private func createButton(key: String, member: Person?, title: String, onHero: Bool) -> some View {
        Button {
            busy = key
            errors[key] = nil
            Task {
                defer { busy = nil }
                do { links[key] = try await store.invite(group: current, memberID: member?.id)
                await loadInvites() }
                catch { errors[key] = error.localizedDescription }
            }
        } label: {
            HStack(spacing: 6) {
                if busy == key { ProgressView().controlSize(.small).tint(onHero ? Palette.hero : Palette.ink) }
                else { Image(systemName: "link") }
                Text(busy == key ? "Creating…" : (errors[key] == nil ? title : "Try again"))
            }
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, 16)
            .frame(minHeight: 44)
            .foregroundStyle(onHero ? Palette.hero : Palette.ink)
            .background(onHero ? AnyShapeStyle(Palette.lime) : AnyShapeStyle(Palette.raised), in: Capsule())
            .overlay(Capsule().stroke(onHero ? Color.clear : Palette.line, lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .disabled(busy != nil)
        .accessibilityLabel(member.map { "Invite \($0.name)" } ?? title)
    }

    private func copyButton(_ link: URL, key: String, onHero: Bool) -> some View {
        let code = link.lastPathComponent
        // Group invitations have a short code; personal ones only work as a link.
        let short = code.count <= 14
        return Button {
            UIPasteboard.general.string = short ? code : link.absoluteString
            withAnimation(.snappy) { copied = key }
            UIAccessibility.post(notification: .announcement, argument: "Copied")
        } label: {
            Label(copied == key ? "Copied" : (short ? "Copy code" : "Copy link"),
                  systemImage: copied == key ? "checkmark" : "doc.on.doc")
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .foregroundStyle(onHero ? Palette.onHero : Palette.ink)
                .background(onHero ? Palette.onHero.opacity(0.12) : Palette.raised, in: Capsule())
                .overlay(Capsule().stroke(onHero ? Palette.onHero.opacity(0.18) : Palette.line, lineWidth: 1))
                .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(.plain)
    }

    private func heroError(_ text: String) -> some View {
        Label(text, systemImage: "exclamationmark.circle.fill")
            .font(.caption)
            .foregroundStyle(Color(red: 1, green: 0.72, blue: 0.60))
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Groups a 12-character code as XXXX-XXXX-XXXX. Other tokens stay as they are.
    static func display(_ code: String) -> String {
        guard code.count == 12, !code.contains("-") else { return code }
        let chars = Array(code)
        return [0, 4, 8].map { String(chars[$0..<$0 + 4]) }.joined(separator: "-")
    }
}

/// A crisp QR code rendered with CoreImage. Dark modules on a light tile so
/// cameras read it in both appearances.
struct QRCodeView: View {
    var text: String

    var body: some View {
        Group {
            if let image = Self.image(for: text) {
                Image(uiImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
            } else {
                Image(systemName: "qrcode").font(.largeTitle).foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    static func image(for text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)),
              let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
