import UIKit
import Vision
import ImageIO

struct Purchase: Codable, Identifiable, Equatable {
    var id = UUID().uuidString
    var title: String
    var amount: Int64
    var memberIDs: [String] = []
    var roundingSeats: [String]?
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
            let people = item.roundingSeats ?? (item.memberIDs.isEmpty ? [payer] : item.memberIDs)
            let shares = try Ledger.allocate(total:amount,weights:people.map { _ in 1 })
            for (id,share) in zip(people,shares) {
                if let index = result.firstIndex(where:{ $0.memberID == id }) { result[index].amount += share }
                else { result.append(Portion(memberID:id,amount:share)) }
            }
        }
        return result
    }
}
struct ReceiptPhoto: Codable, Identifiable { var id = UUID().uuidString; var data: Data }
enum ReceiptReader {
    static func scan(_ data: Data) throws -> (ReceiptPhoto,ReceiptBill) {
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
        return (ReceiptPhoto(data:jpeg),suggest(lines))
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
