import SwiftUI
import UIKit

enum Palette {
    static let paper = Color(light: 0xF7F8F5, dark: 0x0C120F)
    static let background = paper
    static let card = Color(light: 0xFFFFFF, dark: 0x131B16)
    static let raised = Color(light: 0xEFF2EC, dark: 0x1A241E)
    static let ink = Color(light: 0x13201A, dark: 0xECF3EE)
    /// The ink card stays dark in both appearances; it is the one loud surface.
    static let hero = Color(light: 0x13201A, dark: 0x122A20)
    /// Body text on the ink hero in both appearances.
    static let onHero = Color(hex: 0xF4F1E8)
    static let evergreen = Color(light: 0x166534, dark: 0x4ADE80)
    static let green = evergreen
    static let lime = Color(light: 0xD6F294, dark: 0xC9EC86)
    static let mint = Color(light: 0xC9E7D4, dark: 0x2B4A39)
    static let coral = Color(light: 0xC2410C, dark: 0xFB923C)
    static let amber = Color(light: 0xA16207, dark: 0xFBBF24)
    static let line = Color(light: 0xE1E6DC, dark: 0x243129)
    static let muted = Color.secondary
    static let positive = Color(light: 0x0F766E, dark: 0x2DD4BF)
    static let negative = coral
    static let sky = Color(light: 0x2F6E86, dark: 0x8EC8DC)
    static let lavender = Color(light: 0x6C5A93, dark: 0xB7A6E0)
    /// A hairline that lifts glass off the background; stronger in dark mode
    /// where Liquid Glass over the dark paper is otherwise near-invisible.
    static let glassEdge = Color(light: UIColor.white.withAlphaComponent(0.55), dark: UIColor.white.withAlphaComponent(0.10))
    /// Coral that stays legible on the ink hero card.
    static let heroNegative = Color(red: 1, green: 0.72, blue: 0.60)
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        })
    }
    init(light: UIColor, dark: UIColor) {
        self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? dark : light })
    }
}

extension Font {
    static func splitDisplay(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        let scaled = min(UIFontMetrics.default.scaledValue(for: size), size * 1.5)
        return .system(size: scaled, weight: weight, design: .rounded)
    }
    static func splitAmount(_ size: CGFloat, weight: Font.Weight = .semibold) -> Font {
        let scaled = min(UIFontMetrics.default.scaledValue(for: size), size * 1.45)
        return .system(size: scaled, weight: weight, design: .rounded).monospacedDigit()
    }
    static var splitEyebrow: Font { .caption.weight(.semibold) }
}

struct AppBackground: View {
    var body: some View { Palette.background.ignoresSafeArea() }
}

private struct GlassSurface: ViewModifier {
    var shape: AnyShape
    var tint: Color?
    var interactive: Bool

    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            let effect: Glass = interactive
                ? .regular.tint(tint).interactive()
                : .regular.tint(tint)
            content
                .glassEffect(effect, in: shape)
                .overlay(shape.stroke(Palette.glassEdge, lineWidth: 0.75))
        } else {
            content
                .background(.ultraThinMaterial, in: shape)
                .overlay(shape.stroke(Palette.line, lineWidth: 1))
        }
    }
}

extension View {
    func glassSurface(cornerRadius: CGFloat = 18, tint: Color? = nil, interactive: Bool = false) -> some View {
        modifier(GlassSurface(
            shape: AnyShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)),
            tint: tint,
            interactive: interactive
        ))
    }
    func glassCapsule(tint: Color? = nil, interactive: Bool = true) -> some View {
        modifier(GlassSurface(shape: AnyShape(Capsule()), tint: tint, interactive: interactive))
    }
}

/// A labelled action that shares its row equally with its siblings. Put
/// these in an `ActionBar`; the prominent one uses the primary style.
struct SplitActionButton: View {
    var title: String
    var symbol: String
    var prominent: Bool = false
    var tint: Color? = nil
    var action: () -> Void

