import SwiftUI

/// A recognisable mark for well-known merchants, so "Uber home" reads as Uber
/// at a glance instead of a generic car. Marks use the brand's own colour
/// with a system glyph or a short wordmark set in our type; we never ship
/// third-party logo artwork. Anything unrecognised falls back to the
/// category badge.
struct MerchantMark: Equatable {
    enum Glyph: Equatable {
        case symbol(String)
        case text(String)
    }

    var name: String
    var glyph: Glyph
    var background: Color
    var foreground: Color

    /// Lower-cased phrases matched at word boundaries in an entry title.
    fileprivate var keywords: [String]

    static func match(_ title: String) -> MerchantMark? {
        let text = " " + title.lowercased()
            .replacingOccurrences(of: "’", with: "'")
            .map { $0.isLetter || $0.isNumber || $0 == "'" || $0 == "." ? $0 : " " }
            .reduce(into: "") { $0.append($1) } + " "
        return all.first { mark in mark.keywords.contains { text.contains(" \($0) ") || text.contains(" \($0)s ") } }
    }

    /// The category a new expense at this merchant most likely belongs to.
    var category: String? {
        let groups: [String: [String]] = [
            "Transport": ["Uber", "Lyft", "Bolt", "Cabify", "DiDi", "Shell", "Chevron", "YPF", "Hertz", "Lime", "Citi Bike"],
            "Travel": ["Airbnb", "Booking.com", "Expedia", "Hotels.com", "Marriott", "Hilton", "LATAM", "Delta", "United",
                       "American Airlines", "Southwest", "Ryanair", "easyJet", "Aerolíneas"],
            "Dining": ["Uber Eats", "Starbucks", "Dunkin'", "McDonald's", "Burger King", "Chipotle", "Subway", "Taco Bell",
                       "Shake Shack", "DoorDash", "Grubhub", "Deliveroo", "Rappi", "PedidosYa", "iFood"],
            "Groceries": ["Instacart", "Trader Joe's", "Whole Foods", "Costco", "Carrefour", "Tesco", "Mercadona"],
            "Shopping": ["Target", "Walmart", "Amazon", "Mercado Libre", "Apple", "IKEA", "Home Depot"],
            "Entertainment": ["Netflix", "Spotify", "YouTube", "Disney+", "Hulu", "HBO Max", "Ticketmaster", "Steam"],
            "Health": ["CVS", "Walgreens"],
            "Utilities": ["Claro", "Vodafone", "Comcast", "PG&E"],
        ]
        return groups.first { $0.value.contains(name) }?.key
    }

    private static func mark(_ name: String, _ glyph: Glyph, _ background: UInt32, _ foreground: UInt32 = 0xFFFFFF, _ keywords: [String]) -> MerchantMark {
        MerchantMark(name: name, glyph: glyph, background: Color(hex: background), foreground: Color(hex: foreground), keywords: keywords)
    }

