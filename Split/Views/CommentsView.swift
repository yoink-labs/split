import SwiftUI

/// The comment thread for one ledger entry. Works inline in a card or on its own,
/// and in demo mode where the store keeps comments in memory.
struct CommentsView: View {
    var entryID: String
    var compact: Bool = false
    /// Called when the comment field gains focus, so a parent scroll view can
    /// bring the composer above the keyboard.
    var onFocus: (() -> Void)? = nil
    @EnvironmentObject private var store: ExpenseStore
    @FocusState private var fieldFocused: Bool

    @State private var draft = ""
    @State private var loading = false
    @State private var loaded = false
    @State private var sending = false
    @State private var error: String?
    @State private var deleting = Set<String>()

    private var comments: [EntryComment] { store.comments(for: entryID) ?? [] }
    private var storedCount: Int {
        store.state.snapshot.entries.first { $0.id == entryID }?.commentCount ?? 0
    }
    private var totalCount: Int { max(comments.count, storedCount) }
    private var cleanDraft: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSend: Bool { !cleanDraft.isEmpty && cleanDraft.count <= 2000 && !sending }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 10 : 14) {
            header
            content
            if let error {
                InlineError(text: error)
                if !loaded {
                    Button("Try loading comments again") { Task { await load(force: true) } }
                        .buttonStyle(GhostButton())
                        .disabled(loading)
                }
            }
            composer
        }
        .task { await load() }
        .onChange(of: fieldFocused) { _, focused in
            guard focused, let onFocus else { return }
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(350))
                onFocus()
            }
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("Comments").font(.headline).foregroundStyle(Palette.ink)
            if totalCount > 0 {
                Text("\(totalCount)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Palette.raised)
                    .clipShape(Capsule())
            }
            Spacer()
            if loading && !comments.isEmpty {
                ProgressView().controlSize(.small).accessibilityLabel("Refreshing comments")
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if loading && comments.isEmpty {
            HStack(spacing: 10) {
                ProgressView()
                Text("Loading comments…").font(.subheadline).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, compact ? 6 : 10)
        } else if comments.isEmpty {
            if error == nil || loaded {
                if compact {
                    Text("No comments yet. Start the conversation.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 4)
                } else {
                    EmptyPanel(
                        title: "No comments yet",
                        message: "Say something useful, funny, or appreciative. Everyone in the group can read it.",
                        symbol: "bubble.left"
                    )
                }
            }
        } else {
            VStack(spacing: 0) {
                ForEach(Array(comments.indices), id: \.self) { index in
                    if index > 0 {
                        Rectangle().fill(Palette.line).frame(height: 1)
                    }
                    row(comments[index], index: index)
                }
            }
        }
    }

    private func row(_ comment: EntryComment, index: Int) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Avatar(name: comment.authorName, size: compact ? 30 : 34)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .center, spacing: 6) {
                    Text(comment.authorName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                    if comment.mine {
                        Text("You")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Palette.evergreen)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Palette.evergreen.opacity(0.10))
                            .clipShape(Capsule())
                    }
                    Text(time(comment.createdAt))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Spacer(minLength: 4)
                    if comment.mine {
                        Button(role: .destructive) {
                            Task { await remove(comment) }
                        } label: {
                            Image(systemName: "trash")
                                .font(.caption.weight(.semibold))
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Palette.negative)
                        .disabled(deleting.contains(comment.id))
                        .accessibilityLabel("Delete your comment")
                    }
                }
                Text(comment.body)
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, compact ? 6 : 9)
        .accessibilityIdentifier("comment-\(index)")
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Add a comment…", text: $draft, axis: .vertical)
                    .lineLimit(1...4)
                    .font(.subheadline)
                    .textInputAutocapitalization(.sentences)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(Palette.raised)
                    .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous).stroke(Palette.line, lineWidth: 1))
                    .focused($fieldFocused)
                    .accessibilityIdentifier("comment-field")
                    .accessibilityLabel("Write a comment")
                    .onChange(of: draft) { _, value in
                        if value.count > 2000 { draft = String(value.prefix(2000)) }
                    }
                Button {
                    Task { await send() }
                } label: {
                    Group {
                        if sending {
                            ProgressView().tint(Palette.paper)
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 16, weight: .bold))
                        }
                    }
                    .frame(width: 44, height: 44)
                    .foregroundStyle(canSend ? Palette.paper : Palette.muted)
                    .background(canSend ? Palette.evergreen : Palette.raised)
                    .clipShape(Circle())
                    .overlay(Circle().stroke(canSend ? Color.clear : Palette.line, lineWidth: 1))
                    .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .accessibilityIdentifier("comment-send")
                .accessibilityLabel("Send comment")
            }
            if draft.count >= 1900 {
                Text("\(draft.count)/2,000")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(draft.count >= 2000 ? Palette.negative : .secondary)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
    }

    private func time(_ value: String) -> String {
        guard let date = ISO8601DateFormatter().date(from: value) else { return "" }
        return date.formatted(.relative(presentation: .named))
    }

    private func load(force: Bool = false) async {
        guard !loading, force || !loaded else { return }
        loading = true
        defer { loading = false }
        do {
            _ = try await store.loadComments(entryID)
            loaded = true
            error = nil
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }

    private func send() async {
        guard canSend else { return }
        let body = cleanDraft
        guard body.count <= 2000 else {
            error = "Write a comment of up to 2,000 characters."
            return
        }
        sending = true
        defer { sending = false }
        do {
            _ = try await store.addComment(entryID, body: body)
            draft = ""
            loaded = true
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func remove(_ comment: EntryComment) async {
        guard !deleting.contains(comment.id) else { return }
        deleting.insert(comment.id)
        defer { deleting.remove(comment.id) }
        do {
            try await store.deleteComment(entryID, commentID: comment.id)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
