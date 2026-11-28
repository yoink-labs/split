import Foundation

/// Integer currency conversion. Amounts are minor units, rates are E8 fixed point
/// (1 USD = 1,200 ARS is 120_000_000_000). Never uses floating point.
enum FXMath {
    static let scale: Int64 = 100_000_000

    /// `minor × rateE8 / 1e8`, rounded half away from zero. Nil on overflow.
    static func convert(_ minor: Int64, rateE8: Int64) -> Int64? {
        guard rateE8 > 0, minor != Int64.min else { return nil }
        let magnitude = minor.magnitude
        let product = magnitude.multipliedFullWidth(by: UInt64(rateE8))
        let half = UInt64(scale / 2)
        let (low, carry) = product.low.addingReportingOverflow(half)
        let high = product.high &+ (carry ? 1 : 0)
        guard high < UInt64(scale) else { return nil }
        let (quotient, _) = UInt64(scale).dividingFullWidth((high: high, low: low))
        guard quotient <= UInt64(Int64.max) else { return nil }
        let value = Int64(quotient)
        return minor < 0 ? -value : value
    }

    /// Decimal rate to E8 units, rounded half up. Rejects zero, negatives and absurd values.
    static func rateE8(_ rate: Decimal) -> Int64? {
        guard rate > 0, rate <= 10_000_000 else { return nil }
        var scaled = rate * Decimal(scale), rounded = Decimal()
        NSDecimalRound(&rounded, &scaled, 0, .plain)
        let units = NSDecimalNumber(decimal: rounded).int64Value
        return units > 0 ? units : nil
    }

    /// The rate for the opposite direction, 1e16 / rateE8, rounded half up.
    static func inverse(_ rateE8: Int64) -> Int64? {
        guard rateE8 > 0 else { return nil }
        let numerator: UInt64 = 10_000_000_000_000_000
        let value = (numerator + UInt64(rateE8 / 2)) / UInt64(rateE8)
        return value > 0 ? Int64(value) : nil
    }

    /// Human rate text with grouping and up to six significant decimals: "1,200" or "0.000833".
    static func rateText(_ rateE8: Int64) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = true
        let rate = Decimal(rateE8) / Decimal(scale)
        formatter.maximumFractionDigits = rate >= 100 ? 2 : rate >= 1 ? 4 : 6
        formatter.minimumFractionDigits = 0
        return formatter.string(from: NSDecimalNumber(decimal: rate)) ?? "\(rate)"
    }
}

/// A published or manual rate for one currency pair.
struct FXQuote: Codable, Equatable {
    var base: String
    var quote: String
    var rateE8: Int64
    /// The day the rate was published for. A weekend request returns the prior business day.
    var date: String
    /// Provider or manual rate source.
    var source: String
    /// When this device fetched it. Used for the cache age and the offline label.
    var fetchedAt: Date

    var key: String { FXQuote.key(base, quote) }
    static func key(_ base: String, _ quote: String) -> String { base + ">" + quote }

    var exchange: Exchange { Exchange(target: quote, rateE8: rateE8, date: date, source: source) }

    /// "Frankfurter, Nov 18" style source label.
    var sourceLabel: String { "\(source == "Frankfurter" ? "Frankfurter · ECB" : source == "BCRA" ? "BCRA official" : source == "Frankfurter blended" ? "Frankfurter" : "Your rate"), \(FXQuote.shortDay(date))" }

    static func shortDay(_ day: String) -> String {
        let input = DateFormatter(); input.locale = Locale(identifier: "en_US_POSIX"); input.timeZone = TimeZone(identifier: "UTC"); input.dateFormat = "yyyy-MM-dd"
        guard let date = input.date(from: day) else { return day }
        let output = DateFormatter(); output.locale = Locale(identifier: "en_US_POSIX"); output.timeZone = TimeZone(identifier: "UTC"); output.dateFormat = "MMM d"
        return output.string(from: date)
    }