    var body: some View {
        if prominent {
            Button(action: action) { Label(title, systemImage: symbol) }
                .buttonStyle(.splitPrimary)
        } else {
            Button(action: action) { Label(title, systemImage: symbol) }
                .buttonStyle(.splitSecondary)
        }
    }
}

struct SplitIconAction: View {
    var title: String
    var symbol: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: .semibold))
                .frame(width: 46, height: 46)
                .foregroundStyle(Palette.ink)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassCapsule()
        .accessibilityLabel(title)
    }
}

/// A filled confirm action (Save expense, Record payment). Lime by default
/// so every primary action in the app reads the same.
struct SolidButton: ButtonStyle {
    var tint: Color = Palette.lime
    var foreground: Color = Palette.hero
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .padding(.horizontal, Spacing.m)
            .frame(minHeight: 50)
            .background(tint, in: Capsule())
            .foregroundStyle(foreground)
            .contentShape(Capsule())
            .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.5)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.snappy(duration: 0.16), value: configuration.isPressed)
    }
}

struct GhostButton: ButtonStyle {
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(minHeight: 44)
            .foregroundStyle(Palette.ink)
            .glassCapsule(tint: Palette.card.opacity(0.40))
            .opacity(enabled ? (configuration.isPressed ? 0.72 : 1) : 0.48)
    }
}

struct IconButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .frame(width: 44, height: 44)
            .foregroundStyle(Palette.ink)
            .glassCapsule(tint: Palette.card.opacity(0.40))
            .opacity(configuration.isPressed ? 0.72 : 1)
    }
}

struct Avatar: View {
    var name: String
    var size: CGFloat = 40
    var tint: Color? = nil
    private var color: Color {
        if let tint { return tint }
        let colors: [Color] = [Palette.evergreen, Palette.coral, Palette.sky, Palette.amber, Palette.lavender]
        let scalar = name.unicodeScalars.reduce(0) { $0 + Int($1.value) }
        return colors[scalar % colors.count]
    }
    var body: some View {
        Text(initials)
            .font(.system(size: max(11, size * 0.36), weight: .bold, design: .default))
            .frame(width: size, height: size)
            .background(color.opacity(0.16))
            .foregroundStyle(color)
            .clipShape(Circle())
            .overlay(Circle().stroke(color.opacity(0.20), lineWidth: 1))
            .accessibilityHidden(true)
    }
    private var initials: String {
        let parts = name.split(separator: " ").prefix(2)
        let value = parts.compactMap { $0.first.map(String.init) }.joined()
        return value.isEmpty ? "?" : value.uppercased()
    }
}

struct BalanceHero: View {
    let owed: [String: Int64]
    let owe: [String: Int64]
    let subtitle: String

