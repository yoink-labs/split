import SwiftUI
struct MainView: View {
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var store: ExpenseStore
    @State private var tab = 0
    var body: some View {
        TabView(selection:$tab) {
            GroupsView(friends:false).tabItem { Label("Groups",systemImage:"square.grid.2x2") }.tag(0)
            GroupsView(friends:true).tabItem { Label("Friends",systemImage:"person.2") }.tag(1)
            ActivityView().tabItem { Label("Activity",systemImage:"clock.arrow.circlepath") }.tag(2)
            AccountView().tabItem { Label("You",systemImage:"person.crop.circle") }.tag(3)
        }.onChange(of:store.joinedGroupID) { _,id in if id != nil { tab=0 } }
    }
}
struct GroupsView: View {
    var friends: Bool
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var store: ExpenseStore
    @State private var showCreate = false
    @State private var joining = false
    @State private var path: [String] = []
    private var groups: [ExpenseGroup] { store.groups.filter { friends ? $0.kind == "friend" : $0.kind != "friend" } }
    private var totals: [(String,Int64)] {
        Money.currencies.compactMap { currency in
            let value = store.groups.reduce(Int64(0)) { sum,g in
                guard let me = g.members.first(where:{$0.userID == session.userID}) else { return sum }
                return sum + (Ledger.balances(store.entries(in:g),currency:currency)[me.id] ?? 0)
            }
            return value == 0 ? nil : (currency,value)
        }
    }
    var body: some View {
        NavigationStack(path:$path) {
            ScrollView {
                VStack(alignment:.leading,spacing:13) {
                    HStack { Text(friends ? "Friends" : "Groups").font(.title2.bold()).accessibilityAddTraits(.isHeader); Spacer()
                        Image("SplitLogo").resizable().frame(width:30,height:30).clipShape(RoundedRectangle(cornerRadius:11)).accessibilityHidden(true)
                    }
                    if !friends && !groups.isEmpty { summary }
                    ViewThatFits(in:.horizontal) {
                        HStack { groupActions }
                        VStack(alignment:.leading) { groupActions }
                    }.controlSize(.large)
                    if store.isDemo { Label("Sample groups · changes stay in this preview",systemImage:"sparkles").font(.caption).foregroundStyle(.secondary) }
                    if store.pending > 0 || !store.online { Label(store.online ? "\(store.pending) changes waiting to sync" : "Offline · new expenses are saved here",systemImage:store.online ? "arrow.triangle.2.circlepath" : "wifi.slash").font(.caption).foregroundStyle(Palette.green) }
                    if let error = store.error { VStack(alignment:.leading,spacing:8) { ErrorText(text:error); Button("Retry sync") { Task { await store.sync() } }.font(.caption.bold()) } }
                    if groups.isEmpty {
                        ContentUnavailableView(friends ? "No friends yet" : "No groups yet",systemImage:friends ? "person.2" : "person.3",description:Text(friends ? "Add a friend to start a shared tab." : "Create a group or join one with an invite code."))
                    }
                    ForEach(groups) { group in NavigationLink(value:group.id) { GroupCard(group:group) }.buttonStyle(.plain) }
                }.padding(16).frame(maxWidth:680)
            }.frame(maxWidth:.infinity).background(Palette.background).toolbar(.hidden,for:.navigationBar).refreshable { await store.sync() }.onChange(of:store.joinedGroupID,initial:true) { _,id in if !friends, let id { path=[id]; store.joinedGroupID=nil } }.navigationDestination(for:String.self) { GroupDetail(groupID:$0) }.sheet(isPresented:$joining) { JoinGroupView { id in path.append(id) } }.sheet(isPresented:$showCreate) { CreateGroupView(friend:friends) }
        }
    }
    @ViewBuilder private var groupActions: some View {
        Button { showCreate=true } label: { Label(friends ? "Add friend" : "New group",systemImage:"plus") }.buttonStyle(.borderedProminent)
        if !friends { Button { joining=true } label: { Label("Join group",systemImage:"link") }.buttonStyle(.bordered) }
    }
    private var summary: some View {
        VStack(alignment:.leading,spacing:9) {
            HStack { Text("Your balance").font(.subheadline.weight(.semibold)); Spacer() }.opacity(0.75)
            if totals.isEmpty { Text("All settled").font(.title3.weight(.semibold)) }
            else { ForEach(totals,id:\.0) { currency,value in HStack(alignment:.firstTextBaseline) { Text(Money.text(abs(value),currency)).font(.title3.weight(.semibold)).minimumScaleFactor(0.6); Spacer(); Text(value > 0 ? "you’re owed" : "you owe").font(.caption).opacity(0.8) } } }
        }.padding(16).foregroundStyle(Palette.lime).frame(maxWidth:.infinity,alignment:.leading).background(Palette.ink).clipShape(RoundedRectangle(cornerRadius:16))
    }
}
struct GroupCard: View {
    var group: ExpenseGroup
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var store: ExpenseStore
    var body: some View {
        Card {
            HStack(alignment:.top,spacing:9) {
                Image(systemName:group.symbol).font(.title2).frame(width:42,height:42).background((group.kind == "trip" ? Palette.lime : Palette.green.opacity(0.15))).foregroundStyle(group.kind == "trip" ? Palette.ink : Palette.green).clipShape(RoundedRectangle(cornerRadius:12))
                VStack(alignment:.leading,spacing:6) { Text(group.name).font(.headline); Text("\(group.members.count) \(group.members.count == 1 ? "person" : "people") · \(group.kind == "trip" ? "Trip" : group.kind == "home" ? "Home" : "Friend")").font(.caption).foregroundStyle(.secondary) }
                Spacer(); Image(systemName:"chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.secondary).padding(.top,8)
            }
            let open=store.entries(in:group).compactMap(\.bill).reduce(0){$0+$1.openCount}
            if open>0 { Label("\(open) open \(open==1 ? "purchase" : "purchases")",systemImage:"basket").font(.caption.weight(.medium)).foregroundStyle(Palette.green).padding(.top,6) }

        }
    }
}
struct ActivityView: View {
    @EnvironmentObject var store: ExpenseStore
    var body: some View { NavigationStack { ScrollView { LazyVStack(spacing:12) { if store.entries.isEmpty { ContentUnavailableView("Nothing to catch up on",systemImage:"clock",description:Text("Expenses and settle-ups appear here.")) }; ForEach(store.entries) { e in if let g=store.group(e.groupID) { Card { EntryRow(entry:e,group:g,showGroup:true) } } } }.padding(16).frame(maxWidth:680) }.frame(maxWidth:.infinity).background(Palette.background).navigationTitle("Activity").navigationBarTitleDisplayMode(.inline).refreshable { await store.sync() } } }
}
struct EntryRow: View {
    var entry: LedgerEntry; var group: ExpenseGroup; var showGroup = false
    var body: some View {
        HStack(alignment:.top,spacing:12) {
            Image(systemName:entry.kind == "settlement" ? "checkmark.arrow.trianglehead.counterclockwise" : "receipt").font(.body).foregroundStyle(Palette.green).frame(width:38,height:38).background(Palette.green.opacity(0.08)).clipShape(RoundedRectangle(cornerRadius:12))
            VStack(alignment:.leading,spacing:5) { Text(entry.title).font(.subheadline.weight(.semibold)); Text("\(group.members.first(where:{$0.id == entry.paidBy})?.name ?? "Someone") \(entry.kind == "settlement" ? "settled up" : "paid")\(showGroup ? " · " + group.name : "")").font(.caption).foregroundStyle(.secondary); if let bill=entry.bill, bill.openCount>0 { Text("Open · "+Money.text(bill.openTotal,entry.currency)).font(.caption.weight(.medium)).foregroundStyle(Palette.green) }; if let date=ISO8601DateFormatter().date(from:entry.createdAt) { Text(date,style:.date).font(.caption2).foregroundStyle(.tertiary) } }
            Spacer(minLength:4); Text(Money.text(entry.amount,entry.currency)).font(.subheadline.weight(.medium)).multilineTextAlignment(.trailing).monospacedDigit()
        }
    }
}
struct AccountView: View {
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var store: ExpenseStore
    @State private var confirmSignOut = false
    private static func license(_ project:String)->String {
        guard let url=Bundle.main.url(forResource:project,withExtension:"txt",subdirectory:"licenses"),
              let text=try? String(contentsOf:url,encoding:.utf8) else {return "License unavailable."}
        return text
    }
    private var version: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? ""
        let build = info?["CFBundleVersion"] as? String ?? ""
        return "Split \(version) (\(build))"
    }
    var body: some View { NavigationStack { Form {
        Section { HStack(spacing:9) { Avatar(name:session.displayName,size:56); VStack(alignment:.leading) { Text(session.displayName).font(.title2.bold()); Text(session.isDemo ? "Sample preview" : "Your Yoink account").foregroundStyle(.secondary) } } }
        Section("Made for everyone") { Label("Free. Every feature.",systemImage:"heart"); Text("Split is a Yoink Labs app. No subscription, no Pro tier. Just a simpler way to share.").foregroundStyle(.secondary); Link("Visit Yoink Labs",destination:URL(string:"https://yoinklabs.dev")!) }
        NavigationLink("Third-party notices") {
            List {
                ForEach(["manawg","sharetab","spliit","split-pro"],id:\.self) { project in
                    NavigationLink(project) {
                        ScrollView { Text(verbatim:Self.license(project)).font(.footnote).textSelection(.enabled).padding() }.navigationTitle(project)
                    }
                }
            }.navigationTitle("Third-party notices")
        }
        if !session.isDemo {
            NavigationLink("Connected computers") { DeviceAccessView() }
        }
        Section("Sync") { Text(session.isDemo ? "Sample data stays on this device." : store.pending == 0 ? "No pending changes" : "\(store.pending) changes saved on this device"); if !session.isDemo { Button("Sync now") { Task { await store.sync() } } }; if let error=store.error { ErrorText(text:error) } }
        Section { Button(session.isDemo ? "Leave preview & sign in" : "Sign out",role:.destructive) { confirmSignOut=true }; if let error=session.error { ErrorText(text:error) }; Text(version).font(.caption).foregroundStyle(.secondary) }
    }.navigationTitle("You").navigationBarTitleDisplayMode(.inline).confirmationDialog("Sign out?",isPresented:$confirmSignOut,titleVisibility:.visible) { Button("Sign out",role:.destructive) { Task { await session.signOut() } } } message: { Text(store.pending > 0 ? "\(store.pending) unsynced changes will stay on this device for this account. Sign back in to upload them." : "Your shared expenses will be here when you return.") } } }
}
