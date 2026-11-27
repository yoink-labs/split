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
