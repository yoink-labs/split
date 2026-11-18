import Foundation

struct Exchange:Codable,Equatable {
    var target:String
    var rateE8:Int64
    var date:String
    var source:String
    var rate:Decimal { Decimal(rateE8)/100_000_000 }
    func description(base:String)->String { "1 \(base) = \(NSDecimalNumber(decimal:rate).stringValue) \(target) · \(source) · \(date)" }
    static func localDay(_ date:Date)->String {
        let formatter=DateFormatter();formatter.calendar=Calendar(identifier:.gregorian)
        formatter.locale=Locale(identifier:"en_US_POSIX");formatter.timeZone = .current;formatter.dateFormat="yyyy-MM-dd"
        return formatter.string(from:date)
    }
    static func units(_ text:String)->Int64? {
        let clean=text.replacingOccurrences(of:",",with:".")
        guard clean.range(of:#"^\d{1,8}(\.\d{1,8})?$"#,options:.regularExpression) != nil,
              let d=Decimal(string:clean), d>0, d<=10_000_000 else { return nil }
        return NSDecimalNumber(decimal:d*100_000_000).int64Value
    }
    func converting(_ e:LedgerEntry)throws->LedgerEntry {
        var raw=Decimal(e.amount)*rate, rounded=Decimal()
        NSDecimalRound(&rounded,&raw,0,.plain)
        guard rounded>=1,rounded<=Decimal(Money.maxAmount) else { throw LedgerError.invalid("Check the converted amount.") }
        var output=e
        output.amount=NSDecimalNumber(decimal:rounded).int64Value
        let shares=try Ledger.allocate(total:output.amount,weights:e.splits.map(\.amount))
        output.splits=zip(e.splits,shares).map{Portion(memberID:$0.memberID,amount:$1)}
        if let payers=e.payers {
            let converted=try Ledger.allocate(total:output.amount,weights:payers.map(\.amount))
            output.payers=zip(payers,converted).map{Payer(memberID:$0.memberID,amount:$1)}
        }
        output.exchange=nil;output.currency=target
        return output
    }
    static func fetch(base:String,target:String,date:String) async throws -> Exchange {
        let (data,res)=try await URLSession.shared.data(from:FXQuote.url(base:base,quote:target,date:date))
        guard (res as? HTTPURLResponse)?.statusCode==200,
              let q=FXQuote.decode(data,base:base,quote:target,requested:date,source:FXQuote.source(base:base,quote:target)) else { throw LedgerError.invalid("No published rate for this date. Enter a manual rate.") }
        return q.exchange
    }
}
extension LedgerEntry {
    var settling:LedgerEntry { guard let exchange else { return self };return (try? exchange.converting(self)) ?? self }
}
