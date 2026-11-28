import UIKit
import Vision
import ImageIO

struct Purchase: Codable, Identifiable, Equatable {
    var id = UUID().uuidString
    var title: String
    var amount: Int64
    var memberIDs: [String] = []
    var roundingSeats: [String]?
    var shares: [String: Int64]?
    var roundingWeights: [Int64]?

    func portions(gross: Int64, payer: String) throws -> [Portion] {
        let people = roundingSeats ?? (memberIDs.isEmpty ? [payer] : memberIDs)
        let weights = roundingSeats == nil ? people.map { shares?[$0] ?? 100 } : roundingWeights ?? people.map { _ in 1 }
        let amounts = try Ledger.allocate(total: gross, weights: weights)
        return zip(people, amounts).map { Portion(memberID: $0, amount: $1) }
    }
}
struct ReceiptBill: Codable, Equatable {
    var items: [Purchase] = []
    var tax: Int64 = 0
    var tip: Int64 = 0
    var closed = false
    var total: Int64 { items.reduce(tax + tip) { $0 + $1.amount } }
    var openCount: Int { items.filter { $0.memberIDs.isEmpty }.count }
    func gross() throws -> [Int64] {
        guard !items.isEmpty, items.count <= 50, total <= Money.maxAmount,
              items.allSatisfy({ $0.amount > 0 && !$0.title.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && $0.title.count <= 100 })
        else { throw LedgerError.invalid("Give each purchase a name and positive price. A receipt supports up to 50 items.") }
        let extra = tax + tip
        let charges = extra == 0 ? items.map { _ in Int64(0) } : try Ledger.allocate(total:extra,weights:items.map(\.amount))
        return zip(items,charges).map { $0.amount + $1 }
    }
    var openTotal: Int64 { zip(items,(try? gross()) ?? []).reduce(0) { $0 + ($1.0.memberIDs.isEmpty ? $1.1 : 0) } }
    func split(payer: String) throws -> [Portion] {
        var result: [Portion] = []
        for (item,amount) in zip(items,try gross()) {
            for portion in try item.portions(gross: amount, payer: payer) {
                if let index = result.firstIndex(where: { $0.memberID == portion.memberID }) {
                    result[index].amount += portion.amount
                } else {
                    result.append(portion)
                }
            }
        }
        return result
    }
}
struct ReceiptPhoto: Codable, Identifiable { var id = UUID().uuidString; var data: Data }
/// One person's part of an item or a bill: their share split into item price, tax and tip.
/// `items + tax + tip == amount`, always.
struct ConsumptionPart: Equatable {
    var memberID: String
    var amount: Int64
    var items: Int64
    var tax: Int64
    var tip: Int64
}

/// Who consumed one receipt item, with the item's own share of tax and tip.
struct ItemConsumption: Equatable, Identifiable {
    var id: String
    var title: String
    var amount: Int64
    var gross: Int64
    var tax: Int64
    var tip: Int64
    var open: Bool
    var portions: [ConsumptionPart]
}

struct BillConsumption: Equatable {
    var items: [ItemConsumption]
    var people: [ConsumptionPart]
}

/// One consumption line for a person: a receipt item, or a whole non-itemized expense.
struct ConsumptionLine: Equatable {
    var part: ConsumptionPart
    var entryID: String
    var itemID: String?
    var title: String
}

struct PersonConsumption: Equatable {
    var total: ConsumptionPart
    var lines: [ConsumptionLine]
}

/// Swift port of the Worker's `billConsumption`, `entryConsumption` and `consumptionReport`
/// (`worker/src/items.ts`). Keep the two in step: both must agree to the cent.
enum Consumption {
    /// Largest remainder over the weights, or all zeros when there is nothing to spread.
    static func spread(_ total: Int64, _ weights: [Int64]) throws -> [Int64] {
        guard total > 0, weights.contains(where: { $0 > 0 }) else { return weights.map { _ in 0 } }
        return try Ledger.allocate(total: total, weights: weights, maximumTotal: .max)
    }

    static func bill(_ bill: ReceiptBill, payer: String) throws -> BillConsumption {
        let gross = try bill.gross()
        let extras = zip(bill.items, gross).map { $1 - $0.amount }
        let taxes = try spread(bill.tax, extras)
        var items: [ItemConsumption] = []
        for (index, item) in bill.items.enumerated() {
            let raw = try item.portions(gross: gross[index], payer: payer)
            var ids: [String] = []
            for portion in raw where !ids.contains(portion.memberID) { ids.append(portion.memberID) }
            let amounts = ids.map { id in raw.filter { $0.memberID == id }.reduce(Int64(0)) { $0 + $1.amount } }
            let base = try spread(item.amount, amounts)
            let rest = zip(amounts, base).map { $0 - $1 }
            let tax = try spread(taxes[index], rest)
            let portions = ids.indices.map { k in
                ConsumptionPart(memberID: ids[k], amount: amounts[k], items: base[k], tax: tax[k], tip: rest[k] - tax[k])
            }
            items.append(ItemConsumption(id: item.id, title: item.title, amount: item.amount, gross: gross[index],
                                         tax: taxes[index], tip: extras[index] - taxes[index],
                                         open: item.memberIDs.isEmpty, portions: portions))
        }
        var people: [ConsumptionPart] = []
        for part in items.flatMap(\.portions) {
            if let index = people.firstIndex(where: { $0.memberID == part.memberID }) {
                people[index].amount += part.amount
                people[index].items += part.items
                people[index].tax += part.tax
                people[index].tip += part.tip
            } else {
                people.append(part)
            }
        }
        return BillConsumption(items: items, people: people)
    }

