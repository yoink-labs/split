import SwiftUI

struct RootView: View {
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var store: ExpenseStore
    @State private var showInvite = false
    var body: some View {
        Group {
            if session.loading {
                ProgressView("Opening Split…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(AppBackground())
            } else if session.userID == nil {
                WelcomeView()
            } else {
                MainView()
            }
        }
        .onChange(of: store.pendingInvite) { _, token in showInvite = token != nil && session.userID != nil && !session.isDemo }
        .onChange(of: session.userID) { _, id in showInvite = store.pendingInvite != nil && id != nil && !session.isDemo }
        .alert("Join your group", isPresented: $showInvite) {
            Button("Join") { Task { await store.join() } }
            Button("Not now", role: .cancel) { store.pendingInvite = nil }
        } message: {
            Text("Accept this invitation to share expenses with the group. Only accept links from someone you know.")
        }
    }
}

struct WelcomeView: View {
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var store: ExpenseStore
    @Environment(\.horizontalSizeClass) private var size
    @State private var emailSheet = false

    var body: some View {
        ScrollView {
            Group {
                if size == .regular {
                    VStack(alignment: .leading, spacing: 24) {
                        brand
                        HStack(alignment: .top, spacing: 28) {
                            hero
                            VStack(alignment: .leading, spacing: 18) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Get started").font(.title3.weight(.semibold)).foregroundStyle(Palette.ink)
                                    Text("Sign in with your Yoink account, or look around with sample data first.")
                                        .font(.caption).foregroundStyle(.secondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                signIn
                                Spacer(minLength: 0)
                                freeNote
                            }
                            .padding(20)
                            .frame(maxWidth: 380, maxHeight: .infinity, alignment: .topLeading)
                            .glassSurface(cornerRadius: 24, tint: Palette.card.opacity(0.5))
                        }
                        .fixedSize(horizontal: false, vertical: true)
                        features
                        footer
                    }
                    .frame(maxWidth: 920)
                } else {
                    VStack(alignment: .leading, spacing: 26) {
                        brand
                        hero
                        signIn
                        freeNote
                        features
                        footer
                    }
                    .frame(maxWidth: 560)
                }
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 28)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .background(AppBackground())
        .sheet(isPresented: $emailSheet) { EmailView() }
    }

    private var brand: some View {
        HStack(spacing: 10) {
            Image("SplitLogo")
                .resizable()
                .frame(width: 44, height: 44)
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                .accessibilityLabel("Split logo")
            Text("split")
                .font(.splitDisplay(31))
                .foregroundStyle(Palette.evergreen)
            Spacer()
            Text("BY YOINK LABS")
                .font(.system(size: 10, weight: .semibold))
                .tracking(1.6)
                .foregroundStyle(.secondary)
        }
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Shared expenses,\nwithout the invoice.")
                    .font(.splitDisplay(38))
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Track who paid, who owes, and who is square. Every Splitwise feature you use — free, with no ads and no Pro tier.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            miniLedger
        }
    }

