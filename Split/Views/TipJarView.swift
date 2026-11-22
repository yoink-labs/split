import StoreKit
import SwiftUI

/// The pink "Tip the devs" capsule. Every entry point opens the same sheet.
struct TipTheDevsButton: View {
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: "heart.fill")
                    .font(.caption.weight(.bold))
                Text("Tip the devs")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(Color.pink, in: Capsule())
            .fixedSize()
            .frame(minHeight: HitTarget.minimum)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Tip the devs")
        .accessibilityHint("Opens the optional tip jar")
        .accessibilityIdentifier("tip-the-devs")
    }
}

/// Puts the capsule in a navigation bar without the shared glass platter, so
/// it reads as one pink pill on iOS 26 and later.
struct TipTheDevsToolbarItem: ToolbarContent {
    var placement: ToolbarItemPlacement = .topBarLeading
    var action: () -> Void

    var body: some ToolbarContent {
        if #available(iOS 26.0, *) {
            ToolbarItem(placement: placement) { TipTheDevsButton(action: action) }
                .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: placement) { TipTheDevsButton(action: action) }
        }
    }
}

/// "Tip the devs": an optional tip. Nothing in Split depends on it.
struct TipJarView: View {
    @ObservedObject var store: TipJarStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isTestPurchase = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: Spacing.l) {
                    header
                    statusCard
                    tipsSection
                    if store.showsWebTipLink { webTipLink }
                    footnote
                }
                .padding(.horizontal, Spacing.page)
                .padding(.top, Spacing.xs)
                .padding(.bottom, Spacing.xl)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
                .animation(reduceMotion ? nil : .snappy, value: store.purchaseState)
                .animation(reduceMotion ? nil : .snappy, value: store.loadState)
            }
            .background(AppBackground())
            .navigationTitle("Tip the devs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                        .accessibilityIdentifier("tip-jar-close")
                }
            }
            .sensoryFeedback(.success, trigger: store.thanksCount)
            .onChange(of: store.purchaseState) { _, state in announce(state) }
            .task {
                if store.loadState != .loaded {
                    await store.load()
                } else {
                    await store.refreshStorefront()
                }
            }
            .task { isTestPurchase = await Self.isTestEnvironment() }
            .refreshable { await store.load() }
        }
        .accessibilityIdentifier("tip-jar")
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            Image(systemName: "heart.fill")
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: HitTarget.button, height: HitTarget.button)
                .background(Color.pink, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .accessibilityHidden(true)

            Text("Tip the devs")
                .font(.splitDisplay(26))
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)

            Text("Split is free with nothing locked. Tips are optional and unlock nothing.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Spacing.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSurface(cornerRadius: Radius.card, tint: Palette.card.opacity(0.52))
    }

    // MARK: - Status

    @ViewBuilder
    private var statusCard: some View {
        switch store.purchaseState {
        case .idle, .purchasing:
            EmptyView()
        case .thanks(let tier):
            TipStatusBanner(
                icon: "heart.circle.fill",
                tint: .pink,
                title: "Thank you!",
                message: thanksMessage(for: tier),
                actionTitle: "Done",
                action: store.dismissStatus
            )
            .accessibilityIdentifier("tip-jar-thanks")
            .transition(.opacity.combined(with: .move(edge: .top)))
        case .pending:
            TipStatusBanner(
                icon: "hourglass.circle.fill",
                tint: Palette.sky,
                title: "Waiting for approval",
                message: "Your tip will go through once it's approved, for example by a family organiser. You can close this screen.",
                actionTitle: "OK",
                action: store.dismissStatus
            )
            .accessibilityIdentifier("tip-jar-pending")
            .transition(.opacity.combined(with: .move(edge: .top)))
        case .failed(let message):
            TipStatusBanner(
                icon: "exclamationmark.triangle.fill",
                tint: Palette.coral,
                title: "The tip didn't go through",
                message: message,
                actionTitle: "Dismiss",
                action: store.dismissStatus
            )
            .accessibilityIdentifier("tip-jar-failed")
            .transition(.opacity.combined(with: .move(edge: .top)))
        }
    }

    private func thanksMessage(for tier: TipTier) -> String {
        let name = store.products.first(where: { $0.tier == tier })?.title.lowercased() ?? "tip"
        return "Your \(name) means a lot. Thanks for helping keep Split going."
    }

    // MARK: - Tips

    @ViewBuilder
    private var tipsSection: some View {
        switch store.loadState {
        case .idle, .loading where store.products.isEmpty:
            loadingRows
        case .unavailable:
            retryCard(
                title: "Tips aren't available yet",
                message: "The App Store didn't return any tips for your region. Split works the same either way."
            )
        case .failed(let message):
            retryCard(title: "Couldn't load tips", message: message)
        default:
            productRows
        }
    }

    private var productRows: some View {
        Card(padding: 0) {
            VStack(spacing: 0) {
                if !store.canMakePayments {
                    paymentsDisabledNote
                    Divider().overlay(Palette.line)
                }
                ForEach(Array(store.products.enumerated()), id: \.element.id) { index, product in
                    if index > 0 {
                        Divider()
                            .overlay(Palette.line)
                            .padding(.leading, dynamicTypeSize.isAccessibilitySize ? Spacing.m : 70)
                    }
                    TipRow(
                        product: product,
                        isPurchasing: store.purchaseState == .purchasing(product.tier),
                        isEnabled: store.canMakePayments && !store.isPurchasing
                    ) {
                        Task { await store.purchase(product) }
                    }
                }
            }
        }
    }

    private func retryCard(title: String, message: String) -> some View {
        Card {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(Palette.ink)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Try again") { Task { await store.load() } }
                    .buttonStyle(.splitSecondary)
                    .padding(.top, Spacing.xxs)
            }
        }
        .accessibilityIdentifier("tip-jar-unavailable")
    }

    /// US storefront only (see `WebTipLink`). Opens Safari, not an in-app
    /// web view.
    private var webTipLink: some View {
        Button {
            openURL(WebTipLink.url)
        } label: {
            HStack(alignment: .top, spacing: Spacing.s) {
                Image(systemName: "arrow.up.right.square")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.pink)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text("Want to give more?")
                        .font(.headline)
                        .foregroundStyle(Palette.ink)
                    Text("Tip any amount at yoinklabs.dev. Opens in Safari.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(Spacing.m)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .glassSurface(cornerRadius: Radius.card, tint: Palette.card.opacity(0.52))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Want to give more? Tip any amount at yoinklabs.dev")
        .accessibilityHint("Opens yoinklabs.dev in Safari")
        .accessibilityAddTraits(.isLink)
        .accessibilityIdentifier("tip-jar-web-link")
    }

    private var paymentsDisabledNote: some View {
        HStack(alignment: .top, spacing: Spacing.s) {
            Image(systemName: "lock.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text("In-app purchases are turned off on this device, so tips can't be sent from here.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(Spacing.m)
        .accessibilityElement(children: .combine)
    }

    private var loadingRows: some View {
        Card(padding: 0) {
            VStack(spacing: 0) {
                ForEach(TipTier.allCases) { _ in
                    HStack(spacing: Spacing.s) {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(Palette.raised)
                            .frame(width: HitTarget.minimum, height: HitTarget.minimum)
                        VStack(alignment: .leading, spacing: Spacing.xxs) {
                            Capsule().fill(Palette.raised).frame(width: 120, height: 14)
                            Capsule().fill(Palette.raised).frame(height: 11)
                        }
                        Spacer()
                        Capsule().fill(Palette.raised).frame(width: 72, height: HitTarget.minimum)
                    }
                    .padding(Spacing.m)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading tips")
    }

    private var footnote: some View {
        VStack(spacing: Spacing.xs) {
            Text("Tips are one-time payments handled by the App Store. They don't renew, and you can tip again any time.")
            if isTestPurchase {
                Text("Tips go live when Split reaches the App Store. In TestFlight betas, Apple runs test purchases, so you won't be charged.")
                    .accessibilityIdentifier("tip-jar-test-note")
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Spacing.xs)
    }

    private func announce(_ state: TipJarStore.PurchaseState) {
        let message: String
        switch state {
        case .thanks: message = "Tip sent. Thank you!"
        case .pending: message = "Tip waiting for approval"
        case .failed(let detail): message = "The tip didn't go through. \(detail)"
        case .idle, .purchasing: return
        }
        AccessibilityNotification.Announcement(message).post()
    }

    /// TestFlight, Xcode and the debug config client never charge anyone, so
    /// say so instead of implying a real payment.
    private static func isTestEnvironment() async -> Bool {
        #if DEBUG
        if TipJarLaunch.value("uiTipJar") == "config" { return true }
        #endif
        guard let result = try? await AppTransaction.shared else { return false }
        switch result {
        case .verified(let transaction), .unverified(let transaction, _):
            return transaction.environment != .production
        }
    }
}

/// One tip: icon, the App Store's name and description, and its price.
private struct TipRow: View {
    let product: TipProduct
    let isPurchasing: Bool
    let isEnabled: Bool
    let action: () -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Button(action: action) {
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.s))
                : AnyLayout(HStackLayout(spacing: Spacing.s))
            layout {
                if !dynamicTypeSize.isAccessibilitySize {
                    icon
                }
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(product.title)
                        .font(.headline)
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    if !product.description.isEmpty {
                        Text(product.description)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                priceTag
            }
            .padding(.horizontal, Spacing.m)
            .padding(.vertical, Spacing.s)
            .frame(minHeight: 68)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .opacity(isEnabled || isPurchasing ? 1 : 0.55)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(product.title), \(product.displayPrice)")
        .accessibilityValue(isPurchasing ? "Purchasing" : "")
        .accessibilityHint(product.description)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("tip-jar-\(product.tier.rawValue)")
    }

    private var icon: some View {
        Image(systemName: product.tier.symbol)
            .font(.body.weight(.semibold))
            .foregroundStyle(.pink)
            .frame(width: HitTarget.minimum, height: HitTarget.minimum)
            .background(Color.pink.opacity(0.14), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .accessibilityHidden(true)
    }

    private var priceTag: some View {
        ZStack {
            Text(product.displayPrice)
                .font(.headline)
                .monospacedDigit()
                .fixedSize(horizontal: false, vertical: true)
                .opacity(isPurchasing ? 0 : 1)
            if isPurchasing {
                ProgressView().tint(Palette.paper)
            }
        }
        .foregroundStyle(Palette.paper)
        .padding(.horizontal, Spacing.m)
        .padding(.vertical, Spacing.xs)
        .frame(minWidth: HitTarget.minimum, minHeight: HitTarget.minimum)
        .background(Palette.evergreen, in: Capsule())
    }
}

/// Inline outcome of the last tip attempt.
private struct TipStatusBanner: View {
    let icon: String
    let tint: Color
    let title: String
    let message: String
    let actionTitle: String
    let action: () -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.s))
                : AnyLayout(HStackLayout(alignment: .top, spacing: Spacing.s))
            layout {
                Image(systemName: icon)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(tint)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(title)
                        .font(.headline)
                        .foregroundStyle(Palette.ink)
                    Text(message)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 0) }
            }
            Button(actionTitle, action: action)
                .buttonStyle(.splitPrimary)
        }
        .padding(Spacing.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSurface(cornerRadius: Radius.card, tint: Palette.card.opacity(0.52))
    }
}

#Preview("Tip jar") {
    TipJarView(store: .shared)
}