    static func items(_ entry: LedgerEntry) throws -> [ItemConsumption] {
        if let receipt = entry.bill { return try bill(receipt, payer: entry.paidBy).items }
        let portions = entry.splits.map {
            ConsumptionPart(memberID: $0.memberID, amount: $0.amount, items: $0.amount, tax: 0, tip: 0)
        }
        return [ItemConsumption(id: entry.id, title: entry.title, amount: entry.amount, gross: entry.amount,
                                tax: 0, tip: 0, open: false, portions: portions)]
    }

    /// Swift port of the Worker's `itemRefund`: what refunding specific receipt items credits each
    /// person, their full item portion including tax and tip, in first-seen order. Zero credits drop out.
    static func itemRefund(_ original: LedgerEntry, itemIDs: [String]) throws -> (amount: Int64, splits: [Portion]) {
        guard let bill = original.bill else { throw LedgerError.invalid("Only an itemized expense can refund specific items.") }
        guard !itemIDs.isEmpty, Set(itemIDs).count == itemIDs.count else { throw LedgerError.invalid("Choose the items to refund.") }
        let items = try Consumption.bill(bill, payer: original.paidBy).items
        let chosen = try itemIDs.map { id -> ItemConsumption in
            guard let item = items.first(where: { $0.id == id }) else { throw LedgerError.invalid("Choose items from the original receipt.") }
            return item
        }
        var splits: [Portion] = []
        for part in chosen.flatMap(\.portions) {
            if let index = splits.firstIndex(where: { $0.memberID == part.memberID }) {
                splits[index].amount += part.amount
            } else {
                splits.append(Portion(memberID: part.memberID, amount: part.amount))
            }
        }
        splits.removeAll { $0.amount == 0 }
        return (splits.reduce(0) { $0 + $1.amount }, splits)
    }

    /// Receipt items for itemized expenses, otherwise one line per person equal to their split.
    /// Refunds give consumption back as negative lines: an item refund returns exactly those items'
    /// portions (item, tax and tip) when they match its credits, any other refund one line per credited person.
    static func lines(_ entry: LedgerEntry, all: [LedgerEntry] = []) throws -> [ConsumptionLine] {
        if entry.isRefund {
            if let ids = entry.refundItems,
               let original = all.first(where: { $0.id == entry.refundOf && $0.kind == "expense" }), let bill = original.bill {
                let items = try Consumption.bill(bill, payer: original.paidBy).items.filter { ids.contains($0.id) }
                let lines = items.flatMap { item in
                    item.portions.filter { $0.amount != 0 }.map {
                        ConsumptionLine(part: ConsumptionPart(memberID: $0.memberID, amount: -$0.amount, items: -$0.items, tax: -$0.tax, tip: -$0.tip),
                                        entryID: entry.id, itemID: item.id, title: "Refund: " + item.title)
                    }
                }
                let exact = entry.splits.allSatisfy { s in
                    lines.filter { $0.part.memberID == s.memberID }.reduce(Int64(0)) { $0 - $1.part.amount } == s.amount
                } && lines.allSatisfy { l in entry.splits.contains { $0.memberID == l.part.memberID } }
                if exact { return lines }
            }
            return entry.splits.filter { $0.amount != 0 }.map {
                ConsumptionLine(part: ConsumptionPart(memberID: $0.memberID, amount: -$0.amount, items: -$0.amount, tax: 0, tip: 0),
                                entryID: entry.id, itemID: nil, title: entry.title)
            }
        }
        if let bill = entry.bill {
            return try Consumption.bill(bill, payer: entry.paidBy).items.flatMap { item in
                item.portions.map { ConsumptionLine(part: $0, entryID: entry.id, itemID: item.id, title: item.title) }
            }
        }
        return entry.splits.filter { $0.amount != 0 }.map {
            ConsumptionLine(part: ConsumptionPart(memberID: $0.memberID, amount: $0.amount, items: $0.amount, tax: 0, tip: 0),
                            entryID: entry.id, itemID: nil, title: entry.title)
        }
    }

