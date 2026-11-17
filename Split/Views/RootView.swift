import SwiftUI
struct RootView: View {
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var store: ExpenseStore
    @State private var showInvite = false
    var body: some View {
        Group {
            if session.loading { ProgressView("Opening Split…").frame(maxWidth:.infinity,maxHeight:.infinity).background(Palette.background) }
            else if session.userID == nil { WelcomeView() }
            else { MainView() }
        }
        .onChange(of: store.pendingInvite) { _, token in showInvite = token != nil && session.userID != nil && !session.isDemo }
        .onChange(of: session.userID) { _, id in showInvite = store.pendingInvite != nil && id != nil && !session.isDemo }
        .alert("Join your group", isPresented: $showInvite) {
            Button("Join") { Task { await store.join() } }
            Button("Not now",role:.cancel) { store.pendingInvite=nil }
        } message: { Text("Accept this invitation to share expenses with the group. Only accept links from someone you know.") }
    }
}
struct WelcomeView: View {
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var store: ExpenseStore
    @State private var emailSheet = false
    var body: some View {
        ScrollView {
            VStack(alignment:.leading,spacing:28) {
                HStack(spacing:9) { Image("SplitLogo").resizable().frame(width:42,height:42).clipShape(RoundedRectangle(cornerRadius:11)).accessibilityLabel("Split logo"); Text("split").font(.system(size:32,weight:.bold,design:.rounded)); Spacer(); Text("BY YOINK LABS").font(.system(size:10,weight:.semibold)).tracking(2) }.foregroundStyle(Palette.green).padding(.top,28)
                VStack(alignment:.leading,spacing:14) {
                    Text("Share expenses").font(.largeTitle.bold())
                    Text("Keep track of who paid and what everyone owes.").foregroundStyle(.secondary)
                }.padding(.vertical,16)
                VStack(spacing:12) {
                    if let error = session.error { ErrorText(text:error) }
                    if store.pendingInvite != nil { Text("Your invitation is ready. Sign in to join.").font(.subheadline).foregroundStyle(Palette.green) }
                    Button { Task { await session.social(apple:true) } } label: { Label("Continue with Apple",systemImage:"apple.logo") }.buttonStyle(SolidButton())
                    Button { Task { await session.social(apple:false) } } label: { HStack { Text("G").font(.headline.weight(.bold)); Text("Continue with Google").font(.headline) }.frame(maxWidth:.infinity).padding(18).background(Palette.card).clipShape(RoundedRectangle(cornerRadius:18)).overlay(RoundedRectangle(cornerRadius:18).stroke(.secondary.opacity(0.18))) }.foregroundStyle(.primary)
                    Button("Continue with email") { session.error=nil; session.awaitingCode=false; emailSheet=true }.font(.subheadline.weight(.semibold)).padding(6)
                    if session.working { ProgressView() }
                }.disabled(session.working)
                VStack(spacing:12) {
                    Text("One Yoink account. Here, Wanderer, and beyond.").font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Take a look around") { session.demo() }.font(.subheadline.weight(.medium))

                }.frame(maxWidth:.infinity)
            }.padding(24).frame(maxWidth:560)
        }.frame(maxWidth:.infinity).background(Palette.background).sheet(isPresented:$emailSheet) { EmailView() }
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
                Section { Text(session.awaitingCode ? "Check your inbox" : "Your Yoink account").font(.title2.bold()); Text(session.awaitingCode ? "Enter the six-digit code we emailed you." : "Sign in with a code. The same account works across Yoink Labs.").foregroundStyle(.secondary) }
                if session.awaitingCode {
                    Section { TextField("Six-digit code",text:$code).keyboardType(.numberPad).textContentType(.oneTimeCode).accessibilityIdentifier("email-code"); Button("Verify code") { Task { await session.verify(code) } }.disabled(code.count != 6); Button("Send a new code") { Task { await session.resend() } } }
                } else {
                    Section { Picker("Account",selection:$create) { Text("Sign in").tag(false); Text("Sign up").tag(true) }.pickerStyle(.segmented); TextField("Email address",text:$email).accessibilityIdentifier("signup-email").textContentType(.emailAddress).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                        if create { SecureField("Password · 15+ characters",text:$password).accessibilityIdentifier("signup-password").textContentType(.newPassword); Text("Your Yoink account needs a password at signup. Next time, just use an email code.").font(.caption).foregroundStyle(.secondary) }
                        Button("Email me a code") { Task { await session.sendCode(email:email,password:password,create:create) } }.disabled(!email.contains("@") || (create && password.count < 15))
                    }
                }
                if session.working { ProgressView() }
                if let error = session.error { Section { ErrorText(text:error) } }
            }.disabled(session.working).navigationTitle("Email").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement:.cancellationAction) { Button("Close") { dismiss() } } }.onChange(of:session.userID) { _,id in if id != nil { dismiss() } }
        }
    }
}
