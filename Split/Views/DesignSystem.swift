import SwiftUI

// Shared layout tokens and building blocks. Every screen uses these so
// spacing, corners, rows and actions line up across the app.
// Reference: Apple Human Interface Guidelines (layout, toolbars, buttons,
// empty states) and docs/design/ui-audit.md.

/// A 4-point spacing scale.
enum Spacing {
    static let xxs: CGFloat = 4
    static let xs: CGFloat = 8
    static let s: CGFloat = 12
    static let m: CGFloat = 16
    static let l: CGFloat = 20
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
    /// Horizontal page margin for scrolling screens.
    static let page: CGFloat = 16
    /// Vertical gap between the sections of a screen.
    static let section: CGFloat = 20
}

/// Corner radii, from small controls up to header cards.
enum Radius {
    static let badge: CGFloat = 12
    static let card: CGFloat = 18
    static let header: CGFloat = 22
}

/// Minimum tap target from the HIG.
enum HitTarget {
    static let minimum: CGFloat = 44
    static let button: CGFloat = 48
}

// MARK: - Buttons

/// The one prominent action on a screen (Add expense, New group).
struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .padding(.horizontal, Spacing.m)
            .frame(maxWidth: .infinity, minHeight: HitTarget.button)
            .foregroundStyle(Palette.hero)
            .contentShape(Capsule())
            .glassCapsule(tint: Palette.lime)
            .opacity(configuration.isPressed ? 0.8 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.snappy(duration: 0.16), value: configuration.isPressed)
    }
}

/// A companion to the primary action (Settle up).
struct SecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .padding(.horizontal, Spacing.m)
            .frame(maxWidth: .infinity, minHeight: HitTarget.button)
            .foregroundStyle(Palette.ink)
            .contentShape(Capsule())
            .glassCapsule(tint: Palette.card.opacity(0.5))
            .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
            .animation(.snappy(duration: 0.16), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == PrimaryButtonStyle {
    static var splitPrimary: PrimaryButtonStyle { PrimaryButtonStyle() }
}
extension ButtonStyle where Self == SecondaryButtonStyle {
    static var splitSecondary: SecondaryButtonStyle { SecondaryButtonStyle() }
}

/// A row of equal-width actions that fills the content width, and stacks
/// vertically at accessibility text sizes so nothing truncates.
struct ActionBar<Content: View>: View {
    @ViewBuilder var content: Content
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        if typeSize.isAccessibilitySize {
            VStack(spacing: Spacing.xs) { content }
        } else {
            HStack(spacing: Spacing.xs) { content }
        }
    }
}

// MARK: - Amounts

/// A balance from one person's point of view: green when they get money back,
/// coral when they owe. The caption names the direction so colour is never
/// the only signal.
struct BalanceLabel: View {
    var amount: Int64
    var currency: String
    /// Caption when the amount is positive (money comes back) and negative.
    var positive = "gets back"
    var negative = "owes"
    var alignment: HorizontalAlignment = .trailing
    var font: Font = .splitAmount(16)

