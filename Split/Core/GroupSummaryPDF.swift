import CoreGraphics
import CoreText
import Foundation

enum GroupSummaryPDF {
    enum Layout: String, CaseIterable {
        case summary = "Summary"
        case expenses = "Expense breakdown"
        case receipts = "With itemized receipts"
    }

    struct Sections {
        var totals = true
        var balances = true
        var history = true
        var categories = false
        var months = false
        var people = false

        var isEmpty: Bool { !(totals || balances || history || categories || months || people) }
    }

    @MainActor
    static func render(group: ExpenseGroup, entries: [LedgerEntry], fx: FXStore, layout: Layout = .receipts,
                       sections: Sections = .init()) throws -> Data {
        guard !sections.isEmpty else { throw LedgerError.invalid("Choose at least one report section.") }
        let report = sections.history ? layout.rawValue : "Group report"
        let writer = try PDFWriter(title: "\(group.name) – \(report)")
        let home = fx.home
        let rows = entries.sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
            .map { (recorded: $0, preferred: sections.totals || sections.history ? fx.homeEntry($0) : nil) }
        let expenses = rows.filter { !$0.recorded.isSettlement }
        var showsConversion = sections.history && rows.contains { $0.recorded.currency != home && $0.preferred != nil }
        let members = Dictionary(group.members.map { ($0.id, $0.name) }, uniquingKeysWith: { name, _ in name })
        func name(_ id: String) -> String { members[id] ?? "Former member" }

        writer.text(group.name, .title)
        writer.text(sections.totals || sections.balances || sections.history
                    ? "\(report)  /  Preferred currency: \(home)" : report, .heading)
        let kind = switch group.kind { case "trip": "Trip"; case "home": "Household"; case "friend": "Friends"; default: "Group" }
        let dates = [group.startDate, group.endDate].compactMap { $0 }.map(displayDay)
        writer.text(([kind] + dates + ["Exported \(Date.now.formatted(date: .abbreviated, time: .omitted))"]).joined(separator: "  /  "), .detail)
        if let description = group.description, !description.isEmpty {
            writer.space(6)
            writer.text(description, .body)
        }

        if sections.totals {
            writer.section("Total expenses")
            if expenses.isEmpty {
                writer.text("No expenses recorded.", .body)
            } else {
                let preferred = expenses.reduce(Int64?(0)) { total, row in
                    guard let total, let amount = row.preferred?.signedAmount else { return nil }
                    let (sum, overflow) = total.addingReportingOverflow(amount)
                    return overflow ? nil : sum
                }
                let converted = expenses.contains { $0.recorded.currency != home }
                showsConversion = showsConversion || (converted && preferred != nil)
                writer.row("Preferred currency", amount: preferred.map { money($0, home, approximate: converted) } ?? "Unavailable",
                           detail: preferred == nil ? "See the recorded totals below." : nil)
                let byCurrency = Dictionary(grouping: expenses.map(\.recorded), by: \.currency)
                for currency in byCurrency.keys.sorted() {
                    let total = byCurrency[currency, default: []].reduce(0) { $0 + $1.signedAmount }
                    writer.row("Recorded in \(currency)", amount: Money.text(total, currency))
                }
            }
        }

        if sections.balances, renderBalances(group: group, entries: entries, fx: fx, writer: writer, name: name) {
            showsConversion = true
        }

        let recordedExpenses = expenses.map(\.recorded)
        if sections.categories {
            renderSpending("Spending by category", entries: recordedExpenses, writer: writer) {
                CategoryMeta.named($0.category).name
            }
        }
        if sections.months {
            renderSpending("Spending by month", entries: recordedExpenses, writer: writer) {
                String($0.day.prefix(7))
            }
        }
        if sections.people {
            renderPeople(entries: recordedExpenses, writer: writer, name: name)
        }
        guard sections.history else { return writer.finish(showRateNote: showsConversion) }

        renderHistory(rows, layout: layout, home: home, writer: writer, name: name)
        return writer.finish(showRateNote: showsConversion)
    }

