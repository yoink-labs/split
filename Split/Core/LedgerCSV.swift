// Swift adaptation of ManaWG's expense import parsers. See THIRD_PARTY_NOTICES.md.
import Foundation

struct CSVShare:Codable { var name:String; var amount:Int64 }
struct CSVExpense:Codable {
    var title:String; var day:String; var payer:String; var amount:Int64
    var currency:String; var category:String?; var payment:Bool; var splits:[CSVShare]
    var sourceID:String?; var sourceGroup:String?; var exchange:Exchange?
}
enum LedgerCSV {
    static func table(_ raw:String)throws->[[String]] {
        let text=raw.replacingOccurrences(of:"\r\n",with:"\n").replacingOccurrences(of:"\r",with:"\n").trimmingCharacters(in:CharacterSet(charactersIn:"\u{feff}"))
        let line=text.prefix(while:{$0 != "\n"})
        let delimiter:Character=line.filter{$0==";"}.count>line.filter{$0==","}.count ? ";" : ","
        var rows:[[String]]=[],row:[String]=[],cell="",quoted=false, iter=text.makeIterator()
        var char=iter.next()
        while let c=char {
            char=iter.next()
            if c=="\"" {
                if quoted && char=="\"" { cell.append(c);char=iter.next() }
                else { quoted.toggle() }
            } else if !quoted && (c==delimiter || c=="\n") {
                row.append(cell);cell=""
                if c=="\n" { rows.append(row);row=[] }
            } else { cell.append(c) }
        }
        guard !quoted else { throw LedgerError.invalid("Unclosed quotation mark in CSV.") }
        if !row.isEmpty || !cell.isEmpty { row.append(cell);rows.append(row) }
        return rows
    }
    static func parse(_ raw:String,defaultCurrency:String)throws->[CSVExpense] {
        let rows=try table(raw)
        func key(_ v:String)->String { v.trimmingCharacters(in:.whitespacesAndNewlines).folding(options:[.caseInsensitive,.diacriticInsensitive],locale:Locale(identifier:"en_US_POSIX")).lowercased() }
        let dates=["date","datum","fecha","date & time","date and time","transaction date"]
        guard let start=rows.firstIndex(where:{r in r.contains{dates.contains(key($0))}}) else { throw LedgerError.invalid("Missing CSV date header.") }
        let headers=rows[start], keys=headers.map(key)
        func column(_ names:[String])->Int? { keys.firstIndex(where:names.contains) }
        let description=column(["description","descripcion","beschreibung","purpose","title","titulo","titel","titre","transaction title","transaction name","name"])
        let cost=keys.firstIndex{["amount","cost","kosten","coste","costo","betrag","importe","montant"].contains(String($0.split(separator:"(").first ?? "").trimmingCharacters(in:.whitespaces))}
        guard let date=column(dates),let cost,let description,headers.count<=75 else { throw LedgerError.invalid("Missing description or cost columns.") }
        let payer=column(["paid by","payer","who paid","bezahlt von","pagado por","pagador","zahler","paye par"])
        let category=column(["category","categoria","kategorie"]), currency=column(["currency","moneda","wahrung","devise"])
        let people=column(["for whom","participants","teilnehmer","participantes","paid for","fur","split between","beneficiaries"])
        let split=column(["split amounts","split"]),type=column(["type","transaction type","transaktionstyp"])
        let sourceID=column(["split entry id"]),sourceGroup=column(["split group id"]),target=column(["settle currency"]),rate=column(["rate e8"]),rateDate=column(["rate date"]),rateSource=column(["rate source"])
        let known=Set([description,cost,date,payer,category,currency,people,split,type,sourceID,sourceGroup,target,rate,rateDate,rateSource].compactMap{$0})
        let extra=keys.indices.filter{!known.contains($0) && !["notes","notas","notizen","details","detalles","repayments","created date","created by","last changed","last modified by"].contains(keys[$0])}
        let sharePrefix=#"(?i)^(?:impacted(?: to| for)?|paid for|share(?: of)?|bezahlt für)[\s:]+(?=.)"#
        let shareColumns=extra.compactMap { i -> (Int,String)? in guard let range=headers[i].range(of:sharePrefix,options:.regularExpression) else { return nil };return (i,String(headers[i][range.upperBound...])) }
        func number(_ s:String)->Int64? { s.hasPrefix("-") ? Money.parse(String(s.dropFirst())).map{-$0} : Money.parse(s) }
        var result:[CSVExpense]=[]
        for (offset,row) in rows.dropFirst(start+1).enumerated() {
            func cell(_ i:Int?)->String { guard let i,i<row.count else{return ""};return row[i].trimmingCharacters(in:.whitespacesAndNewlines) }
            let invalid=LedgerError.invalid("Check the date, currency, payer and shares on CSV row "+String(start+offset+2)+".")
            let title=cell(description)
            if row.allSatisfy({$0.trimmingCharacters(in:.whitespaces).isEmpty}) || ["total balance","saldo total","gesamtsaldo"].contains(key(title)) { continue }
            let day=String(cell(date).prefix(10))
            let headerCurrency=headers[cost].split(separator:"(").last.map{String($0.prefix(3)).uppercased()} ?? ""
            let code=cell(currency).isEmpty ? (Money.currencies.contains(headerCurrency) ? headerCurrency : defaultCurrency) : cell(currency).uppercased()
            guard let amount=number(cell(cost)), amount>0, !title.isEmpty, Money.currencies.contains(code),day.count==10,
                  let iso=ISO8601DateFormatter().date(from:day+"T12:00:00Z"),String(ISO8601DateFormatter().string(from:iso).prefix(10))==day else { throw invalid }
            var by=cell(payer),shares:[CSVShare]=[]
            let kind=key(cell(type)+" "+cell(category))
            if kind.range(of:"income|refund|revenu",options:.regularExpression) != nil { throw invalid }
            let payment=kind.range(of:"settlement|payment|zahlung|pago|transfer|reimburs|remboursement",options:.regularExpression) != nil
            if !shareColumns.isEmpty {
                for (i,name) in shareColumns where !cell(i).isEmpty {
                    guard let n=number(cell(i)) else {throw invalid}
                    if n != 0 {shares.append(CSVShare(name:name,amount:abs(n)))}
                }
            } else if let people {
                let names=cell(people).components(separatedBy:CharacterSet(charactersIn:",;|")).map{$0.trimmingCharacters(in:.whitespaces)}.filter{!$0.isEmpty}
                let inputs=cell(split).components(separatedBy:";").compactMap{Money.parse($0)}
                let amounts=cell(split).isEmpty ? try Ledger.allocate(total:amount,weights:names.map{_ in 1}) : inputs
                guard amounts.count==names.count else {throw invalid}
                shares=zip(names,amounts).map{CSVShare(name:$0,amount:$1)}
            } else {
                var net:[(String,Int64)]=[]
                for i in extra where !cell(i).isEmpty {
                    guard let n=number(cell(i)) else {throw invalid}
                    net.append((headers[i],n))
                }
                if by.isEmpty { let positive=net.filter{$0.1>0};guard positive.count==1 else {throw invalid};by=positive[0].0 }
                guard net.reduce(0,{$0+$1.1})==0 else {throw invalid}
                for (n,v) in net {
                    let share=(n==by ? amount : 0)-v
                    guard share>=0 else {throw invalid}
                    if share>0 {shares.append(CSVShare(name:n,amount:share))}
                }
            }
            guard !by.isEmpty,shares.reduce(0,{$0+$1.amount})==amount,!payment || (shares.count==1 && shares[0].name != by) else {throw invalid}
            var exchange:Exchange?
            if !cell(rate).isEmpty {
                guard let units=Int64(cell(rate)),units>0 else {throw invalid}
                exchange=Exchange(target:cell(target),rateE8:units,date:cell(rateDate),source:cell(rateSource))
            }
            result.append(CSVExpense(title:title,day:day,payer:by,amount:amount,currency:code,category:cell(category).isEmpty ? nil : cell(category),payment:payment,splits:shares,sourceID:sourceID==nil ? nil : cell(sourceID),sourceGroup:sourceGroup==nil ? nil : cell(sourceGroup),exchange:exchange))
        }
        guard (1...80).contains(result.count) else {throw LedgerError.invalid("Choose a file with 1–80 expense rows.")}
        return result
    }
    static func export(_ entries:[LedgerEntry],group:ExpenseGroup)->String {
        func safe(_ s:String)->String {
            let prefix=s.first.map{"=+-@\t\r".contains($0)} == true ? "'" : ""
            return "\""+prefix+s.replacingOccurrences(of:"\"",with:"\"\"")+"\""
        }
        let members=group.members
        var rows=[(["Date","Description","Category","Cost","Currency","Paid by","Split entry ID","Split group ID","Settle currency","Rate E8","Rate date","Rate source"]+members.map(\.name)).map(safe).joined(separator:",")]
        for e in entries {
            var columns=[String(e.createdAt.prefix(10)),e.title,e.kind=="settlement" ? "Payment" : (e.category ?? ""),Money.input(e.amount),e.currency,members.first{$0.id==e.paidBy}?.name ?? ""]
            columns += [e.id,group.id,e.exchange?.target ?? "",e.exchange.map{String($0.rateE8)} ?? "",e.exchange?.date ?? "",e.exchange?.source ?? ""]
            let nets=members.map{m in Money.input((m.id==e.paidBy ? e.amount : 0)-(e.splits.first{$0.memberID==m.id}?.amount ?? 0))}
            rows.append((columns.map(safe)+nets).joined(separator:","))
        }
        return rows.joined(separator:"\r\n")+"\r\n"
    }
}
