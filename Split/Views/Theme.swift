import SwiftUI
import UIKit

enum Palette {
    static let paper = Color(light: 0xF7F4ED, dark: 0x0A100E)
    static let background = paper
    static let card = Color(light: 0xFFFEFA, dark: 0x111A16)
    static let raised = Color(light: 0xF0EDE3, dark: 0x17231D)
    static let ink = Color(light: 0x0F241C, dark: 0xEAF2EC)
    /// The ink card stays dark in both appearances; it is the one loud surface.
    static let hero = Color(light: 0x0F241C, dark: 0x122A20)
    /// Body text on the ink hero in both appearances.
    static let onHero = Color(hex: 0xF4F1E8)
    static let evergreen = Color(light: 0x1D4C3A, dark: 0x7BC7A0)
    static let green = evergreen
    static let lime = Color(light: 0xD6F294, dark: 0xC9EC86)
    static let mint = Color(light: 0xC9E7D4, dark: 0x2B4A39)
    static let coral = Color(light: 0xB84A2E, dark: 0xF08A6C)
    static let amber = Color(light: 0x986B16, dark: 0xE8B957)
    static let line = Color(light: 0xE2DED2, dark: 0x25322B)
    static let muted = Color.secondary
    static let positive = Color(light: 0x2C6E52, dark: 0x8BD3AC)
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
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drift = false

    var body: some View {
        GeometryReader { proxy in
            let size = max(proxy.size.width, proxy.size.height)
            ZStack {
                Palette.background
                Circle()
                    .fill(Palette.mint.opacity(scheme == .dark ? 0.16 : 0.34))
                    .frame(width: size * 0.54, height: size * 0.54)
                    .blur(radius: 90)
                    .offset(x: proxy.size.width * (drift ? 0.34 : 0.24), y: -proxy.size.height * 0.34)
                Circle()
                    .fill(Palette.sky.opacity(scheme == .dark ? 0.10 : 0.12))
                    .frame(width: size * 0.48, height: size * 0.48)
                    .blur(radius: 100)
                    .offset(x: -proxy.size.width * (drift ? 0.30 : 0.18), y: -proxy.size.height * 0.18)
                Circle()
                    .fill(Palette.lime.opacity(scheme == .dark ? 0.06 : 0.18))
                    .frame(width: size * 0.52, height: size * 0.52)
                    .blur(radius: 100)
                    .offset(x: -proxy.size.width * (drift ? 0.30 : 0.20), y: proxy.size.height * (drift ? 0.40 : 0.30))
                Circle()
                    .fill(Palette.coral.opacity(scheme == .dark ? 0.10 : 0.12))
                    .frame(width: size * 0.36, height: size * 0.36)
                    .blur(radius: 90)
                    .offset(x: proxy.size.width * (drift ? 0.42 : 0.30), y: proxy.size.height * (drift ? 0.48 : 0.36))
                Circle()
                    .fill(Palette.lavender.opacity(scheme == .dark ? 0.08 : 0.09))
                    .frame(width: size * 0.40, height: size * 0.40)
                    .blur(radius: 100)
                    .offset(x: proxy.size.width * 0.32, y: proxy.size.height * 0.08)
                if scheme == .light {
                    Circle()
                        .fill(Palette.evergreen.opacity(0.06))
                        .frame(width: size * 0.44, height: size * 0.44)
                        .blur(radius: 100)
                        .offset(x: -proxy.size.width * 0.38, y: -proxy.size.height * (drift ? 0.12 : 0.04))
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .clipped()
        }
        .ignoresSafeArea()
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 24).repeatForever(autoreverses: true)) { drift = true }
        }
    }
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

struct SolidButton: ButtonStyle {
    var tint: Color = Palette.evergreen
    var foreground: Color = Palette.paper
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .frame(minHeight: 48)
            .background(tint)
            .foregroundStyle(foreground)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .opacity(configuration.isPressed ? 0.72 : 1)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.snappy(duration: 0.16), value: configuration.isPressed)
    }
}