    @MainActor
    private static func renderBalances(group: ExpenseGroup, entries: [LedgerEntry], fx: FXStore,
                                       writer: PDFWriter, name: (String) -> String) -> Bool {
        let home = fx.home
        var showsConversion = false
        writer.section("Outstanding balances")
        var balances: [String: [String: Int64]] = [:]
        var transfers: [Transfer] = []
        for currency in Analytics.currencies(in: group, entries: entries) {
            let values = Ledger.balances(entries, currency: currency)
            transfers += group.simplify == false
                ? Ledger.directPlan(values, currency: currency)
                : Ledger.plan(values, currency: currency)
            for (id, amount) in values where amount != 0 {
                balances[id, default: [:]][currency] = amount
            }
        }
        if balances.isEmpty {
            writer.text("No outstanding balances.", .body)
        } else {
            writer.text("Positive balances are owed money. Negative balances owe money.", .detail)
            for id in balances.keys.sorted(by: { (name($0), $0) < (name($1), $1) }) {
                guard let amounts = balances[id] else { continue }
                let total = fx.total(amounts, in: home)
                showsConversion = showsConversion || (total.missing.isEmpty && !total.quotes.isEmpty)
                let preferred = total.missing.isEmpty
                    ? money(total.amount, home, approximate: !total.quotes.isEmpty, signed: true)
                    : "Rate unavailable"
                let originals = amounts.keys.sorted().map { Money.text(amounts[$0, default: 0], $0, signed: true) }
                let detail = amounts.keys.contains(where: { $0 != home }) ? "Settlement currencies: " + originals.joined(separator: "  /  ") : nil
                writer.row(name(id), amount: preferred, detail: detail)
            }
        }
        if !transfers.isEmpty {
            writer.section("Suggested payments")
            writer.draw(writer.tableRow("From", "To", "Amount", style: .detail, middleAlignedRight: false))
            writer.rule()
            for transfer in transfers {
                let original = Money.text(transfer.amount, transfer.currency)
                let total = fx.total([transfer.currency: transfer.amount], in: home)
                let converted = transfer.currency != home && total.missing.isEmpty
                showsConversion = showsConversion || converted
                writer.draw(writer.tableRow(name(transfer.from), name(transfer.to),
                                            converted ? money(total.amount, home, approximate: true) : original,
                                            rightDetail: converted ? "Pay \(original)" : nil, middleAlignedRight: false))
            }
        }

        return showsConversion
    }

    private static func renderSpending(_ title: String, entries: [LedgerEntry], writer: PDFWriter,
                                       key: (LedgerEntry) -> String) {
        writer.section(title)
        guard !entries.isEmpty else {
            writer.text("No expenses recorded.", .body)
            return
        }
        let groups = Dictionary(grouping: entries, by: key)
        for label in groups.keys.sorted() {
            let byCurrency = Dictionary(grouping: groups[label, default: []], by: \.currency)
            for currency in byCurrency.keys.sorted() {
                let total = byCurrency[currency, default: []].reduce(Int64(0)) { $0 + $1.signedAmount }
                writer.row(label, amount: Money.text(total, currency))
            }
        }
    }

    private static func renderPeople(entries: [LedgerEntry], writer: PDFWriter, name: (String) -> String) {
        writer.section("Spending by person")
        guard !entries.isEmpty else {
            writer.text("No expenses recorded.", .body)
            return
        }
        var people: [String: [String: (paid: Int64, share: Int64)]] = [:]
        for entry in entries {
            for payer in entry.allPayers {
                people[payer.memberID, default: [:]][entry.currency, default: (0, 0)].paid += entry.sign * payer.amount
            }
            for portion in entry.splits {
                people[portion.memberID, default: [:]][entry.currency, default: (0, 0)].share += entry.sign * portion.amount
            }
        }
        writer.draw(writer.tableRow("Person", "Paid", "Share", style: .detail))
        writer.rule()
        for id in people.keys.sorted(by: { (name($0), $0) < (name($1), $1) }) {
            guard let amounts = people[id] else { continue }
            for currency in amounts.keys.sorted() {
                guard let amount = amounts[currency] else { continue }
                writer.draw(writer.tableRow(name(id), Money.text(amount.paid, currency), Money.text(amount.share, currency)))
            }
        }
    }

