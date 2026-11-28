import Foundation

/// Refunds and credits give money back. A refund's `paidBy` received the money and its splits are
/// each person's credit. Linked refunds follow the same limits the Worker enforces: only people who
/// shared the original, at most their share each, and at most the original amount in total.
/// See docs/REFUNDS_AND_PENDING.md.
enum Refunds {
    /// Non-deleted refunds linked to an expense, oldest first.
    static func linked(to original: LedgerEntry, in entries: [LedgerEntry], excluding id: String? = nil) -> [LedgerEntry] {
        entries.filter { $0.isRefund && $0.refundOf == original.id && $0.groupID == original.groupID && $0.id != id }
            .sorted { $0.createdAt < $1.createdAt }
    }

    /// Receipt item IDs already given back by these refunds. Each item can be refunded once.
    static func refundedItems(_ refunds: [LedgerEntry]) -> Set<String> { Set(refunds.flatMap { $0.refundItems ?? [] }) }

    static func refundedTotal(_ refunds: [LedgerEntry]) -> Int64 { refunds.reduce(0) { $0 + $1.amount } }

    /// What each person who shared the original can still be credited.
    static func remainingShares(of original: LedgerEntry, refunds: [LedgerEntry]) -> [Portion] {
        var credited: [String: Int64] = [:]
        for refund in refunds { for s in refund.splits { credited[s.memberID, default: 0] += s.amount } }
        return original.splits.compactMap { share in
            let left = share.amount - (credited[share.memberID] ?? 0)
            return left > 0 ? Portion(memberID: share.memberID, amount: left) : nil
        }
    }

    static func remaining(of original: LedgerEntry, refunds: [LedgerEntry]) -> Int64 {
        max(0, original.amount - refundedTotal(refunds))
    }

    /// Splits `amount` across the chosen people in proportion to what each can still be credited,
    /// by largest remainder. Each credit stays within that person's remaining share.
    static func proportional(_ amount: Int64, original: LedgerEntry, refunds: [LedgerEntry], people: [String]) throws -> [Portion] {
        let left = remainingShares(of: original, refunds: refunds).filter { people.contains($0.memberID) }
        let available = left.reduce(0) { $0 + $1.amount }
        guard !left.isEmpty else { throw LedgerError.invalid("Choose people who shared the original expense.") }
        guard amount <= available else {
            throw LedgerError.invalid("The refund can’t be more than \(Money.text(available, original.currency)) for these people.")
        }
        let amounts = try Ledger.allocate(total: amount, weights: left.map(\.amount))
        return zip(left, amounts).map { Portion(memberID: $0.memberID, amount: $1) }.filter { $0.amount > 0 }
    }

    /// Mirrors the Worker's checks so the composer can explain a problem before saving.
    static func validate(_ refund: LedgerEntry, original: LedgerEntry?, others: [LedgerEntry]) throws {
        guard refund.isRefund, refund.amount > 0, refund.splits.reduce(0, { $0 + $1.amount }) == refund.amount,
              refund.splits.allSatisfy({ $0.amount >= 0 }) else {
            throw LedgerError.invalid("The credits must add up to the refund exactly.")
        }
        guard refund.splits.contains(where: { $0.memberID != refund.paidBy && $0.amount > 0 }) else {
            throw LedgerError.invalid("Credit the refund to someone other than the person who received it.")
        }
        guard refund.pending != true || refund.handled != true else { throw LedgerError.invalid("A handled entry can’t be pending.") }
        guard let original else { return }
        guard original.kind == "expense" else { throw LedgerError.invalid("Refunds can only refer to an expense.") }
        guard refund.currency == original.currency else { throw LedgerError.invalid("Use the original expense’s currency.") }
        guard (refund.exchange == nil) == (original.exchange == nil),
              refund.exchange == nil || refund.exchange?.target == original.exchange?.target else {
            throw LedgerError.invalid("Use the original expense’s settlement currency.")
        }
        if let ids = refund.refundItems {
            guard others.allSatisfy({ ($0.refundItems ?? []).allSatisfy { !ids.contains($0) } }) else {
                throw LedgerError.invalid("One of these items has already been refunded.")
            }
            let exact = try Consumption.itemRefund(original, itemIDs: ids)
            let credits = refund.splits.filter { $0.amount != 0 }
            guard refund.amount == exact.amount, credits.count == exact.splits.count,
                  exact.splits.allSatisfy({ p in credits.contains { $0.memberID == p.memberID && $0.amount == p.amount } }) else {
                throw LedgerError.invalid("Refresh the item refund: credits must match what each person paid for these items.")
            }
        }
        guard refundedTotal(others) + refund.amount <= original.amount else {
            throw LedgerError.invalid("Refunds can’t exceed the original expense of \(Money.text(original.amount, original.currency)).")
        }
        let left = Dictionary(remainingShares(of: original, refunds: others).map { ($0.memberID, $0.amount) }, uniquingKeysWith: +)
        for credit in refund.splits where credit.amount > 0 {
            guard original.splits.contains(where: { $0.memberID == credit.memberID && $0.amount > 0 }) else {
                throw LedgerError.invalid("Refund only people who shared the original expense.")
            }
            guard credit.amount <= left[credit.memberID] ?? 0 else {
                throw LedgerError.invalid("A person’s refunds can’t exceed their share of the original expense.")
            }
        }
    }

    /// A linked refund received by `receiver`, with its own exchange rate copied from the original.
    static func make(id: String = UUID().uuidString, original: LedgerEntry, title: String, credits: [Portion], receiver: String,
                     createdAt: String = ISO8601DateFormatter().string(from: Date())) -> LedgerEntry {
        let amount = credits.reduce(0) { $0 + $1.amount }
        var refund = LedgerEntry(id: id, groupID: original.groupID, title: title, amount: amount, currency: original.currency,
                                 paidBy: receiver, splits: credits, category: original.category, kind: "refund",
                                 splitMode: .exact, createdAt: createdAt)
        refund.refundOf = original.id
        if var exchange = original.exchange {
            if exchange.source == "Statement" { exchange.source = "Manual"; exchange.statementAmount = nil }
            refund.exchange = exchange
        }
        return refund
    }

    /// Rescales an entry's splits and payers to a new amount by largest remainder.
    static func adjusted(_ entry: LedgerEntry, to amount: Int64) throws -> LedgerEntry {
        guard amount > 0, amount <= Money.maxAmount else { throw LedgerError.invalid("Enter a positive amount.") }
        guard entry.bill == nil else { throw LedgerError.invalid("Edit the receipt items to change an itemized expense.") }
        var next = entry
        next.amount = amount
        let shares = try Ledger.allocate(total: amount, weights: entry.splits.map(\.amount))
        next.splits = zip(entry.splits, shares).map { Portion(memberID: $0.memberID, amount: $1) }
        if let payers = entry.payers, !payers.isEmpty {
            let paid = try Ledger.allocate(total: amount, weights: payers.map(\.amount))
            next.payers = zip(payers, paid).map { Payer(memberID: $0.memberID, amount: $1) }
        }
        next.pending = nil
        next.pendingNote = nil
        return next
    }
}