    /// Validates a Frankfurter v2 `/rate/{base}/{quote}` response. `requested` is nil for the latest rate.
    static func decode(_ data: Data, base: String, quote: String, requested: String?, source: String, now: Date = Date()) -> FXQuote? {
        struct Wire: Decodable { var base: String; var quote: String; var date: String; var rate: Decimal }
        guard let wire = try? JSONDecoder().decode(Wire.self, from: data),
              wire.base == base, wire.quote == quote,
              wire.date.range(of: #"^\d{4}-\d\d-\d\d$"#, options: .regularExpression) != nil,
              requested.map({ wire.date <= $0 }) ?? true,
              let units = FXMath.rateE8(wire.rate) else { return nil }
        return FXQuote(base: base, quote: quote, rateE8: units, date: wire.date, source: source, fetchedAt: now)
    }

    private static let ecbCurrencies = Set("AUD BRL CAD CHF CNY CZK DKK EUR GBP HKD HUF IDR ILS INR ISK JPY KRW MXN MYR NOK NZD PHP PLN RON SEK SGD THB TRY USD ZAR".split(separator: " ").map(String.init))

    static func url(base: String, quote: String, date: String?, source: String? = nil) -> URL {
        var url = URLComponents(string: "https://api.frankfurter.dev/v2/rate/\(base)/\(quote)")!
        var items: [URLQueryItem] = []
        if let date { items.append(URLQueryItem(name: "date", value: date)) }
        let provider = source ?? Self.source(base: base, quote: quote)
        if provider == "BCRA" || provider == "Frankfurter" {
            items.append(URLQueryItem(name: "providers", value: provider == "BCRA" ? "bcra" : "ecb"))
        }
        url.queryItems = items.isEmpty ? nil : items
        return url.url!
    }

    static func source(base: String, quote: String) -> String {
        if [base, quote].contains("ARS") { return "BCRA" }
        return ecbCurrencies.contains(base) && ecbCurrencies.contains(quote) ? "Frankfurter" : "Frankfurter blended"
    }
}

/// Last known rates on this device, so conversions keep working offline.
struct FXCache: Codable, Equatable {
    var quotes: [String: FXQuote] = [:]
    /// People's own rates, for example the ARS blue rate. Always preferred over published rates.
    var manual: [String: Int64] = [:]

    /// Published rates younger than this are reused without a network call.
    static let freshFor: TimeInterval = 6 * 3600

    func needsRefresh(_ base: String, _ quote: String, now: Date) -> Bool {
        guard let cached = quotes[FXQuote.key(base, quote)] else { return true }
        return now.timeIntervalSince(cached.fetchedAt) > FXCache.freshFor
    }

    /// The rate to use for display: a manual rate first, then a published one in either direction.
    func rate(_ base: String, _ quote: String) -> FXQuote? {
        if base == quote { return FXQuote(base: base, quote: quote, rateE8: FXMath.scale, date: "", source: "Same", fetchedAt: .distantPast) }
        if let units = manual[FXQuote.key(base, quote)] {
            return FXQuote(base: base, quote: quote, rateE8: units, date: "", source: "Manual", fetchedAt: .distantPast)
        }
        if let units = manual[FXQuote.key(quote, base)], let inverse = FXMath.inverse(units) {
            return FXQuote(base: base, quote: quote, rateE8: inverse, date: "", source: "Manual", fetchedAt: .distantPast)
        }
        return published(base, quote)
    }

    func published(_ base: String, _ quote: String, day: String? = nil) -> FXQuote? {
        let suffix = day.map { "@" + $0 } ?? ""
        if let direct = quotes[FXQuote.key(base, quote) + suffix] { return direct }
        if let reverse = quotes[FXQuote.key(quote, base) + suffix], let inverse = FXMath.inverse(reverse.rateE8) {
            var flipped = reverse
            flipped.base = base; flipped.quote = quote; flipped.rateE8 = inverse
            return flipped
        }
        return nil
    }

    /// Sums per-currency amounts into one currency. `missing` lists currencies without any known rate.
    func total(_ amounts: [String: Int64], in target: String) -> (amount: Int64, missing: [String], quotes: [FXQuote]) {
        var sum: Int64 = 0, missing: [String] = [], used: [FXQuote] = []
        for (currency, amount) in amounts.sorted(by: { $0.key < $1.key }) where amount != 0 {
            guard let quote = rate(currency, target), let converted = FXMath.convert(amount, rateE8: quote.rateE8) else {
                missing.append(currency); continue
            }
            if currency != target { used.append(quote) }
            let (next, overflow) = sum.addingReportingOverflow(converted)
            if overflow { missing.append(currency) } else { sum = next }
        }
        return (sum, missing, used)
    }
}

/// Fetches, caches and serves exchange rates. Free: Frankfurter (ECB) and BCRA via Frankfurter; no keys.
@MainActor
final class FXStore: ObservableObject {
    @Published private(set) var cache: FXCache
    /// The person's home currency, set in Account. Shared with the default for new groups.
    @Published var home: String { didSet { defaults.set(home, forKey: FXStore.homeKey) } }
    @Published private(set) var offline = false
    @Published private(set) var refreshing = false