    @EnvironmentObject private var fx: FXStore
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        let target = fx.home
        let incoming = fx.total(owed, in: target)
        let outgoing = fx.total(owe, in: target)
        let incomingApproximate = owed.keys.contains { $0 != target }
        let outgoingApproximate = owe.keys.contains { $0 != target }
        let needsConversion = incomingApproximate || outgoingApproximate
        let missingRates = !incoming.missing.isEmpty || !outgoing.missing.isEmpty
        let net = incoming.amount - outgoing.amount
        let wide = sizeClass == .regular && !typeSize.isAccessibilitySize
        let headline = VStack(alignment: .leading, spacing: 6) {
            Text(subtitle).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.onHero.opacity(0.82))
            Text(missingRates ? "Net balance unavailable" : balanceText(net, currency: target, approximate: needsConversion, signed: true))
                .font(.splitAmount(wide ? 40 : 32, weight: .bold))
                .foregroundStyle(net < 0 && !missingRates ? Palette.heroNegative : Palette.lime)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .contentTransition(.numericText())
                .accessibilityLabel(missingRates ? "Net balance unavailable" : "Net balance, " + balanceText(net, currency: target, approximate: needsConversion, signed: true))
            if needsConversion {
                Text(missingRates ? (fx.refreshing ? "Getting exchange rates…" : "Some exchange rates are unavailable.")
                                  : (fx.offline ? "Converted to \(target) with saved rates" : "Converted to \(target) at current rates"))
                    .font(.caption)
                    .foregroundStyle(Palette.onHero.opacity(0.6))
            }
        }
        let stats = Group {
            stat("You owe", amount: outgoing.missing.isEmpty ? outgoing.amount : nil, approximate: outgoingApproximate, tint: Palette.heroNegative)
            stat("You’re owed", amount: incoming.missing.isEmpty ? incoming.amount : nil, approximate: incomingApproximate, tint: Palette.lime)
        }

        Group {
            if wide {
                HStack(alignment: .center, spacing: Spacing.xl) {
                    headline.frame(maxWidth: .infinity, alignment: .leading)
                    Rectangle().fill(Palette.lime.opacity(0.16)).frame(width: 1).padding(.vertical, 4)
                        .accessibilityHidden(true)
                    HStack(alignment: .top, spacing: Spacing.xl) { stats }
                        .frame(maxWidth: 360)
                }
                .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(alignment: .leading, spacing: 14) {
                    headline
                    Rectangle().fill(Palette.lime.opacity(0.16)).frame(height: 1)
                        .accessibilityHidden(true)
                    if typeSize.isAccessibilitySize {
                        VStack(alignment: .leading, spacing: 12) { stats }
                    } else {
                        HStack(alignment: .top, spacing: 16) { stats }
                    }
                }
            }
        }
        .padding(wide ? Spacing.xl : 18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            LinearGradient(colors: [Palette.hero, Palette.hero.opacity(0.92)], startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: Radius.header + 4, style: .continuous)
        )
        .overlay(RoundedRectangle(cornerRadius: Radius.header + 4, style: .continuous).strokeBorder(Palette.lime.opacity(0.14)))
    }

    private func stat(_ title: String, amount: Int64?, approximate: Bool, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.subheadline).foregroundStyle(Palette.onHero.opacity(0.7))
            Text(amount.map { balanceText($0, currency: fx.home, approximate: approximate) } ?? "Unavailable")
                .font(.splitAmount(19, weight: .semibold))
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .contentTransition(.numericText())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func balanceText(_ amount: Int64, currency: String, approximate: Bool, signed: Bool = false) -> String {
        (approximate ? "≈ " : "") + Money.text(amount, currency, signed: signed)
    }
}

struct Card<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: Radius.card))
            .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.line))
    }
}

struct SectionHeader: View {
    var title: String
    var subtitle: String? = nil
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline).foregroundStyle(Palette.ink)
                if let subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.evergreen)
            }
        }
    }
}

struct MonthHeader: View {
    var date: Date
    var total: String? = nil
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(date.formatted(.dateTime.month(.wide).year()))
                .font(.subheadline.weight(.bold))
                .foregroundStyle(.secondary)
            Spacer()
            if let total {
                Text(total).font(.caption.weight(.medium)).foregroundStyle(.tertiary)
            }
        }
        .padding(.top, 6)
    }
}

struct AmountText: View {
    var minor: Int64
    var currency: String
    var size: CGFloat = 16
    var signed: Bool = false
    var entry: LedgerEntry? = nil
    @EnvironmentObject private var fx: FXStore
    var body: some View {
        Text(entry.map { fx.entryText($0, amount: minor, signed: signed) } ?? Money.text(minor, currency, signed: signed))
            .font(.splitAmount(size))
            .foregroundStyle(signed && minor < 0 ? Palette.negative : Palette.ink)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .contentTransition(.numericText())
    }
}

/// An entry's amount. Refunds read as money coming back: a minus sign in the credit colour.
struct EntryAmount: View {
    var entry: LedgerEntry
    var size: CGFloat = 15
    @EnvironmentObject private var fx: FXStore
    private var label: String {
        let text = fx.entryText(entry, amount: entry.amount)
        guard entry.isRefund else { return text }
        return text.hasPrefix("≈ ") ? "≈ −" + text.dropFirst(2) : "−" + text
    }
    var body: some View {
        Text(label)
            .font(.splitAmount(size))
            .foregroundStyle(entry.isRefund ? Palette.positive : Palette.ink)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .contentTransition(.numericText())
            .accessibilityLabel(entry.isRefund ? "Refund \(fx.entryText(entry, amount: entry.amount))" : fx.entryText(entry, amount: entry.amount))
    }
}

