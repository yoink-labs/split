import Foundation

/// Where one member stands on one ledger entry: the web ledger's `position()`.
/// Handled expenses and payments count as involvement but not as money owed.
struct LedgerPosition: Equatable {
    var involved: Bool
    /// Paid minus share, in the settlement currency. Negative means they owe.
    var net: Int64
    var currency: String

    init(_ entry: LedgerEntry, memberID: String?) {
        let involved = memberID.map { id in entry.allPayers.contains { $0.memberID == id } || entry.splits.contains { $0.memberID == id } } ?? false
        self.involved = involved
        guard involved, let memberID, !entry.isHandled, entry.kind == "expense" else {
            net = 0
            currency = entry.currency
            return
        }
        let settled = entry.settling
        net = Ledger.paid(settled, by: memberID) - Ledger.share(settled, of: memberID)
        currency = settled.currency
    }
}