    static let homeKey = "split.defaultCurrency"
    private let defaults: UserDefaults
    private let fileURL: URL?
    private let fetcher: (URL) async throws -> (Data, URLResponse)
    private let clock: () -> Date
    private var failedHistory: [String: Date] = [:]

    init(defaults: UserDefaults = .standard,
         fileURL: URL? = FXStore.defaultFile(),
         fetcher: @escaping (URL) async throws -> (Data, URLResponse) = { try await URLSession.shared.data(from: $0) },
         clock: @escaping () -> Date = Date.init) {
        self.defaults = defaults
        self.fileURL = fileURL
        self.fetcher = fetcher
        self.clock = clock
        let stored = defaults.string(forKey: FXStore.homeKey)
        let local = Locale.current.currency?.identifier
        let resolvedHome = stored.flatMap { Money.currencies.contains($0) ? $0 : nil } ?? local.flatMap { Money.currencies.contains($0) ? $0 : nil } ?? "USD"
        home = resolvedHome
        if let fileURL, let data = try? Data(contentsOf: fileURL), let decoded = try? JSONDecoder().decode(FXCache.self, from: data) {
            cache = decoded
        } else {
            cache = FXCache()
        }
    }

    nonisolated static func defaultFile() -> URL? {
        guard let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        return dir.appendingPathComponent("split-fx-rates.json")
    }

    func rate(_ base: String, _ quote: String) -> FXQuote? { cache.rate(base, quote) }

    func total(_ amounts: [String: Int64], in target: String) -> (amount: Int64, missing: [String], quotes: [FXQuote]) {
        cache.total(amounts, in: target)
    }

    func homeText(_ amount: Int64, currency: String, signed: Bool = false) -> String {
        homeTotalText([currency: amount], signed: signed)
    }

    func homeTotalText(_ amounts: [String: Int64], signed: Bool = false, magnitude: Bool = false) -> String {
        let result = total(amounts, in: home)
        guard result.missing.isEmpty else { return "Rate unavailable" }
        return (result.quotes.isEmpty ? "" : "≈ ") + Money.text(magnitude ? abs(result.amount) : result.amount, home, signed: signed)
    }

    private func displayQuote(_ entry: LedgerEntry) -> FXQuote? {
        let base = entry.currency
        let day = entry.exchange?.date ?? entry.day
        return cache.published(base, home, day: day) ?? cache.published(base, home) ?? cache.rate(base, home)
    }

    func homeEntry(_ entry: LedgerEntry) -> LedgerEntry? {
        if entry.currency == home {
            var copy = entry
            copy.exchange = nil
            return copy
        }
        if let exchange = entry.exchange, exchange.target == home { return try? exchange.converting(entry) }
        guard let quote = displayQuote(entry) else { return nil }
        return try? quote.exchange.converting(entry, maximumTotal: Int64.max)
    }

    func entryText(_ entry: LedgerEntry, amount: Int64? = nil, signed: Bool = false) -> String {
        let value = amount ?? entry.amount
        if entry.currency == home || value == 0 { return Money.text(value, home, signed: signed) }
        let converted: Int64?
        if amount == nil || value == entry.amount {
            converted = homeEntry(entry)?.amount
        } else if let exchange = entry.exchange, exchange.target == home {
            converted = FXMath.convert(value, rateE8: exchange.rateE8)
        } else {
            converted = displayQuote(entry).flatMap { FXMath.convert(value, rateE8: $0.rateE8) }
        }
        guard let converted else { return "Rate unavailable" }
        return "≈ " + Money.text(converted, home, signed: signed)
    }

    func portionText(_ entry: LedgerEntry, memberID: String, paid: Bool = false) -> String {
        guard let projected = homeEntry(entry) else { return "Rate unavailable" }
        let amount = paid ? Ledger.paid(projected, by: memberID) : Ledger.share(projected, of: memberID)
        return (entry.currency == home ? "" : "≈ ") + Money.text(amount, home)
    }

