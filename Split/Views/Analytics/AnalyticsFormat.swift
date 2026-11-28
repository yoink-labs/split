import Foundation

/// Amount and period labels shared by every Analytics card.
struct AnalyticsFormat {
    var home: String
    var estimated: Bool

    /// The web's `homeMoney.format`: `≈` for converted totals, a real minus sign.
    func money(_ amount: Int64, estimated: Bool? = nil, signed: Bool = false) -> String {
        ((estimated ?? self.estimated) ? "≈ " : "") + Money.text(amount, home, signed: signed)
    }

    /// Short axis labels such as 1.2k, in the home currency's major units.
    static func axis(_ minor: Int64) -> String {
        Decimal(minor) / 100 == 0 ? "0" : (Double(minor) / 100).formatted(.number.notation(.compactName).precision(.fractionLength(0...1)))
    }

    static func bucket(_ key: String, _ grain: SpendAnalytics.Granularity, long: Bool = false) -> String {
        guard let date = SpendAnalytics.bucketDate(key) else { return key }
        let utc = Date.FormatStyle(timeZone: TimeZone(identifier: "UTC")!)
        switch grain {
        case .month:
            return long ? date.formatted(utc.month(.wide).year()) : date.formatted(utc.month(.abbreviated).year(.twoDigits))
        case .week:
            return long ? "Week of " + date.formatted(utc.weekday(.abbreviated).month(.abbreviated).day().year()) : date.formatted(utc.month(.abbreviated).day())
        case .day:
            return long ? date.formatted(utc.weekday(.abbreviated).month(.abbreviated).day().year()) : date.formatted(utc.month(.abbreviated).day())
        }
    }

    static func count(_ value: Int, _ noun: String, plural: String? = nil) -> String {
        "\(value) \(value == 1 ? noun : plural ?? noun + "s")"
    }
}
