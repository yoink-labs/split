import SwiftUI
import Network
import ClerkKit

@MainActor final class ExpenseStore: ObservableObject {
    @Published private(set) var state = DiskState()
    @Published private(set) var syncing = false
    @Published private(set) var online = true
    @Published var error: String?
    @Published var pendingInvite: String?
    private var scope: String?
    private var demo = false
    private var monitor = NWPathMonitor()
    private var generation = UUID()
    private let baseURL = URL(string: "https://split-api.yoinklabs.dev")!
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
        generation = UUID(); syncing = false; self.scope = userID; self.demo = demo; state = DiskState(); error = nil
        guard let userID else { return }
        if demo { state.snapshot = Fixtures.snapshot() }
        else {
            do { let url = try file(for: userID); if FileManager.default.fileExists(atPath: url.path) { state = try JSONDecoder().decode(DiskState.self, from: Data(contentsOf: url)) } }
            catch { self.error = "Could not open your saved expenses. Your existing file has been kept."; scope = nil; return }
            await sync()
        }
    }
    func entries(in group: ExpenseGroup) -> [LedgerEntry] { entries.filter { $0.groupID == group.id } }
    func group(_ id: String) -> ExpenseGroup? { groups.first { $0.id == id } }
    func create(name: String, kind: String, currency: String, names: [String], userID: String, displayName: String) throws {
        guard scope != nil else { throw LedgerError.invalid("Sign in again before adding a group.") }
        let id = UUID().uuidString
        let members = [Person(groupID: id, userID: userID, name: displayName)] + names.map { Person(groupID: id, name: $0) }
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
    private func request(path: String, body: Data? = nil) async throws -> Data {
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
    func invite(group: ExpenseGroup, memberID: String) async throws -> URL {
        guard !demo else { throw LedgerError.invalid("Sign in to create a real invitation. This is a sample group.") }
        await sync()
        guard !state.outbox.contains(where: { $0.id == group.id }) else { throw LedgerError.invalid("Connect to the internet and sync this group before inviting someone.") }
        let data = try await request(path: "/v1/groups/\(group.id)/invites", body: JSONEncoder().encode(["memberID": memberID]))
        return try JSONDecoder().decode(InviteResponse.self, from: data).url
    }
    func receive(_ url: URL) {
        if url.host == "split-api.yoinklabs.dev", url.path.hasPrefix("/join/") { pendingInvite = url.lastPathComponent }
        else if url.scheme == "com.yoinklabs.split", url.host == "join" { pendingInvite = url.lastPathComponent }
    }
    func join() async {
        guard let token = pendingInvite, scope != nil else { return }
        guard !demo else { error = "Leave the sample and sign in to accept your invitation."; return }
        do { _ = try await request(path: "/v1/join", body: JSONEncoder().encode(["token":token])); pendingInvite = nil; await sync() }
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
        let e = [LedgerEntry(id:"demo-dinner",groupID:id,title:"Dinner in Palermo",amount:8400000,currency:"ARS",paidBy:people[0].id,splits:people.map{Portion(memberID:$0.id,amount:2800000)}),LedgerEntry(id:"demo-coffee",groupID:id,title:"Coffee & medialunas",amount:1850000,currency:"ARS",paidBy:people[1].id,splits:[Portion(memberID:people[0].id,amount:616667),Portion(memberID:people[1].id,amount:616667),Portion(memberID:people[2].id,amount:616666)]),LedgerEntry(id:"demo-stay",groupID:id,title:"A place for the weekend",amount:18000,currency:"USD",paidBy:people[2].id,splits:people.map{Portion(memberID:$0.id,amount:6000)})]
        return Snapshot(groups:[group,house],entries:e)
    }
}