    private static func renderHistory(_ rows: [(recorded: LedgerEntry, preferred: LedgerEntry?)], layout: Layout,
                                      home: String, writer: PDFWriter, name: (String) -> String) {
        if layout == .summary, !rows.isEmpty {
            writer.section("Expense and payment history")
            for (entry, projected) in rows {
                let status = (entry.isSettlement ? " (payment)" : entry.isRefund ? " (refund)" : entry.isHandled ? " (handled)" : "")
                    + (entry.isPending ? " (pending)" : "")
                let original = Money.text(entry.signedAmount, entry.currency)
                let converted = projected.map { money($0.signedAmount, home, approximate: entry.currency != home) }
                writer.row("\(displayDay(entry.day))  /  \(entry.title)\(status)", amount: converted ?? original,
                           detail: entry.currency != home && converted != nil ? "Recorded \(original)" : nil)
            }
            return
        }
        if rows.isEmpty {
            writer.section("Expense and payment history")
            writer.text("No entries recorded.", .body)
        }
        for (offset, row) in rows.enumerated() {
            let (entry, projected) = row
            let date = displayDay(entry.day)
            let kind = entry.isSettlement ? "Payment" : entry.isRefund ? "Refund" : (entry.category ?? "Expense")
            let status = (entry.isHandled ? "  /  Already handled" : "")
                + (entry.isPending ? "  /  Pending" + (entry.pendingNote.map { ": " + $0 } ?? "") : "")
            let approximate = entry.currency != home
            func amount(_ original: Int64?, _ preferred: Int64?) -> String {
                guard let original else { return "—" }
                return preferred.map { money($0, home, approximate: approximate) } ?? Money.text(original, entry.currency)
            }
            func recorded(_ original: Int64?, _ preferred: Int64?) -> String? {
                guard approximate, let original, preferred != nil else { return nil }
                return "Recorded \(Money.text(original, entry.currency))"
            }
            func line(_ label: String, _ original: Int64, _ preferred: Int64?) -> PDFWriter.Row {
                writer.makeRow(label, amount: amount(original, preferred), detail: recorded(original, preferred))
            }
            var header = writer.lines(entry.title, .heading) + writer.lines("\(date)  /  \(kind)\(status)", .detail)
            if approximate && projected == nil {
                header += writer.lines("\(home) rate unavailable. Showing recorded \(entry.currency) amounts.", .detail)
            }
            let settling = entry.settling
            if settling.currency != entry.currency && settling.currency != home {
                header += writer.lines("Settles in \(Money.text(settling.amount, settling.currency))", .detail)
            }
            let total = line(entry.isSettlement ? "Payment amount" : entry.isRefund ? "Refund amount" : "Expense total", entry.amount, projected?.amount)
            let paid = Dictionary(entry.allPayers.map { ($0.memberID, $0.amount) }, uniquingKeysWith: +)
            let shares = Dictionary(entry.splits.map { ($0.memberID, $0.amount) }, uniquingKeysWith: +)
            let preferredPaid = Dictionary((projected?.allPayers ?? []).map { ($0.memberID, $0.amount) }, uniquingKeysWith: +)
            let preferredShares = Dictionary((projected?.splits ?? []).map { ($0.memberID, $0.amount) }, uniquingKeysWith: +)
            let people = Set(paid.keys).union(shares.keys).sorted { (name($0), $0) < (name($1), $1) }
            let tableHeader = entry.isRefund
                ? writer.tableRow("Person", "Received", "Credit", style: .detail)
                : writer.tableRow("Person", "Paid", entry.isSettlement ? "Received" : "Share", style: .detail)
            var detailRows = [tableHeader] + people.map { id in
                writer.tableRow(name(id), amount(paid[id], preferredPaid[id]), amount(shares[id], preferredShares[id]),
                                middleDetail: recorded(paid[id], preferredPaid[id]),
                                rightDetail: recorded(shares[id], preferredShares[id]))
            }
            if layout == .receipts, let bill = entry.bill, let gross = try? bill.gross() {
                let itemShares = zip(bill.items, gross).map { item, original in
                    let parts = (try? item.portions(gross: original, payer: entry.paidBy)) ?? []
                    return Dictionary(parts.map { ($0.memberID, $0.amount) }, uniquingKeysWith: +)
                }
                let converted = projected == nil ? [:] : receiptShares(itemShares, recorded: shares, preferred: preferredShares)
                let itemized = writer.tableRow("Itemized receipt", "", "Share incl. tax & tip", style: .detail)
                detailRows.append(itemized)
                for (index, item) in bill.items.enumerated() {
                    let itemPreferred = converted[index]
                    detailRows.append(line(item.title, gross[index], itemPreferred.map { $0.values.reduce(0, +) }))
                    for id in itemShares[index].keys.sorted(by: { (name($0), $0) < (name($1), $1) }) {
                        let label = item.memberIDs.isEmpty ? "    Unclaimed · \(name(id))" : "    \(name(id))"
                        detailRows.append(line(label, itemShares[index][id, default: 0], itemPreferred?[id]))
                    }
                }
                if bill.tax > 0 || bill.tip > 0 {
                    let includes = [(bill.tax, "tax"), (bill.tip, "tip")].filter { $0.0 > 0 }
                        .map { "\(Money.text($0.0, entry.currency)) \($0.1)" }
                    detailRows.append(writer.makeRow("Included on receipt", amount: "", detail: includes.joined(separator: "  /  ")))
                }
            }
            let notes = writer.lines(entry.notes ?? "", .detail)
            let lines = [total] + detailRows
            let fullHeight = header.reduce(15) { $0 + $1.height }
                + lines.reduce(0) { $0 + $1.height } + notes.reduce(0) { $0 + $1.height }
            let minimum = header.reduce(7 + lines.prefix(3).reduce(0) { $0 + $1.height }) { $0 + $1.height }
            if offset == 0 {
                writer.section("Expense and payment history", minimumFollowing: minimum, preferredFollowing: fullHeight)
            } else {
                writer.reserve(fullHeight <= writer.contentHeight ? fullHeight : minimum)
            }
            writer.space(7)
            writer.draw(header)
            for part in lines { writer.draw(part) }
            writer.draw(notes)
            writer.rule()
        }
    }

