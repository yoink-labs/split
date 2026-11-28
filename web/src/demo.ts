import type { Bill } from "../../worker/src/items";
import {
  itemSplit,
  type ActiveInvite,
  type Expense,
  type ExpenseComment,
  type Group,
  type InboxReceipt,
  type Snapshot,
} from "./data";

export const DEMO_USER = "demo-user-harris";

/** Generates a crisp realistic thermal receipt image as a Blob for demo mode. */
function makeReceiptBlob(title: string, subtitle: string, lines: [string, string][], tax: string, tip: string, total: string): Blob {
  const xmlText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows = lines
    .map(
      ([name, price], i) =>
        `<text x="28" y="${142 + i * 28}" font-family="monospace" font-size="14" fill="#1e293b">${xmlText(name)}</text>
         <text x="372" y="${142 + i * 28}" text-anchor="end" font-family="monospace" font-size="14" fill="#0f172a">${xmlText(price)}</text>`,
    )
    .join("");
  const baseY = 148 + lines.length * 28;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="${baseY + 135}" viewBox="0 0 400 ${baseY + 135}">
    <rect width="400" height="${baseY + 135}" rx="8" fill="#ffffff"/>
    <rect x="0.5" y="0.5" width="399" height="${baseY + 134}" rx="8" fill="none" stroke="#e2e8f0"/>
    <text x="200" y="44" text-anchor="middle" font-family="system-ui,sans-serif" font-size="19" font-weight="800" fill="#0f172a">${xmlText(title)}</text>
    <text x="200" y="66" text-anchor="middle" font-family="monospace" font-size="11.5" fill="#64748b">${xmlText(subtitle)}</text>
    <line x1="24" y1="88" x2="376" y2="88" stroke="#cbd5e1" stroke-dasharray="4 4"/>
    <text x="28" y="110" font-family="monospace" font-size="11.5" font-weight="700" fill="#64748b">ITEM</text>
    <text x="372" y="110" text-anchor="end" font-family="monospace" font-size="11.5" font-weight="700" fill="#64748b">PRICE</text>
    ${rows}
    <line x1="24" y1="${baseY}" x2="376" y2="${baseY}" stroke="#cbd5e1" stroke-dasharray="4 4"/>
    <text x="28" y="${baseY + 26}" font-family="monospace" font-size="13" fill="#475569">Tax</text>
    <text x="372" y="${baseY + 26}" text-anchor="end" font-family="monospace" font-size="13" fill="#475569">${xmlText(tax)}</text>
    <text x="28" y="${baseY + 50}" font-family="monospace" font-size="13" fill="#475569">Service / Tip</text>
    <text x="372" y="${baseY + 50}" text-anchor="end" font-family="monospace" font-size="13" fill="#475569">${xmlText(tip)}</text>
    <line x1="24" y1="${baseY + 66}" x2="376" y2="${baseY + 66}" stroke="#0f172a" stroke-width="1.5"/>
    <text x="28" y="${baseY + 94}" font-family="monospace" font-size="16" font-weight="700" fill="#0f172a">TOTAL</text>
    <text x="372" y="${baseY + 94}" text-anchor="end" font-family="monospace" font-size="16" font-weight="700" fill="#0f172a">${xmlText(total)}</text>
    <text x="200" y="${baseY + 120}" text-anchor="middle" font-family="monospace" font-size="10.5" fill="#94a3b8">Parsed &amp; synced via Split MCP</text>
  </svg>`;
  return new Blob([svg], { type: "image/svg+xml" });
}

/** Deterministic pseudo-random numbers so the demo history is identical on every load. */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Eighteen months of household history for the demo apartment, so long lists and charts have real volume. */
function householdHistory(groupID: string, memberIDs: string[]): Expense[] {
  const random = seeded(4242);
  const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)];
  const entries: Expense[] = [];
  const add = (day: string, title: string, amount: number, category: string, currency = "USD", rateE8 = 0) => {
    const n = memberIDs.length;
    const base = Math.floor(amount / n);
    const extra = amount - base * n;
    const index = entries.length;
    entries.push({
      id: `e-home-h${index}`, groupID, title, amount, currency, paidBy: memberIDs[index % n],
      splits: memberIDs.map((memberID, i) => ({ memberID, amount: base + (i < extra ? 1 : 0) })),
      kind: "expense", splitMode: "equal", category, createdAt: `${day}T${String(9 + (index % 11)).padStart(2, "0")}:15:00Z`,
      editable: true,
      ...(rateE8 ? { exchange: { target: "USD", rateE8, date: day, source: "Manual" as const } } : {}),
    });
  };
  const grocers = ["Trader Joe’s", "Whole Foods", "Key Food", "Costco run", "Farmers market"];
  const takeout = ["Thai takeout", "Pizza night", "Ramen delivery", "Taco Tuesday", "Dumpling order"];
  const supplies = ["Paper towels & soap", "Cleaning supplies", "Light bulbs", "Dish sponges", "Laundry pods"];
  for (let month = 0; month < 17; month++) {
    const y = 2025 + Math.floor((5 + month) / 12);
    const m = ((5 + month) % 12) + 1;
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    const day = (d: number) => `${ym}-${String(Math.min(d, 28)).padStart(2, "0")}`;
    add(day(1), "Rent", 285000, "Rent & Utilities");
    add(day(6), "ConEd Electric & Gas", 9000 + Math.floor(random() * 9000), "Rent & Utilities");
    add(day(9), "Spectrum Internet", 7999, "Rent & Utilities");
    for (let week = 0; week < 4; week++) {
      add(day(2 + week * 7), pick(grocers), 4200 + Math.floor(random() * 11000), "Groceries");
      if (random() > 0.35) add(day(4 + week * 7), pick(takeout), 2800 + Math.floor(random() * 5200), "Dining");
    }
    add(day(14), pick(supplies), 1500 + Math.floor(random() * 3500), "Shopping");
    if (random() > 0.6) add(day(20), "Movie night", 3600 + Math.floor(random() * 2000), "Activities");
    if (random() > 0.7) add(day(23), "Coffee beans", 1800 + Math.floor(random() * 900), "Drinks");
  }
  // A long weekend in Lisbon, paid in euros with the rate the group agreed on.
  add("2026-07-17", "Alfama apartment", 54000, "Lodging", "EUR", 108000000);
  add("2026-07-18", "Time Out Market", 8640, "Dining", "EUR", 108000000);
  add("2026-07-18", "Tram 28 passes", 3180, "Transport", "EUR", 108000000);
  add("2026-07-19", "Sintra day trip", 11400, "Activities", "EUR", 108000000);
  return entries;
}

export function createDemoState() {
  const gBA: Group = {
    id: "grp-ba-trip",
    name: "Buenos Aires Trip",
    kind: "trip",
    currency: "USD",
    description: "Palermo steaks, wine bars, and weekend ferry to Colonia",
    startDate: "2026-11-12",
    endDate: "2026-11-21",
    simplify: true,
    members: [
      { id: "m-harris", name: "Harris", userID: DEMO_USER, avatarURL: "preset:cobalt", payment: { venmo: "harris-k", paypal: "harrisk", alias: "harris.split.mp" } },
      { id: "m-maya", name: "Maya Lin", userID: "user-maya", avatarURL: "preset:emerald", paymentMethods: [{ platform: "zelle", handle: "maya@example.com", preferred: true }, { platform: "paypal", handle: "mayalin" }] },
      { id: "m-alex", name: "Alex Rivera", userID: "user-alex", avatarURL: "preset:indigo", payment: { venmo: "alexr" } },
      { id: "m-sam", name: "Sam Patel", userID: null, avatarURL: "preset:amber" },
      { id: "m-jordan", name: "Jordan Kim", userID: null, removed: true, avatarURL: "preset:slate" },
    ],
  };

  const gHome: Group = {
    id: "grp-apt-4b",
    name: "Apt 4B — Rent & Bills",
    kind: "home",
    currency: "USD",
    description: "Ongoing apartment rent, utilities, and shared household supplies",
    simplify: true,
    defaultWeights: { "h-harris": 4, "h-maya": 3, "h-sam": 3 },
    members: [
      { id: "h-harris", name: "Harris", userID: DEMO_USER, avatarURL: "preset:cobalt", payment: { venmo: "harris-k" } },
      { id: "h-maya", name: "Maya Lin", userID: "user-maya", avatarURL: "preset:emerald", payment: { venmo: "mayalin" } },
      { id: "h-sam", name: "Sam Patel", userID: null, avatarURL: "preset:amber" },
    ],
  };

  const gTokyo: Group = {
    id: "grp-tokyo-27",
    name: "Tokyo Spring ’27",
    kind: "trip",
    currency: "USD",
    description: "Shibuya hotels, shinkansen passes, and late-night ramen",
    startDate: "2027-04-04",
    endDate: "2027-04-14",
    simplify: true,
    members: [
      { id: "t-harris", name: "Harris", userID: DEMO_USER, avatarURL: "preset:cobalt" },
      { id: "t-alex", name: "Alex Rivera", userID: "user-alex", avatarURL: "preset:indigo" },
    ],
  };

  const donJulioBill: Bill = {
    closed: false,
    tax: 1400,
    tip: 2600,
    items: [
      { id: "dj-1", title: "Bife de Chorizo (Ribeye)", amount: 5400, memberIDs: ["m-harris", "m-maya"], shares: { "m-harris": 100, "m-maya": 100 } },
      { id: "dj-2", title: "3x Catena Malbec Glasses", amount: 3600, memberIDs: ["m-harris", "m-alex"], shares: { "m-harris": 200, "m-alex": 100 } },
      { id: "dj-3", title: "Provoleta & Chimichurri", amount: 1800, memberIDs: ["m-harris", "m-maya", "m-alex", "m-sam"] },
      { id: "dj-4", title: "Grilled Sweetbreads (Mollejas)", amount: 2400, memberIDs: [] },
      { id: "dj-5", title: "Flan con Dulce de Leche", amount: 1200, memberIDs: [] },
    ],
  };

  const tortoniBill = {
    closed: false,
    tax: 300,
    tip: 500,
    items: [
      { id: "ct-1", title: "4x Cortados & Medialunas", amount: 2200, memberIDs: ["m-harris", "m-maya", "m-alex", "m-sam"] },
      { id: "ct-2", title: "Churros con Chocolate", amount: 1400, memberIDs: [] },
    ],
  };

  const entries: Expense[] = [
    {
      id: "e-ba-donjulio",
      groupID: gBA.id,
      title: "Don Julio Parrilla",
      amount: 18400,
      currency: "USD",
      paidBy: "m-harris",
      splits: itemSplit(donJulioBill, "m-harris"),
      kind: "expense",
      splitMode: "exact",
      category: "Dining",
      notes: "Uploaded from receipt photo via local LLM — claim your items & fractional wine pours!",
      bill: donJulioBill,
      receiptIDs: ["photo-donjulio"],
      createdAt: "2026-11-15T22:30:00Z",
      editable: true,
      commentCount: 2,
      likeCount: 3,
      likedByMe: true,
    },
    {
      id: "e-ba-airbnb",
      groupID: gBA.id,
      title: "Palermo Soho Loft (5 nights)",
      amount: 120000,
      currency: "USD",
      paidBy: "m-harris",
      payers: [
        { memberID: "m-harris", amount: 70000 },
        { memberID: "m-maya", amount: 50000 },
      ],
      splits: [
        { memberID: "m-harris", amount: 30000 },
        { memberID: "m-maya", amount: 30000 },
        { memberID: "m-alex", amount: 30000 },
        { memberID: "m-sam", amount: 30000 },
      ],
      kind: "expense",
      splitMode: "equal",
      category: "Lodging",
      notes: "Harris paid the booking deposit ($700), Maya paid the balance at check-in ($500).",
      createdAt: "2026-11-12T15:00:00Z",
      editable: true,
      commentCount: 1,
      likeCount: 2,
      likedByMe: false,
    },
    {
      id: "e-ba-uber-ars",
      groupID: gBA.id,
      title: "Ezeiza Airport Van",
      amount: 6400000, // ARS 64,000.00
      currency: "ARS",
      paidBy: "m-alex",
      splits: [
        { memberID: "m-harris", amount: 1600000 },
        { memberID: "m-maya", amount: 1600000 },
        { memberID: "m-alex", amount: 1600000 },
        { memberID: "m-sam", amount: 1600000 },
      ],
      exchange: { target: "USD", rateE8: 85470, date: "2026-11-12", source: "Manual" }, // ~1 USD = 1170 ARS -> 1 ARS = 0.0008547 USD
      kind: "expense",
      splitMode: "equal",
      category: "Transport",
      notes: "Paid in cash pesos using the blue-dollar rate we exchanged on arrival.",
      createdAt: "2026-11-12T11:20:00Z",
      editable: true,
      likeCount: 1,
    },
    {
      id: "e-ba-tango",
      groupID: gBA.id,
      title: "Rojo Tango Show Tickets",
      amount: 32000,
      currency: "USD",
      paidBy: "m-maya",
      splits: [
        { memberID: "m-harris", amount: 8000 },
        { memberID: "m-maya", amount: 8000 },
        { memberID: "m-alex", amount: 8000 },
        { memberID: "m-sam", amount: 8000 },
      ],
      kind: "expense",
      splitMode: "equal",
      category: "Activities",
      createdAt: "2026-11-14T20:00:00Z",
      editable: true,
    },
    {
      id: "e-ba-wine-ars",
      groupID: gBA.id,
      title: "Anchoíta Wine Bar",
      amount: 14500000, // ARS 145,000.00
      currency: "ARS",
      paidBy: "m-sam",
      splits: [
        { memberID: "m-harris", amount: 3625000 },
        { memberID: "m-maya", amount: 3625000 },
        { memberID: "m-alex", amount: 3625000 },
        { memberID: "m-sam", amount: 3625000 },
      ],
      exchange: { target: "USD", rateE8: 98039, date: "2026-11-13", source: "BCRA" },
      kind: "expense",
      splitMode: "equal",
      category: "Drinks",
      notes: "Paid on Sam’s Visa (official BCRA rate for Nov 13).",
      createdAt: "2026-11-13T21:45:00Z",
      editable: true,
    },
    {
      id: "e-ba-tortoni",
      groupID: gBA.id,
      title: "Café Tortoni Breakfast",
      amount: 4400,
      currency: "USD",
      paidBy: "m-maya",
      splits: itemSplit(tortoniBill, "m-maya"),
      kind: "expense",
      splitMode: "exact",
      category: "Drinks",
      bill: tortoniBill,
      receiptIDs: ["photo-tortoni"],
      createdAt: "2026-11-16T10:15:00Z",
      editable: true,
    },
    {
      id: "e-ba-ferry",
      groupID: gBA.id,
      title: "Buquebus Ferry to Colonia",
      amount: 21000,
      currency: "USD",
      paidBy: "m-alex",
      splits: [
        { memberID: "m-harris", amount: 7000 },
        { memberID: "m-maya", amount: 7000 },
        { memberID: "m-alex", amount: 7000 },
      ],
      kind: "expense",
      splitMode: "equal",
      category: "Flights",
      notes: "Sam stayed in BA to work that day.",
      createdAt: "2026-11-17T08:00:00Z",
      editable: true,
    },
    {
      id: "e-ba-settle-1",
      groupID: gBA.id,
      title: "Settle-up payment",
      amount: 10000,
      currency: "USD",
      paidBy: "m-alex",
      splits: [{ memberID: "m-harris", amount: 10000 }],
      kind: "settlement",
      splitMode: "exact",
      createdAt: "2026-11-18T16:00:00Z",
      editable: true,
    },
    {
      id: "e-ba-seats",
      groupID: gBA.id,
      title: "Colonia day-trip boat seats",
      amount: 24000,
      currency: "USD",
      paidBy: "m-harris",
      splits: [
        { memberID: "m-harris", amount: 6000 },
        { memberID: "m-maya", amount: 6000 },
        { memberID: "m-alex", amount: 6000 },
        { memberID: "m-sam", amount: 6000 },
      ],
      kind: "expense",
      splitMode: "equal",
      category: "Transport",
      createdAt: "2026-11-15T09:00:00Z",
      editable: true,
    },
    {
      id: "e-ba-seats-refund",
      groupID: gBA.id,
      title: "Seacat refund: Alex’s seat",
      amount: 6000,
      currency: "USD",
      paidBy: "m-harris",
      splits: [{ memberID: "m-alex", amount: 6000 }],
      kind: "refund",
      refundOf: "e-ba-seats",
      splitMode: "exact",
      category: "Transport",
      notes: "Alex took the earlier boat; Seacat refunded the seat to Harris’s card.",
      createdAt: "2026-11-16T10:00:00Z",
      editable: true,
    },
    {
      id: "e-ba-tigre",
      groupID: gBA.id,
      title: "Tigre Delta boat excursion",
      amount: 32000,
      currency: "USD",
      paidBy: "m-maya",
      splits: [
        { memberID: "m-harris", amount: 8000 },
        { memberID: "m-maya", amount: 8000 },
        { memberID: "m-alex", amount: 8000 },
        { memberID: "m-sam", amount: 8000 },
      ],
      kind: "expense",
      splitMode: "equal",
      category: "Entertainment",
      pending: true,
      pendingNote: "Sam couldn’t go. Asking the operator to refund Sam’s ticket.",
      createdAt: "2026-11-19T11:00:00Z",
      editable: true,
    },
    // Long-term Apt 4B
    {
      id: "e-home-rent-nov",
      groupID: gHome.id,
      title: "November Rent",
      amount: 360000,
      currency: "USD",
      paidBy: "h-harris",
      splits: [
        { memberID: "h-harris", amount: 144000 },
        { memberID: "h-maya", amount: 108000 },
        { memberID: "h-sam", amount: 108000 },
      ],
      kind: "expense",
      splitMode: "shares",
      category: "Rent & Utilities",
      recurrence: "monthly",
      notes: "Master bedroom 40%, smaller rooms 30% each.",
      createdAt: "2026-11-01T12:00:00Z",
      editable: true,
    },
    {
      id: "e-home-coned",
      groupID: gHome.id,
      title: "ConEd Electric & Gas",
      amount: 16800,
      currency: "USD",
      paidBy: "h-maya",
      splits: [
        { memberID: "h-harris", amount: 5600 },
        { memberID: "h-maya", amount: 5600 },
        { memberID: "h-sam", amount: 5600 },
      ],
      kind: "expense",
      splitMode: "equal",
      category: "Rent & Utilities",
      recurrence: "monthly",
      createdAt: "2026-11-08T12:00:00Z",
      editable: true,
    },
    {
      id: "e-home-groceries",
      groupID: gHome.id,
      title: "Costco Household Run",
      amount: 14250,
      currency: "USD",
      paidBy: "h-sam",
      splits: [
        { memberID: "h-harris", amount: 4750 },
        { memberID: "h-maya", amount: 4750 },
        { memberID: "h-sam", amount: 4750 },
      ],
      kind: "expense",
      splitMode: "equal",
      category: "Groceries",
      createdAt: "2026-10-22T18:30:00Z",
      editable: true,
    },
    // Tokyo Trip
    {
      id: "e-tokyo-hotel",
      groupID: gTokyo.id,
      title: "Shibuya Granbell Hotel Deposit",
      amount: 48000,
      currency: "USD",
      paidBy: "t-harris",
      splits: [
        { memberID: "t-harris", amount: 24000 },
        { memberID: "t-alex", amount: 24000 },
      ],
      kind: "expense",
      splitMode: "equal",
      category: "Lodging",
      createdAt: "2026-11-20T14:00:00Z",
      editable: true,
    },
  ];

  const comments: Record<string, ExpenseComment[]> = {
    "e-ba-donjulio": [
      {
        id: "c-1",
        entryID: "e-ba-donjulio",
        authorUserID: "user-maya",
        authorName: "Maya Lin",
        body: "Claimed half the ribeye and the provoleta! Who had the flan?",
        createdAt: "2026-11-16T01:12:00Z",
        mine: false,
      },
      {
        id: "c-2",
        entryID: "e-ba-donjulio",
        authorUserID: DEMO_USER,
        authorName: "Harris",
        body: "Set myself to 2x on the Malbec glasses since I had two pours.",
        createdAt: "2026-11-16T01:25:00Z",
        mine: true,
      },
    ],
    "e-ba-airbnb": [
      {
        id: "c-3",
        entryID: "e-ba-airbnb",
        authorUserID: "user-alex",
        authorName: "Alex Rivera",
        body: "Best balcony in Palermo, worth every cent.",
        createdAt: "2026-11-13T09:00:00Z",
        mine: false,
      },
    ],
  };

  const invites: Record<string, ActiveInvite[]> = {
    [gBA.id]: [
      {
        id: "a".repeat(64),
        kind: "member",
        memberID: "m-sam",
        memberName: "Sam Patel",
        expiresAt: Date.now() + 5 * 86400_000,
        url: "https://split.yoinklabs.dev/invite/SAM7PATEL992",
        code: "SAM7PATEL992",
      },
    ],
  };

  const photos: Record<string, Blob> = {
    "photo-donjulio": makeReceiptBlob(
      "PARRILLA DON JULIO",
      "Guatemala 4691 · Palermo, Buenos Aires",
      [
        ["1x Bife de Chorizo", "$54.00"],
        ["3x Catena Malbec Glass", "$36.00"],
        ["1x Provoleta & Chimi", "$18.00"],
        ["1x Mollejas Asadas", "$24.00"],
        ["1x Flan Dulce de Leche", "$12.00"],
      ],
      "$14.00",
      "$26.00",
      "$184.00",
    ),
    "photo-tortoni": makeReceiptBlob(
      "CAFÉ TORTONI",
      "Av. de Mayo 825 · Buenos Aires",
      [
        ["4x Cortados & Medialunas", "$22.00"],
        ["1x Churros con Chocolate", "$14.00"],
      ],
      "$3.00",
      "$5.00",
      "$44.00",
    ),
  };

  photos["photo-inbox-cabrera"] = makeReceiptBlob(
    "LA CABRERA",
    "José A. Cabrera 5099 · Palermo Soho",
    [
      ["1x Ojo de Bife 400g", "$38.00"],
      ["1x Parrillada para 2", "$46.00"],
      ["2x Quilmes Cerveza", "$12.00"],
    ],
    "$9.60",
    "$14.40",
    "$120.00",
  );
  photos["photo-inbox-kiosco"] = makeReceiptBlob(
    "KIOSCO 24HS",
    "Av. Santa Fe 3253 · Buenos Aires",
    [
      ["2x Agua Mineral", "$3.00"],
      ["1x Alfajores Havanna (6)", "$9.00"],
    ],
    "$1.20",
    "$0.00",
    "$13.20",
  );
  // Receipts uploaded to the group inbox, waiting to be paired with an expense.
  const inbox: InboxReceipt[] = [
    { id: "photo-inbox-cabrera", groupID: gBA.id, uploadedBy: "m-harris", createdAt: "2026-11-19T23:10:00Z", note: "La Cabrera dinner", bytes: 48211 },
    { id: "photo-inbox-kiosco", groupID: gBA.id, uploadedBy: "m-maya", createdAt: "2026-11-18T13:40:00Z", note: "Snacks for the ferry", bytes: 30120 },
  ];

  return {
    inbox,
    snapshot: { userID: DEMO_USER, avatarURL: "preset:cobalt", paymentMethods: [{ platform: "venmo", handle: "harris-k", preferred: true }],
      groups: [gBA, gHome, gTokyo].map((group) => ({ ...group, canDelete: true, members: group.members.map((person) =>
        person.userID === DEMO_USER ? { ...person, paymentMethods: [{ platform: "venmo", handle: "harris-k", preferred: true }] } : person
      ) })), entries: [...entries, ...householdHistory(gHome.id, gHome.members.map((m) => m.id))] } as Snapshot,
    comments,
    invites,
    photos,
  };
}
