import SwiftUI
import Network
import ClerkKit

@MainActor final class ExpenseStore: ObservableObject {
    @Published private(set) var state = DiskState()
    @Published private(set) var syncing = false
    @Published private(set) var online = true
    @Published private(set) var currentUserID: String?
    @Published private(set) var comments: [String:[EntryComment]] = [:]
    @Published var error: String?
    @Published var joinedGroupID: String?
    @Published var pendingInvite: String?
    private var scope: String?
    private var demoPhotos: [String:Data] = [:]
    private var demoComments: [String:[EntryComment]] = [:]
    private var demo = false
    private var monitor = NWPathMonitor()
    private var generation = UUID()
    private let baseURL: URL = {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-splitLocalAPI") {
            return URL(string:"http://127.0.0.1:8787")!
        }
        #endif
        return URL(string:"https://split-api.yoinklabs.dev")!
    }()
    var groups: [ExpenseGroup] { state.snapshot.groups }
    var entries: [LedgerEntry] { state.snapshot.entries.sorted { $0.createdAt > $1.createdAt } }
    var pending: Int { state.outbox.count }
    var isDemo: Bool { demo }
    init() {
        monitor.pathUpdateHandler = { [weak self] path in Task { @MainActor in
            self?.online = path.status == .satisfied
            if path.status == .satisfied { await self?.sync() }
        } }
        monitor.start(queue: DispatchQueue(label: "split.connectivity"))
    }
    deinit { monitor.cancel() }
    private func file(for scope: String) throws -> URL {
        let folder = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("Split", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let safe = Data(scope.utf8).base64EncodedString().replacingOccurrences(of: "/", with: "_")
        var url = folder.appendingPathComponent(safe + ".json")
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        if FileManager.default.fileExists(atPath: url.path) { try url.setResourceValues(values) }
        return url
    }
    private func persist(_ next: DiskState) throws {
        guard let scope, !demo else { state = next; return }
        let data = try JSONEncoder().encode(next)
        try data.write(to: file(for: scope), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        state = next
    }
    func activate(userID: String?, demo: Bool) async {
        demoPhotos.removeAll(); demoComments.removeAll(); comments.removeAll()
        generation = UUID(); syncing = false; self.scope = userID.map { baseURL.host == "127.0.0.1" ? "local-" + $0 : $0 }; joinedGroupID = nil; self.demo = demo; state = DiskState(); error = nil
        currentUserID = userID
        guard let scope else { return }
        if demo { state.snapshot = Fixtures.snapshot(); demoComments = Fixtures.comments() }
        else {
            do { let url = try file(for: scope); if FileManager.default.fileExists(atPath: url.path) { state = try JSONDecoder().decode(DiskState.self, from: Data(contentsOf: url)) } }
            catch { self.error = "Could not open your saved expenses. Your existing file has been kept."; self.scope = nil; return }
            await sync()
        }
    }
    func entries(in group: ExpenseGroup) -> [LedgerEntry] { entries.filter { $0.groupID == group.id } }
    func group(_ id: String) -> ExpenseGroup? { groups.first { $0.id == id } }
    func create(name: String, kind: String, currency: String, people: [MemberDraft], userID: String, displayName: String) throws {
        guard scope != nil else { throw LedgerError.invalid("Sign in again before adding a group.") }
        let id = UUID().uuidString
        let members = [Person(groupID: id, userID: userID, name: displayName)] + people.map { Person(id:$0.id, groupID:id, userID:$0.userID, name:$0.name, email:$0.email, phone:$0.phone) }
        let group = ExpenseGroup(id: id, name: name, kind: kind, currency: currency, members: members)
        var next = state; next.snapshot.groups.insert(group, at: 0)
        if !demo { next.outbox.append(OutboxItem(id: id, path: "/v1/groups", body: try JSONEncoder().encode(group))) }
        try persist(next); Task { await sync() }
    }
    func add(_ entry: LedgerEntry) throws {
        guard scope != nil else { throw LedgerError.invalid("Sign in again before adding an expense.") }
        var next = state; next.snapshot.entries.append(entry)
        if !demo { next.outbox.append(OutboxItem(id: entry.id, path: "/v1/entries", body: try JSONEncoder().encode(entry))) }
        try persist(next); Task { await sync() }
    }
    func request(path: String, body: Data? = nil, method: String? = nil) async throws -> Data {
        guard let token = try await Clerk.shared.auth.getToken() else { throw LedgerError.invalid("Sign in again to sync. Your pending changes are saved on this device.") }
        var req = URLRequest(url: baseURL.appendingPathComponent(path)); req.timeoutInterval = 20
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body { req.httpMethod = method ?? "POST"; req.httpBody = body; req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        else if let method { req.httpMethod = method }
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(APIError.self, from: data))?.error ?? "Sync is unavailable. Your changes are safe on this device."
            throw LedgerError.invalid(message)
        }
        return data
    }
    func sync() async {
        guard scope != nil, !demo, online, !syncing else { return }
        let current = generation; syncing = true; error = nil
        defer { if current == generation { syncing = false } }
        do {
            // FIFO makes an offline group reach the server before its expenses.
            while let item = state.outbox.first {
                _ = try await request(path: item.path, body: item.body)
                guard current == generation else { return }
                var next = state; next.outbox.removeAll { $0.id == item.id }; try persist(next)
            }
            let data = try await request(path: "/v1/snapshot")
            guard current == generation else { return }
            var remote = try JSONDecoder().decode(Snapshot.self, from: data)
            // Changes can arrive while a request is suspended. Never replace pending local work.
            let ids = Set(state.outbox.map(\.id))
            remote.groups += groups.filter { ids.contains($0.id) && !remote.groups.map(\.id).contains($0.id) }
            remote.entries += entries.filter { ids.contains($0.id) && !remote.entries.map(\.id).contains($0.id) }
            try persist(DiskState(snapshot: remote, outbox: state.outbox))
            if !state.outbox.isEmpty { Task { await self.syncAfterCurrent() } }
        } catch { if current == generation { self.error = error.localizedDescription } }
    }
    private func syncAfterCurrent() async { await Task.yield(); await sync() }
    private func waitForSync() async throws {
        let current = generation
        while syncing && current == generation { try await Task.sleep(for: .milliseconds(80)) }
        guard scope != nil, current == generation else { throw LedgerError.invalid("Sign in again to continue.") }
    }

    private func post(_ path: String, _ data: Data) async throws -> Data {
        guard online else { throw LedgerError.invalid("Connect to the internet to continue.") }
        let current = generation
        try await waitForSync()
        if pending > 0 { await sync() }
        guard current == generation, pending == 0 else { throw LedgerError.invalid(error ?? "Wait for your changes to finish syncing.") }
        let result = try await request(path: path, body: data)
        guard current == generation else { throw LedgerError.invalid("Your account changed. Try again.") }
        return result
    }

    func groupAction(_ group:String,_ action:String,_ values:[String:Any]) async throws -> Data {
        guard !isDemo else { throw LedgerError.invalid("Sign in to change shared group settings.") }
        let result=try await post("/v1/groups/"+group+"/"+action,JSONSerialization.data(withJSONObject:values))
        try await waitForSync()
        await sync()
        return result
    }
    func search(_ query: String) async throws -> [SplitUser] {
        if demo { return [] }
        let result = try await post("/v1/people/search", JSONEncoder().encode(["query":query]))
        return try JSONDecoder().decode([SplitUser].self, from:result)
    }

    func updateGroup(_ group: ExpenseGroup, name: String, currency: String, simplify: Bool) async throws {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, clean.count <= 80 else { throw LedgerError.invalid("Give the group a name of up to 80 characters.") }
        if demo {
            guard let index = groups.firstIndex(where: { $0.id == group.id }) else { throw LedgerError.invalid("Group unavailable.") }
            var next = state
            next.snapshot.groups[index].name = clean
            next.snapshot.groups[index].currency = currency
            next.snapshot.groups[index].simplify = simplify
            try persist(next)
        } else {
            _ = try await groupAction(group.id, "update", ["name": clean, "currency": currency, "simplify": simplify])
        }
    }

    func setArchived(_ group: ExpenseGroup, archived: Bool) async throws {
        if demo {
            guard let index = groups.firstIndex(where: { $0.id == group.id }) else { throw LedgerError.invalid("Group unavailable.") }
            var next = state
            next.snapshot.groups[index].archived = archived
            try persist(next)
        } else {
            _ = try await groupAction(group.id, "archive", ["archived": archived])
        }
    }

    func leaveGroup(_ group: ExpenseGroup) async throws {
        if demo {
            var next = state
            next.snapshot.groups.removeAll { $0.id == group.id }
            next.snapshot.entries.removeAll { $0.groupID == group.id }
            try persist(next)
        } else {
            _ = try await groupAction(group.id, "leave", [:])
            var next = state
            next.snapshot.groups.removeAll { $0.id == group.id }
            next.snapshot.entries.removeAll { $0.groupID == group.id }
            try persist(next)
        }
    }

    func comments(for entryID: String) -> [EntryComment]? {
        if demo { return demoComments[entryID] ?? [] }
        return comments[entryID]
    }

    func loadComments(_ entryID: String) async throws -> [EntryComment] {
        if demo { return demoComments[entryID] ?? [] }
        let data = try await request(path: "/v1/entries/\(entryID)/comments")
        let list = try JSONDecoder().decode(CommentList.self, from: data).comments
        comments[entryID] = list
        return list
    }

    func addComment(_ entryID: String, body: String) async throws -> EntryComment {
        let clean = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, clean.count <= 2000 else { throw LedgerError.invalid("Write a comment of up to 2,000 characters.") }
        if demo {
            let comment = EntryComment(id: UUID().uuidString, entryID: entryID, authorUserID: "demo-user", authorName: "Alex", body: clean, createdAt: ISO8601DateFormatter().string(from: Date()), mine: true)
            demoComments[entryID, default: []].append(comment)
            bumpCommentCount(entryID, by: 1)
            return comment
        }
        let data = try await post("/v1/entries/\(entryID)/comments", JSONEncoder().encode(["body": clean]))
        let comment = try JSONDecoder().decode(EntryComment.self, from: data)
        comments[entryID, default: []].append(comment)
        bumpCommentCount(entryID, by: 1)
        return comment
    }

    func deleteComment(_ entryID: String, commentID: String) async throws {
        if demo {
            demoComments[entryID]?.removeAll { $0.id == commentID }
        } else {
            _ = try await post("/v1/entries/\(entryID)/comments/\(commentID)", Data("{}".utf8))
            comments[entryID]?.removeAll { $0.id == commentID }
        }
        bumpCommentCount(entryID, by: -1)
    }

    func toggleLike(_ entry: LedgerEntry) async throws {
        if demo {
            guard let index = state.snapshot.entries.firstIndex(where: { $0.id == entry.id }) else { return }
            var next = state
            let liked = !(next.snapshot.entries[index].likedByMe ?? false)
            next.snapshot.entries[index].likedByMe = liked
            next.snapshot.entries[index].likeCount = max(0, (next.snapshot.entries[index].likeCount ?? 0) + (liked ? 1 : -1))
            try persist(next)
            return
        }
        struct Result: Decodable { var liked: Bool; var count: Int }
        let data = try await post("/v1/entries/\(entry.id)/like", Data("{}".utf8))
        let result = try JSONDecoder().decode(Result.self, from: data)
        if let index = state.snapshot.entries.firstIndex(where: { $0.id == entry.id }) {
            var next = state
            next.snapshot.entries[index].likedByMe = result.liked
            next.snapshot.entries[index].likeCount = result.count
            try persist(next)
        }
    }

    private func bumpCommentCount(_ entryID: String, by delta: Int) {
        guard let index = state.snapshot.entries.firstIndex(where: { $0.id == entryID }) else { return }
        var next = state
        next.snapshot.entries[index].commentCount = max(0, (next.snapshot.entries[index].commentCount ?? 0) + delta)
        try? persist(next)
    }

    func addMember(groupID: String, draft: MemberDraft) async throws -> String {
        guard let index = groups.firstIndex(where: { $0.id == groupID }) else { throw LedgerError.invalid("Group unavailable.") }
        if demo {
            var next = state
            next.snapshot.groups[index].members.append(Person(id:draft.id,groupID:groupID,userID:draft.userID,name:draft.name))
            try persist(next)
            return draft.id
        }
        let data = try await post("/v1/groups/\(groupID)/members", JSONEncoder().encode(draft))
        let result = try JSONDecoder().decode(MemberResult.self,from:data)
        try await waitForSync()
        await sync()
        return result.id
    }

    func change(_ original: LedgerEntry, to replacement: LedgerEntry?) async throws {
        guard demo || original.editable == true else { throw LedgerError.invalid("Only the person who recorded this entry can change it.") }
        if demo {
            var next = state
            next.snapshot.entries.removeAll { $0.id == original.id }
            if let replacement { next.snapshot.entries.append(replacement) }
            try persist(next)
        } else {
            let action = replacement == nil ? "delete" : "edit"
            _ = try await post("/v1/entries/\(original.id)/\(action)", JSONEncoder().encode(["original":original,"entry":replacement]))
            try await waitForSync()
            await sync()
        }
    }

    func saveReceipted(_ entry: LedgerEntry, original: LedgerEntry?, photos: [ReceiptPhoto]) async throws {
        guard !photos.isEmpty else {
            if let original { try await change(original,to:entry) } else { try add(entry) }
            return
        }
        if demo {
            var copy = entry
            copy.receiptIDs = (original?.receiptIDs ?? []) + photos.map(\.id)
            for photo in photos { demoPhotos[photo.id] = photo.data }
            if let original { try await change(original,to:copy) } else { try add(copy) }
            return
        }
        let encoder=JSONEncoder()
        var payload:[String:Any]
        let path:String
        if let original {
            payload=["entry":try JSONSerialization.jsonObject(with:encoder.encode(entry)), "original":try JSONSerialization.jsonObject(with:encoder.encode(original))]
            path="/v1/entries/\(entry.id)/edit"
        } else {
            payload=try JSONSerialization.jsonObject(with:encoder.encode(entry)) as? [String:Any] ?? [:]
            path="/v1/entries"
        }
        payload["photos"]=try JSONSerialization.jsonObject(with:encoder.encode(photos))
        _ = try await post(path,JSONSerialization.data(withJSONObject:payload))
        try await waitForSync()
        await sync()
    }
    func image(entry:String,id:String) async throws -> Data {
        if demo, let data=demoPhotos[id] { return data }
        return try await request(path:"/v1/entries/\(entry)/receipts/\(id)")
    }
    func claim(_ entry:LedgerEntry,item:Purchase?,people:[String]) async throws {
        guard var bill=entry.bill, !bill.closed else { throw LedgerError.invalid("This receipt is closed.") }
        if demo {
            var updated=entry
            if let item, let index=bill.items.firstIndex(where:{$0.id==item.id}) { bill.items[index].memberIDs=people; bill.items[index].roundingSeats=nil }
            else { for i in bill.items.indices where bill.items[i].memberIDs.isEmpty { bill.items[i].memberIDs=people }; bill.closed=true }
            updated.bill=bill; updated.splits=try bill.split(payer:entry.paidBy)
            try await change(entry,to:updated)
        } else {
            var data:[String:Any]=["memberIDs":people]
            if let item { data["itemID"]=item.id; data["original"]=item.memberIDs;data["mergeEdits"]=true }
            let action=item == nil ? "close" : "claim"
            do { _ = try await post("/v1/entries/\(entry.id)/\(action)",JSONSerialization.data(withJSONObject:data)) }
            catch { await sync(); throw error }
            try await waitForSync()
            await sync()
        }
    }

    func invite(group: ExpenseGroup, memberID: String? = nil) async throws -> URL {
        guard !demo else { throw LedgerError.invalid("Sign in to share a group invitation.") }
        let data = try await post("/v1/groups/\(group.id)/invites", JSONEncoder().encode(["memberID":memberID]))
        return try JSONDecoder().decode(InviteResponse.self, from:data).url
    }

    static func inviteToken(_ input: String) -> String? {
        var raw = input.trimmingCharacters(in:.whitespacesAndNewlines)
        if let url = URL(string:raw), url.scheme != nil {
            let web = url.scheme == "https" && url.host == "split-api.yoinklabs.dev" && url.pathComponents.count == 3 && url.pathComponents[1] == "join"
            let app = url.scheme == "com.yoinklabs.split" && url.host == "join" && url.pathComponents.count == 2
            guard web || app else { return nil }
            raw = url.lastPathComponent
        }
        if raw.range(of:#"^[a-f0-9-]{72}$"#,options:.regularExpression) != nil { return raw }
        let code = raw.uppercased().filter { !$0.isWhitespace && $0 != "-" }
        return code.range(of:#"^[A-HJ-NP-Z2-9]{12}$"#,options:.regularExpression) == nil ? nil : code
    }

    func receive(_ url: URL) {
        if let token = Self.inviteToken(url.absoluteString) { pendingInvite = token }
    }

    func accept(_ token: String) async throws -> String? {
        guard !demo else { throw LedgerError.invalid("Sign in to join a group.") }
        let result = try await post("/v1/join", JSONEncoder().encode(["token":token]))
        let groupID = try JSONDecoder().decode(JoinResult.self,from:result).groupID
        pendingInvite = nil
        try await waitForSync()
        await sync()
        return groupID
    }

    func join() async {
        guard let token = pendingInvite else { return }
        do { joinedGroupID = try await accept(token) }
        catch { self.error = error.localizedDescription }
    }
}
private struct APIError: Decodable { var error: String }
private struct InviteResponse: Decodable { var url: URL }
private struct CommentList: Decodable { var comments: [EntryComment] }

enum Fixtures {
    static func snapshot() -> Snapshot {
        let trip = "demo-buenos-aires", home = "demo-home", spain = "demo-spain", sam = "demo-friend-sam", maya = "demo-friend-maya"
        let people = [
            Person(id:"demo-alex",groupID:trip,userID:"demo-user",name:"Alex"),
            Person(id:"demo-maya",groupID:trip,userID:"demo-maya-account",name:"Maya"),
            Person(id:"demo-jules",groupID:trip,name:"Jules"),
            Person(id:"demo-harris",groupID:trip,userID:"demo-harris-account",name:"Harris")
        ]
        let group = ExpenseGroup(id:trip,name:"Buenos Aires",kind:"trip",currency:"ARS",members:people,simplify:true)
        let houseMembers = [Person(id:"demo-home-alex",groupID:home,userID:"demo-user",name:"Alex"),Person(id:"demo-home-sam",groupID:home,userID:"demo-sam-account",name:"Sam"),Person(id:"demo-home-nina",groupID:home,name:"Nina")]
        let house = ExpenseGroup(id:home,name:"Our place",kind:"home",currency:"USD",members:houseMembers,simplify:true)
        let spainMembers = [Person(id:"demo-spain-alex",groupID:spain,userID:"demo-user",name:"Alex"),Person(id:"demo-spain-harris",groupID:spain,userID:"demo-harris-account",name:"Harris"),Person(id:"demo-spain-sanjit",groupID:spain,name:"Sanjit"),Person(id:"demo-spain-rock",groupID:spain,name:"Rock")]
        let spainGroup = ExpenseGroup(id:spain,name:"Spain",kind:"trip",currency:"EUR",members:spainMembers,simplify:true)
        let samGroup = ExpenseGroup(id:sam,name:"Sam",kind:"friend",currency:"USD",members:[Person(id:"demo-sam-alex",groupID:sam,userID:"demo-user",name:"Alex"),Person(id:"demo-sam-sam",groupID:sam,userID:"demo-sam-account",name:"Sam")],simplify:false)
        let mayaGroup = ExpenseGroup(id:maya,name:"Maya",kind:"friend",currency:"USD",members:[Person(id:"demo-maya-alex",groupID:maya,userID:"demo-user",name:"Alex"),Person(id:"demo-maya-maya",groupID:maya,userID:"demo-maya-account",name:"Maya")],simplify:false)

        func entry(_ id:String, _ group:String, _ title:String, _ amount:Int64, _ currency:String, _ paidBy:String, _ splits:[(String,Int64)], category:String? = nil, notes:String? = nil, day:String = "2026-11-17T18:30:00Z") -> LedgerEntry {
            LedgerEntry(id:id,groupID:group,title:title,amount:amount,currency:currency,paidBy:paidBy,splits:splits.map{Portion(memberID:$0.0,amount:$0.1)},category:category,createdAt:day,notes:notes)
        }

        var e: [LedgerEntry] = []
        e.append(entry("demo-dinner",trip,"Guerrín dinner (pizza, empanadas, beer)",20845000,"ARS",people[3].id,[("demo-alex",5200000),("demo-maya",4200000),("demo-jules",5200000),("demo-harris",6245000)],category:"Dining",notes:"Split the provoleta three ways. Harris covered the tip in cash."))
        e.append(entry("demo-uber",trip,"Uber EZE to Palermo",7592500,"ARS",people[3].id,[("demo-alex",1898125),("demo-maya",1898125),("demo-jules",1898125),("demo-harris",1898125)],category:"Transport",day:"2026-11-17T09:10:00Z"))
        e.append(entry("demo-coffee",trip,"Coffee & medialunas",1850000,"ARS",people[1].id,[("demo-alex",616667),("demo-maya",616667),("demo-jules",616666)],category:"Dining",day:"2026-11-16T14:05:00Z"))
        e.append(entry("demo-stay",trip,"A place for the weekend",18000,"USD",people[2].id,[("demo-alex",6000),("demo-maya",6000),("demo-jules",6000)],category:"Lodging",day:"2026-11-15T12:00:00Z"))
        e.append(entry("demo-wine",trip,"Wine tasting in San Telmo",4300000,"ARS",people[0].id,[("demo-alex",1433333),("demo-maya",1433333),("demo-jules",1433334)],category:"Entertainment",day:"2026-11-14T19:00:00Z"))
        e.append(entry("demo-ride",trip,"Uber to Av. Corrientes",884100,"ARS",people[3].id,[("demo-alex",221025),("demo-maya",221025),("demo-jules",221025),("demo-harris",221025)],category:"Transport",day:"2026-11-13T21:15:00Z"))
        e.append(entry("demo-rainforest",spain,"Rainforest dinner",62109,"EUR",spainMembers[1].id,[("demo-spain-alex",15527),("demo-spain-harris",15527),("demo-spain-sanjit",15527),("demo-spain-rock",15528)],category:"Dining",notes:"Table for four, set menu.",day:"2026-11-12T20:00:00Z"))
        e.append(entry("demo-boat",spain,"WeBoat Tour",47044,"EUR",spainMembers[2].id,[("demo-spain-alex",11761),("demo-spain-harris",11761),("demo-spain-sanjit",11761),("demo-spain-rock",11761)],category:"Travel",day:"2026-11-09T10:00:00Z"))
        e.append(entry("demo-rent",home,"November rent",240000,"USD",houseMembers[0].id,[("demo-home-alex",80000),("demo-home-sam",80000),("demo-home-nina",80000)],category:"Rent",day:"2026-11-01T08:00:00Z"))
        e.append(entry("demo-groceries",home,"Sunday groceries",9214,"USD",houseMembers[1].id,[("demo-home-alex",3071),("demo-home-sam",3071),("demo-home-nina",3072)],category:"Groceries",day:"2026-11-08T17:40:00Z"))
        e.append(entry("demo-utilities",home,"Internet",6000,"USD",houseMembers[0].id,[("demo-home-alex",2000),("demo-home-sam",2000),("demo-home-nina",2000)],category:"Utilities",day:"2026-11-05T09:00:00Z"))
        e.append(entry("demo-sam-tickets",sam,"Concert tickets",12000,"USD","demo-sam-alex",[("demo-sam-alex",6000),("demo-sam-sam",6000)],category:"Entertainment",day:"2026-11-10T15:00:00Z"))
        e.append(entry("demo-sam-grocery",sam,"Trader Joe’s run",6420,"USD","demo-sam-sam",[("demo-sam-alex",3210),("demo-sam-sam",3210)],category:"Groceries",day:"2026-11-04T18:20:00Z"))
        e.append(entry("demo-maya-dinner",maya,"Maya’s birthday dinner",15000,"USD","demo-maya-maya",[("demo-maya-alex",5000),("demo-maya-maya",10000)],category:"Dining",day:"2026-11-02T20:00:00Z"))

        e[0].bill = ReceiptBill(items: [
            Purchase(title:"Empanadas",amount:3800000,memberIDs:[people[0].id,people[1].id,people[3].id]),
            Purchase(title:"Mushroom pizza",amount:6200000,memberIDs:[people[0].id,people[2].id,people[3].id]),
            Purchase(title:"Grilled provoleta",amount:4850000),
            Purchase(title:"Quilmes × 4",amount:5995000,memberIDs:[people[0].id,people[3].id])
        ],tax:0,tip:0)
        e[0].splitMode = .exact
        e[0].splits = (try? e[0].bill?.split(payer:people[3].id)) ?? e[0].splits
        e[0].likeCount = 3
        e[0].commentCount = 2
        e[1].likeCount = 1
        e[2].commentCount = 1
        e[4].likeCount = 2
        e[4].commentCount = 1
        e[0].notes = "Split the provoleta three ways. Harris covered the tip in cash."
        return Snapshot(groups:[group,house,spainGroup,samGroup,mayaGroup],entries:e)
    }

    static func comments() -> [String:[EntryComment]] {
        [
            "demo-dinner": [
                EntryComment(id:"demo-c1",entryID:"demo-dinner",authorUserID:"demo-maya-account",authorName:"Maya",body:"That provoleta was unreal. Same place next year?",createdAt:"2026-11-17T19:02:00Z",mine:false),
                EntryComment(id:"demo-c2",entryID:"demo-dinner",authorUserID:"demo-user",authorName:"Alex",body:"Agreed. I’ll add the tip next time.",createdAt:"2026-11-17T19:10:00Z",mine:true)
            ],
            "demo-coffee": [
                EntryComment(id:"demo-c3",entryID:"demo-coffee",authorUserID:"demo-user",authorName:"Alex",body:"Best medialunas of the trip.",createdAt:"2026-11-16T15:00:00Z",mine:true)
            ],
            "demo-wine": [
                EntryComment(id:"demo-c4",entryID:"demo-wine",authorUserID:"demo-maya-account",authorName:"Maya",body:"The Malbec flight was worth it.",createdAt:"2026-11-14T20:30:00Z",mine:false)
            ]
        ]
    }
}

struct SplitUser: Decodable, Identifiable {
    var userID: String
    var name: String
    var username: String?
    var id: String { userID }
}
struct MemberDraft: Codable {
    var id = UUID().uuidString
    var name: String
    var email: String?
    var phone: String?
    var userID: String?
}
private struct MemberResult: Decodable { var id: String }
private struct JoinResult: Decodable { var groupID: String? }