/// Marks an entry whose cost may still change, with its reason when one was given.
struct PendingBadge: View {
    var note: String?
    var body: some View {
        HStack(spacing: 4) {
            Label("Pending", systemImage: "clock")
                .font(.caption2.weight(.bold))
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Palette.amber.opacity(0.16), in: Capsule())
                .foregroundStyle(Palette.amber)
            if let note, !note.isEmpty {
                Text(note).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Pending" + (note.map { ". \($0)" } ?? ""))
    }
}

struct CategoryBadge: View {
    var category: String?
    var size: CGFloat = 34
    var body: some View {
        let meta = CategoryMeta.named(category)
        Image(systemName: meta.symbol)
            .font(.system(size: size * 0.40, weight: .semibold))
            .frame(width: size, height: size)
            .foregroundStyle(meta.tint)
            .background(meta.tint.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: size * 0.30, style: .continuous))
            .accessibilityLabel(meta.name)
    }
}

struct Chip: View {
    var title: String
    var symbol: String? = nil
    var selected: Bool = false
    /// Shows a trailing clear mark, for a chip whose tap removes a filter.
    var removable: Bool = false
    var action: (() -> Void)? = nil
    var body: some View {
        let label = HStack(spacing: 5) {
            if let symbol { Image(systemName: symbol).font(.caption.weight(.semibold)) }
            Text(title).font(.subheadline.weight(.semibold)).lineLimit(1)
            if removable {
                Image(systemName: "xmark.circle.fill")
                    .font(.subheadline)
                    .opacity(0.75)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(minHeight: 36)
        .foregroundStyle(selected ? Palette.paper : Palette.ink)
        .background(selected ? Palette.evergreen : Palette.raised)
        .clipShape(Capsule())
        .overlay(Capsule().stroke(selected ? Color.clear : Palette.line, lineWidth: 1))
        .contentShape(Capsule())
        if let action {
            Button(action: action) { label }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
        } else {
            label
        }
    }
}

struct PersonBalanceRow: View {
    var person: PersonBalance
    var showsChevron: Bool = true
    @EnvironmentObject private var fx: FXStore
    var body: some View {
        HStack(spacing: 12) {
            Avatar(name: person.name, size: 42)
            VStack(alignment: .leading, spacing: 3) {
                Text(person.name).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
                Text("\(person.groupIDs.count) shared \(person.groupIDs.count == 1 ? "group" : "groups")")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            BalanceLabel(amounts: person.amounts, positive: "owes you", negative: "you owe")
            .layoutPriority(1)
            if showsChevron {
                Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(.tertiary)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

struct EntryRow: View {
    @EnvironmentObject private var fx: FXStore
    @EnvironmentObject private var store: ExpenseStore
    var entry: LedgerEntry
    var group: ExpenseGroup
    var currentUserID: String?
    var showGroup: Bool = false
    var showDate: Bool = false
    var showSocial: Bool = true
    @Environment(\.horizontalSizeClass) private var size
    private var meta: CategoryMeta { CategoryMeta.named(entry.category) }
    private var me: Person? { Analytics.me(in: group, userID: currentUserID) }
    private func name(_ id: String) -> String {
        if let person = group.members.first(where: { $0.id == id }) {
            return person.userID == currentUserID ? "You" : person.name
        }
        return "Someone"
    }

    /// Width actually available to the row. A regular-width screen can still
    /// put the row in a narrow column, so the layout follows the space.
    @State private var width: CGFloat = 0

    var body: some View {
        Group {
            if size == .compact || width < 520 { compactBody } else { regularBody }
        }
        .padding(.vertical, 2)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .accessibilityElement(children: .combine)
    }

    private var iconView: some View {
        ZStack(alignment: .bottomTrailing) {
            EntryBadge(title: entry.title, category: entry.category, size: 40)
            if entry.isSettlement {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Palette.paper, Palette.evergreen)
                    .offset(x: 3, y: 3)
            } else if entry.isRefund {
                Image(systemName: "arrow.uturn.backward.circle.fill")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Palette.paper, Palette.positive)
                    .offset(x: 3, y: 3)
            } else if entry.isPending {
                Image(systemName: "clock.badge.questionmark.fill")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(Palette.paper, Palette.amber)
                    .offset(x: 3, y: 3)
            }
        }
        .accessibilityHidden(true)
    }

    private var titleView: some View {
        Text(entry.title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Palette.ink)
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// One line, truncated at the end, so long names never break the row into
    /// narrow columns: "Jason Huang paid · Buenos Aires and Rio… · Nov 28".
    private var metaLine: some View {
        let who = entry.isSettlement ? "\(name(entry.paidBy)) paid \(entry.splits.first.map { name($0.memberID) } ?? "someone")"
            : entry.isRefund ? (entry.refundOf == nil ? "Credit from \(name(entry.paidBy))" : "Refund to \(name(entry.paidBy))")
            : "\(name(entry.paidBy)) paid"
        var parts = [who]
        if showDate { parts.append(LedgerDate.short(entry.createdAt)) }
        if showGroup { parts.append(group.name) }
        return Text(parts.joined(separator: " · "))
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.tail)
    }

    private var originalTitle: String? {
        guard let id = entry.refundOf else { return nil }
        return store.entries.first { $0.id == id }?.title
    }

    @ViewBuilder private var statusLine: some View {
        if let phase = group.phase(for: entry) {
            Text(phase.title).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
        }
        if entry.isRefund {
            Label(originalTitle.map { "Refund of \($0)" } ?? (entry.refundOf == nil ? "Credit" : "Refund"), systemImage: "arrow.uturn.backward")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Palette.positive)
                .lineLimit(1)
        }
        if entry.isPending {
            PendingBadge(note: entry.pendingNote)
        }
    }

    @ViewBuilder private var noteLine: some View {
        if let notes = entry.notes, !notes.isEmpty {
            Text(notes).font(.caption).foregroundStyle(.tertiary).lineLimit(1)
        }
    }

    @ViewBuilder private var openLine: some View {
        if let bill = entry.bill, bill.openCount > 0 {
            Label("\(bill.openCount) unclaimed · \(fx.entryText(entry, amount: bill.openTotal))", systemImage: "circle.dashed")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Palette.amber)
                .lineLimit(1)
        }
    }

    @ViewBuilder private var socialLine: some View {
        if showSocial, (entry.commentCount ?? 0) > 0 || (entry.likeCount ?? 0) > 0 {
            HStack(spacing: 10) {
                if let likes = entry.likeCount, likes > 0 {
                    Label("\(likes)", systemImage: entry.likedByMe == true ? "hand.thumbsup.fill" : "hand.thumbsup")
                        .foregroundStyle(entry.likedByMe == true ? Palette.evergreen : .secondary)
                }
                if let count = entry.commentCount, count > 0 {
                    Label("\(count)", systemImage: "bubble.left")
                }
            }
            .font(.caption2.weight(.medium))
            .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var netLine: some View {
        let (mine, netText) = me.map { fx.entryNet(entry, for: $0.id) } ?? (0, "")
        if entry.isHandled {
            Label("Handled", systemImage: "checkmark.circle")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Palette.positive)
        } else if entry.isRefund && mine != 0 {
            Text(mine > 0 ? "you get back \(netText)" : "you owe \(netText) · \(entry.refundOf == nil ? "credit you’re giving" : "refund you received for others")")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(mine > 0 ? Palette.positive : Palette.negative)
                .lineLimit(2)
                .minimumScaleFactor(0.7)
        } else if entry.kind == "expense" && mine != 0 {
            Text(mine > 0 ? "you lent \(netText)" : "you owe \(netText)")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(mine > 0 ? Palette.positive : Palette.negative)
                .lineLimit(2)
                .minimumScaleFactor(0.7)
        } else if entry.isSpending {
            Text("not involved").font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
        }
    }

    private var compactBody: some View {
        HStack(alignment: .top, spacing: 10) {
            iconView
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    titleView
                    Spacer(minLength: 4)
                    EntryAmount(entry: entry, size: 15)
                        .fixedSize()
                        .layoutPriority(1)
                }
                metaLine
                statusLine
                netLine
                noteLine
                openLine
                socialLine
            }
        }
    }

    private var regularBody: some View {
        HStack(alignment: .top, spacing: 12) {
            iconView
            VStack(alignment: .leading, spacing: 4) {
                titleView
                metaLine
                statusLine
                noteLine
                openLine
                socialLine
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 3) {
                EntryAmount(entry: entry, size: 16)
                    .fixedSize()
                netLine
                    .multilineTextAlignment(.trailing)
            }
            .frame(minWidth: 110, maxWidth: 190, alignment: .trailing)
            .layoutPriority(1)
        }
    }
}


struct GroupCard: View {
    var summary: GroupSummary
    var currentUserID: String?
    var body: some View {
        let group = summary.group
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: group.symbol)
                    .font(.system(size: 18, weight: .semibold))
                    .frame(width: 42, height: 42)
                    .background(group.isFriend ? Palette.raised : Palette.lime.opacity(0.55))
                    .foregroundStyle(group.isFriend ? Palette.evergreen : Palette.ink)
                    .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(group.name).font(.headline).foregroundStyle(Palette.ink).lineLimit(1)
                    Text(group.isFriend ? "One-to-one tab" : "\(group.members.count) people · \(group.kind == "trip" ? "Trip" : group.kind == "home" ? "Home" : "Group")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(.tertiary)
            }
            HStack(alignment: .lastTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) { groupBalances }
                Spacer(minLength: 6)
                groupEntryCount
            }
        }
        .padding(16)
        .glassSurface(cornerRadius: 18, tint: Palette.card.opacity(0.52))
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private var groupBalances: some View {
        BalanceLabel(amounts: summary.mine, positive: "you’re owed", negative: "you owe", alignment: .leading)
    }

