enum TripPhase: String, Codable, CaseIterable, Identifiable {
    case pre, during, post

    var id: Self { self }

    var title: String {
        switch self {
        case .pre: "Pre-trip"
        case .during: "During trip"
        case .post: "Post-trip"
        }
    }
}

extension ExpenseGroup {
    func defaultPhase(on date: String) -> TripPhase {
        let day = String(date.prefix(10))
        if let startDate, day < startDate { return .pre }
        if let endDate, day > endDate { return .post }
        return .during
    }

    func phase(for entry: LedgerEntry) -> TripPhase? {
        guard kind == "trip", entry.kind == "expense" else { return nil }
        return entry.phase ?? defaultPhase(on: entry.createdAt)
    }
}
