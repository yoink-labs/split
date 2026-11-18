import SwiftUI
import Network
import ClerkKit

@MainActor final class ExpenseStore: ObservableObject {
    @Published private(set) var state = DiskState()
    @Published private(set) var syncing = false
    @Published private(set) var online = true
    @Published var error: String?
    @Published var joinedGroupID: String?
    @Published var pendingInvite: String?
    private var scope: String?
    private var demoPhotos: [String:Data] = [:]
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
        demoPhotos.removeAll()
        generation = UUID(); syncing = false; self.scope = userID.map { baseURL.host == "127.0.0.1" ? "local-" + $0 : $0 }; joinedGroupID = nil; self.demo = demo; state = DiskState(); error = nil
        guard let scope else { return }
        if demo { state.snapshot = Fixtures.snapshot() }
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
    func request(path: String, body: Data? = nil) async throws -> Data {
        guard let token = try await Clerk.shared.auth.getToken() else { throw LedgerError.invalid("Sign in again to sync. Your pending changes are saved on this device.") }
        var req = URLRequest(url: baseURL.appendingPathComponent(path)); req.timeoutInterval = 20
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body { req.httpMethod = "POST"; req.httpBody = body; req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
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

enum Fixtures {
    static func snapshot() -> Snapshot {
        let id = "demo-buenos-aires", home = "demo-home"
        let people = [Person(id:"demo-alex",groupID:id,userID:"demo-user",name:"Alex"),Person(id:"demo-maya",groupID:id,name:"Maya"),Person(id:"demo-jules",groupID:id,name:"Jules")]
        let group = ExpenseGroup(id:id,name:"Buenos Aires",kind:"trip",currency:"ARS",members:people)
        let house = ExpenseGroup(id:home,name:"Our place",kind:"home",currency:"USD",members:[Person(id:"demo-home-alex",groupID:home,userID:"demo-user",name:"Alex"),Person(id:"demo-home-sam",groupID:home,name:"Sam")])
        var e = [LedgerEntry(id:"demo-dinner",groupID:id,title:"Dinner in Palermo",amount:8400000,currency:"ARS",paidBy:people[0].id,splits:people.map{Portion(memberID:$0.id,amount:2800000)}),LedgerEntry(id:"demo-coffee",groupID:id,title:"Coffee & medialunas",amount:1850000,currency:"ARS",paidBy:people[1].id,splits:[Portion(memberID:people[0].id,amount:616667),Portion(memberID:people[1].id,amount:616667),Portion(memberID:people[2].id,amount:616666)]),LedgerEntry(id:"demo-stay",groupID:id,title:"A place for the weekend",amount:18000,currency:"USD",paidBy:people[2].id,splits:people.map{Portion(memberID:$0.id,amount:6000)})]
        let dinner=ReceiptBill(items:[
            Purchase(title:"Empanadas",amount:1800000,memberIDs:[people[0].id,people[1].id]),
            Purchase(title:"Mushroom pasta",amount:2500000,memberIDs:[people[2].id]),
            Purchase(title:"Grilled provoleta",amount:2700000)
        ],tax:700000,tip:700000)
        e[0].bill=dinner; e[0].splitMode = .exact; e[0].category="Dining"
        e[0].splits=(try? dinner.split(payer:people[0].id)) ?? e[0].splits
        e[1].category="Dining"; e[2].category="Lodging"
        return Snapshot(groups:[group,house],entries:e)
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
