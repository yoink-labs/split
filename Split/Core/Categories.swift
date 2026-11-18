import SwiftUI

struct CategoryMeta: Identifiable, Equatable {
    var name: String
    var symbol: String
    var tint: Color
    var id: String { name }

    static let all: [CategoryMeta] = [
        CategoryMeta(name: "General", symbol: "square.grid.2x2", tint: Color(red: 0.36, green: 0.48, blue: 0.42)),
        CategoryMeta(name: "Dining", symbol: "fork.knife", tint: Color(red: 0.86, green: 0.43, blue: 0.28)),
        CategoryMeta(name: "Groceries", symbol: "cart", tint: Color(red: 0.31, green: 0.55, blue: 0.35)),
        CategoryMeta(name: "Liquor", symbol: "wineglass", tint: Color(red: 0.58, green: 0.32, blue: 0.55)),
        CategoryMeta(name: "Rent", symbol: "house", tint: Color(red: 0.40, green: 0.46, blue: 0.62)),
        CategoryMeta(name: "Home", symbol: "sofa", tint: Color(red: 0.48, green: 0.40, blue: 0.30)),
        CategoryMeta(name: "Utilities", symbol: "bolt", tint: Color(red: 0.84, green: 0.66, blue: 0.22)),
        CategoryMeta(name: "Transport", symbol: "car", tint: Color(red: 0.26, green: 0.48, blue: 0.62)),
        CategoryMeta(name: "Travel", symbol: "airplane", tint: Color(red: 0.20, green: 0.50, blue: 0.48)),
        CategoryMeta(name: "Entertainment", symbol: "ticket", tint: Color(red: 0.66, green: 0.36, blue: 0.60)),
        CategoryMeta(name: "Shopping", symbol: "bag", tint: Color(red: 0.73, green: 0.40, blue: 0.42)),
        CategoryMeta(name: "Health", symbol: "cross.case", tint: Color(red: 0.74, green: 0.30, blue: 0.28)),
        CategoryMeta(name: "Education", symbol: "book", tint: Color(red: 0.28, green: 0.44, blue: 0.66)),
        CategoryMeta(name: "Gifts", symbol: "gift", tint: Color(red: 0.76, green: 0.45, blue: 0.24)),
        CategoryMeta(name: "Fees", symbol: "percent", tint: Color(red: 0.42, green: 0.42, blue: 0.42)),
        CategoryMeta(name: "Other", symbol: "ellipsis.circle", tint: Color(red: 0.40, green: 0.42, blue: 0.40)),
    ]

    static func named(_ name: String?) -> CategoryMeta {
        guard let name, !name.isEmpty else { return all[0] }
        return all.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }
            ?? CategoryMeta(name: name, symbol: "tag", tint: Color(red: 0.42, green: 0.42, blue: 0.42))
    }

    static let grid: [CategoryMeta] = all.filter { $0.name != "General" }
}
