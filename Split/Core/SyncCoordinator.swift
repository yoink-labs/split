import Foundation

/// Runs one piece of async work at a time. Callers that arrive while it is
/// running wait for that run (plus one follow-up pass, so their request is not
/// lost) instead of starting a second request or returning early.
///
/// The work runs in its own task, so a caller that is cancelled (for example a
/// pull-to-refresh whose view re-rendered) never cancels the network request
/// and never surfaces a "cancelled" error.
@MainActor final class SingleFlight {
    private var task: Task<Void, Never>?
    private var again = false

    var isRunning: Bool { task != nil }

    func run(_ work: @escaping @MainActor () async -> Void) async {
        if let task {
            again = true
            await task.value
            return
        }
        let next = Task { @MainActor [weak self] in
            repeat {
                self?.again = false
                await work()
            } while self?.again == true
            self?.task = nil
        }
        task = next
        await next.value
    }
}

enum SyncFailure {
    /// Cancellation is not a failure the person needs to see: it happens when
    /// a refresh is superseded, a view disappears, or the app is backgrounded.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if let url = error as? URLError, url.code == .cancelled { return true }
        let ns = error as NSError
        return ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled
    }
}

enum SnapshotMerge {
    /// Combines the server snapshot with local work that has not reached the
    /// server yet. Every group and entry appears once (the server copy wins),
    /// and the result is ordered deterministically so rows do not jump between
    /// refreshes that return the same data.
    static func merge(remote: Snapshot, local: Snapshot, pendingIDs: Set<String>) -> Snapshot {
        var groups = unique(remote.groups)
        let groupIDs = Set(groups.map(\.id))
        groups += unique(local.groups.filter { pendingIDs.contains($0.id) && !groupIDs.contains($0.id) })

        var entries = unique(remote.entries)
        let entryIDs = Set(entries.map(\.id))
        entries += unique(local.entries.filter { pendingIDs.contains($0.id) && !entryIDs.contains($0.id) })

        return Snapshot(groups: groups, entries: ordered(entries))
    }

    /// Newest first, with the id as a tie-breaker so equal timestamps keep a
    /// stable order.
    static func ordered(_ entries: [LedgerEntry]) -> [LedgerEntry] {
        entries.sorted { ($0.createdAt, $0.id) > ($1.createdAt, $1.id) }
    }

    static func unique<T: Identifiable>(_ items: [T]) -> [T] where T.ID == String {
        var seen = Set<String>()
        return items.filter { seen.insert($0.id).inserted }
    }
}