    private static func displayDay(_ day: String) -> String {
        Exchange.date(fromDay: day)?.formatted(date: .abbreviated, time: .omitted) ?? day
    }

    /// Allocate each person's converted expense share across their own items so the receipt reconciles to the ledger.
    private static func receiptShares(_ items: [[String: Int64]], recorded: [String: Int64],
                                      preferred: [String: Int64]) -> [Int: [String: Int64]] {
        let portions = items.enumerated().flatMap { index, shares in
            shares.map { (person: $0.key, item: index, amount: $0.value) }
        }
        let byPerson = Dictionary(grouping: portions, by: \.person)
        guard byPerson.mapValues({ $0.reduce(0) { $0 + $1.amount } }) == recorded else { return [:] }
        var converted: [Int: [String: Int64]] = [:]
        for (person, shares) in byPerson {
            guard let total = preferred[person] else { return [:] }
            let amounts = total == 0 ? shares.map { _ in Int64(0) }
                : try? Ledger.allocate(total: total, weights: shares.map(\.amount), maximumTotal: .max)
            guard let amounts else { return [:] }
            for (share, amount) in zip(shares, amounts) {
                converted[share.item, default: [:]][person] = amount
            }
        }
        return converted
    }

    private static func money(_ amount: Int64, _ currency: String, approximate: Bool, signed: Bool = false) -> String {
        (approximate ? "≈ " : "") + Money.text(amount, currency, signed: signed)
    }
}

private final class PDFWriter {
    enum Style {
        case title, heading, body, detail

        var font: CTFont {
            let size: CGFloat = switch self { case .title: 30; case .heading: 13; case .body: 11; case .detail: 10 }
            let type: CTFontUIFontType = switch self { case .title, .heading: .emphasizedSystem; default: .system }
            return CTFontCreateUIFontForLanguage(type, size, nil) ?? CTFontCreateWithName("Helvetica" as CFString, size, nil)
        }

        var color: CGColor {
            switch self {
            case .title, .heading: CGColor(red: 0.08, green: 0.25, blue: 0.19, alpha: 1)
            case .body: CGColor(gray: 0.10, alpha: 1)
            case .detail: CGColor(gray: 0.33, alpha: 1)
            }
        }
    }

    struct Line {
        let text: CTLine
        let ascent: CGFloat
        let height: CGFloat
    }

    struct Cell {
        let lines: [Line]
        let x: CGFloat
        let width: CGFloat
        let rightAligned: Bool
    }

    struct Row {
        let cells: [Cell]
        var height: CGFloat {
            (cells.map { $0.lines.reduce(0) { $0 + $1.height } }.max() ?? 0) + 3
        }
    }

    private let buffer = NSMutableData()
    private let context: CGContext
    private let margin: CGFloat = 46
    private let pageSize = CGSize(width: 612, height: 792)
    private var width: CGFloat { pageSize.width - 2 * margin }
    var contentHeight: CGFloat { pageSize.height - 2 * margin }
    private var y: CGFloat = 0
    private var page = 0

    init(title: String) throws {
        var pageBox = CGRect(origin: .zero, size: pageSize)
        guard let consumer = CGDataConsumer(data: buffer as CFMutableData),
              let context = CGContext(consumer: consumer, mediaBox: &pageBox,
                                      [kCGPDFContextTitle: title, kCGPDFContextCreator: "Split"] as CFDictionary)
        else { throw LedgerError.invalid("Couldn’t create the expense summary PDF.") }
        self.context = context
        newPage()
    }

    func finish(showRateNote: Bool) -> Data {
        if showRateNote, let note = lines("≈ Converted with available exchange rates.", .detail).first {
            paint(note, y: 32)
        }
        context.endPDFPage()
        context.closePDF()
        return buffer as Data
    }

