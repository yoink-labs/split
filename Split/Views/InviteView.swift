import SwiftUI
import CoreImage.CIFilterBuiltins

struct InviteView: View {
    var group: ExpenseGroup
    @EnvironmentObject private var store: ExpenseStore
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var adding = false
    @State private var links: [String: URL] = [:]
    @State private var copied: String?
    @State private var busy: String?
    @State private var errors: [String: String] = [:]
    private var current: ExpenseGroup { store.group(group.id) ?? group }
    private var placeholders: [Person] { current.members.filter { $0.userID == nil } }
    private var joined: [Person] { current.members.filter { $0.userID != nil } }

    var body: some View {
        NavigationStack {
            ScrollView {
                Group {
                    if sizeClass == .regular {
                        HStack(alignment: .top, spacing: 20) {
                            groupInvite.frame(maxWidth: 380)
                            peopleColumn
                        }
                    } else {
                        VStack(spacing: 18) {
                            groupInvite
                            peopleColumn
                        }
                    }
                }
                .padding(16)
                .frame(maxWidth: 860)
                .frame(maxWidth: .infinity)
            }
            .background(AppBackground())
            .ledgerDestinations()
            .navigationTitle(Text(verbatim: "People & invites"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $adding) {
                MemberEditor { draft in _ = try await store.addMember(groupID: group.id, draft: draft) }
            }
        }
    }

    // MARK: - Group invitation

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
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("People · \(current.members.count)").font(.headline).foregroundStyle(Palette.ink)
                    Text(placeholders.isEmpty ? "Everyone has joined." : "Send a personal link so a placeholder can claim their history.")
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                Button { adding = true } label: {
                    Label("Add", systemImage: "person.badge.plus")
                }
                .buttonStyle(GhostButton())
                .accessibilityLabel("Add person")
            }
            if !placeholders.isEmpty {
                VStack(spacing: 10) {
                    ForEach(placeholders) { member in placeholderRow(member) }
                }
            }
            if !joined.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Joined").font(.splitEyebrow).foregroundStyle(.secondary)
                    FlowLayout(spacing: 6) {
                        ForEach(joined) { member in
                            NavigationLink(value: LedgerRoute.member(group: current.id, seat: member.id)) {
                                PersonChip(
                                    name: member.name,
                                    label: member.userID == session.userID ? "You" : member.name,
                                    compact: true
                                )
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("Opens \(member.name)'s charges")
                        }
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassSurface(cornerRadius: 16, tint: Palette.card.opacity(0.45))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func placeholderRow(_ member: Person) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Avatar(name: member.name, size: 34)
                VStack(alignment: .leading, spacing: 1) {
                    Text(member.name).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
                    Text("Placeholder · not joined yet").font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                NavigationLink(value: LedgerRoute.member(group: current.id, seat: member.id)) {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(width: 44, height: 44)
                        .foregroundStyle(Palette.ink)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("View \(member.name)'s charges")
                if links[member.id] == nil {
                    createButton(key: member.id, member: member, title: "Invite", onHero: false)
                }
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
                do { links[key] = try await store.invite(group: current, memberID: member?.id) }
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
