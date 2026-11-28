import { balances, entryPayers, groupTransfers, settlementEntry, sign, type Expense, type Group, type Person } from "./data";

type BalanceLine = { group: Group; person: Person; currency: string; amount: number };
type PersonBalance = { name: string; avatarURL?: string | null; lines: BalanceLine[]; net: Map<string, number> };

export function personalLedger(groups: Group[], entries: Expense[], viewer: string) {
  const seats = new Map<string, string>();
  const byGroup = new Map<string, Expense[]>();
  for (const group of groups) {
    const seat = group.members.find((member) => member.userID === viewer && !member.removed);
    if (seat) {
      seats.set(group.id, seat.id);
      byGroup.set(group.id, []);
    }
  }
  for (const entry of entries) byGroup.get(entry.groupID)?.push(entry);

  const totals = new Map<string, { owe: number; owed: number }>();
  const people = new Map<string, PersonBalance>();
  const summaries = groups.flatMap((group) => {
    const seat = seats.get(group.id);
    if (!seat) return [];
    const ledger = byGroup.get(group.id)!.map(settlementEntry);
    const members = new Map(group.members.map((person) => [person.id, person]));
    const mine = new Map<string, number>();
    for (const currency of new Set(ledger.map((entry) => entry.currency))) {
      const values = balances(ledger, currency);
      const net = values[seat] ?? 0;
      if (!net) continue;
      mine.set(currency, net);
      const total = totals.get(currency) ?? { owe: 0, owed: 0 };
      total.owe += Math.max(0, -net);
      total.owed += Math.max(0, net);
      totals.set(currency, total);

      for (const transfer of groupTransfers(group, values)) {
        if (transfer.from !== seat && transfer.to !== seat) continue;
        const outgoing = transfer.from === seat;
        const person = members.get(outgoing ? transfer.to : transfer.from);
        if (!person) continue;
        const key = person.userID ? "account:" + person.userID : "seat:" + person.id;
        const balance: PersonBalance = people.get(key) ?? { name: person.name, avatarURL: person.avatarURL, lines: [], net: new Map() };
        const amount = outgoing ? -transfer.amount : transfer.amount;
        balance.lines.push({ group, person, currency, amount });
        balance.net.set(currency, (balance.net.get(currency) ?? 0) + amount);
        people.set(key, balance);
      }
    }
    return [{ group, mine }];
  });

  const transactions = entries.flatMap((entry) => {
    const seat = seats.get(entry.groupID);
    if (!seat) return [];
    const paid = entryPayers(entry).reduce((sum, part) => sum + (part.memberID === seat ? part.amount : 0), 0);
    const share = entry.splits.reduce((sum, part) => sum + (part.memberID === seat ? part.amount : 0), 0);
    if (!paid && !share) return [];
    const settling = settlementEntry(entry);
    const direction = entry.handled ? 0 : sign(entry) * (
      entryPayers(settling).reduce((sum, part) => sum + (part.memberID === seat ? part.amount : 0), 0)
      - settling.splits.reduce((sum, part) => sum + (part.memberID === seat ? part.amount : 0), 0)
    );
    return [{ entry, paid, share, direction }];
  }).sort((a, b) => b.entry.createdAt.localeCompare(a.entry.createdAt) || b.entry.id.localeCompare(a.entry.id));
  return { summaries, seats, people, totals, transactions };
}
