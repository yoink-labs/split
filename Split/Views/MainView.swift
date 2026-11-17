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
        }
    }
}
struct GroupsView: View {
    var friends: Bool
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var store: ExpenseStore
    @State private var showCreate = false
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
        NavigationStack {
            ScrollView {
                VStack(alignment:.leading,spacing:24) {
                    HStack { VStack(alignment:.leading,spacing:5) { Text(session.isDemo ? "A LITTLE PREVIEW" : "LESS MATH, MORE LIVING").font(.system(size:10,weight:.semibold)).tracking(1.8).foregroundStyle(.secondary); Text(friends ? "Better together." : "Your shared life.").font(.system(size:32,weight:.semibold,design:.rounded)).tracking(-1) }; Spacer(); Image("SplitLogo").resizable().frame(width:46,height:46).clipShape(RoundedRectangle(cornerRadius:13)).accessibilityLabel("Split logo") }.padding(.top,12)
                    if !friends { summary }
                    if store.isDemo { Label("Sample groups · changes stay in this preview",systemImage:"sparkles").font(.caption).foregroundStyle(.secondary) }
                    if store.pending > 0 || !store.online { Label(store.online ? "\(store.pending) changes waiting to sync" : "Offline · new expenses are saved here",systemImage:store.online ? "arrow.triangle.2.circlepath" : "wifi.slash").font(.caption).foregroundStyle(Palette.green) }
                    if let error = store.error { VStack(alignment:.leading,spacing:8) { ErrorText(text:error); Button("Retry sync") { Task { await store.sync() } }.font(.caption.bold()) } }
                    HStack { Text(friends ? "Friends" : "Groups").font(.title3.bold()); Spacer(); Text("\(groups.count)").font(.subheadline).foregroundStyle(.secondary); Button { showCreate=true } label: { Image(systemName:"plus").font(.headline).frame(width:34,height:34).background(Palette.green.opacity(0.08)).clipShape(Circle()) }.accessibilityLabel(friends ? "Add friend" : "Create group") }
                    if groups.isEmpty {
                        Card { VStack(alignment:.leading,spacing:16) { Image(systemName:friends ? "person.2" : "sparkles").font(.largeTitle).foregroundStyle(Palette.green); Text(friends ? "Start with a friend." : "Every good plan starts here.").font(.title2.weight(.semibold)); Text(friends ? "Keep a running tab with someone. Add their name, then invite them with a link." : "Make a group for a trip, your home, or whatever brings you together.").foregroundStyle(.secondary); Button(friends ? "Add a friend" : "Make your first group") { showCreate=true }.buttonStyle(SolidButton()) } }
                    }
                    ForEach(groups) { group in NavigationLink { GroupDetail(groupID:group.id) } label: { GroupCard(group:group) }.buttonStyle(.plain) }
                    Text("Good friends don’t need a subscription.").font(.caption).foregroundStyle(.secondary).frame(maxWidth:.infinity).padding(.top,12)
                }.padding(24).frame(maxWidth:680)
            }.frame(maxWidth:.infinity).background(Palette.background).toolbar(.hidden,for:.navigationBar).refreshable { await store.sync() }.sheet(isPresented:$showCreate) { CreateGroupView(friend:friends) }
        }
    }
    private var summary: some View {
        VStack(alignment:.leading,spacing:16) {
            HStack { Text("AT A GLANCE").font(.system(size:10,weight:.semibold)).tracking(1.8); Spacer(); Image(systemName:"arrow.up.right") }.opacity(0.75)
            if totals.isEmpty { Text("A fresh start.").font(.system(size:33,weight:.medium,design:.rounded)); Text("Your balances will feel right at home here.").font(.subheadline).opacity(0.75) }
            else { ForEach(totals,id:\.0) { currency,value in HStack(alignment:.firstTextBaseline) { Text(Money.text(abs(value),currency)).font(.system(size:28,weight:.medium,design:.rounded)).minimumScaleFactor(0.6); Spacer(); Text(value > 0 ? "you’re owed" : "you owe").font(.caption).opacity(0.8) } }; Text("Each currency stays in its own lane.").font(.caption).opacity(0.7) }
        }.padding(24).foregroundStyle(Palette.lime).frame(maxWidth:.infinity,alignment:.leading).background(Palette.ink).clipShape(RoundedRectangle(cornerRadius:28))
    }
}
struct GroupCard: View {
    var group: ExpenseGroup
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var store: ExpenseStore
    var body: some View {
        Card {
            HStack(alignment:.top,spacing:16) {
                Image(systemName:group.symbol).font(.title2).frame(width:58,height:58).background((group.kind == "trip" ? Palette.lime : Palette.green.opacity(0.15))).foregroundStyle(group.kind == "trip" ? Palette.ink : Palette.green).clipShape(RoundedRectangle(cornerRadius:18))
                VStack(alignment:.leading,spacing:6) { Text(group.name).font(.title3.weight(.semibold)); Text("\(group.members.count) people · \(group.kind == "trip" ? "Trip" : group.kind == "home" ? "Home" : "Friend")").font(.caption).foregroundStyle(.secondary) }
                Spacer(); Image(systemName:"chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.secondary).padding(.top,8)
            }
            Divider().padding(.vertical,12)
            HStack { HStack(spacing:-8) { ForEach(Array(group.members.prefix(4))) { p in Avatar(name:p.name,size:28).overlay(Circle().stroke(Palette.card,lineWidth:2)) } }; Spacer(); Text(store.entries(in:group).isEmpty ? "Ready for your first expense" : "\(store.entries(in:group).count) shared moments").font(.caption).foregroundStyle(.secondary) }
        }
    }
}
struct ActivityView: View {
    @EnvironmentObject var store: ExpenseStore
    var body: some View { NavigationStack { ScrollView { LazyVStack(spacing:12) { if store.entries.isEmpty { ContentUnavailableView("Nothing to catch up on",systemImage:"clock",description:Text("Expenses and settle-ups appear here.")) }; ForEach(store.entries) { e in if let g=store.group(e.groupID) { Card { EntryRow(entry:e,group:g,showGroup:true) } } } }.padding(24).frame(maxWidth:680) }.frame(maxWidth:.infinity).background(Palette.background).navigationTitle("Activity").refreshable { await store.sync() } } }
}
struct EntryRow: View {
    var entry: LedgerEntry; var group: ExpenseGroup; var showGroup = false
    var body: some View {
        HStack(alignment:.top,spacing:12) {
            Image(systemName:entry.kind == "settlement" ? "checkmark.arrow.trianglehead.counterclockwise" : "receipt").font(.body).foregroundStyle(Palette.green).frame(width:38,height:38).background(Palette.green.opacity(0.08)).clipShape(RoundedRectangle(cornerRadius:12))
            VStack(alignment:.leading,spacing:5) { Text(entry.title).font(.subheadline.weight(.semibold)); Text("\(group.members.first(where:{$0.id == entry.paidBy})?.name ?? "Someone") \(entry.kind == "settlement" ? "settled up" : "paid")\(showGroup ? " · " + group.name : "")").font(.caption).foregroundStyle(.secondary); if let date=ISO8601DateFormatter().date(from:entry.createdAt) { Text(date,style:.date).font(.caption2).foregroundStyle(.tertiary) } }
            Spacer(minLength:4); Text(Money.text(entry.amount,entry.currency)).font(.subheadline.weight(.medium)).multilineTextAlignment(.trailing).monospacedDigit()
        }
    }
}
struct AccountView: View {
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var store: ExpenseStore
    @State private var confirmSignOut = false
    var body: some View { NavigationStack { Form {
        Section { HStack(spacing:16) { Avatar(name:session.displayName,size:56); VStack(alignment:.leading) { Text(session.displayName).font(.title2.bold()); Text(session.isDemo ? "Sample preview" : "Your Yoink account").foregroundStyle(.secondary) } } }
        Section("Made for everyone") { Label("Free. Every feature.",systemImage:"heart"); Text("Split is a Yoink Labs app. No subscription, no Pro tier. Just a simpler way to share.").foregroundStyle(.secondary); Link("Visit Yoink Labs",destination:URL(string:"https://yoinklabs.dev")!) }
        if !session.isDemo {
            NavigationLink("Connected computers") { DeviceAccessView() }
        }
        Section("Sync") { Text(session.isDemo ? "Sample data stays on this device." : store.pending == 0 ? "No pending changes" : "\(store.pending) changes saved on this device"); if !session.isDemo { Button("Sync now") { Task { await store.sync() } } }; if let error=store.error { ErrorText(text:error) } }
        Section { Button(session.isDemo ? "Leave preview & sign in" : "Sign out",role:.destructive) { confirmSignOut=true }; if let error=session.error { ErrorText(text:error) }; Text("Split 0.1.0 (2)").font(.caption).foregroundStyle(.secondary) }
    }.navigationTitle("You").confirmationDialog("Sign out?",isPresented:$confirmSignOut,titleVisibility:.visible) { Button("Sign out",role:.destructive) { Task { await session.signOut() } } } message: { Text(store.pending > 0 ? "\(store.pending) unsynced changes will stay on this device for this account. Sign back in to upload them." : "Your shared expenses will be here when you return.") } } }
}