    func section(_ title: String, minimumFollowing: CGFloat = 0, preferredFollowing: CGFloat? = nil) {
        let heading = lines(title, .heading)
        let headingHeight = heading.reduce(25) { $0 + $1.height }
        let following = preferredFollowing.flatMap { headingHeight + $0 <= contentHeight ? $0 : nil } ?? minimumFollowing
        reserve(min(contentHeight, max(70, headingHeight + following)))
        space(17)
        draw(heading)
        rule()
    }

    func space(_ height: CGFloat) { y -= height }

    func rule() {
        guard y >= margin + 5 else { return }
        context.setStrokeColor(CGColor(gray: 0.78, alpha: 1))
        context.setLineWidth(0.5)
        context.move(to: CGPoint(x: margin, y: y - 3))
        context.addLine(to: CGPoint(x: margin + width, y: y - 3))
        context.strokePath()
        space(8)
    }

    func reserve(_ height: CGFloat) {
        if y - height < margin { newPage() }
    }

    func text(_ text: String, _ style: Style) { draw(lines(text, style)) }

    func row(_ label: String, amount: String, detail: String? = nil) {
        draw(makeRow(label, amount: amount, detail: detail))
    }

    func makeRow(_ label: String, amount: String, detail: String?) -> Row {
        let split = width * 0.57
        return Row(cells: [
            cell(label, x: 0, width: split - 12),
            cell(amount, detail: detail, x: split, width: width - split, rightAligned: true)
        ])
    }

    func tableRow(_ first: String, _ middle: String, _ last: String, middleDetail: String? = nil,
                  rightDetail: String? = nil, style: Style = .body, middleAlignedRight: Bool = true) -> Row {
        let firstWidth = width * 0.40
        let middleWidth = width * 0.30
        let lastX = firstWidth + middleWidth
        return Row(cells: [
            cell(first, style: style, x: 0, width: firstWidth - 12),
            cell(middle, detail: middleDetail, style: style, x: firstWidth, width: middleWidth - 12, rightAligned: middleAlignedRight),
            cell(last, detail: rightDetail, style: style, x: lastX, width: width - lastX, rightAligned: true)
        ])
    }

    private func cell(_ value: String, detail: String? = nil, style: Style = .body,
                      x: CGFloat, width: CGFloat, rightAligned: Bool = false) -> Cell {
        let primary = lines(value, style, maxWidth: width)
        let secondary = detail.map { lines($0, .detail, maxWidth: width) } ?? []
        return Cell(lines: primary + secondary, x: x, width: width, rightAligned: rightAligned)
    }

    func draw(_ row: Row) {
        let height = row.height
        reserve(height)
        for cell in row.cells {
            var baseline = y
            for line in cell.lines {
                paint(line, y: baseline, x: cell.x, availableWidth: cell.rightAligned ? cell.width : nil)
                baseline -= line.height
            }
        }
        space(height)
    }

    func lines(_ text: String, _ style: Style, maxWidth: CGFloat? = nil) -> [Line] {
        let attributed = NSAttributedString(string: text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): style.font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): style.color,
        ])
        let typesetter = CTTypesetterCreateWithAttributedString(attributed)
        var result: [Line] = []
        var start = 0
        while start < attributed.length {
            let length = CTTypesetterSuggestLineBreak(typesetter, start, Double(maxWidth ?? width))
            guard length > 0 else { break }
            let line = CTTypesetterCreateLine(typesetter, CFRange(location: start, length: length))
            var ascent: CGFloat = 0, descent: CGFloat = 0, leading: CGFloat = 0
            CTLineGetTypographicBounds(line, &ascent, &descent, &leading)
            result.append(Line(text: line, ascent: ascent, height: ceil(ascent + descent + max(leading, 0)) + 3))
            start += length
        }
        return result
    }

    func draw(_ lines: [Line]) {
        for line in lines {
            reserve(line.height)
            paint(line, y: y)
            y -= line.height
        }
    }

    private func paint(_ line: Line, y: CGFloat, x: CGFloat = 0, availableWidth: CGFloat? = nil) {
        let offset = availableWidth.map { CTLineGetPenOffsetForFlush(line.text, 1, Double($0)) } ?? 0
        context.textPosition = CGPoint(x: margin + x + CGFloat(offset), y: y - line.ascent)
        CTLineDraw(line.text, context)
    }

    private func newPage() {
        if page > 0 { context.endPDFPage() }
        context.beginPDFPage(nil)
        context.textMatrix = .identity
        page += 1
        y = pageSize.height - margin
        if let footer = lines("Split  /  \(page)", .detail).first {
            paint(footer, y: 32, availableWidth: width)
        }
    }
}
