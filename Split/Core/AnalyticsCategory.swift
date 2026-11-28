import SwiftUI

/// The category vocabulary the web client's analytics groups by, and how each
/// one looks on iOS. IDs and labels match `web/src/categories.ts`.
struct AnalyticsCategory: Identifiable, Equatable {
    var id: String
    var label: String
    var symbol: String
    var tint: Color

    init(id: String, label: String, symbol: String, tint: Color) {
        self.id = id
        self.label = label
        self.symbol = symbol
        self.tint = tint
    }

    init(id: String, label: String, symbol: String, light: UInt32, dark: UInt32) {
        self.init(id: id, label: label, symbol: symbol, tint: Color(light: light, dark: dark))
    }

    static let web: [AnalyticsCategory] = [
        AnalyticsCategory(id: "Dining", label: "Dining", symbol: "fork.knife", light: 0xC2410C, dark: 0xFB923C),
        AnalyticsCategory(id: "Lodging", label: "Lodging", symbol: "bed.double", light: 0x4F46E5, dark: 0x818CF8),
        AnalyticsCategory(id: "Flights", label: "Flights", symbol: "airplane", light: 0x0369A1, dark: 0x38BDF8),
        AnalyticsCategory(id: "Transport", label: "Transport", symbol: "car", light: 0x0F766E, dark: 0x2DD4BF),
        AnalyticsCategory(id: "Groceries", label: "Groceries", symbol: "cart", light: 0x15803D, dark: 0x4ADE80),
        AnalyticsCategory(id: "Drinks", label: "Drinks & Coffee", symbol: "cup.and.saucer", light: 0x7E22CE, dark: 0xC084FC),
        AnalyticsCategory(id: "Activities", label: "Activities", symbol: "ticket", light: 0xBE185D, dark: 0xF472B6),
        AnalyticsCategory(id: "Rent & Utilities", label: "Rent & Utilities", symbol: "house", light: 0x1D4ED8, dark: 0x60A5FA),
        AnalyticsCategory(id: "Shopping", label: "Shopping", symbol: "bag", light: 0xB45309, dark: 0xFBBF24),
        AnalyticsCategory(id: "Other", label: "Other", symbol: "tag", light: 0x64748B, dark: 0x94A3B8),
    ]

    /// Display details for a normalized ID from `SpendAnalytics.categoryID`.
    /// iOS-only names such as General keep their app symbol and tint.
    static func meta(_ id: String) -> AnalyticsCategory {
        if let known = web.first(where: { $0.id == id }) { return known }
        let app = CategoryMeta.named(id)
        return AnalyticsCategory(id: id, label: id, symbol: app.symbol, tint: app.tint)
    }

    static let otherStack = AnalyticsCategory(id: "__other", label: "Everything else", symbol: "ellipsis", light: 0xA8B0A6, dark: 0x4B5650)
}
