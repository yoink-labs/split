import SwiftUI
import ClerkKit
import AuthenticationServices

@MainActor final class SessionStore: ObservableObject {
    @Published var userID: String?
    @Published var displayName = "You"
    @Published var loading = true
    @Published var working = false
    @Published var error: String?
    @Published var awaitingCode = false
    @Published var isCreating = false
    @Published var isDemo = false
    private var email = ""
    func restore() async {
        for _ in 0..<60 { if Clerk.shared.isLoaded { break }; try? await Task.sleep(for: .milliseconds(100)) }
        #if DEBUG
        // A genuine Clerk sign-in token for an isolated QA user. No API auth bypass.
        // File lives in the lane, never in source or in the released app bundle.
        let args = ProcessInfo.processInfo.arguments
        if let index = args.firstIndex(of: "-splitQATicketFile"), args.indices.contains(index + 1) {
            do {
                let url = URL(fileURLWithPath: args[index + 1])
                let ticket = try String(contentsOf: url, encoding: .utf8)
                if Clerk.shared.session != nil { try await Clerk.shared.auth.signOut() }
                let flow = try await Clerk.shared.auth.signInWithTicket(ticket)
                guard let id = flow.createdSessionId else { throw LedgerError.invalid("QA sign-in requires another step.") }
                try await Clerk.shared.auth.setActive(sessionId: id)
            } catch { self.error = "QA sign-in failed: " + error.localizedDescription }
        }
        #endif
        applyUser(); loading = false
    }
    private func applyUser() {
        userID = Clerk.shared.user?.id
        displayName = Clerk.shared.user?.firstName ?? Clerk.shared.user?.primaryEmailAddress?.emailAddress.components(separatedBy: "@").first ?? "You"
    }
    func social(apple: Bool) async {
        guard !working else { return }; working = true; error = nil
        defer { working = false }
        do {
            let result = apple ? try await Clerk.shared.auth.signInWithApple() : try await Clerk.shared.auth.signInWithOAuth(provider: .google)
            let id: String?
            switch result { case .signIn(let flow): id = flow.createdSessionId; case .signUp(let flow): id = flow.createdSessionId }
            if let id { try await Clerk.shared.auth.setActive(sessionId: id) }
            applyUser()
            if userID == nil { error = "Sign-in needs another step. Try email, or finish setting up your Yoink account on yoinklabs.dev." }
        } catch {
            let ns = error as NSError
            if !((ns.domain == ASAuthorizationError.errorDomain && ns.code == ASAuthorizationError.canceled.rawValue) || (ns.domain == ASWebAuthenticationSessionError.errorDomain && ns.code == ASWebAuthenticationSessionError.canceledLogin.rawValue)) { self.error = error.localizedDescription }
        }
    }
    func sendCode(email: String, password: String, create: Bool) async {
        guard !working else { return }; working = true; error = nil
        defer { working = false }
        do {
            self.email = email.trimmingCharacters(in: .whitespacesAndNewlines)
            isCreating = create
            if create { let flow = try await Clerk.shared.auth.signUp(emailAddress: self.email, password: password); _ = try await flow.sendEmailCode() }
            else { _ = try await Clerk.shared.auth.signInWithEmailCode(emailAddress: self.email) }
            awaitingCode = true
        } catch { self.error = error.localizedDescription }
    }
    func verify(_ code: String) async {
        guard !working else { return }; working = true; error = nil
        defer { working = false }
        do {
            let id: String?
            if isCreating, let flow = Clerk.shared.client?.signUp { id = try await flow.verifyEmailCode(code).createdSessionId }
            else if let flow = Clerk.shared.client?.signIn { id = try await flow.verifyCode(code).createdSessionId }
            else { throw LedgerError.invalid("Request a new code to continue.") }
            guard let id else { throw LedgerError.invalid("There’s another account step to finish. Please visit yoinklabs.dev, then sign in here.") }
            try await Clerk.shared.auth.setActive(sessionId: id); applyUser(); awaitingCode = false
        } catch { self.error = error.localizedDescription }
    }
    func resend() async {
        guard !working else { return }; working = true; error = nil; defer { working = false }
        do {
            if isCreating, let flow = Clerk.shared.client?.signUp { _ = try await flow.sendEmailCode() }
            else { _ = try await Clerk.shared.auth.signInWithEmailCode(emailAddress: email) }
        } catch { self.error = error.localizedDescription }
    }
    func demo() { isDemo = true; userID = "demo-user"; displayName = "Alex"; error = nil }
    func signOut() async {
        do { if !isDemo { try await Clerk.shared.auth.signOut() }; userID = nil; isDemo = false; awaitingCode = false }
        catch { self.error = error.localizedDescription }
    }
}
