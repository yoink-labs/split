import SwiftUI

struct InviteView: View {
    var group: ExpenseGroup
    @EnvironmentObject private var store: ExpenseStore
    @Environment(\.dismiss) private var dismiss
    @State private var adding = false
    @State private var links: [String:URL] = [:]
    @State private var copied: String?
    @State private var busy: String?
    @State private var error: String?
    private var current: ExpenseGroup { store.group(group.id) ?? group }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    invitation(member:nil)
                } header: { Text("Group invitation") } footer: {
                    Text("Anyone with this link or code can join for seven days. Create another whenever you need one.")
                }
                Section {
                    Button { adding=true } label: { Label("Add person",systemImage:"person.badge.plus") }
                    ForEach(current.members) { member in
                        VStack(alignment:.leading,spacing:6) {
                            NavigationLink(value:LedgerRoute.member(group:current.id,seat:member.id)) { HStack { Avatar(name:member.name,size:30); VStack(alignment:.leading) {
                                Text(member.name).font(.headline)
                                Text(member.userID == nil ? "Placeholder" : "Joined").font(.caption).foregroundStyle(.secondary)
                            } } }
                            if member.userID == nil { invitation(member:member) }
                        }.padding(.vertical,4)
                    }
                } header: { Text("People · \(current.members.count)") }
                if let error { ErrorText(text:error) }
            }.ledgerDestinations().navigationTitle(Text(verbatim:"People & invites")).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement:.confirmationAction) { Button("Done") { dismiss() } } }
                .sheet(isPresented:$adding) {
                    MemberEditor { draft in _ = try await store.addMember(groupID:group.id,draft:draft) }
                }
        }
    }

    @ViewBuilder private func invitation(member:Person?) -> some View {
        let key = member?.id ?? "group"
        if let link=links[key] {
            VStack(alignment:.leading,spacing:6) {
                Text(link.lastPathComponent).font(.title3.monospaced().weight(.semibold)).textSelection(.enabled)
                    .accessibilityLabel("Invite code " + link.lastPathComponent)
                ViewThatFits(in:.horizontal) {
                    HStack { share(link); Spacer(); copy(link,key) }
                    VStack(alignment:.leading) { share(link); copy(link,key) }
                }
            }
        } else {
            Button {
                busy=key; error=nil
                Task {
                    defer { busy=nil }
                    do { links[key]=try await store.invite(group:current,memberID:member?.id) }
                    catch { self.error=error.localizedDescription }
                }
            } label: {
                if busy==key { ProgressView() }
                else { Label(member == nil ? "Create group invite" : "Invite " + (member?.name ?? ""),systemImage:"link") }
            }.buttonStyle(.borderless).disabled(busy != nil)
        }
    }
    private func share(_ link:URL) -> some View {
        ShareLink(item:link) { Label("Share link",systemImage:"square.and.arrow.up") }.buttonStyle(.borderless)
    }
    private func copy(_ link:URL,_ key:String) -> some View {
        Button { UIPasteboard.general.string=link.lastPathComponent; copied=key } label: {
            Label(copied==key ? "Copied" : "Copy code",systemImage:"doc.on.doc")
        }.buttonStyle(.borderless)
    }
}