    // Order matters: the more specific phrase wins ("uber eats" before "uber").
    static let all: [MerchantMark] = [
        mark("Uber Eats", .symbol("takeoutbag.and.cup.and.straw.fill"), 0x06C167, 0xFFFFFF, ["uber eats", "ubereats"]),
        mark("Uber", .text("Uber"), 0x000000, 0xFFFFFF, ["uber"]),
        mark("Lyft", .text("lyft"), 0xFF00BF, 0xFFFFFF, ["lyft"]),
        mark("Bolt", .symbol("bolt.fill"), 0x34D186, 0xFFFFFF, ["bolt"]),
        mark("Cabify", .symbol("car.fill"), 0x7145D6, 0xFFFFFF, ["cabify"]),
        mark("DiDi", .symbol("car.fill"), 0xFC4C02, 0xFFFFFF, ["didi"]),
        mark("Airbnb", .symbol("house.fill"), 0xFF385C, 0xFFFFFF, ["airbnb"]),
        mark("Booking.com", .text("B."), 0x003580, 0xFFFFFF, ["booking.com", "booking"]),
        mark("Expedia", .symbol("airplane"), 0x191E3B, 0xFDDB32, ["expedia"]),
        mark("Hotels.com", .symbol("bed.double.fill"), 0xD32F2F, 0xFFFFFF, ["hotels.com"]),
        mark("Marriott", .symbol("building.2.fill"), 0x8C1B2F, 0xFFFFFF, ["marriott"]),
        mark("Hilton", .symbol("building.2.fill"), 0x104C97, 0xFFFFFF, ["hilton"]),
        mark("LATAM", .symbol("airplane"), 0x1B0088, 0xFFFFFF, ["latam"]),
        mark("Delta", .symbol("airplane"), 0x003366, 0xFFFFFF, ["delta air", "delta airlines"]),
        mark("United", .symbol("airplane"), 0x005DAA, 0xFFFFFF, ["united airlines"]),
        mark("American Airlines", .symbol("airplane"), 0x0078D2, 0xFFFFFF, ["american airlines"]),
        mark("Southwest", .symbol("airplane"), 0x304CB2, 0xFFBF27, ["southwest"]),
        mark("Ryanair", .symbol("airplane"), 0x073590, 0xF1C933, ["ryanair"]),
        mark("easyJet", .symbol("airplane"), 0xFF6600, 0xFFFFFF, ["easyjet"]),
        mark("Aerolíneas", .symbol("airplane"), 0x0A2F6B, 0xFFFFFF, ["aerolineas", "aerolíneas"]),
        mark("Starbucks", .symbol("cup.and.saucer.fill"), 0x00704A, 0xFFFFFF, ["starbucks"]),
        mark("Dunkin'", .symbol("cup.and.saucer.fill"), 0xFF671F, 0xFFFFFF, ["dunkin", "dunkin'"]),
        mark("McDonald's", .text("M"), 0xDA291C, 0xFFC72C, ["mcdonald's", "mcdonalds", "mcdonald", "mcd"]),
        mark("Burger King", .symbol("flame.fill"), 0xD62300, 0xF5EBDC, ["burger king"]),
        mark("Chipotle", .symbol("flame.fill"), 0x441500, 0xFFFFFF, ["chipotle"]),
        mark("Subway", .text("S"), 0x008C15, 0xFFC600, ["subway sandwich", "subway sandwiches", "subway footlong"]),
        mark("Taco Bell", .symbol("bell.fill"), 0x702082, 0xFFFFFF, ["taco bell"]),
        mark("Shake Shack", .symbol("takeoutbag.and.cup.and.straw.fill"), 0x1F1F1F, 0x6CB33E, ["shake shack"]),
        mark("DoorDash", .symbol("takeoutbag.and.cup.and.straw.fill"), 0xFF3008, 0xFFFFFF, ["doordash"]),
        mark("Grubhub", .symbol("takeoutbag.and.cup.and.straw.fill"), 0xF63440, 0xFFFFFF, ["grubhub"]),
        mark("Deliveroo", .symbol("bicycle"), 0x00CCBC, 0xFFFFFF, ["deliveroo"]),
        mark("Rappi", .symbol("bicycle"), 0xFF441F, 0xFFFFFF, ["rappi"]),
        mark("PedidosYa", .symbol("bicycle"), 0xFA0050, 0xFFFFFF, ["pedidosya", "pedidos ya"]),
        mark("iFood", .symbol("takeoutbag.and.cup.and.straw.fill"), 0xEA1D2C, 0xFFFFFF, ["ifood"]),
        mark("Instacart", .symbol("carrot.fill"), 0x0AAD0A, 0xFFFFFF, ["instacart"]),
        mark("Trader Joe's", .symbol("cart.fill"), 0xBA0C2F, 0xFFFFFF, ["trader joe's", "trader joes", "trader joe"]),
        mark("Whole Foods", .symbol("leaf.fill"), 0x00674B, 0xFFFFFF, ["whole foods"]),
        mark("Costco", .symbol("cart.fill"), 0x005DAA, 0xE31837, ["costco"]),
        mark("Target", .symbol("target"), 0xCC0000, 0xFFFFFF, ["target"]),
        mark("Walmart", .symbol("sparkle"), 0x0071CE, 0xFFC220, ["walmart"]),
        mark("Carrefour", .symbol("cart.fill"), 0x004E9F, 0xFFFFFF, ["carrefour"]),
        mark("Tesco", .symbol("cart.fill"), 0x00539F, 0xFFFFFF, ["tesco"]),
        mark("Mercadona", .symbol("cart.fill"), 0x009A3E, 0xFFFFFF, ["mercadona"]),
        mark("Amazon", .text("a"), 0x232F3E, 0xFF9900, ["amazon"]),
        mark("Mercado Libre", .symbol("shippingbox.fill"), 0xFFE600, 0x2D3277, ["mercado libre", "mercadolibre"]),
        mark("Apple", .symbol("apple.logo"), 0x1D1D1F, 0xFFFFFF, ["apple store", "app store", "icloud"]),
        mark("Netflix", .text("N"), 0x141414, 0xE50914, ["netflix"]),
        mark("Spotify", .symbol("waveform"), 0x1DB954, 0x000000, ["spotify"]),
        mark("YouTube", .symbol("play.rectangle.fill"), 0xFF0000, 0xFFFFFF, ["youtube"]),
        mark("Disney+", .symbol("sparkles"), 0x0E1A5B, 0xFFFFFF, ["disney+", "disney plus", "disney"]),
        mark("Hulu", .text("hulu"), 0x1CE783, 0x0B0C0F, ["hulu"]),
        mark("HBO Max", .text("max"), 0x002BE7, 0xFFFFFF, ["hbo", "hbo max"]),
        mark("Ticketmaster", .symbol("ticket.fill"), 0x026CDF, 0xFFFFFF, ["ticketmaster"]),
        mark("Steam", .symbol("gamecontroller.fill"), 0x171A21, 0x66C0F4, ["steam store", "steam game", "steam games"]),
        mark("Shell", .symbol("fuelpump.fill"), 0xFFD500, 0xDD1D21, ["shell"]),
        mark("Chevron", .symbol("fuelpump.fill"), 0x0054A4, 0xFFFFFF, ["chevron"]),
        mark("YPF", .symbol("fuelpump.fill"), 0x0047BA, 0xFFFFFF, ["ypf"]),
        mark("Hertz", .symbol("key.fill"), 0xFFD100, 0x000000, ["hertz"]),
        mark("Lime", .symbol("scooter"), 0x00DE00, 0xFFFFFF, ["lime scooter", "lime bike"]),
        mark("Citi Bike", .symbol("bicycle"), 0x0062A9, 0xFFFFFF, ["citi bike", "citibike"]),
        mark("Venmo", .text("V"), 0x008CFF, 0xFFFFFF, ["venmo"]),
        mark("PayPal", .text("P"), 0x003087, 0xFFFFFF, ["paypal"]),
        mark("CVS", .symbol("cross.case.fill"), 0xCC0000, 0xFFFFFF, ["cvs"]),
        mark("Walgreens", .symbol("cross.case.fill"), 0xE31837, 0xFFFFFF, ["walgreens"]),
        mark("IKEA", .symbol("sofa.fill"), 0x0058A3, 0xFFDA1A, ["ikea"]),
        mark("Home Depot", .symbol("hammer.fill"), 0xF96302, 0xFFFFFF, ["home depot"]),
        mark("Claro", .symbol("antenna.radiowaves.left.and.right"), 0xDA291C, 0xFFFFFF, ["claro"]),
        mark("Vodafone", .symbol("antenna.radiowaves.left.and.right"), 0xE60000, 0xFFFFFF, ["vodafone"]),
        mark("Comcast", .symbol("wifi"), 0x1F69FF, 0xFFFFFF, ["comcast", "xfinity"]),
        mark("PG&E", .symbol("bolt.fill"), 0x0C5BA8, 0xFFFFFF, ["pg&e", "pge"]),
    ]
}