    /// Consumption by person across the expenses and refunds recorded in one currency, oldest
    /// first (then by ID), with people in first-seen order. Refunds net out what they gave back.
    static func report(_ entries: [LedgerEntry], currency: String) throws -> [PersonConsumption] {
        var people: [PersonConsumption] = []
        let spending = entries.filter { ($0.kind == "expense" || $0.kind == "refund") && $0.currency == currency }
            .sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
        for entry in spending {
            for line in try lines(entry, all: entries) {
                if let index = people.firstIndex(where: { $0.total.memberID == line.part.memberID }) {
                    people[index].total.amount += line.part.amount
                    people[index].total.items += line.part.items
                    people[index].total.tax += line.part.tax
                    people[index].total.tip += line.part.tip
                    people[index].lines.append(line)
                } else {
                    people.append(PersonConsumption(total: line.part, lines: [line]))
                }
            }
        }
        return people
    }
}

/// A receipt photo uploaded to a group's inbox and not yet paired to an expense.
struct InboxReceipt: Codable, Identifiable, Equatable {
    var id: String
    var groupID: String
    var uploadedBy: String
    var createdAt: String
    var note: String?
    var bytes: Int

    var date: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: createdAt) ?? ISO8601DateFormatter().date(from: createdAt)
    }
}

struct InboxReceiptList: Codable { var receipts: [InboxReceipt] }

/// The most receipt photos one expense can hold.
let receiptLimit = 4


struct ReceiptDraft: Codable, Identifiable {
    var id = UUID().uuidString
    let groupID: String
    var title = ""
    var photos: [ReceiptPhoto] = []
    var capturedAt = Date()
}

enum ReceiptReader {
    private static func prepare(_ data: Data) throws -> (ReceiptPhoto, CGImage) {
        guard let source = CGImageSourceCreateWithData(data as CFData,nil),
              let cg = CGImageSourceCreateThumbnailAtIndex(source,0,[
                kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceCreateThumbnailWithTransform:true,
                kCGImageSourceThumbnailMaxPixelSize:1600
              ] as CFDictionary) else { throw LedgerError.invalid("Couldn’t read this photo.") }
        let image = UIImage(cgImage:cg)
        var jpeg: Data?
        for quality in [0.82,0.65,0.48,0.32,0.18,0.09] {
            if let candidate = image.jpegData(compressionQuality:quality), candidate.count <= 245760 { jpeg=candidate; break }
        }
        guard let jpeg else { throw LedgerError.invalid("This photo is too large. Crop to the receipt and try again.") }
        return (ReceiptPhoto(data: jpeg), cg)
    }

    static func photo(_ data: Data) throws -> ReceiptPhoto {
        try prepare(data).0
    }

    static func scan(_ data: Data) throws -> (ReceiptPhoto, ReceiptBill) {
        let (photo, cg) = try prepare(data)
        return (photo, recognize(cg))
    }

    static func readDraft(_ photos: [ReceiptPhoto]) -> ReceiptBill {
        var bill = ReceiptBill()
        for photo in photos {
            if Task.isCancelled { break }
            guard let source = CGImageSourceCreateWithData(photo.data as CFData, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { continue }
            let suggestion = recognize(image)
            bill.items.append(contentsOf: suggestion.items.prefix(50 - bill.items.count))
            bill.tax += suggestion.tax
            bill.tip += suggestion.tip
        }
        return bill
    }

    private static func recognize(_ cg: CGImage) -> ReceiptBill {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        try? VNImageRequestHandler(cgImage:cg).perform([request])
        let words = (request.results ?? []).sorted { $0.boundingBox.midY > $1.boundingBox.midY }
        var rows: [[VNRecognizedTextObservation]] = []
        for word in words {
            if let index = rows.firstIndex(where:{ abs($0[0].boundingBox.midY-word.boundingBox.midY) < min($0[0].boundingBox.height,word.boundingBox.height)*0.55 }) { rows[index].append(word) }
            else { rows.append([word]) }
        }
        let lines = rows.map { $0.sorted { $0.boundingBox.minX < $1.boundingBox.minX }.compactMap { $0.topCandidates(1).first?.string }.joined(separator:" ") }
        return suggest(lines)
    }
    static func suggest(_ lines:[String]) -> ReceiptBill {
        var bill = ReceiptBill()
        for line in lines {
            guard let range = line.range(of:#"\s+[$€£]?\s*\d+[.,]\d{2}\s*$"#,options:.regularExpression),
                  let digits = line[range].range(of:#"\d+[.,]\d{2}"#,options:.regularExpression),
                  let amount=Money.parse(String(line[digits])), amount>0 else { continue }
            let title=String(line[..<range.lowerBound]).trimmingCharacters(in:.whitespacesAndNewlines)
            let key=title.lowercased()
            if key.range(of:#"\b(tax|vat|iva)\b"#,options:.regularExpression) != nil { bill.tax += amount }
            else if key.range(of:#"\b(tip|gratuity|propina)\b"#,options:.regularExpression) != nil { bill.tip += amount }
            else if !title.isEmpty && key.range(of:#"total|balance|change|tender|cash|credit|debit|discount|payment|refund|paid|suggested"#,options:.regularExpression)==nil && bill.items.count<50 {
                bill.items.append(Purchase(title:String(title.prefix(100)),amount:amount))
            }
        }
        return bill
    }
}