    var body: some View {
        VStack(alignment: alignment, spacing: 1) {
            Text(Money.text(abs(amount), currency))
                .font(font)
                .foregroundStyle(amount == 0 ? Palette.ink : amount > 0 ? Palette.positive : Palette.negative)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .contentTransition(.numericText())
            Text(amount == 0 ? "settled" : amount > 0 ? positive : negative)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Rows

/// The standard ledger row: a leading badge, a title and detail line, and a
/// trailing value with a caption. Used for charges, payments and statements.
struct LedgerRow<Leading: View>: View {
    var title: String
    var detail: String
    var value: String
    var valueCaption: String?
    var valueTint: Color = Palette.ink
    @ViewBuilder var leading: Leading

    var body: some View {
        HStack(alignment: .center, spacing: Spacing.s) {
            leading
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
                    Text(title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(value)
                        .font(.splitAmount(16))
                        .foregroundStyle(valueTint)
                        .lineLimit(1)
                        .fixedSize()
                }
                HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let valueCaption {
                        Text(valueCaption)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
            }
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, Spacing.m)
        .padding(.vertical, Spacing.s)
        .frame(minHeight: HitTarget.minimum)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// A divider inset to line up with row text after a leading badge.
struct RowDivider: View {
    var inset: CGFloat = Spacing.m + 40 + Spacing.s
    var body: some View {
        Divider().overlay(Palette.line).padding(.leading, inset)
    }
}

// MARK: - Empty states

/// The system empty state with at most one primary action, centred in the
/// available space.
struct EmptyStateView: View {
    var title: String
    var message: String
    var symbol: String
    var actionTitle: String? = nil
    var actionSymbol: String = "plus"
    var action: (() -> Void)? = nil

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: {
            Text(message)
        } actions: {
            if let actionTitle, let action {
                Button(action: action) { Label(actionTitle, systemImage: actionSymbol) }
                    .buttonStyle(.splitPrimary)
                    .frame(maxWidth: 260)
            }
        }
        .foregroundStyle(Palette.ink)
    }
}

// MARK: - Dates

enum LedgerDate {
    private static let parser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let plain = ISO8601DateFormatter()

    static func date(_ stamp: String) -> Date? {
        parser.date(from: stamp) ?? plain.date(from: stamp)
    }

    /// "Nov 17", or "Nov 17, 2025" outside the current year.
    static func short(_ stamp: String) -> String {
        guard let date = date(stamp) else { return String(stamp.prefix(10)) }
        let sameYear = Calendar.current.isDate(date, equalTo: Date(), toGranularity: .year)
        return sameYear ? date.formatted(.dateTime.month(.abbreviated).day()) : date.formatted(.dateTime.month(.abbreviated).day().year())
    }
}

// MARK: - Headers

/// The ink header card at the top of a group, person or statement: a badge or
/// avatar, a title and subtitle, then any balances or controls below.
struct HeroHeader<Leading: View, Footer: View>: View {
    var title: String
    var subtitle: String
    @ViewBuilder var leading: Leading
    @ViewBuilder var footer: Footer

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            HStack(alignment: .center, spacing: Spacing.s) {
                leading
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.splitDisplay(24))
                        .foregroundStyle(Palette.onHero)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(Palette.lime.opacity(0.75))
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            footer
        }
        .padding(Spacing.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            LinearGradient(colors: [Palette.hero, Palette.hero.opacity(0.94)], startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: Radius.header)
        )
        .overlay(RoundedRectangle(cornerRadius: Radius.header).stroke(Palette.lime.opacity(0.16), lineWidth: 1))
    }
}

/// Net balances inside a `HeroHeader`, one line per currency.
struct HeroBalances: View {
    var balances: [(currency: String, amount: Int64)]
    var positive = "gets back"
    var negative = "owes"

    private var open: [(currency: String, amount: Int64)] { balances.filter { $0.amount != 0 } }

    var body: some View {
        if open.isEmpty {
            Label("Settled up", systemImage: "checkmark.circle.fill")
                .font(.headline)
                .foregroundStyle(Palette.lime)
        } else {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                ForEach(open, id: \.currency) { item in
                    HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
                        Text(Money.text(abs(item.amount), item.currency))
                            .font(.splitAmount(open.count > 1 ? 22 : 28, weight: .bold))
                            .foregroundStyle(item.amount > 0 ? Palette.lime : Palette.heroNegative)
                            .lineLimit(1)
                            .minimumScaleFactor(0.6)
                            .contentTransition(.numericText())
                        Text(item.amount > 0 ? positive : negative)
                            .font(.subheadline)
                            .foregroundStyle(Palette.onHero.opacity(0.7))
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}

/// Two or three small figures under a hero balance (Paid, Share, Entries).
struct HeroStats: View {
    var items: [(label: String, value: String)]
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        Group {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: Spacing.xs) { cells }
            } else {
                HStack(alignment: .top, spacing: Spacing.s) { cells }
            }
        }
        .padding(.top, Spacing.xxs)
        .accessibilityElement(children: .combine)
    }
    @ViewBuilder private var cells: some View {
        ForEach(items, id: \.label) { item in
            VStack(alignment: .leading, spacing: 1) {
                Text(item.label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Palette.lime.opacity(0.6))
                Text(item.value)
                    .font(.splitAmount(15))
                    .foregroundStyle(Palette.onHero.opacity(0.92))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
