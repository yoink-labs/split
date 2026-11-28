import SwiftUI
import Charts

/// A donut of category shares with a ranked, tappable list beside it.
struct CategoryBreakdownCard: View {
    var report: SpendAnalytics.Report
    var format: AnalyticsFormat
    var active: String?
    var onSelect: (String) -> Void

    private let innerRadiusRatio = 0.64

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: Spacing.s) {
                SectionHeader(title: "By category", subtitle: AnalyticsFormat.count(report.categories.count, "category", plural: "categories"))
                if report.total > 0 {
                    donut
                        .frame(height: 168)
                        .frame(maxWidth: .infinity)
                }
                VStack(spacing: 2) {
                    ForEach(report.categories) { category in
                        row(category)
                    }
                }
            }
        }
    }

    private var donut: some View {
        let positive = report.categories.filter { $0.amount > 0 }
        return Chart(positive) { category in
            SectorMark(
                angle: .value("Spent", Double(category.amount)),
                innerRadius: .ratio(innerRadiusRatio),
                angularInset: 1.5
            )
            .cornerRadius(3)
            .foregroundStyle(AnalyticsCategory.meta(category.id).tint)
            .opacity(active == nil || active == category.id ? 1 : 0.3)
        }
        .chartAngleSelection(value: Binding<Double?>(
            get: { nil },
            set: { value in
                guard let value else { return }
                var end: Int64 = 0
                for category in positive {
                    end += category.amount
                    if value < Double(end) {
                        onSelect(category.id)
                        return
                    }
                }
            }
        ))
        .chartGesture { proxy in
            SpatialTapGesture()
                .onEnded { tap in
                    let size = proxy.plotSize
                    let radius = min(size.width, size.height) / 2
                    let distance = hypot(tap.location.x - size.width / 2, tap.location.y - size.height / 2)
                    guard distance >= radius * innerRadiusRatio, distance <= radius else { return }
                    proxy.selectAngleValue(at: proxy.angle(at: tap.location))
                }
        }
        .chartBackground { proxy in
            GeometryReader { geometry in
                if let frame = proxy.plotFrame {
                    let rect = geometry[frame]
                    VStack(spacing: 0) {
                        Text(active.map { AnalyticsCategory.meta($0).label } ?? "Total")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Text(format.money(active.flatMap { id in report.categories.first { $0.id == id }?.amount } ?? report.total))
                            .font(.splitAmount(12))
                            .foregroundStyle(Palette.ink)
                            .lineLimit(1)
                            .minimumScaleFactor(0.6)
                    }
                    .frame(width: rect.width * 0.56)
                    .position(x: rect.midX, y: rect.midY)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Category shares")
        .accessibilityValue(report.categories.prefix(6).map { "\(AnalyticsCategory.meta($0.id).label) \($0.percent) percent" }.joined(separator: ", "))
    }

    private func row(_ category: SpendAnalytics.CategoryTotal) -> some View {
        let meta = AnalyticsCategory.meta(category.id)
        let fraction = Double(category.amount) / Double(Swift.max(1, report.categories.first?.amount ?? 1))
        let selected = active == category.id
        return Button { onSelect(category.id) } label: {
            HStack(spacing: Spacing.s) {
                Image(systemName: meta.symbol)
                    .font(.system(size: 13, weight: .semibold))
                    .frame(width: 30, height: 30)
                    .foregroundStyle(meta.tint)
                    .background(meta.tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .top, spacing: 6) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(meta.label).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink).lineLimit(2)
                            Text(AnalyticsFormat.count(category.count, "expense")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        .layoutPriority(1)
                        Spacer(minLength: 4)
                        VStack(alignment: .trailing, spacing: 1) {
                            Text(format.money(category.amount)).font(.splitAmount(13)).foregroundStyle(Palette.ink).lineLimit(1).minimumScaleFactor(0.7)
                            Text("\(category.percent)%").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                        }
                    }
                    ProportionBar(fraction: fraction, tint: meta.tint)
                }
            }
            .padding(.vertical, 7)
            .padding(.horizontal, 8)
            .background(selected ? meta.tint.opacity(0.10) : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(meta.label)
        .accessibilityValue("\(format.money(category.amount)), \(category.percent) percent, \(AnalyticsFormat.count(category.count, "expense"))")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityHint(selected ? "Clears the category filter" : "Lists these expenses")
    }
}

/// A thin horizontal bar for a share of the largest value.
struct ProportionBar: View {
    var fraction: Double
    var tint: Color
    var height: CGFloat = 6

    var body: some View {
        Capsule()
            .fill(Palette.raised)
            .frame(height: height)
            .overlay(alignment: .leading) {
                GeometryReader { proxy in
                    Capsule()
                        .fill(tint)
                        .frame(width: fraction > 0 ? Swift.max(height, proxy.size.width * Swift.min(1, fraction)) : 0)
                }
            }
            .accessibilityHidden(true)
    }
}