    @ViewBuilder private var groupEntryCount: some View {
        if summary.entryCount > 0 {
            Text("\(summary.entryCount) \(summary.entryCount == 1 ? "entry" : "entries")")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }
}

struct EmptyPanel: View {
    var title: String
    var message: String
    var symbol: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(Palette.evergreen)
                .frame(width: 60, height: 60)
                .background(Palette.evergreen.opacity(0.09))
                .clipShape(Circle())
            Text(title).font(.headline).foregroundStyle(Palette.ink)
            Text(message).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            if let actionTitle, let action {
                Button(actionTitle, action: action).buttonStyle(GhostButton())
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
        .padding(.horizontal, 20)
    }
}

struct InlineError: View {
    var text: String
    var body: some View {
        Label(text, systemImage: "exclamationmark.circle.fill")
            .font(.subheadline)
            .foregroundStyle(Palette.negative)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct ErrorText: View {
    var text: String
    var body: some View { InlineError(text: text) }
}

/// A wrapping row of chips. Each chip keeps its intrinsic width; a chip wider
/// than the row is clamped to the row so long names truncate instead of clip.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat? = nil

    private func measure(_ subview: LayoutSubview, maxWidth: CGFloat) -> CGSize {
        let ideal = subview.sizeThatFits(.unspecified)
        guard ideal.width > maxWidth, maxWidth.isFinite else { return ideal }
        return subview.sizeThatFits(ProposedViewSize(width: maxWidth, height: nil))
    }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> (CGSize, [CGRect]) {
        let rowGap = lineSpacing ?? spacing
        var frames: [CGRect] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var usedWidth: CGFloat = 0
        for subview in subviews {
            let size = measure(subview, maxWidth: width)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + rowGap
                rowHeight = 0
            }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            usedWidth = max(usedWidth, x + size.width)
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return (CGSize(width: usedWidth, height: y + rowHeight), frames)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(subviews, width: proposal.width ?? .infinity).0
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let (_, frames) = arrange(subviews, width: proposal.width ?? .infinity)
        for (subview, frame) in zip(subviews, frames) {
            subview.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                          anchor: .topLeading, proposal: ProposedViewSize(frame.size))
        }
    }
}

/// An avatar + name capsule for a group member. Used for receipt claimants:
/// selected chips are filled with the member colour, unselected chips are
/// outlined, and the checkmark carries state so it is not colour-only.
struct PersonChip: View {
    var name: String
    var label: String? = nil
    var selected: Bool = true
    var compact: Bool = false
    var action: (() -> Void)? = nil

