import Foundation

struct CombinationSuggestion: Decodable, Identifiable {
    let title: String
    let entryIDs: [String]
    var id: String { entryIDs.joined(separator: ",") }
}

struct CombinationEvent: Decodable, Identifiable {
    let entryID: String
    let title: String
    let count: Int
    let action: String
    let at: String
    var id: String { entryID + action }
}

struct CombinationSuggestions: Decodable { let suggestions: [CombinationSuggestion] }
struct CombinationHistory: Decodable { let events: [CombinationEvent] }
struct CombinationResult: Decodable { let entryID: String }

extension LedgerEntry {
    func canCombine(in entries: [LedgerEntry]) -> Bool {
        kind == "expense" && combinedCount == nil && !isPending && !isHandled && exchange == nil && spread == nil && !usesNights &&
        (recurrence == nil || recurrence == "off") && !entries.contains { $0.refundOf == id }
    }
}