struct GhostButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(minHeight: 44)
            .foregroundStyle(Palette.ink)
            .glassCapsule(tint: Palette.card.opacity(0.40))
            .opacity(configuration.isPressed ? 0.72 : 1)
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
            .font(.system(size: max(11, size * 0.36), weight: .bold, design: .rounded))
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
    var net: [CurrencyTotal]
    var owed: [CurrencyTotal]
    var owe: [CurrencyTotal]
    var subtitle: String? = nil
    @Environment(\.horizontalSizeClass) private var size

    var body: some View {
        Group {
            if size == .regular {
                HStack(alignment: .top, spacing: 24) {
                    netStack(compact: false)
                    Rectangle()
                        .fill(Palette.lime.opacity(0.16))
                        .frame(width: 1)
                        .padding(.vertical, 2)
                    VStack(alignment: .leading, spacing: 16) {
                        heroStat("You owe", value: owe, tint: Color(red: 1, green: 0.74, blue: 0.64))
                        Rectangle().fill(Palette.lime.opacity(0.12)).frame(height: 1)
                        heroStat("You’re owed", value: owed, tint: Palette.lime)
                    }
                    .frame(width: 300, alignment: .leading)
                }
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    netStack(compact: true)
                    HStack(spacing: 12) {
                        heroStat("You owe", value: owe, tint: Color(red: 1, green: 0.74, blue: 0.64))
                        Rectangle().fill(Palette.lime.opacity(0.18)).frame(width: 1).padding(.vertical, 2)
                        heroStat("You’re owed", value: owed, tint: Palette.lime)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.horizontal, size == .regular ? 24 : 16)
        .padding(.vertical, size == .regular ? 22 : 14)
        .background(
            LinearGradient(colors: [Palette.hero, Palette.hero.opacity(0.94)], startPoint: .topLeading, endPoint: .bottomTrailing)
        )
        .clipShape(RoundedRectangle(cornerRadius: Radius.header))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.header)
                .stroke(Palette.lime.opacity(0.16), lineWidth: 1)
        )
    }

    private func netStack(compact: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(subtitle ?? "Your balance")
                    .font(.splitEyebrow)
                    .foregroundStyle(Palette.lime.opacity(0.72))
                Spacer(minLength: 8)
                if !compact {
                    Image(systemName: "equal.circle.fill")
                        .font(.system(size: 22, weight: .light))
                        .foregroundStyle(Palette.lime.opacity(0.32))
                        .accessibilityHidden(true)
                }
            }
            if net.isEmpty {
                Text("All settled")
                    .font(.splitDisplay(compact ? 30 : 40))
                    .foregroundStyle(Palette.lime)
            } else {
                ForEach(net) { total in
                    Text(Money.text(total.amount, total.currency, signed: true))
                        .font(.splitDisplay(compact ? (net.count > 1 ? 24 : 30) : (net.count > 1 ? 30 : 38), weight: .bold))
                        .foregroundStyle(total.amount < 0 ? Color(red: 1, green: 0.72, blue: 0.60) : Palette.lime)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                        .contentTransition(.numericText())
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func heroStat(_ title: String, value: [CurrencyTotal], tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.splitEyebrow)
                .foregroundStyle(Palette.lime.opacity(0.58))
            if value.isEmpty {
                Text("—").font(.splitAmount(17)).foregroundStyle(tint.opacity(0.8))
            } else {
                ForEach(value) { item in
                    Text(Money.text(item.amount, item.currency))
                        .font(.splitAmount(17))
                        .foregroundStyle(tint)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct Card<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassSurface(cornerRadius: 18, tint: Palette.card.opacity(0.52))
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
    var body: some View {
        Text(Money.text(minor, currency, signed: signed))
            .font(.splitAmount(size))
            .foregroundStyle(signed && minor < 0 ? Palette.negative : Palette.ink)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .contentTransition(.numericText())
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
    var action: (() -> Void)? = nil
    var body: some View {
        let label = HStack(spacing: 5) {
            if let symbol { Image(systemName: symbol).font(.caption.weight(.semibold)) }
            Text(title).font(.subheadline.weight(.semibold))
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
    var body: some View {
        HStack(spacing: 12) {
            Avatar(name: person.name, size: 42)
            VStack(alignment: .leading, spacing: 3) {
                Text(person.name).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
                if person.currencies.count > 1 {
                    Text("\(person.currencies.count) currencies · \(person.groupIDs.count) \(person.groupIDs.count == 1 ? "group" : "groups")")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("\(person.groupIDs.count) shared \(person.groupIDs.count == 1 ? "group" : "groups")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                ForEach(person.currencies, id: \.self) { currency in
                    let amount = person.amount(currency)
                    Text(Money.text(abs(amount), currency))
                        .font(.splitAmount(15))
                        .foregroundStyle(amount < 0 ? Palette.negative : Palette.positive)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Text(amount < 0 ? "you owe" : "owes you")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
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
    var entry: LedgerEntry
    var group: ExpenseGroup
    var currentUserID: String?
    var showGroup: Bool = false
    var showDate: Bool = false
    var showSocial: Bool = true
    @Environment(\.horizontalSizeClass) private var size
    private var meta: CategoryMeta { CategoryMeta.named(entry.category) }
    private var me: Person? { Analytics.me(in: group, userID: currentUserID) }
    private var mine: Int64 { guard let me else { return 0 }; return Ledger.net(entry, for: me.id) }
    private func name(_ id: String) -> String {
        if let person = group.members.first(where: { $0.id == id }) {
            return person.userID == currentUserID ? "You" : person.name
        }
        return "Someone"
    }

    var body: some View {
        Group {
            if size == .compact { compactBody } else { regularBody }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var iconView: some View {
        ZStack(alignment: .bottomTrailing) {
            CategoryBadge(category: entry.category, size: 40)
            if entry.isSettlement {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Palette.paper, Palette.evergreen)
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

    @ViewBuilder private var metaLine: some View {
        HStack(spacing: 4) {
            Text(entry.isSettlement ? "\(name(entry.paidBy)) settled up" : "\(name(entry.paidBy)) paid")
            if showGroup { Text("· \(group.name)") }
            if showDate, let date = ISO8601DateFormatter().date(from: entry.createdAt) {
                Text("· \(date.formatted(.dateTime.month(.abbreviated).day()))")
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    @ViewBuilder private var noteLine: some View {
        if let notes = entry.notes, !notes.isEmpty {
            Text(notes).font(.caption).foregroundStyle(.tertiary).lineLimit(1)
        }
    }

    @ViewBuilder private var openLine: some View {
        if let bill = entry.bill, bill.openCount > 0 {
            Text("\(bill.openCount) open \(bill.openCount == 1 ? "purchase" : "purchases") · \(Money.text(bill.openTotal, entry.currency))")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Palette.amber)
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
        if entry.kind == "expense" && mine != 0 {
            Text(mine > 0 ? "you lent \(Money.text(mine, entry.currency))" : "you owe \(Money.text(abs(mine), entry.currency))")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(mine > 0 ? Palette.positive : Palette.negative)
                .lineLimit(2)
                .minimumScaleFactor(0.7)
        } else if entry.kind == "expense" {
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
                    AmountText(minor: entry.amount, currency: entry.currency, size: 15)
                        .layoutPriority(1)
                }
                metaLine
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
                noteLine
                openLine
                socialLine
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 3) {
                AmountText(minor: entry.amount, currency: entry.currency, size: 15)
                netLine
                    .multilineTextAlignment(.trailing)
            }
            .frame(maxWidth: 150, alignment: .trailing)
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

    @ViewBuilder private var groupBalances: some View {
        if summary.isSettled {
            Text("Settled up")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Palette.evergreen)
        } else {
            ForEach(summary.currencies, id: \.self) { currency in
                let amount = summary.mine[currency] ?? 0
                if amount != 0 {
                    HStack(spacing: 4) {
                        Text(Money.text(abs(amount), currency))
                            .font(.splitAmount(summary.currencies.count > 1 ? 16 : 19))
                            .foregroundStyle(amount > 0 ? Palette.positive : Palette.negative)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                        Text(amount > 0 ? "you’re owed" : "you owe")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
        }
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

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        let rowGap = lineSpacing ?? spacing
        var width: CGFloat = 0
        var height: CGFloat = 0
        var rowWidth: CGFloat = 0
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = measure(subview, maxWidth: maxWidth)
            if rowWidth > 0, rowWidth + spacing + size.width > maxWidth {
                width = max(width, rowWidth)
                height += rowHeight + rowGap
                rowWidth = size.width
                rowHeight = size.height
            } else {
                rowWidth += (rowWidth == 0 ? 0 : spacing) + size.width
                rowHeight = max(rowHeight, size.height)
            }
        }
        width = max(width, rowWidth)
        height += rowHeight
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rowGap = lineSpacing ?? spacing
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = measure(subview, maxWidth: bounds.width)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + rowGap
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), anchor: .topLeading,
                          proposal: ProposedViewSize(width: size.width, height: size.height))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
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
    var bill: ReceiptBill
    var currency: String
    var openLabel: String = "unassigned"

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
        pill(Money.text(bill.total, currency), symbol: "sum", tint: Palette.ink, strong: true)
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
