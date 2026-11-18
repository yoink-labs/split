import XCTest
@testable import Split

/// Refresh behaviour: one request in flight, cancellation stays silent, and a
/// merged snapshot never duplicates or reorders rows.
@MainActor final class RefreshTests: XCTestCase {
    private func entry(_ id: String, _ day: String) -> LedgerEntry {
        LedgerEntry(id: id, groupID: "g", title: id, amount: 100, currency: "USD", paidBy: "a",
                    splits: [Portion(memberID: "a", amount: 100)], createdAt: day)
    }
    private func group(_ id: String) -> ExpenseGroup {
        ExpenseGroup(id: id, name: id, kind: "trip", currency: "USD", members: [])
    }

    @MainActor private final class Probe {
        var runs = 0
        var finished = false
        var release: CheckedContinuation<Void, Never>?
    }

    private func settle(_ condition: @MainActor () -> Bool) async {
        for _ in 0..<200 where !condition() { try? await Task.sleep(for: .milliseconds(5)) }
    }

    func testConcurrentCallersShareOneRun() async {
        let flight = SingleFlight()
        let probe = Probe()
        let work: @MainActor () async -> Void = {
            probe.runs += 1
            if probe.runs == 1 { await withCheckedContinuation { probe.release = $0 } }
        }
        let first = Task { @MainActor in await flight.run(work) }
        await settle { probe.release != nil }
        XCTAssertTrue(flight.isRunning)
        let second = Task { @MainActor in await flight.run(work) }
        let third = Task { @MainActor in await flight.run(work) }
        try? await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(probe.runs, 1, "a second caller must not start a parallel request")
        probe.release?.resume()
        await first.value; await second.value; await third.value
        // Callers that arrived mid-flight get exactly one follow-up pass.
        XCTAssertEqual(probe.runs, 2)
        XCTAssertFalse(flight.isRunning)
        await flight.run(work)
        XCTAssertEqual(probe.runs, 3)
    }

    func testCancelledCallerDoesNotCancelTheRequest() async {
        let flight = SingleFlight()
        let probe = Probe()
        let caller = Task { @MainActor in
            await flight.run {
                try? await Task.sleep(for: .milliseconds(50))
                probe.finished = !Task.isCancelled
            }
        }
        await settle { flight.isRunning }
        caller.cancel()
        await caller.value
        XCTAssertTrue(probe.finished, "pull-to-refresh cancellation must not cancel the sync")
    }

    func testCancellationIsNotAnError() {
        XCTAssertTrue(SyncFailure.isCancellation(CancellationError()))
        XCTAssertTrue(SyncFailure.isCancellation(URLError(.cancelled)))
        XCTAssertTrue(SyncFailure.isCancellation(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)))
        XCTAssertFalse(SyncFailure.isCancellation(URLError(.timedOut)))
        XCTAssertFalse(SyncFailure.isCancellation(LedgerError.invalid("Sync is unavailable.")))
    }

    func testMergeDedupesAndKeepsPendingWork() {
        let server = Snapshot(groups: [group("g1"), group("g1")],
                              entries: [entry("e1", "2026-11-17T10:00:00Z"), entry("e1", "2026-11-17T10:00:00Z"), entry("e2", "2026-11-16T10:00:00Z")])
        var stale = entry("e2", "2026-11-16T10:00:00Z"); stale.title = "old title"
        let local = Snapshot(groups: [group("g1"), group("g2"), group("gone")],
                             entries: [stale, entry("e3", "2026-11-18T10:00:00Z"), entry("deleted", "2026-11-01T10:00:00Z")])
        let merged = SnapshotMerge.merge(remote: server, local: local, pendingIDs: ["g2", "e2", "e3"])
        XCTAssertEqual(merged.groups.map(\.id), ["g1", "g2"], "pending groups survive, stale ones are dropped")
        XCTAssertEqual(merged.entries.map(\.id), ["e3", "e1", "e2"], "no duplicates, newest first")
        XCTAssertEqual(merged.entries.last?.title, "e2", "the server copy wins over a stale local row")
    }

    func testOrderIsStableForEqualTimestamps() {
        let day = "2026-11-17T10:00:00Z"
        let a = [entry("b", day), entry("a", day), entry("c", day)]
        let once = SnapshotMerge.ordered(a).map(\.id)
        XCTAssertEqual(once, ["c", "b", "a"])
        XCTAssertEqual(SnapshotMerge.ordered(a.reversed()).map(\.id), once, "input order must not change row order")
    }

    func testUnchangedSnapshotCompareEqual() {
        let snapshot = Fixtures.snapshot()
        let merged = SnapshotMerge.merge(remote: snapshot, local: snapshot, pendingIDs: [])
        XCTAssertEqual(Set(merged.entries.map(\.id)), Set(snapshot.entries.map(\.id)))
        XCTAssertEqual(SnapshotMerge.merge(remote: merged, local: merged, pendingIDs: []), merged,
                       "a refresh that returns the same data must not republish")
    }
}
