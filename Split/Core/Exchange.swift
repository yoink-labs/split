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
        output.exchange=nil;output.currency=target
        return output
    }
    static func fetch(base:String,target:String,date:String) async throws -> Exchange {
        let bcra=[base,target].contains("ARS")
        var url=URLComponents(string:"https://api.frankfurter.dev/v2/rate/\(base)/\(target)")!
        url.queryItems=[URLQueryItem(name:"date",value:date)]
        if bcra { url.queryItems?.append(URLQueryItem(name:"providers",value:"bcra")) }
        struct Quote:Decodable { var base:String;var quote:String;var date:String;var rate:Decimal }
        let (data,res)=try await URLSession.shared.data(from:url.url!)
        guard (res as? HTTPURLResponse)?.statusCode==200,let q=try? JSONDecoder().decode(Quote.self,from:data),
              q.base==base,q.quote==target,q.date<=date,q.rate>0,q.rate<=10_000_000 else { throw LedgerError.invalid("No published rate for this date. Enter a manual rate.") }
        var scaled=q.rate*100_000_000, rounded=Decimal()
        NSDecimalRound(&rounded,&scaled,0,.plain)
        return Exchange(target:target,rateE8:NSDecimalNumber(decimal:rounded).int64Value,date:q.date,source:bcra ? "BCRA" : "Frankfurter")
    }
}
extension LedgerEntry {
    var settling:LedgerEntry { guard let exchange else { return self };return (try? exchange.converting(self)) ?? self }
}
