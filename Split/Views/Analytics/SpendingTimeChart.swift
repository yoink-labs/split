import SwiftUI
import Charts

/// Spending per day, week or month, stacked by the six largest categories.
/// Tap a bar (or pick it with VoiceOver) to list its expenses.
struct SpendingTimeChart: View {
    var report: SpendAnalytics.Report
    var format: AnalyticsFormat
    @Binding var grain: SpendAnalytics.Granularity?
    var active: String?
    var onSelect: (String) -> Void

    @State private var scrubbing: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let stackLimit = 6
    private static let scrollThreshold = 31

    private struct Segment: Identifiable {
        var bucket: String
        var category: String
        var amount: Int64
        var id: String { bucket + "|" + category }
    }

    private var stackIDs: [String] { report.categories.prefix(Self.stackLimit).map(\.id) }

    private var segments: [Segment] {
        let stacked = Set(stackIDs)
        let order = stackIDs + [AnalyticsCategory.otherStack.id]
        return report.buckets.flatMap { bucket -> [Segment] in
            var parts: [String: Int64] = [:]
            for (id, amount) in bucket.parts { parts[stacked.contains(id) ? id : AnalyticsCategory.otherStack.id, default: 0] += amount }
            return order.compactMap { id in parts[id].map { Segment(bucket: bucket.key, category: id, amount: $0) } }
        }
    }

    private var legend: [AnalyticsCategory] {
        stackIDs.map(AnalyticsCategory.meta) + (report.categories.count > Self.stackLimit ? [AnalyticsCategory.otherStack] : [])
    }

    private var focus: SpendAnalytics.Bucket? {
        guard let key = scrubbing ?? active else { return nil }
        return report.buckets.first { $0.key == key }
    }

    private var labelStride: Int { Swift.max(1, Int((Double(report.buckets.count) / (scrolls ? 31 : 6)).rounded(.up))) }
    private var scrolls: Bool { report.buckets.count > Self.scrollThreshold }

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: Spacing.s) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top) { titleBlock; Spacer(minLength: Spacing.s); grainPicker.fixedSize() }
                    VStack(alignment: .leading, spacing: Spacing.s) { titleBlock; grainPicker }
                }
                chart
                    .frame(height: 220)
                legendView
            }
        }
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Spending over time").font(.headline).foregroundStyle(Palette.ink)
            Text(readout)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .contentTransition(.numericText())
                .accessibilityAddTraits(.updatesFrequently)
        }
    }

    private var readout: String {
        if let focus {
            return "\(AnalyticsFormat.bucket(focus.key, report.granularity, long: true)) · \(format.money(focus.amount)) · \(AnalyticsFormat.count(focus.count, "expense"))"
        }
        if let busiest = report.busiest {
            return "Busiest \(report.granularity.noun): \(AnalyticsFormat.bucket(busiest.key, report.granularity, long: true)) · \(format.money(busiest.amount))"
        }
        return "No priced expenses in range"
    }

    private var grainPicker: some View {
        Picker("Group by", selection: $grain) {
            Text("Auto").tag(SpendAnalytics.Granularity?.none)
            ForEach(SpendAnalytics.Granularity.allCases) { Text($0.rawValue.capitalized).tag(Optional($0)) }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("analytics-grain")
    }

    private var chart: some View {
        let mean = report.bucketMean
        let keys = report.buckets.map(\.key)
        let labelled = Set(keys.enumerated().filter { $0.offset % labelStride == 0 }.map(\.element))
        return Chart {
            ForEach(segments) { segment in
                BarMark(
                    x: .value("Period", segment.bucket),
                    y: .value("Spent", Double(segment.amount) / 100)
                )
                .foregroundStyle(AnalyticsCategory.meta(segment.category).tint)
                .opacity(active == nil || active == segment.bucket ? 1 : 0.28)
                .cornerRadius(2)
            }
            if mean > 0 {
                RuleMark(y: .value("Average", Double(mean) / 100))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    .foregroundStyle(Palette.ink.opacity(0.45))
                    .annotation(position: .top, alignment: .trailing, spacing: 2) {
                        Text("avg \(format.money(mean))")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 4)
                            .background(Palette.card.opacity(0.85), in: Capsule())
                    }
            }
            if let scrubbing {
                RuleMark(x: .value("Period", scrubbing))
                    .foregroundStyle(Palette.ink.opacity(0.18))
                    .lineStyle(StrokeStyle(lineWidth: 1))
            }
        }
        .chartXScale(domain: keys)
        .chartXAxis {
            AxisMarks(values: keys.filter { labelled.contains($0) }) { value in
                AxisValueLabel(collisionResolution: .greedy) {
                    if let key = value.as(String.self) {
                        Text(AnalyticsFormat.bucket(key, report.granularity)).font(.caption2)
                    }
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
                AxisGridLine().foregroundStyle(Palette.line)
                AxisValueLabel {
                    if let amount = value.as(Double.self) { Text(AnalyticsFormat.axis(Int64((amount * 100).rounded()))).font(.caption2) }
                }
            }
        }
        .chartScrollableAxes(scrolls ? .horizontal : [])
        .chartXVisibleDomain(length: scrolls ? Self.scrollThreshold : Swift.max(1, keys.count))
        .chartScrollPosition(initialX: keys.last.map { _ in keys[Swift.max(0, keys.count - Self.scrollThreshold)] } ?? "")
        .chartXSelection(value: $scrubbing)
        .chartOverlay { proxy in
            GeometryReader { geometry in
                Rectangle()
                    .fill(.clear)
                    .contentShape(Rectangle())
                    .onTapGesture { location in
                        guard let frame = proxy.plotFrame else { return }
                        let x = location.x - geometry[frame].origin.x
                        guard let key: String = proxy.value(atX: x),
                              let bucket = report.buckets.first(where: { $0.key == key }), bucket.count > 0 else { return }
                        onSelect(key)
                    }
            }
        }
        .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: report.buckets)
        .accessibilityRepresentation {
            VStack {
                ForEach(report.buckets.filter { $0.count > 0 }) { bucket in
                    Button {
                        onSelect(bucket.key)
                    } label: {
                        Text(AnalyticsFormat.bucket(bucket.key, report.granularity, long: true))
                    }
                    .accessibilityValue("\(format.money(bucket.amount)), \(AnalyticsFormat.count(bucket.count, "expense"))")
                    .accessibilityAddTraits(active == bucket.key ? .isSelected : [])
                    .accessibilityHint("Lists these expenses")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Spending over time by \(report.granularity.noun)")
        }
    }

    private var legendView: some View {
        FlowLegend(items: legend)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Colors: " + legend.map(\.label).joined(separator: ", "))
    }
}

/// Category swatches that wrap onto as many lines as they need.
struct FlowLegend: View {
    var items: [AnalyticsCategory]

    var body: some View {
        LegendLayout(spacing: 12, lineSpacing: 6) {
            ForEach(items) { item in
                HStack(spacing: 5) {
                    RoundedRectangle(cornerRadius: 2).fill(item.tint).frame(width: 9, height: 9)
                    Text(item.label).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// A minimal wrapping layout for legends.
struct LegendLayout: Layout {
    var spacing: CGFloat
    var lineSpacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width { y += line + lineSpacing; x = 0; line = 0 }
            x += size.width + spacing
            widest = Swift.max(widest, x - spacing)
            line = Swift.max(line, size.height)
        }
        return CGSize(width: proposal.width ?? widest, height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX { y += line + lineSpacing; x = bounds.minX; line = 0 }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = Swift.max(line, size.height)
        }
    }
}