    func spendingText(_ entries: [LedgerEntry]) -> String {
        let expenses = entries.filter { $0.kind == "expense" }
        let converted = expenses.compactMap(homeEntry)
        guard converted.count == expenses.count else { return "Rate unavailable" }
        return (expenses.contains { $0.currency != home } ? "≈ " : "") + Money.text(converted.reduce(0) { $0 + $1.amount }, home)
    }

    func displayHistory(_ entries: [LedgerEntry], into target: String) async {
        let today = Exchange.localDay(clock())
        var seen = Set<String>()
        defer { persist() }
        for entry in entries where entry.currency != target && entry.exchange?.target != target && !Task.isCancelled {
            let base = entry.currency
            let day = entry.exchange?.date ?? entry.day
            let key = FXQuote.key(base, target) + "@" + day
            guard base != target, day < today, Exchange.date(fromDay: day) != nil,
                  seen.insert(key).inserted, cache.published(base, target, day: day) == nil,
                  failedHistory[key].map({ clock().timeIntervalSince($0) > FXCache.freshFor }) ?? true else { continue }
            do {
                let quote = try await fetchQuote(base: base, quote: target, date: day)
                guard !Task.isCancelled else { break }
                cache.quotes[key] = quote
                failedHistory[key] = nil
            } catch {
                if !Task.isCancelled { failedHistory[key] = clock() }
            }
        }
    }

    func setManual(_ base: String, _ quote: String, rateE8: Int64?) {
        var next = cache
        next.manual[FXQuote.key(quote, base)] = nil
        next.manual[FXQuote.key(base, quote)] = rateE8
        cache = next
        persist()
    }

    func manualRate(_ base: String, _ quote: String) -> Int64? { cache.manual[FXQuote.key(base, quote)] }

    /// Latest published rates for every pair into `target`. Stale or missing pairs are fetched;
    /// failures keep the cached rate and flag `offline`.
    func refresh(currencies: Set<String>, into target: String, force: Bool = false) async {
        let now = clock()
        let pairs = currencies.filter { $0 != target && (force || cache.needsRefresh($0, target, now: now)) }.sorted()
        guard !pairs.isEmpty else { return }
        refreshing = true
        defer { refreshing = false }
        var failed = false
        for base in pairs {
            do {
                let quote = try await fetchQuote(base: base, quote: target, date: nil)
                var next = cache
                next.quotes[quote.key] = quote
                cache = next
            } catch { failed = true }
        }
        offline = failed
        persist()
    }

    /// Prefer the charge date, then the most recent published rate.
    func quote(base: String, target: String, date: String) async throws -> FXQuote {
        let today = Exchange.localDay(clock())
        if date < today {
            if let historical = try? await historicalQuote(base: base, target: target, date: date) { return historical }
            try Task.checkCancellation()
        }
        if !cache.needsRefresh(base, target, now: clock()), let cached = cache.published(base, target) {
            return cached
        }
        do {
            let latest = try await fetchQuote(base: base, quote: target, date: nil)
            cache.quotes[latest.key] = latest
            offline = false
            persist()
            return latest
        } catch {
            if let cached = cache.published(base, target) {
                offline = true
                return cached
            }
            throw LedgerError.invalid("No published rate is available. Enter your own rate.")
        }
    }

    /// A reference rate published on or before the requested day.
    func historicalQuote(base: String, target: String, date: String) async throws -> FXQuote {
        if let cached = cache.published(base, target, day: date) { return cached }
        let quote = try await fetchQuote(base: base, quote: target, date: date)
        try Task.checkCancellation()
        cache.quotes[quote.key + "@" + date] = quote
        offline = false
        persist()
        return quote
    }

    private func fetchQuote(base: String, quote: String, date: String?) async throws -> FXQuote {
        let source = FXQuote.source(base: base, quote: quote)
        let sources = source == "Frankfurter blended" ? [source] : [source, "Frankfurter blended"]
        for provider in sources {
            let url = FXQuote.url(base: base, quote: quote, date: date, source: provider)
            let (data, response) = try await fetcher(url)
            if (response as? HTTPURLResponse)?.statusCode == 200,
               let parsed = FXQuote.decode(data, base: base, quote: quote, requested: date, source: provider, now: clock()) {
                return parsed
            }
        }
        throw LedgerError.invalid("No published rate is available. Enter your own rate.")
    }

    private func persist() {
        guard let fileURL, let data = try? JSONEncoder().encode(cache) else { return }
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: fileURL, options: .atomic)
    }
}