/// The leading badge for a ledger entry: a merchant mark when the title names
/// a known brand, otherwise the category badge.
struct EntryBadge: View {
    var title: String
    var category: String?
    var size: CGFloat = 40

    var body: some View {
        if let mark = MerchantMark.match(title) {
            MerchantBadge(mark: mark, size: size)
        } else {
            CategoryBadge(category: category, size: size)
        }
    }
}

struct MerchantBadge: View {
    var mark: MerchantMark
    var size: CGFloat = 40

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.30, style: .continuous)
            .fill(mark.background.gradient)
            .overlay {
                switch mark.glyph {
                case .symbol(let name):
                    Image(systemName: name)
                        .font(.system(size: size * 0.42, weight: .semibold))
                case .text(let word):
                    Text(word)
                        .font(.system(size: size * (word.count <= 1 ? 0.5 : word.count <= 2 ? 0.4 : word.count <= 3 ? 0.32 : 0.27),
                                      weight: .heavy, design: word.count == 1 ? .rounded : .default))
                        .tracking(word.count > 2 ? -0.3 : 0)
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                        .padding(.horizontal, size * 0.08)
                }
            }
            .foregroundStyle(mark.foreground)
            .overlay(RoundedRectangle(cornerRadius: size * 0.30, style: .continuous).strokeBorder(.white.opacity(0.10), lineWidth: 0.5))
            .frame(width: size, height: size)
            .accessibilityLabel(mark.name)
    }
}
