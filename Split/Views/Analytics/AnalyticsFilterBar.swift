import SwiftUI

/// Scope, date range and member filters. Chips wrap to a column at large text sizes.
struct AnalyticsFilterBar: View {
    var scope: AnalyticsScope
    @Binding var range: SpendAnalytics.Range
    @Binding var customFrom: Date
    @Binding var customTo: Date
    @Binding var person: String?
    var scopeSelection: Binding<String?>?
    var groups: [ExpenseGroup]

    @Environment(\.dynamicTypeSize) private var typeSize

    private var ranges: [SpendAnalytics.Range] {
        SpendAnalytics.Range.allCases.filter { $0 != .trip || scope.tripRange }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: Spacing.xs) { chips }
            } else {
                ScrollView(.horizontal) {
                    HStack(spacing: Spacing.xs) { chips }
                        .padding(.vertical, 2)
                }
                .scrollIndicators(.hidden)
                .scrollClipDisabled()
            }
            if range == .custom {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: Spacing.m) { fromPicker; toPicker }
                    VStack(alignment: .leading, spacing: Spacing.xs) { fromPicker; toPicker }
                }
                .font(.subheadline)
            }
        }
    }

    @ViewBuilder private var chips: some View {
        if let scopeSelection {
            Menu {
                Picker("Groups", selection: scopeSelection) {
                    Label("All groups", systemImage: "square.stack").tag(String?.none)
                    ForEach(groups) { group in
                        Label(group.name, systemImage: group.symbol).tag(Optional(group.id))
                    }
                }
            } label: {
                FilterChip(title: scope.title, symbol: scope.group?.symbol ?? "square.stack", active: scope.group != nil)
            }
            .accessibilityLabel("Groups, \(scope.title)")
            .accessibilityIdentifier("analytics-scope")
        }
        Menu {
            Picker("Date range", selection: $range) {
                ForEach(ranges) { Text($0.title).tag($0) }
            }
        } label: {
            FilterChip(title: range.title, symbol: "calendar", active: range != .all)
        }
        .accessibilityLabel("Date range, \(range.title)")
        .accessibilityIdentifier("analytics-range")
        Menu {
            Picker("View as", selection: $person) {
                Label("Everyone", systemImage: "person.3").tag(String?.none)
                ForEach(scope.members) { member in
                    Text(member.removed ? "\(member.name) (removed)" : member.name).tag(Optional(member.key))
                }
            }
        } label: {
            FilterChip(title: scope.members.first { $0.key == person }?.name ?? "Everyone", symbol: "person.crop.circle", active: person != nil)
        }
        .accessibilityLabel("View as, \(scope.members.first { $0.key == person }?.name ?? "Everyone")")
        .accessibilityIdentifier("analytics-member")
    }

    private var fromPicker: some View {
        DatePicker("From", selection: $customFrom, displayedComponents: .date)
            .fixedSize()
    }

    private var toPicker: some View {
        DatePicker("To", selection: $customTo, displayedComponents: .date)
            .fixedSize()
    }
}

private struct FilterChip: View {
    var title: String
    var symbol: String
    var active: Bool

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
                .imageScale(.small)
                .accessibilityHidden(true)
            Text(title)
                .lineLimit(1)
            Image(systemName: "chevron.down")
                .font(.caption2.weight(.bold))
                .foregroundStyle(active ? Palette.hero.opacity(0.7) : Color.secondary)
                .accessibilityHidden(true)
        }
        .font(.subheadline.weight(.semibold))
        .padding(.horizontal, 14)
        .frame(minHeight: HitTarget.minimum)
        .foregroundStyle(active ? Palette.hero : Palette.ink)
        .background(active ? Palette.lime : Palette.card, in: Capsule())
        .overlay(Capsule().strokeBorder(active ? Color.clear : Palette.line))
        .contentShape(Capsule())
    }
}