    private var miniLedger: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Buenos Aires")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.lime)
                Spacer()
                Text("4 people · ARS")
                    .font(.caption)
                    .foregroundStyle(Palette.lime.opacity(0.60))
            }
            HStack(alignment: .firstTextBaseline) {
                Text("ARS 52,000.00")
                    .font(.splitAmount(26))
                    .foregroundStyle(Palette.lime)
                    .lineLimit(1)
                    .minimumScaleFactor(0.55)
                Text("you’re owed")
                    .font(.caption)
                    .foregroundStyle(Palette.lime.opacity(0.65))
                Spacer()
            }
            HStack(spacing: 8) {
                ForEach(["Maya", "Jules", "Harris"], id: \.self) { name in
                    HStack(spacing: 6) {
                        Avatar(name: name, size: 24, tint: Palette.lime)
                        Text(name)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(Palette.lime.opacity(0.85))
                            .lineLimit(1)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(Palette.lime.opacity(0.12))
                    .clipShape(Capsule())
                }
                Spacer()
            }
        }
        .padding(18)
        .background(Palette.hero)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(Palette.lime.opacity(0.18), lineWidth: 1))
    }

    private var signIn: some View {
        VStack(spacing: 12) {
            if let error = session.error { InlineError(text: error) }
            if store.pendingInvite != nil {
                Label("Your invitation is ready. Sign in to join.", systemImage: "link")
                    .font(.subheadline)
                    .foregroundStyle(Palette.evergreen)
            }
            Button { Task { await session.social(apple: true) } } label: {
                Label("Continue with Apple", systemImage: "apple.logo")
            }
            .buttonStyle(SolidButton())
            Button { Task { await session.social(apple: false) } } label: {
                HStack(spacing: 10) {
                    Text("G").font(.headline.weight(.bold))
                    Text("Continue with Google").font(.headline)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .frame(minHeight: 48)
                .background(Palette.card)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Palette.line, lineWidth: 1))
            }
            .foregroundStyle(Palette.ink)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { emailButton; demoButton }
                VStack(spacing: 8) { emailButton; demoButton }
            }
            if session.working { ProgressView() }
        }
        .disabled(session.working)
    }

    private var emailButton: some View {
        Button {
            session.error = nil; session.awaitingCode = false; emailSheet = true
        } label: {
            Label("Email", systemImage: "envelope")
                .lineLimit(1)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(GhostButton())
        .accessibilityLabel("Continue with email")
    }

    private var demoButton: some View {
        Button { session.demo() } label: {
            Label("Look around", systemImage: "sparkles")
                .lineLimit(1)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(GhostButton())
        .accessibilityLabel("Take a look around")
    }

    private var features: some View {
        Card {
            VStack(alignment: .leading, spacing: 16) {
                Text("What you get")
                    .font(.headline)
                    .foregroundStyle(Palette.ink)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: 18, alignment: .leading)], alignment: .leading, spacing: 16) {
                    feature("person.3", "Groups and one-to-one tabs", "Trips, homes, couples and roommates — all in one ledger.")
                    feature("receipt", "Receipts, notes and comments", "Split items, claims and the story behind each expense.")
                    feature("chart.bar.xaxis", "Insights and search", "The features other apps charge for are simply here.")
                    feature("arrow.left.arrow.right", "Settle in any currency", "Historical rates, manual rates and payment links.")
                }
            }
        }
    }

    private var freeNote: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "heart.fill")
                .font(.system(size: 15, weight: .semibold))
                .frame(width: 34, height: 34)
                .background(Palette.lime.opacity(0.45))
                .foregroundStyle(Palette.ink)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text("Free. Every feature.")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                Text("No ads, no Pro tier, no card. Split is free because the ledger should be.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(Palette.mint.opacity(0.45), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private func feature(_ symbol: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .semibold))
                .frame(width: 34, height: 34)
                .background(Palette.lime.opacity(0.40))
                .foregroundStyle(Palette.ink)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    private var footer: some View {
        VStack(spacing: 10) {
            Text("One Yoink account. Here, Wanderer, and beyond.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Text("Split does not move money. It keeps the record straight.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
    }
}

struct EmailView: View {
    @EnvironmentObject var session: SessionStore
    @Environment(\.dismiss) var dismiss
    @State private var email = ""
    @State private var password = ""
    @State private var code = ""
    @State private var create = false
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(session.awaitingCode ? "Check your inbox" : "Your Yoink account").font(.title2.bold())
                    Text(session.awaitingCode ? "Enter the six-digit code we emailed you." : "Sign in with a code. The same account works across Yoink Labs.")
                        .foregroundStyle(.secondary)
                }
                if session.awaitingCode {
                    Section {
                        TextField("Six-digit code", text: $code)
                            .keyboardType(.numberPad)
                            .textContentType(.oneTimeCode)
                            .accessibilityIdentifier("email-code")
                        Button("Verify code") { Task { await session.verify(code) } }.disabled(code.count != 6)
                        Button("Send a new code") { Task { await session.resend() } }
                    }
                } else {
                    Section {
                        Picker("Account", selection: $create) {
                            Text("Sign in").tag(false)
                            Text("Sign up").tag(true)
                        }.pickerStyle(.segmented)
                        TextField("Email address", text: $email)
                            .accessibilityIdentifier("signup-email")
                            .textContentType(.emailAddress)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        if create {
                            SecureField("Password · 15+ characters", text: $password)
                                .accessibilityIdentifier("signup-password")
                                .textContentType(.newPassword)
                            Text("Your Yoink account needs a password at signup. Next time, just use an email code.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Button("Email me a code") { Task { await session.sendCode(email: email, password: password, create: create) } }
                            .disabled(!email.contains("@") || (create && password.count < 15))
                    }
                }
                if session.working { ProgressView() }
                if let error = session.error { Section { InlineError(text: error) } }
            }
            .scrollContentBackground(.hidden)
            .background(AppBackground())
            .disabled(session.working)
            .navigationTitle("Email")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .onChange(of: session.userID) { _, id in if id != nil { dismiss() } }
        }
    }
}
