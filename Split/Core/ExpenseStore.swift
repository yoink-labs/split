import SwiftUI
import Network
import ClerkKit

struct ActiveInvite: Decodable, Identifiable {
    let id: String
    let memberID: String?
    let memberName: String?
    let recipientEmail: String?
    /// Set for invitations sent to a Split account from people search.
    let recipientName: String?
    let expiresAt: Double

    var expirationDate: Date { Date(timeIntervalSince1970: expiresAt / 1000) }
}

private struct MemberClaimEmails: Decodable {
    struct Contact: Decodable {
        let memberID: String
        let email: String
    }
    let claimEmails: [Contact]
}

private struct ActiveInviteResponse: Decodable {
    let invites: [ActiveInvite]
}

@MainActor final class ExpenseStore: ObservableObject {
    @Published private(set) var state = DiskState()
    @Published private(set) var syncing = false
    /// False until this account has data to show (from disk or the first
    /// sync), so lists show a loading state instead of flashing "empty".
    @Published private(set) var hasLoaded = false
    @Published private(set) var online = true
    @Published private(set) var currentUserID: String?
    @Published private(set) var comments: [String:[EntryComment]] = [:]
    @Published var error: String?
    @Published var joinedGroupID: String?
    @Published var pendingInvite: String?
    private var scope: String?
    private var demoCombinations: [String: [LedgerEntry]] = [:]
    private var demoCombinationHistory: [CombinationEvent] = []
    private var demoPhotos: [String:Data] = [:]
    private var demoComments: [String:[EntryComment]] = [:]
    private var demoInbox: [InboxReceipt] = []
    private var demoFriends = Array(Fixtures.directory.prefix(1))
    private var demoLinks: [String: [MemberLink]] = [:]
    private var demoInvitations: [GroupInvitation] = Fixtures.invitations()
    private var demo = false
    private var monitor = NWPathMonitor()
    private var generation = UUID()
    private let flight = SingleFlight()
    private let baseURL: URL = {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-splitLocalAPI") {
            return URL(string:"http://127.0.0.1:8787")!
        }
        #endif
        return URL(string:"https://split-api.yoinklabs.dev")!
    }()
    var groups: [ExpenseGroup] { state.snapshot.groups }
    var entries: [LedgerEntry] { SnapshotMerge.ordered(state.snapshot.entries) }
    var unsentPayments: [LedgerEntry] { state.unsentPayments ?? [] }
    var pendingSettlements: [LedgerEntry] { state.snapshot.settlementRequests ?? [] }
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
        demoCombinations.removeAll(); demoCombinationHistory.removeAll()
        demoPhotos.removeAll(); demoComments.removeAll(); demoInbox.removeAll(); comments.removeAll()
        generation = UUID(); syncing = false; self.scope = userID.map { baseURL.host == "127.0.0.1" ? "local-" + $0 : $0 }; joinedGroupID = nil; self.demo = demo; state = DiskState(); error = nil; hasLoaded = false
        currentUserID = userID
        guard let scope else { return }
        if demo {
            state.snapshot = Fixtures.snapshot(); demoComments = Fixtures.comments(); hasLoaded = true
            #if DEBUG
            if StressFixtures.enabled { StressFixtures.apply(to: &state.snapshot) }
            #endif
            (demoInbox, demoPhotos) = Fixtures.inbox()
            demoPhotos.merge(Fixtures.ridePhotos()) { current, _ in current }
        }
        else {
            do {
                let url = try file(for: scope)
                if FileManager.default.fileExists(atPath: url.path) {
                    var loaded = try JSONDecoder().decode(DiskState.self, from: Data(contentsOf: url))
                    if let userID, loaded.migrateQueuedPayments(userID: userID) {
                        try persist(loaded)
                    } else {
                        state = loaded
                    }
                    hasLoaded = true
                }
            } catch {
                self.error = "Could not open your saved expenses. Your existing file has been kept."
                self.scope = nil
                return
            }
            await sync()
        }
    }
    func entries(in group: ExpenseGroup) -> [LedgerEntry] { entries.filter { $0.groupID == group.id } }
    func group(_ id: String) -> ExpenseGroup? { groups.first { $0.id == id } }
    func create(name: String, kind: String, currency: String, people: [MemberDraft], userID: String, displayName: String,
                description: String = "", start: Date? = nil, end: Date? = nil) throws {
        guard scope != nil else { throw LedgerError.invalid("Sign in again before adding a group.") }
        let id = UUID().uuidString
        let members = [Person(groupID: id, userID: userID, name: displayName)] + people.map { Person(id:$0.id, groupID:id, userID:$0.userID, name:$0.name, email:$0.email, phone:$0.phone) }
        var group = ExpenseGroup(id: id, name: name, kind: kind, currency: currency, members: members)
        try group.setMetadata(description: description, start: start, end: end)
        var next = state; next.snapshot.groups.insert(group, at: 0)
        if !demo { next.outbox.append(OutboxItem(id: id, path: "/v1/groups", body: try JSONEncoder().encode(group))) }
        try persist(next); Task { await sync() }
    }
    func add(_ entry: LedgerEntry) throws {
        guard scope != nil else { throw LedgerError.invalid("Sign in again before adding an expense.") }
        var entry = entry
        if demo, let bill = entry.bill { entry.bill?.closed = bill.openCount == 0 }
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
    /// Pull-to-refresh, connectivity changes and writes all funnel through
    /// here. Only one sync runs at a time; a caller that arrives mid-flight
    /// waits for it (and one follow-up pass) rather than returning early,
    /// so the refresh spinner stays until fresh data is on screen.
    func sync() async {
        guard scope != nil, !demo else { return }
        guard online else { hasLoaded = true; return }
        await flight.run { [weak self] in await self?.performSync() }
    }
    private func performSync() async {
        guard scope != nil, !demo, online else { return }
        let current = generation; syncing = true
        defer { if current == generation { syncing = false; hasLoaded = true } }
        do {
            // FIFO makes an offline group reach the server before its expenses.
            while let item = state.outbox.first {
                _ = try await request(path: item.path, body: item.body)
                guard current == generation else { return }
                var next = state; next.outbox.removeAll { $0.id == item.id }; try persist(next)
            }
            let data = try await request(path: "/v1/snapshot")
            guard current == generation else { return }
            let remote = try JSONDecoder().decode(Snapshot.self, from: data)
            // Changes can arrive while a request is suspended. Never replace pending local work.
            let merged = SnapshotMerge.merge(remote: remote, local: state.snapshot, pendingIDs: Set(state.outbox.map(\.id)))
            // Publishing an identical snapshot would still redraw every list; skip it.
            if merged != state.snapshot {
                var next = state
                next.snapshot = merged
                try persist(next)
            }
            if error != nil { error = nil }
        } catch {
            guard current == generation, !SyncFailure.isCancellation(error) else { return }
            self.error = error.localizedDescription
        }
    }
    private func waitForSync() async throws {
        let current = generation
        while flight.isRunning && current == generation { try await Task.sleep(for: .milliseconds(80)) }
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
    func combinationInfo(_ groupID: String) async throws -> ([CombinationSuggestion], [CombinationEvent]) {
        if demo {
            let entries = self.entries.filter { $0.groupID == groupID }
            let rides = entries.filter { $0.title.hasPrefix("Uber to ") && $0.canCombine(in: entries) }
            let matches = Dictionary(grouping: rides) { $0.currency + $0.title }.values.compactMap { trip -> CombinationSuggestion? in
                guard let first = trip.first, trip.count > 1, Set(trip.map(\.paidBy)).count > 1 else { return nil }
                let formatter = ISO8601DateFormatter()
                let dates = trip.compactMap { formatter.date(from: $0.createdAt) }.sorted()
                guard let start = dates.first, let end = dates.last, end.timeIntervalSince(start) <= 7_200 else { return nil }
                return CombinationSuggestion(title: first.title, entryIDs: trip.map(\.id))
            }
            return (matches, demoCombinationHistory.filter { demoCombinations[$0.entryID]?.first?.groupID == groupID })
        }
        let path = "/v1/groups/" + groupID
        async let matches = request(path: path + "/combine-suggestions")
        async let activity = request(path: path + "/combine-activity")
        return (try JSONDecoder().decode(CombinationSuggestions.self, from: await matches).suggestions,
                try JSONDecoder().decode(CombinationHistory.self, from: await activity).events)
    }

    func combineExpenses(group: String, ids: [String], title: String, mode: SplitMode,
                         members: [String], values: [String: String]) async throws -> LedgerEntry? {
        let originals = entries.filter { ids.contains($0.id) && $0.groupID == group }.sorted { $0.createdAt < $1.createdAt }
        guard let first = originals.first, originals.count >= 2, originals.count == ids.count,
              originals.allSatisfy({ $0.currency == first.currency }) else {
            throw LedgerError.invalid("Choose at least two expenses in one currency.")
        }
        let total = originals.reduce(0) { $0 + $1.amount }
        let splits = try Ledger.split(total: total, people: members, mode: mode, values: values)
        let description = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard description.count <= 120 else { throw LedgerError.invalid("Use a description of up to 120 characters.") }
        if demo {
            let payers = Dictionary(grouping: originals.flatMap(\.allPayers), by: \.memberID)
                .map { Payer(memberID: $0.key, amount: $0.value.reduce(0) { $0 + $1.amount }) }
                .sorted { $0.memberID < $1.memberID }
            let combined = LedgerEntry(groupID: group, title: description.isEmpty ? first.title : description, amount: total,
                currency: first.currency, paidBy: first.paidBy, splits: splits, category: first.category,
                receiptIDs: originals.flatMap { $0.receiptIDs ?? [] }, editable: false, splitMode: mode,
                createdAt: first.createdAt, payers: payers, combinedCount: originals.count)
            demoCombinations[combined.id] = originals
            logDemoCombination(combined, action: "combine")
            var next = state
            next.snapshot.entries.removeAll { ids.contains($0.id) }
            next.snapshot.entries.append(combined)
            try persist(next)
            return combined
        }
        let parts: [[String: Any]] = members.map { member in
            let raw = values[member] ?? "0"
            let amount = mode == .adjustment ? Money.parseSigned(raw) : Money.parse(raw)
            return ["memberID": member, "amount": mode == .equal ? 1 : amount ?? 0]
        }
        var input: [String: Any] = ["entryIDs": ids, "splitMode": mode.rawValue, "parts": parts]
        if !description.isEmpty { input["title"] = description }
        let response = try await groupAction(group, "combine", input)
        let id = try JSONDecoder().decode(CombinationResult.self, from: response).entryID
        return entries.first { $0.id == id }
    }

    func uncombine(_ combined: LedgerEntry) async throws {
        if demo {
            guard let originals = demoCombinations[combined.id] else { throw LedgerError.invalid("Original expenses unavailable.") }
            var next = state
            next.snapshot.entries.removeAll { $0.id == combined.id }
            next.snapshot.entries.append(contentsOf: originals)
            logDemoCombination(combined, action: "uncombine")
            try persist(next)
        } else {
            _ = try await post("/v1/entries/\(combined.id)/uncombine", Data("{}".utf8))
            try await waitForSync()
            await sync()
        }
    }

    private func logDemoCombination(_ entry: LedgerEntry, action: String) {
        demoCombinationHistory.insert(CombinationEvent(entryID: entry.id, title: entry.title, count: entry.combinedCount ?? 0,
            action: action, at: ISO8601DateFormatter().string(from: Date())), at: 0)
    }

    var invitationCount: Int { state.snapshot.invitationCount ?? 0 }
    var discoverable: Bool { state.snapshot.discoverable ?? true }

    func knownPeople() async throws -> [SplitUser] {
        if demo { return Fixtures.directory + demoFriends.filter { !Fixtures.directory.contains($0) } }
        return try await people(at: "/v1/people/known")
    }

    func sharedPeople() async throws -> [SplitUser] {
        if demo { return Fixtures.directory }
        return try await people(at: "/v1/people/shared")
    }

    func friends() async throws -> [SplitUser] {
        if demo { return demoFriends }
        return try await people(at: "/v1/friends")
    }

    private func people(at path: String) async throws -> [SplitUser] {
        try JSONDecoder().decode([SplitUser].self, from: try await request(path: path))
    }

    func sendFriendRequest(email: String? = nil, userID: String? = nil) async throws {
        if demo { return }
        let target = ["email": email, "userID": userID].compactMapValues { $0 }
        _ = try await post("/v1/friends/requests", JSONEncoder().encode(target))
    }

    func removeFriend(_ userID: String) async throws {
        if demo { demoFriends.removeAll { $0.userID == userID }; return }
        _ = try await post("/v1/friends/\(userID)/remove", Data("{}".utf8))
    }

    func linkMember(groupID: String, memberID: String, person: SplitUser) async throws {
        if demo {
            guard let groupIndex = groups.firstIndex(where: { $0.id == groupID }),
                  let memberIndex = groups[groupIndex].members.firstIndex(where: { $0.id == memberID && $0.userID == nil }),
                  !groups[groupIndex].members.contains(where: { $0.userID == person.userID })
            else { throw LedgerError.invalid("Choose an available demo placeholder and account.") }
            var next = state
            let name = next.snapshot.groups[groupIndex].members[memberIndex].name
            next.snapshot.groups[groupIndex].members[memberIndex].userID = person.userID
            try persist(next)
            demoLinks[groupID, default: []].insert(MemberLink(id: UUID().uuidString, memberName: name, actorName: "You", userName: person.name), at: 0)
            return
        }
        _ = try await groupAction(groupID, "members/\(memberID)/link", ["userID": person.userID])
    }

    func memberLinks(groupID: String) async throws -> [MemberLink] {
        if demo { return demoLinks[groupID] ?? [] }
        let data = try await request(path: "/v1/groups/\(groupID)/member-links")
        return try JSONDecoder().decode(MemberLinkList.self, from: data).links
    }

    func invitations() async throws -> [GroupInvitation] {
        if demo { return demoInvitations }
        let result = try await request(path: "/v1/invitations")
        let list = try JSONDecoder().decode(InvitationList.self, from: result).invitations
        if state.snapshot.invitationCount != list.count {
            var next = state
            next.snapshot.invitationCount = list.count
            try? persist(next)
        }
        return list
    }

    /// Accepting joins the group (claiming any placeholder history); declining removes the invitation.
    @discardableResult
    func answer(_ invitation: GroupInvitation, accept: Bool) async throws -> String? {
        if demo {
            if invitation.kind == "friend", accept {
                demoFriends.append(SplitUser(userID: "demo-friend-request", name: invitation.inviterName ?? "Split member"))
            }
            demoInvitations.removeAll { $0.id == invitation.id }
            var next = state
            next.snapshot.invitationCount = demoInvitations.count
            try persist(next)
            return nil
        }
        let result = try await post("/v1/invitations/\(invitation.id)/\(accept ? "accept" : "decline")", Data("{}".utf8))
        let groupID = try? JSONDecoder().decode(JoinResult.self, from: result).groupID
        try await waitForSync()
        await sync()
        return accept && invitation.kind != "friend" && invitation.kind != "linked" ? groupID ?? invitation.groupID : nil
    }

    func setDiscoverable(_ value: Bool) async throws {
        if !demo { _ = try await post("/v1/profile/discoverable", JSONEncoder().encode(["discoverable": value])) }
        var next = state
        next.snapshot.discoverable = value
        try persist(next)
    }

    func updateGroup(_ group: ExpenseGroup, name: String, currency: String, simplify: Bool,
                     description: String, start: Date?, end: Date?) async throws {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, clean.count <= 80 else { throw LedgerError.invalid("Give the group a name of up to 80 characters.") }
        var updated = group
        try updated.setMetadata(description: description, start: start, end: end)
        updated.name = clean
        updated.currency = currency
        updated.simplify = simplify
        if demo {
            guard let index = groups.firstIndex(where: { $0.id == group.id }) else { throw LedgerError.invalid("Group unavailable.") }
            var next = state
            next.snapshot.groups[index] = updated
            try persist(next)
        } else {
            _ = try await groupAction(group.id, "update", [
                "name": clean, "currency": currency, "simplify": simplify,
                "description": updated.description ?? "",
                "startDate": (updated.startDate as Any?) ?? NSNull(),
                "endDate": (updated.endDate as Any?) ?? NSNull()
            ])
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
        try await removeGroup(group, action: "leave")
    }

    func deleteGroup(_ group: ExpenseGroup) async throws {
        try await removeGroup(group, action: "delete")
    }

    private func removeGroup(_ group: ExpenseGroup, action: String) async throws {
        if !demo { _ = try await groupAction(group.id, action, [:]) }
        var next = state
        next.snapshot.groups.removeAll { $0.id == group.id }
        let entryIDs = Set(next.snapshot.entries.filter { $0.groupID == group.id }.map(\.id))
        next.snapshot.entries.removeAll { $0.groupID == group.id }
        next.snapshot.settlementRequests?.removeAll { $0.groupID == group.id }
        if action == "delete" {
            next.receiptDrafts?.removeAll { $0.groupID == group.id }
            next.unsentPayments?.removeAll { $0.groupID == group.id }
        }
        try persist(next)
        for id in entryIDs { comments.removeValue(forKey: id) }
    }

    func savePaymentMethods(_ methods: [PaymentMethod]?, in groupID: String?) async throws {
        struct Update: Encodable {
            let methods: [PaymentMethod]?
            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(methods, forKey: .methods)
            }
            enum CodingKeys: String, CodingKey { case methods }
        }
        if demo {
            var next = state
            if groupID == nil { next.snapshot.paymentMethods = methods ?? [] }
            for group in next.snapshot.groups.indices where groupID == nil || next.snapshot.groups[group].id == groupID {
                let members = next.snapshot.groups[group].members
                guard let index = members.firstIndex(where: { $0.userID == currentUserID }) else { continue }
                if groupID != nil { next.snapshot.groups[group].members[index].paymentOverride = methods }
                let override = next.snapshot.groups[group].members[index].paymentOverride
                next.snapshot.groups[group].members[index].paymentMethods = override ?? next.snapshot.paymentMethods ?? []
            }
            try persist(next)
        } else {
            let path = groupID.map { "/v1/groups/\($0)/payment-profile" } ?? "/v1/profile/payment-methods"
            _ = try await post(path, JSONEncoder().encode(Update(methods: methods)))
            await sync()
        }
    }

    func chargedAmountHistory(for entryID: String) async throws -> [ChargedAmountChange] {
        guard !isDemo else { return [] }
        let data = try await request(path: "/v1/entries/\(entryID)/charged-amount-history")
        return try JSONDecoder().decode(ChargedAmountHistory.self, from: data).history
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
            next.snapshot.groups[index].members.append(Person(id:draft.id,groupID:groupID,userID:draft.userID,name:draft.name,email:draft.email,phone:draft.phone))
            try persist(next)
            return draft.id
        }
        let data = try await post("/v1/groups/\(groupID)/members", JSONEncoder().encode(draft))
        let result = try JSONDecoder().decode(MemberResult.self,from:data)
        try await waitForSync()
        await sync()
        return result.id
    }

    struct SplitwiseResult: Decodable, Equatable {
        struct ImportedPerson: Decodable, Equatable {
            var name: String
            var memberID: String
        }
        var groupID: String
        var created: Bool
        var inserted: Int
        var duplicates: Int
        var people: [ImportedPerson]?
    }

    /// Imports one Splitwise group in a single atomic request. Demo mode applies it on the device.
    func importSplitwise(_ request: SplitwiseImportRequest) async throws -> SplitwiseResult {
        if demo { return try importSplitwiseLocally(request) }
        let data = try await post("/v1/import/splitwise", JSONEncoder().encode(request))
        let result = try JSONDecoder().decode(SplitwiseResult.self, from: data)
        try await waitForSync()
        await sync()
        return result
    }

    private func importSplitwiseLocally(_ request: SplitwiseImportRequest) throws -> SplitwiseResult {
        var next = state
        let groupID = request.group?.id ?? request.groupID ?? ""
        var created = false
        if let spec = request.group, !next.snapshot.groups.contains(where: { $0.id == spec.id }) {
            next.snapshot.groups.insert(ExpenseGroup(id: spec.id, name: spec.name, kind: spec.kind, currency: spec.currency, members: [], simplify: true), at: 0)
            created = true
        }
        guard let index = next.snapshot.groups.firstIndex(where: { $0.id == groupID }) else { throw LedgerError.invalid("Group unavailable.") }
        var ids: [String: String] = [:]
        for person in request.people {
            let key = person.name.lowercased()
            if person.me == true {
                if let mine = next.snapshot.groups[index].members.first(where: { $0.userID == currentUserID }) { ids[key] = mine.id }
                else {
                    let me = Person(id: "demo-me-" + groupID, groupID: groupID, userID: currentUserID, name: person.displayName ?? person.name)
                    next.snapshot.groups[index].members.append(me); ids[key] = me.id
                }
            } else if let id = person.memberID { ids[key] = id }
            else {
                let id = "demo-sw-" + SplitwiseCSV.fingerprint(groupID + key).prefix(16)
                if let member = next.snapshot.groups[index].members.firstIndex(where: { $0.id == id }) {
                    if let name = person.displayName { next.snapshot.groups[index].members[member].name = name }
                } else {
                    next.snapshot.groups[index].members.append(Person(id: id, groupID: groupID, name: person.displayName ?? person.name))
                }
                ids[key] = id
            }
        }
        func id(_ name: String) throws -> String {
            guard let id = ids[name.lowercased()] else { throw LedgerError.invalid("Every name in the import needs a person.") }
            return id
        }
        var inserted = 0
        for (offset, row) in request.rows.enumerated() {
            let entryID = "demo-sw-" + SplitwiseCSV.fingerprint(groupID + String(offset) + row.title + row.day).prefix(24)
            guard !next.snapshot.entries.contains(where: { $0.id == entryID }) else { continue }
            var entry = LedgerEntry(id: entryID, groupID: groupID, title: row.title, amount: row.amount, currency: row.currency, paidBy: try id(row.payer),
                                    splits: try row.splits.map { Portion(memberID: try id($0.name), amount: $0.amount) }, category: row.category,
                                    kind: row.payment ? "settlement" : row.refund == true ? "refund" : "expense", editable: true, splitMode: .exact, createdAt: row.day + "T12:00:00Z")
            if let payers = row.payers, payers.count > 1 { entry.payers = try payers.map { Payer(memberID: try id($0.name), amount: $0.amount) } }
            entry.exchange = row.exchange
            next.snapshot.entries.append(entry)
            inserted += 1
        }
        try persist(next)
        let people = request.people.compactMap { person in
            ids[person.name.lowercased()].map { SplitwiseResult.ImportedPerson(name: person.name, memberID: $0) }
        }
        return SplitwiseResult(groupID: groupID, created: created, inserted: inserted, duplicates: request.rows.count - inserted, people: people)
    }

    func requestSettlement(_ entry: LedgerEntry) async throws {
        if demo {
            var next = state
            next.snapshot.settlementRequests = [entry] + pendingSettlements.filter { $0.id != entry.id }
            try persist(next)
            return
        }
        _ = try await post("/v1/settlements", JSONEncoder().encode(entry))
        try await waitForSync()
        await sync()
    }

    func respond(to entry: LedgerEntry, with response: SettlementResponse) async throws {
        if demo {
            var next = state
            next.snapshot.settlementRequests?.removeAll { $0.id == entry.id }
            if response == .approve { next.snapshot.entries.append(entry) }
            try persist(next)
            return
        }
        _ = try await post("/v1/settlements/\(entry.id)/\(response.rawValue)", Data("{}".utf8))
        try await waitForSync()
        await sync()
    }

    func setHandled(_ entry: LedgerEntry, handled: Bool) async throws {
        if demo {
            var next = state
            guard let index = next.snapshot.entries.firstIndex(where: { $0.id == entry.id }) else {
                throw LedgerError.invalid("Expense unavailable.")
            }
            next.snapshot.entries[index].handled = handled ? true : nil
            try persist(next)
            return
        }
        _ = try await post("/v1/entries/\(entry.id)/handled", JSONEncoder().encode(["handled": handled]))
        try await waitForSync()
        await sync()
    }

    /// Marks an expense or refund pending (with an optional note), or confirms it.
    func setPending(_ entry: LedgerEntry, pending: Bool, note: String? = nil) async throws {
        let clean = note?.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = pending && clean?.isEmpty == false ? clean : nil
        guard (text?.count ?? 0) <= 500 else { throw LedgerError.invalid("Write a pending note of up to 500 characters.") }
        if demo {
            try updateDemo(entry.id) { $0.pending = pending ? true : nil; $0.pendingNote = text }
            return
        }
        var body: [String: Any] = ["pending": pending]
        if let text { body["note"] = text }
        _ = try await post("/v1/entries/\(entry.id)/pending", JSONSerialization.data(withJSONObject: body))
        try await waitForSync()
        await sync()
    }

    enum Resolution { case confirm, adjust(Int64), refund(LedgerEntry) }

    /// Resolves a pending entry: confirm it, adjust the amount (splits rescale by largest remainder), or record a linked refund.
    func resolve(_ entry: LedgerEntry, _ resolution: Resolution) async throws {
        if case .refund(let refund) = resolution {
            try Refunds.validate(refund, original: entry, others: Refunds.linked(to: entry, in: entries, excluding: refund.id))
        }
        if demo {
            var next = state
            guard let index = next.snapshot.entries.firstIndex(where: { $0.id == entry.id }) else { throw LedgerError.invalid("Expense unavailable.") }
            switch resolution {
            case .confirm: next.snapshot.entries[index].pending = nil; next.snapshot.entries[index].pendingNote = nil
            case .adjust(let amount): next.snapshot.entries[index] = try Refunds.adjusted(next.snapshot.entries[index], to: amount)
            case .refund(var refund):
                next.snapshot.entries[index].pending = nil; next.snapshot.entries[index].pendingNote = nil
                refund.editable = true
                next.snapshot.entries.append(refund)
            }
            try persist(next)
            return
        }
        let body: Data
        switch resolution {
        case .confirm: body = try JSONEncoder().encode(["action": "confirm"])
        case .adjust(let amount): body = try JSONSerialization.data(withJSONObject: ["action": "adjust", "amount": amount])
        case .refund(let refund): body = try JSONEncoder().encode(ResolveRefund(refund: refund))
        }
        _ = try await post("/v1/entries/\(entry.id)/resolve", body)
        try await waitForSync()
        await sync()
    }

    private func updateDemo(_ id: String, _ change: (inout LedgerEntry) -> Void) throws {
        var next = state
        guard let index = next.snapshot.entries.firstIndex(where: { $0.id == id }) else { throw LedgerError.invalid("Expense unavailable.") }
        change(&next.snapshot.entries[index])
        try persist(next)
    }

    func change(_ original: LedgerEntry, to replacement: LedgerEntry?) async throws {
        guard demo || original.editable == true else { throw LedgerError.invalid("Only the person who recorded this entry can change it.") }
        if demo {
            var next = state
            next.snapshot.entries.removeAll { $0.id == original.id }
            if var replacement {
                if let bill = replacement.bill { replacement.bill?.closed = bill.openCount == 0 }
                next.snapshot.entries.append(replacement)
            }
            try persist(next)
        } else {
            let action = replacement == nil ? "delete" : "edit"
            _ = try await post("/v1/entries/\(original.id)/\(action)", JSONEncoder().encode(["original":original,"entry":replacement]))
            try await waitForSync()
            await sync()
        }
    }

    func receiptDrafts(in groupID: String) -> [ReceiptDraft] {
        let savedIDs = Set(state.snapshot.entries.filter { $0.groupID == groupID }.map(\.id))
        return (state.receiptDrafts ?? []).filter { $0.groupID == groupID && !savedIDs.contains($0.id) }
            .sorted { $0.capturedAt > $1.capturedAt }
    }

    func saveReceiptDraft(_ draft: ReceiptDraft) throws {
        guard scope != nil, group(draft.groupID) != nil else { throw LedgerError.invalid("Group unavailable.") }
        var next = state
        var drafts = next.receiptDrafts ?? []
        drafts.removeAll { $0.id == draft.id }
        drafts.append(draft)
        next.receiptDrafts = drafts
        try persist(next)
    }

    func removeReceiptDraft(_ id: String) throws {
        var next = state
        next.receiptDrafts?.removeAll { $0.id == id }
        try persist(next)
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
    // MARK: - Receipts inbox

    private func inboxPath(_ groupID: String, _ rest: String = "") -> String {
        "/v1/groups/\(groupID)/receipts" + rest
    }

    /// Receipts uploaded to the group and not yet paired to an expense, newest first.
    func inboxReceipts(groupID: String) async throws -> [InboxReceipt] {
        if demo { return demoInbox.filter { $0.groupID == groupID } }
        let data = try await request(path: inboxPath(groupID))
        return try JSONDecoder().decode(InboxReceiptList.self, from: data).receipts
    }

    func inboxImage(groupID: String, id: String) async throws -> Data {
        if demo, let data = demoPhotos[id] { return data }
        return try await request(path: inboxPath(groupID, "/\(id)"))
    }

    /// Uploads a prepared JPEG (see `ReceiptReader.photo`) to the group inbox. Idempotent per photo ID.
    func uploadInboxReceipt(groupID: String, photo: ReceiptPhoto, note: String?) async throws {
        let clean = note?.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200)
        let trimmed = clean.flatMap { $0.isEmpty ? nil : String($0) }
        if demo {
            guard !demoInbox.contains(where: { $0.id == photo.id }) else { return }
            let me = group(groupID).flatMap { Analytics.me(in: $0, userID: currentUserID) }
            demoPhotos[photo.id] = photo.data
            demoInbox.insert(InboxReceipt(id: photo.id, groupID: groupID, uploadedBy: me?.id ?? "",
                                          createdAt: ISO8601DateFormatter().string(from: Date()), note: trimmed,
                                          bytes: photo.data.count), at: 0)
            return
        }
        var body: [String: Any] = ["id": photo.id, "data": photo.data.base64EncodedString()]
        if let trimmed { body["note"] = trimmed }
        _ = try await post(inboxPath(groupID), JSONSerialization.data(withJSONObject: body))
    }

    func deleteInboxReceipt(groupID: String, id: String) async throws {
        if demo { demoInbox.removeAll { $0.id == id }; demoPhotos[id] = nil; return }
        _ = try await post(inboxPath(groupID, "/\(id)/delete"), Data("{}".utf8))
    }

    /// Attaches an inbox receipt to an expense in the same group.
    func pairInboxReceipt(groupID: String, id: String, to entry: LedgerEntry) async throws {
        guard (entry.receiptIDs?.count ?? 0) < receiptLimit else {
            throw LedgerError.invalid("An expense holds up to \(receiptLimit) receipt photos.")
        }
        if demo {
            guard demoInbox.contains(where: { $0.id == id }) else { throw LedgerError.invalid("This receipt is no longer in the inbox.") }
            demoInbox.removeAll { $0.id == id }
            try setDemoReceipts(entry.id) { $0.append(id) }
            return
        }
        _ = try await post(inboxPath(groupID, "/\(id)/pair"), JSONSerialization.data(withJSONObject: ["entryID": entry.id]))
        try await waitForSync()
        await sync()
    }

    /// Moves an attached receipt to another expense in the same group, or back to the inbox when `target` is nil.
    func moveReceipt(_ id: String, from entry: LedgerEntry, to target: LedgerEntry?) async throws {
        if let target, (target.receiptIDs?.count ?? 0) >= receiptLimit {
            throw LedgerError.invalid("\(target.title) already has \(receiptLimit) receipt photos.")
        }
        if demo {
            try setDemoReceipts(entry.id) { $0.removeAll { $0 == id } }
            if let target {
                try setDemoReceipts(target.id) { $0.append(id) }
            } else {
                let me = group(entry.groupID).flatMap { Analytics.me(in: $0, userID: currentUserID) }
                demoInbox.insert(InboxReceipt(id: id, groupID: entry.groupID, uploadedBy: me?.id ?? "",
                                              createdAt: ISO8601DateFormatter().string(from: Date()), note: entry.title,
                                              bytes: demoPhotos[id]?.count ?? 0), at: 0)
            }
            return
        }
        let body: [String: Any] = ["entryID": target?.id ?? NSNull()]
        _ = try await post("/v1/entries/\(entry.id)/receipts/\(id)/move", JSONSerialization.data(withJSONObject: body))
        try await waitForSync()
        await sync()
    }

    private func setDemoReceipts(_ entryID: String, _ change: (inout [String]) -> Void) throws {
        var next = state
        guard let index = next.snapshot.entries.firstIndex(where: { $0.id == entryID }) else {
            throw LedgerError.invalid("This expense is unavailable.")
        }
        var ids = next.snapshot.entries[index].receiptIDs ?? []
        change(&ids)
        next.snapshot.entries[index].receiptIDs = ids.isEmpty ? nil : ids
        try persist(next)
    }

    func claim(_ entry: LedgerEntry, item: Purchase?, people: [String], shares: [String: Int64] = [:]) async throws {
        guard var bill=entry.bill else { throw LedgerError.invalid("This receipt has no items.") }
        if demo {
            var updated=entry
            if let item {
                guard let index = bill.items.firstIndex(where: { $0.id == item.id }) else {
                    throw LedgerError.invalid("This purchase is unavailable.")
                }
                var updatedItem = bill.items[index]
                var weights = updatedItem.shares ?? [:]
                weights.merge(shares) { _, new in new }
                weights = weights.filter { people.contains($0.key) && $0.value != 100 }
                if Set(people) != Set(updatedItem.memberIDs) || !shares.isEmpty {
                    updatedItem.roundingSeats = nil
                    updatedItem.roundingWeights = nil
                }
                updatedItem.memberIDs = people
                updatedItem.shares = weights.isEmpty ? nil : weights
                bill.items[index] = updatedItem
            } else {
                for index in bill.items.indices where bill.items[index].memberIDs.isEmpty {
                    bill.items[index].memberIDs = people
                }
            }
            updated.bill=bill; updated.splits=try bill.split(payer:entry.paidBy)
            try await change(entry,to:updated)
        } else {
            var data:[String:Any]=["memberIDs":people]
            if let item {
                data["itemID"] = item.id
                data["original"] = item.memberIDs
                data["mergeEdits"] = true
                if !shares.isEmpty { data["shares"] = shares }
            }
            let action=item == nil ? "close" : "claim"
            do { _ = try await post("/v1/entries/\(entry.id)/\(action)",JSONSerialization.data(withJSONObject:data)) }
            catch { await sync(); throw error }
            try await waitForSync()
            await sync()
        }
    }

    func memberClaimEmails(groupID: String) async throws -> [String: String] {
        if demo {
            return Dictionary(uniqueKeysWithValues: (group(groupID)?.members ?? []).compactMap { member in
                guard let email = member.email, member.userID == nil, member.removed != true else { return nil }
                return (member.id, email)
            })
        }
        let data = try await request(path: "/v1/groups/\(groupID)/members")
        let contacts = try JSONDecoder().decode(MemberClaimEmails.self, from: data).claimEmails
        return Dictionary(uniqueKeysWithValues: contacts.map { ($0.memberID, $0.email) })
    }

    func updateClaimEmail(groupID: String, memberID: String, email: String) async throws {
        _ = try await post("/v1/groups/\(groupID)/members/\(memberID)/email",
                           JSONSerialization.data(withJSONObject: ["email": email.isEmpty ? NSNull() : email as Any]))
    }

    func sendMemberEmail(groupID: String, memberID: String, email: String? = nil) async throws {
        let action = email == nil ? "sign-in-email" : "invite-email"
        _ = try await post("/v1/groups/\(groupID)/members/\(memberID)/\(action)",
                           JSONEncoder().encode(email.map { ["email": $0] } ?? [:]))
    }

    func resendInvite(_ invite: ActiveInvite, groupID: String) async throws {
        _ = try await post("/v1/groups/\(groupID)/invites/\(invite.id)/resend", Data("{}".utf8))
    }

    func activeInvites(groupID: String) async throws -> [ActiveInvite] {
        #if DEBUG
        if demo && StressFixtures.enabled && groupID == StressFixtures.groupID { return StressFixtures.invites() }
        #endif
        guard !demo else { return [] }
        let result = try await request(path: "/v1/groups/\(groupID)/invites")
        return try JSONDecoder().decode(ActiveInviteResponse.self, from: result).invites
    }

    func revokeInvite(_ invite: ActiveInvite, groupID: String) async throws {
        guard !demo else { return }
        _ = try await post("/v1/groups/\(groupID)/invites/\(invite.id)/revoke", Data("{}".utf8))
    }

    func invite(group: ExpenseGroup, memberID: String? = nil) async throws -> URL {
        try await invite(groupID: group.id, memberID: memberID)
    }

    func invite(groupID: String, memberID: String?, email: String? = nil) async throws -> URL {
        guard !demo else { throw LedgerError.invalid("Sign in to share a group invitation.") }
        let payload = ["memberID": memberID, "email": email].compactMapValues { $0 }
        let data = try await post("/v1/groups/\(groupID)/invites", JSONEncoder().encode(payload))
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
private struct ResolveRefund: Encodable { var action = "refund"; var refund: LedgerEntry }
private struct InviteResponse: Decodable { var url: URL }
struct ChargedAmountChange: Decodable, Identifiable {
    var id: Int
    var previousCurrency: String?
    var previousAmount: Int64?
    var chargedCurrency: String?
    var chargedAmount: Int64?
    var changedAt: String
}

private struct ChargedAmountHistory: Decodable {
    var history: [ChargedAmountChange]
}

private struct CommentList: Decodable { var comments: [EntryComment] }

enum Fixtures {
    static let directory = [
        SplitUser(userID: "demo-priya-account", name: "Priya Shah"),
        SplitUser(userID: "demo-priyanka-account", name: "Priyanka Rao"),
        SplitUser(userID: "demo-carmen-account", name: "Carmen Ortiz"),
        SplitUser(userID: "demo-maya-account", name: "Maya")
    ]
    static func invitations() -> [GroupInvitation] {
        let now = Date().timeIntervalSince1970 * 1000
        return [
            GroupInvitation(id: String(repeating: "c", count: 64), kind: "friend", groupID: "", groupName: "Friend request",
                            groupKind: "", memberCount: 0, inviterName: "Jordan Lee", memberName: nil, expiresAt: now + 10 * 86_400_000),
            GroupInvitation(id: String(repeating: "a", count: 64), kind: "direct", groupID: "demo-lisbon", groupName: "Lisbon Long Weekend",
                            groupKind: "trip", memberCount: 4, inviterName: "Priya Shah", memberName: nil, expiresAt: now + 13 * 86_400_000),
            GroupInvitation(id: String(repeating: "b", count: 64), kind: "email", groupID: "demo-climbing", groupName: "Climbing Club Dues",
                            groupKind: "home", memberCount: 7, inviterName: nil, memberName: "Alex K.", expiresAt: now + 6 * 86_400_000)
        ]
    }
    static func snapshot() -> Snapshot {
        let trip = "demo-buenos-aires", home = "demo-home", spain = "demo-spain", sam = "demo-friend-sam", maya = "demo-friend-maya"
        let people = [
            Person(id:"demo-alex",groupID:trip,userID:"demo-user",name:"Alex"),
            Person(id:"demo-maya",groupID:trip,userID:"demo-maya-account",name:"Maya",paymentMethods:[PaymentMethod(platform:"zelle",handle:"maya@example.com",preferred:true),PaymentMethod(platform:"venmo",handle:"maya-lin")]),
            Person(id:"demo-sam",groupID:trip,userID:"demo-sam-account",name:"Sam"),
            Person(id:"demo-harris",groupID:trip,userID:"demo-harris-account",name:"Harris")
        ]
        let group = ExpenseGroup(id:trip,name:"Buenos Aires Trip",kind:"trip",currency:"ARS",members:people,simplify:true)
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
        e.append(entry("demo-dinner",trip,"Guerrín dinner (pizza, empanadas, beer)",20845000,"ARS",people[3].id,[("demo-alex",5200000),("demo-maya",4200000),("demo-sam",5200000),("demo-harris",6245000)],category:"Dining",notes:"Split the provoleta three ways. Harris covered the tip in cash."))
        e.append(entry("demo-uber",trip,"Uber EZE to Palermo",7592500,"ARS",people[3].id,[("demo-alex",1898125),("demo-maya",1898125),("demo-sam",1898125),("demo-harris",1898125)],category:"Transport",day:"2026-11-17T09:10:00Z"))
        e.append(entry("demo-coffee",trip,"Coffee & medialunas",1850000,"ARS",people[1].id,[("demo-alex",616667),("demo-maya",616667),("demo-sam",616666)],category:"Dining",day:"2026-11-16T14:05:00Z"))
        e.append(entry("demo-stay",trip,"A place for the weekend",18000,"USD",people[2].id,[("demo-alex",6000),("demo-maya",6000),("demo-sam",6000)],category:"Lodging",day:"2026-11-15T12:00:00Z"))
        e.append(entry("demo-wine",trip,"Wine tasting in San Telmo",4300000,"ARS",people[0].id,[("demo-alex",1433333),("demo-maya",1433333),("demo-sam",1433334)],category:"Entertainment",day:"2026-11-14T19:00:00Z"))
        e.append(entry("demo-ride",trip,"Uber to Av. Corrientes",884100,"ARS",people[3].id,[("demo-alex",221025),("demo-maya",221025),("demo-sam",221025),("demo-harris",221025)],category:"Transport",day:"2026-11-13T21:15:00Z"))
        e.append(entry("demo-rainforest",spain,"Rainforest dinner",62109,"EUR",spainMembers[1].id,[("demo-spain-alex",15527),("demo-spain-harris",15527),("demo-spain-sanjit",15527),("demo-spain-rock",15528)],category:"Dining",notes:"Table for four, set menu.",day:"2026-11-12T20:00:00Z"))
        e.append(entry("demo-boat",spain,"WeBoat Tour",47044,"EUR",spainMembers[2].id,[("demo-spain-alex",11761),("demo-spain-harris",11761),("demo-spain-sanjit",11761),("demo-spain-rock",11761)],category:"Travel",day:"2026-11-09T10:00:00Z"))
        e.append(entry("demo-rent",home,"November rent",240000,"USD",houseMembers[0].id,[("demo-home-alex",80000),("demo-home-sam",80000),("demo-home-nina",80000)],category:"Rent",day:"2026-11-01T08:00:00Z"))
        e.append(entry("demo-groceries",home,"Sunday groceries",9214,"USD",houseMembers[1].id,[("demo-home-alex",3071),("demo-home-sam",3071),("demo-home-nina",3072)],category:"Groceries",day:"2026-11-08T17:40:00Z"))
        e.append(entry("demo-utilities",home,"Internet",6000,"USD",houseMembers[0].id,[("demo-home-alex",2000),("demo-home-sam",2000),("demo-home-nina",2000)],category:"Utilities",day:"2026-11-05T09:00:00Z"))
        e.append(entry("demo-sam-tickets",sam,"Concert tickets",12000,"USD","demo-sam-alex",[("demo-sam-alex",6000),("demo-sam-sam",6000)],category:"Entertainment",day:"2026-11-10T15:00:00Z"))
        e.append(entry("demo-sam-grocery",sam,"Trader Joe’s run",6420,"USD","demo-sam-sam",[("demo-sam-alex",3210),("demo-sam-sam",3210)],category:"Groceries",day:"2026-11-04T18:20:00Z"))
        e.append(entry("demo-maya-dinner",maya,"Maya’s birthday dinner",15000,"USD","demo-maya-maya",[("demo-maya-alex",5000),("demo-maya-maya",10000)],category:"Dining",day:"2026-11-02T20:00:00Z"))

        // Sam couldn't join the delta excursion; the agency may still refund the ticket.
        var excursion = entry("demo-tigre",trip,"Tigre delta excursion",9600000,"ARS",people[0].id,[("demo-alex",2400000),("demo-maya",2400000),("demo-sam",2400000),("demo-harris",2400000)],category:"Travel",day:"2026-11-18T10:00:00Z")
        excursion.pending = true
        excursion.pendingNote = "Sam couldn’t go. We asked the agency to refund his ticket."
        e.append(excursion)
        // Rock missed the boat tour and WeBoat refunded his ticket to Sanjit's card.
        var boatRefund = entry("demo-boat-refund",spain,"Refund: Rock’s WeBoat ticket",11761,"EUR",spainMembers[2].id,[("demo-spain-rock",11761)],category:"Travel",day:"2026-11-11T09:00:00Z")
        boatRefund.kind = "refund"
        boatRefund.refundOf = "demo-boat"
        boatRefund.splitMode = .exact
        e.append(boatRefund)

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
        for (index, payer) in people.prefix(2).enumerated() {
            let amount: Int64 = index == 0 ? 1_852_501 : 2_164_000
            var ride = entry("demo-obelisco-\(index)", trip, "Uber to Obelisco", amount, "ARS", payer.id, [(payer.id, amount)],
                             category: "Transport", day: "2026-11-19T19:0\(index):00Z")
            ride.receiptIDs = ["demo-ride-photo-\(index)"]
            e.append(ride)
        }
        return Snapshot(groups:[group,house,spainGroup,samGroup,mayaGroup],entries:e,invitationCount:3,discoverable:true)
    }

    /// Two demo receipts waiting in the Buenos Aires inbox, with rendered photos.
    static func inbox() -> ([InboxReceipt], [String: Data]) {
        let receipts = [
            (InboxReceipt(id: "demo-inbox-parrilla", groupID: "demo-buenos-aires", uploadedBy: "demo-alex",
                          createdAt: "2026-11-18T22:40:00Z", note: "Don Julio parrilla", bytes: 0),
             ["DON JULIO", "Bife de chorizo  38.500,00", "Provoleta  9.800,00", "Malbec  24.000,00", "Propina  7.230,00"]),
            (InboxReceipt(id: "demo-inbox-market", groupID: "demo-buenos-aires", uploadedBy: "demo-maya",
                          createdAt: "2026-11-18T13:05:00Z", note: "San Telmo market snacks", bytes: 0),
             ["MERCADO SAN TELMO", "Choripán x3  13.500,00", "Agua  2.400,00", "Alfajores  6.000,00"])
        ]
        var photos: [String: Data] = [:]
        var list: [InboxReceipt] = []
        for (receipt, lines) in receipts {
            var item = receipt
            let data = receiptImage(lines)
            item.bytes = data.count
            photos[item.id] = data
            list.append(item)
        }
        return (list, photos)
    }

    static func ridePhotos() -> [String: Data] {
        [
            "demo-ride-photo-0": receiptImage(["UBER", "Destino: Obelisco", "Total ARS 18.525,01"]),
            "demo-ride-photo-1": receiptImage(["UBER", "Destino: Obelisco", "Total ARS 21.640,00"])
        ]
    }

    private static func receiptImage(_ lines: [String]) -> Data {
        let size = CGSize(width: 360, height: 520)
        let image = UIGraphicsImageRenderer(size: size).image { context in
            UIColor(white: 0.97, alpha: 1).setFill()
            context.fill(CGRect(origin: .zero, size: size))
            var y: CGFloat = 36
            for (index, line) in lines.enumerated() {
                let font = index == 0 ? UIFont.monospacedSystemFont(ofSize: 22, weight: .bold) : UIFont.monospacedSystemFont(ofSize: 16, weight: .regular)
                (line as NSString).draw(at: CGPoint(x: 24, y: y), withAttributes: [.font: font, .foregroundColor: UIColor.darkGray])
                y += index == 0 ? 56 : 34
            }
            ("GRACIAS" as NSString).draw(at: CGPoint(x: 24, y: size.height - 60),
                                         withAttributes: [.font: UIFont.monospacedSystemFont(ofSize: 16, weight: .semibold), .foregroundColor: UIColor.gray])
        }
        return image.jpegData(compressionQuality: 0.7) ?? Data()
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

/// An account card with public display fields.
struct SplitUser: Decodable, Identifiable, Hashable {
    var userID: String
    var name: String
    var avatarURL: String?
    var id: String { userID }
}
struct MemberLink: Decodable, Identifiable {
    var id: String
    var memberName: String
    var actorName: String?
    var userName: String?
}
private struct MemberLinkList: Decodable { var links: [MemberLink] }
struct GroupInvitation: Decodable, Identifiable, Hashable {
    var id: String
    var kind: String
    var groupID: String
    var groupName: String
    var groupKind: String
    var memberCount: Int
    var inviterName: String?
    var memberName: String?
    var expiresAt: Double
    var expirationDate: Date { Date(timeIntervalSince1970: expiresAt / 1000) }
}
private struct InvitationList: Decodable { var invitations: [GroupInvitation] }
struct MemberDraft: Codable {
    var id = UUID().uuidString
    var name: String
    var email: String?
    var phone: String?
    var userID: String?
}
private struct MemberResult: Decodable { var id: String }
private struct JoinResult: Decodable { var groupID: String? }