    private var display: String { label ?? name }

    var body: some View {
        let content = HStack(spacing: 6) {
            Avatar(name: name, size: compact ? 20 : 24)
            Text(display)
                .font((compact ? Font.caption : Font.subheadline).weight(.semibold))
                .lineLimit(1)
            if action != nil {
                Image(systemName: selected ? "checkmark" : "plus")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(selected ? Palette.evergreen : Color.secondary)
                    .accessibilityHidden(true)
            }
        }
        .padding(.leading, compact ? 3 : 4)
        .padding(.trailing, compact ? 9 : 11)
        .padding(.vertical, compact ? 3 : 4)
        .foregroundStyle(selected ? Palette.ink : Color.secondary)
        .background(selected ? Palette.mint.opacity(0.75) : Palette.raised.opacity(0.55), in: Capsule())
        .overlay(
            Capsule().strokeBorder(
                selected ? Palette.evergreen.opacity(0.28) : Palette.line,
                style: StrokeStyle(lineWidth: 1, dash: selected ? [] : [3, 3])
            )
        )
        .contentShape(Capsule())

        if let action {
            Button(action: action) {
                content
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(display)
            .accessibilityValue(selected ? "Sharing" : "Not sharing")
            .accessibilityHint(selected ? "Double-tap to remove from this item" : "Double-tap to add to this item")
            .accessibilityAddTraits(selected ? .isSelected : [])
        } else {
            content
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(display)
        }
    }
}

/// "6 items · 2 unassigned · ARS 25.00" — a compact receipt summary rail.
/// A sidebar list on regular width, a plain list on a phone. The sidebar style
/// is unreadable on a compact phone: its section spacing and row insets leave
/// a large hole above the first group.
private struct AdaptiveSidebarListStyle: ViewModifier {
    @Environment(\.horizontalSizeClass) private var size
    @ViewBuilder func body(content: Content) -> some View {
        if size == .regular {
            content.listStyle(.sidebar)
        } else {
            content.listStyle(.plain)
        }
    }
}

extension View {
    func adaptiveSidebarListStyle() -> some View {
        modifier(AdaptiveSidebarListStyle())
    }
}

struct ReceiptSummaryRail: View {
    @EnvironmentObject private var fx: FXStore
    var bill: ReceiptBill
    var currency: String
    var openLabel: String = "unassigned"
    var entry: LedgerEntry? = nil

    var body: some View {
        let open = bill.openCount
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { pills(open) }
            VStack(alignment: .leading, spacing: 6) { pills(open) }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func pills(_ open: Int) -> some View {
        pill("\(bill.items.count) \(bill.items.count == 1 ? "item" : "items")", symbol: "list.bullet", tint: Palette.evergreen)
        pill(open == 0 ? "All assigned" : "\(open) \(openLabel)",
             symbol: open == 0 ? "checkmark.circle.fill" : "circle.dashed",
             tint: open == 0 ? Palette.positive : Palette.amber)
        pill(entry.map { fx.entryText($0) } ?? Money.text(bill.total, currency), symbol: "sum", tint: Palette.ink, strong: true)
    }

    private func pill(_ text: String, symbol: String, tint: Color, strong: Bool = false) -> some View {
        HStack(spacing: 5) {
            Image(systemName: symbol).font(.caption2.weight(.bold)).accessibilityHidden(true)
            Text(text)
                .font(strong ? .splitAmount(13, weight: .bold) : .caption.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(tint.opacity(0.10), in: Capsule())
        .fixedSize()
    }
}
