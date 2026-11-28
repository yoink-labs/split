import Foundation

#if DEBUG
/// A large, deliberately awkward sample trip for layout audits: ten people
/// with long names, placeholders with contact details, ~90 expenses across
/// two currencies and every entry kind. Enabled with the `-splitDemoStress`
/// launch argument on top of `-splitDemo`. Never shipped in release builds.
enum StressFixtures {
    static let groupID = "demo-stress-brazil"

    static var enabled: Bool { ProcessInfo.processInfo.arguments.contains("-splitDemoStress") }

    static func apply(to snapshot: inout Snapshot) {
        let g = groupID
        let names: [(String, String?, String?)] = [
            ("Alex", "demo-user", nil),
            ("Harris Khan", "demo-harris-account", nil),
            ("Sanjit Verma", "demo-sanjit-account", nil),
            ("Amine Yahi", "demo-amine-account", nil),
            ("Jason Huang", nil, "jasonh7702@example.com"),
            ("Ethan Monico Bayotas", nil, "ethan.bayotas@example.com"),
            ("Victor Shi", nil, nil),
            ("Sarvesh Somasundaram", nil, "sarvesh.s@example.com"),
            ("Maya", "demo-maya-account", nil),
            ("Guadalupe Fernández-Castillo", nil, nil)
        ]
        let people = names.enumerated().map { index, item in
            Person(id: "stress-p\(index)", groupID: g, userID: item.1, name: item.0, email: item.2)
        }
        var group = ExpenseGroup(id: g, name: "Buenos Aires and Rio de Janeiro", kind: "trip", currency: "USD", members: people, simplify: true)
        group.description = "Ten days across Argentina and Brazil."
        group.startDate = "2026-11-18"
        group.endDate = "2026-11-28"

        let titles: [(String, String, Int64)] = [
            ("Uber to Palermo Soho", "Transport", 647), ("Beers last night", "Liquor", 1646), ("Uber home", "Transport", 275),
            ("Ubers to acai + mexican", "Transport", 794), ("Don Julio parrilla dinner for the whole group", "Dining", 41250),
            ("Airbnb Copacabana — 5 nights", "Lodging", 186_000), ("Lyft to the airport", "Transport", 3420),
            ("Starbucks", "Dining", 1890), ("Sugarloaf cable car tickets", "Entertainment", 21_600),
            ("Christ the Redeemer tour", "Travel", 38_500), ("Groceries at Carrefour", "Groceries", 8_730),
            ("Booking.com hostel deposit", "Lodging", 24_000), ("LATAM flights EZE→GIG", "Travel", 152_400),
            ("Caipirinhas at the beach", "Liquor", 2_850), ("McDonald's late night", "Dining", 2_260),
            ("SIM cards (Claro)", "Utilities", 3_600), ("Spotify Family", "Entertainment", 1_699),
            ("Tango show in San Telmo", "Entertainment", 27_000), ("Empanadas", "Dining", 1_480),
            ("Pharmacy — sunscreen and aloe", "Health", 2_315), ("Netflix", "Entertainment", 1_549),
            ("Shell gas station", "Transport", 5_400), ("Ipanema beach chairs", "Other", 1_200),
            ("Amazon — travel adapters", "Shopping", 3_197), ("DoorDash", "Dining", 4_430)
        ]
        let dayCount = 10
        var entries: [LedgerEntry] = []
        for index in 0..<88 {
            let template = titles[index % titles.count]
            let payer = people[(index * 7) % people.count]
            let day = 28 - (index * dayCount / 88)
            let hour = 8 + (index * 5) % 14
            let participants = index % 4 == 0 ? people : Array(people.shuffledDeterministic(seed: index).prefix(2 + index % 5))
            let amount = template.2 + Int64((index * 37) % 400)
            let shares = (try? Ledger.allocate(total: amount, weights: Array(repeating: 1, count: participants.count))) ?? []
            var entry = LedgerEntry(id: "stress-\(index)", groupID: g, title: template.0, amount: amount, currency: index % 9 == 4 ? "BRL" : "USD",
                                    paidBy: payer.id, splits: zip(participants, shares).map { Portion(memberID: $0.id, amount: $1) },
                                    category: template.1, createdAt: String(format: "2026-11-%02dT%02d:%02d:00Z", day, hour, (index * 13) % 60))
            if index % 11 == 3 { entry.notes = "Paid with the shared card. Ask Harris for the paper receipt." }
            if index % 6 == 1 { entry.likeCount = 1 + index % 3 }
            if index % 8 == 2 { entry.commentCount = 1 + index % 4 }
            if index == 9 {
                entry.pending = true
                entry.pendingNote = "Victor might get a refund for the cancelled tour."
            }
            entries.append(entry)
        }
        // Settlements between members.
        for (index, pair) in [(1, 0), (2, 3), (4, 1), (0, 5)].enumerated() {
            entries.append(LedgerEntry(id: "stress-pay-\(index)", groupID: g, title: "Payment", amount: Int64(2_500 + index * 1_350), currency: "USD",
                                       paidBy: people[pair.0].id, splits: [Portion(memberID: people[pair.1].id, amount: Int64(2_500 + index * 1_350))],
                                       kind: "settlement", createdAt: "2026-11-2\(index + 1)T12:00:00Z"))
        }
        // A receipt with open items.
        if let first = entries.firstIndex(where: { $0.id == "stress-4" }) {
            entries[first].bill = ReceiptBill(items: [
                Purchase(title: "Bife de chorizo", amount: 12_400, memberIDs: [people[0].id, people[1].id]),
                Purchase(title: "Provoleta", amount: 3_800),
                Purchase(title: "Malbec reserva bottle", amount: 9_600, memberIDs: [people[2].id, people[3].id, people[4].id]),
                Purchase(title: "Ensalada mixta", amount: 2_450),
                Purchase(title: "Flan con dulce de leche", amount: 1_900, memberIDs: [people[5].id])
            ], tax: 0, tip: 11_100)
            entries[first].amount = entries[first].bill?.total ?? entries[first].amount
            entries[first].splitMode = .exact
            entries[first].splits = (try? entries[first].bill?.split(payer: entries[first].paidBy)) ?? entries[first].splits
        }
        snapshot.groups.insert(group, at: 0)
        snapshot.entries.append(contentsOf: entries)
    }

    static func invites() -> [ActiveInvite] {
        let expiry = (Date().timeIntervalSince1970 + 6 * 86_400) * 1000
        return [("stress-p4", "Jason Huang"), ("stress-p5", "Ethan Monico Bayotas"), ("stress-p6", "Victor Shi"), ("stress-p7", "Sarvesh Somasundaram")]
            .enumerated().map { index, item in
                ActiveInvite(id: "stress-invite-\(index)", memberID: item.0, memberName: item.1, recipientEmail: nil, recipientName: nil, expiresAt: expiry)
            }
    }
}

private extension Array {
    /// A stable pseudo-shuffle so the fixture is identical on every launch.
    func shuffledDeterministic(seed: Int) -> [Element] {
        enumerated().sorted { ($0.offset * 31 + seed * 17) % 13 < ($1.offset * 31 + seed * 17) % 13 }.map(\.element)
    }
}
#endif
