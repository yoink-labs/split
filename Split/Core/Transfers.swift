import Foundation

extension Ledger {
    static func plan(_ values:[String:Int64],currency:String)->[Transfer] {
        var parts:[[String]]=[], rest:[String]=[]
        for id in values.keys.sorted() where values[id] != 0 {
            if let index=rest.firstIndex(where:{ values[$0] == -(values[id] ?? 0) }) {
                parts.append([rest.remove(at:index),id])
            } else { rest.append(id) }
        }
        if !rest.isEmpty && rest.count<=16 {
            let size=1<<rest.count
            var sums=Array(repeating:Int64(0),count:size), counts=Array(repeating:0,count:size), last=counts
            for mask in 1..<size {
                let bit=mask & -mask
                sums[mask]=sums[mask^bit]+(values[rest[bit.trailingZeroBitCount]] ?? 0)
                var best = -1, bits=mask
                while bits>0 {
                    let b=bits & -bits, count=counts[mask^b]
                    if count>best { best=count; last[mask]=b.trailingZeroBitCount }
                    bits &= bits-1
                }
                counts[mask]=best+(sums[mask]==0 ? 1 : 0)
            }
            var mask=size-1, part:[String]=[]
            while mask>0 {
                let index=last[mask];part.append(rest[index]);mask ^= 1<<index
                if sums[mask]==0 { parts.append(part);part=[] }
            }
        } else if !rest.isEmpty { parts.append(rest) }
        var result:[Transfer]=[]
        for part in parts {
            let ordered=part.sorted { a,b in
                let x=abs(values[a] ?? 0), y=abs(values[b] ?? 0)
                return x==y ? a<b : x>y
            }
            var remaining=values
            for d in ordered where (values[d] ?? 0)<0 {
                for c in ordered where (values[c] ?? 0)>0 {
                    let amount=min(-(remaining[d] ?? 0),remaining[c] ?? 0)
                    if amount>0 {
                        result.append(Transfer(from:d,to:c,amount:amount,currency:currency))
                        remaining[d,default:0]+=amount;remaining[c,default:0]-=amount
                    }
                }
            }
        }
        return result
    }
}

extension Ledger {
    /// Direct matching without subset or exact-opposite simplification. Used
    /// when a group turns "Simplify payments" off: every nonzero balance pays
    /// the people it can, in a stable order, without routing through others.
    static func directPlan(_ values: [String: Int64], currency: String) -> [Transfer] {
        var remaining = values.filter { $0.value != 0 }
        var debtors = remaining.filter { $0.value < 0 }.keys.sorted()
        var creditors = remaining.filter { $0.value > 0 }.keys.sorted()
        var transfers: [Transfer] = []
        var d = 0, c = 0
        while d < debtors.count, c < creditors.count {
            let from = debtors[d], to = creditors[c]
            let amount = min(-(remaining[from] ?? 0), remaining[to] ?? 0)
            if amount > 0 {
                transfers.append(Transfer(from: from, to: to, amount: amount, currency: currency))
                remaining[from, default: 0] += amount
                remaining[to, default: 0] -= amount
            }
            if (remaining[from] ?? 0) == 0 { d += 1 }
            if (remaining[to] ?? 0) == 0 { c += 1 }
        }
        return transfers
    }

    /// Exponential search for large ledgers, run off the UI thread only on request.
    /// Eliminating a seat against each opposite balance enumerates balanced partitions.
    static func minimumPlan(_ values:[String:Int64],currency:String) throws -> [Transfer] {
        let ids=values.keys.filter{values[$0] != 0}.sorted()
        var amounts=ids.map{values[$0] ?? 0}
        var best=plan(values,currency:currency),edges:[(Int,Int)]=[]
        func visit(_ start:Int)throws {
            try Task.checkCancellation()
            var i=start
            while i<ids.count && amounts[i]==0 {i+=1}
            if i==ids.count {
                guard edges.count<best.count else {return}
                var labels=Array(ids.indices)
                for (a,b) in edges {
                    let from=labels[a],to=labels[b]
                    for j in labels.indices where labels[j]==from {labels[j]=to}
                }
                let parts=Dictionary(grouping:ids.indices,by:{labels[$0]})
                best=parts.keys.sorted().flatMap { key in
                    let subset=Dictionary(uniqueKeysWithValues:(parts[key] ?? []).map{(ids[$0],values[ids[$0]] ?? 0)})
                    return plan(subset,currency:currency)
                }
                return
            }
            let remaining=amounts[i...]
            let lower=max(remaining.filter{$0>0}.count,remaining.filter{$0<0}.count)
            guard edges.count+lower<best.count else{return}
            var seen=Set<Int64>()
            let first=amounts[i]
            for j in (i+1)..<ids.count where (first>0 && amounts[j]<0) || (first<0 && amounts[j]>0) {
                let prior=amounts[j]
                if !seen.insert(prior).inserted {continue}
                edges.append((i,j));amounts[j]+=first
                try visit(i+1)
                edges.removeLast();amounts[j]=prior
                if first == -prior {break}
            }
        }
        try visit(0)
        return best
    }
}
