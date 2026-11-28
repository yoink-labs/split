// The CLI help, CLI parser and both MCP transports share these tool definitions.
const text = (description, maxLength = 120) => ({ type: 'string', description, minLength: 1, maxLength });
const id = description => ({ ...text(description, 80), pattern: '^[a-zA-Z0-9_-]{8,80}$' });
const money = { ...text('Amount in major currency units, e.g. "12.50".'), pattern: '^(0|[1-9][0-9]{0,9})([.][0-9]{1,2})?$' };
const enumeration = (description, values) => ({ type: 'string', description, enum: values });
const group = id('Group ID from groups list.');
const expense = id('Expense ID from expenses list.');
const member = id('Member ID from members list.');
const currency = enumeration('Three-letter currency. Defaults to the group currency.', ['USD','ARS','EUR','GBP','BRL','CAD','AUD','MXN']);
const list = (description, items) => ({ type: 'array', description, items, minItems: 1, maxItems: 50, uniqueItems: true });
const shareNumber = { type: 'number', description: 'Share multiplier, e.g. 0.5, 1 or 2.5.', minimum: 0.01, maximum: 1000 };
const share = { ...text('Share multiplier for this member, e.g. "0.5", "1" or "2.5". Defaults to 1.', 8), pattern: '^(0|[1-9][0-9]{0,3})([.][0-9]{1,2})?$' };
const receiptItem = {
  type: 'object',
  properties: {
    title: text('Line item name.', 100),
    amount: money,
    memberIDs: { type: 'array', description: 'Optional initial claimant member IDs.', items: member, maxItems: 50, uniqueItems: true },
    shares: { type: 'array', description: 'Optional share multipliers in memberIDs order, e.g. [2, 1] when one person had two of three. Defaults to 1 each.', items: shareNumber, maxItems: 50 }
  },
  required: ['title', 'amount'],
  additionalProperties: false
};
const receiptBill = {
  type: 'object',
  description: 'Itemized receipt, e.g. {"items":[{"title":"Coffee","amount":"4.50"}]}. Each item needs a title and an amount. Tax and tip are optional. Unclaimed items stay with the payer until claimed.',
  properties: {
    items: { type: 'array', items: receiptItem, minItems: 1, maxItems: 50 },
    tax: money,
    tip: money
  },
  required: ['items'],
  additionalProperties: false
};
const receiptPhotos = {
  type: 'array',
  description: 'Up to four JPEG receipt photos (240 KiB each), encoded as base64. Pass --photo PATH on the command line or absolute paths to local split mcp. On macOS these paths also support HEIC/PNG and image resizing. Convert PDFs to an image first.',
  items: { type: 'string', minLength: 16, maxLength: 327680 },
  minItems: 1,
  maxItems: 4
};
const day = description => ({ ...text(description + ' YYYY-MM-DD, or "none" to clear.', 10), pattern: '^(\\d{4}-\\d{2}-\\d{2}|none)$' });
const payerSplit = {
  type: 'array', description: 'Several people paid: [{"member":"ID","amount":"60.00"}, ...]. Amounts must sum to the expense amount. --payer must be one of them.',
  items: { type: 'object', properties: { member, amount: money }, required: ['member', 'amount'], additionalProperties: false },
  minItems: 1, maxItems: 50
};
const allocation = {
  rate: { ...text('Group currency per 1 unit of expense currency. For a BRL expense in a USD group, --rate 0.18 means 1 BRL = 0.18 USD. On add, a saved trip rate is used when available.'), pattern:'^[0-9]{1,8}([.][0-9]{1,8})?$' },
  category: text('Spending category.',50), title: text('Expense description.'), amount: money, payer: member, currency,
  notes: text('Optional notes on this expense.', 2000),
  payers: payerSplit,
  mode: enumeration('How to allocate the expense.', ['equal','exact','percent','shares']),
  participants: list('Member IDs, in rounding order. Equal split defaults to all members.', member),
  values: listValues()
};
function listValues() {
  return { type: 'array', description: 'Decimal strings in participant order. Exact values must sum to the amount. Percent values must sum to 100.', items: money, minItems: 1, maxItems: 50 };
}
const confirmation = {
  yes: { type: 'boolean', description: 'Apply the reviewed change.' },
  revision: text('Fingerprint returned by the preview. Required when confirming.', 64)
};
const paymentMethods = {type:'array',description:'Payment methods, e.g. [{"platform":"Venmo","handle":"maya-r","preferred":true}]. An empty array clears them. Replaces the older handles.',maxItems:20,
      items:{type:'object',properties:{platform:text('Platform name.',60),handle:text('Username, link or account.',500),preferred:{type:'boolean',description:'Mark one method as preferred.'}},required:['platform','handle'],additionalProperties:false}};
function op(name, description, properties = {}, required = [], readOnly = false, destructive = false) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: false } };
}
export const tools = [
  op('groups_default_split','Set default weights in member order. Supply empty arrays to restore equal splits.',{group,participants:{type:'array',items:member,maxItems:50,uniqueItems:true},weights:{type:'array',items:{type:'integer',minimum:1,maximum:1000},maxItems:50}},['group','participants','weights']),
  op('members_payment','Replace your own payment profile for a group. Pass methods for any platform, or the older paypal, venmo, mercado and alias handles. Omitted handles are cleared. Pass reset to use your account methods again.',{group,paypal:text('PayPal.Me username',40),venmo:text('Venmo username',40),mercado:text('Mercado Pago payment link'),alias:text('Argentine alias or CVU',22),
    methods:paymentMethods,
    reset:{type:'boolean',description:'Remove your group override and use your account payment methods here again.'}},['group']),
  op('profile_payment','Show your account payment methods, used in every group without its own override, or replace them with methods.',{methods:paymentMethods},[]),
  op('groups_rate','Set the exchange rate a trip uses for a foreign currency, or "none" to clear it. Only active trip members can change it.',{group,
    currency:enumeration('Foreign currency to convert from.',['USD','ARS','EUR','GBP','BRL','CAD','AUD','MXN']),
    rate:{...text('Trip currency units per one foreign unit, e.g. "1050.5", or "none".',17),pattern:'^(none|(0|[1-9][0-9]{0,6})([.][0-9]{1,8})?)$'}},['group','currency','rate']),
  op('expenses_handled','Mark an expense you paid as already handled outside Split, or unhandled again.',{group,expense,state:enumeration('Defaults to handled.',['handled','unhandled'])},['group','expense']),
  op('expenses_repeat','Set or cancel the schedule for your fixed-currency expense.',{group,expense,cadence:enumeration('Repeat cadence: off, daily, weekly, monthly, or yearly.',['off','daily','weekly','monthly','yearly'])},['group','expense','cadence']),
  op('groups_breakdown','Spending, categories, months, paid, shares, ledger net and suggested transfers by currency. Ledger net includes handled expenses. Suggested transfers use outstanding balances. Provide a member ID for their expense detail.',{group,member},['group'],true),
  op('items_open','List open purchases with tax and tip included in each gross amount.',{group},['group'],true),
  op('items_list','List every line item on an itemized expense with its ID, gross amount including tax and tip, claimants and share multipliers.',{group,expense},['group','expense'],true),
  op('items_claim','Add or remove a claimant on a purchase. Defaults to yourself. Use share for a partial claim, e.g. 0.5 or 2.',{group,expense,item:id('Receipt item ID.'),member,share,action:enumeration('Defaults to add.',['add','remove'])},['group','expense','item']),
  op('items_assign','Replace the claimants of one purchase in a single call. Supply shares in participant order for uneven splits. An empty participants array leaves the item open.',{group,expense,item:id('Receipt item ID.'),participants:{type:'array',description:'Member IDs who share this item.',items:member,maxItems:50,uniqueItems:true},shares:{type:'array',description:'Share multipliers in participant order. Defaults to 1 each.',items:shareNumber,maxItems:50}},['group','expense','item','participants']),
  op('items_close','As payer, close a receipt and split remaining purchases across the selected members or everyone.',{group,expense,participants:list('Members for remaining items.',member)},['group','expense']),
  op('receipts_list','List receipt photo IDs on an expense.',{group,expense},['group','expense'],true),
  op('receipts_get','Read one private receipt photo as base64 JPEG.',{group,expense,photo:id('Receipt photo ID.')},['group','expense','photo'],true),
  op('groups_list','List groups you belong to.', {}, [], true),
  op('groups_show','Show one group and its members.', { group }, ['group'], true),
  op('groups_create','Create a group with you and optional placeholder members.', {
    name: text('Group name.',80), self: text('Your display name in this group.',60),
    kind: enumeration('Group type, defaults to trip.', ['trip','home','friend']), currency,
    description: text('Optional description.', 500), start: day('Trip start date'), end: day('Trip end date'),
    placeholders: list('Names of unclaimed members.', text('Name.',60))
  }, ['name','self']),
  op('groups_update','Change a group’s name, description, trip dates, debt simplification or currency (currency only before any expenses).', {
    group, name: text('Group name.',80), description: text('Description, or "none" to clear.', 500),
    start: day('Trip start date'), end: day('Trip end date'),
    simplify: enumeration('Simplify debts into the fewest transfers.', ['on','off']), currency
  }, ['group']),
  op('groups_archive','Archive a settled group, or restore it.', { group, action: enumeration('Defaults to archive.', ['archive','restore']) }, ['group']),
  op('groups_leave','Preview leaving a group. Confirm with yes. The group and its history are deleted when the last member leaves.', { group, yes: confirmation.yes }, ['group'], false, true),
  op('groups_delete','Preview deleting a group you created, with everything in it, for every member. Confirm with yes and the revision from the preview. Archive or leave instead to keep history.', { group, ...confirmation }, ['group'], false, true),
  op('groups_export','Export a group. ledger: one CSV row per expense with each member’s net effect. summary: CSV of paid, share and net per member and currency. json: everything, including items, comments and settlements.', {
    group, format: enumeration('Defaults to ledger.', ['ledger','summary','json'])
  }, ['group'], true),
  op('members_remove','Archive a member to keep their history but leave them out of new splits, restore them, or delete someone with no expenses.', {
    group, member, mode: enumeration('Defaults to archive.', ['archive','restore','delete'])
  }, ['group','member'], false, true),
  op('invites_list','List open group and member invites.', { group }, ['group'], true),
  op('invites_revoke','Revoke an invite by the ID from invites list.', { group, invite: { ...text('Invite ID.', 64), pattern: '^[a-f0-9]{64}$' } }, ['group','invite'], false, true),
  op('import_splitwise','Import a Splitwise “Export as spreadsheet” CSV into a new group or an existing one. Step 1: omit me to see the names in the file. Step 2: set me (and group or mapping) with preview to review who becomes whom. Step 3: run without preview to import. Imports are all-or-nothing and repeat imports skip duplicates.', {
    csv: text('CSV file contents. On the command line, pass --file PATH instead.', 1_500_000),
    file: text('File name, used for the default group name.', 200),
    me: text('Your name as it appears in the Splitwise file.', 60),
    group: id('Existing group to import into. Omit to create a new group.'),
    name: text('New group name. Defaults to the file name.', 80),
    kind: enumeration('New group type, defaults to trip.', ['trip','home','friend']),
    mapping: { type: 'object', description: 'Map Splitwise names to existing member IDs in group, e.g. {"Maya R":"MEMBER_ID"}. Unmapped names become placeholders. Split only suggests exact name matches; it never links them for you.', additionalProperties: member, maxProperties: 50 },
    preview: { type: 'boolean', description: 'Show the import plan without saving anything.' }
  }, ['csv']),
  op('profile_avatar','Set your avatar to a preset (preset:NAME), an https image URL, or "none" to reset.', { avatar: text('preset:NAME, https URL or none.', 500) }, ['avatar']),
  op('members_list','List claimed and placeholder member IDs.', { group }, ['group'], true),
  op('members_lookup','Find a Split user by exact email, username, or a shared group member’s name.', { query: text('Search term.',254) }, ['query'], true),
  op('members_add','Add a placeholder or an existing Split user to a group.', {
    group, name: text('Member display name.',60), user: text('Existing user ID returned by members lookup.',128),
    email: text('Optional placeholder email for verified matching.',254), phone: text('Optional placeholder contact number.',32)
  }, ['group','name']),
  op('members_update','Set or clear an unclaimed member’s email for verified matching. Email changes revoke their existing invite links.', {
    group, member, email: text('Email address, or "none" to clear.',254)
  }, ['group','member','email']),
  op('invite','Create a group invitation, invite an existing placeholder, or create and invite a new placeholder. Returns a link and code.', {
    group, member, name: text('Name for a new placeholder. Use without --member.',60),
    email: text('Optional email for verified matching. Use with --member or --name.',254)
  }, ['group']),
  op('join','Claim an invited member slot with a Split invite link or code.', { invite: text('Invite link or code.',512) }, ['invite']),
  op('expenses_list','List expenses with dates, payers and IDs. Amounts in results are integer minor units.', { group }, ['group'], true),
  op('expenses_add','Record a standard or itemized expense. Supply an amount for standard expenses. Itemized expenses use the sum of the bill, and any supplied amount must match it.', {
    group, ...allocation,
    date: { ...text('Optional expense date YYYY-MM-DD.', 10), pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    bill: receiptBill,
    photos: receiptPhotos
  }, ['group','title','payer']),
  op('expenses_show','Show one expense in full, including payers, splits, exchange, receipts, comments and likes.', { group, expense: id('Full expense ID or a unique prefix of at least eight characters from expenses list.') }, ['group','expense'], true),
  op('expenses_like','Like or unlike an expense.', { group, expense }, ['group','expense']),
  op('comments_list','List comments on an expense.', { group, expense }, ['group','expense'], true),
  op('comments_add','Comment on an expense.', { group, expense, text: text('Comment.', 2000) }, ['group','expense','text']),
  op('comments_delete','Delete one of your comments.', { group, expense, comment: id('Comment ID.') }, ['group','expense','comment'], false, true),
  op('receipts_add','Attach up to four receipt photos to an expense you recorded.', { group, expense, photos: receiptPhotos }, ['group','expense','photos']),
  op('expenses_edit','Preview changes to your expense. Review the preview before confirming with yes and revision.', { group, expense, ...allocation, ...confirmation }, ['group','expense'], false, true),
  op('expenses_delete','Preview deletion of your expense. Review the preview before confirming with yes and revision.', { group, expense, ...confirmation }, ['group','expense'], false, true),
  op('balances','Show each member’s net balance and suggested settlements, separately by currency, in minor units.', { group }, ['group'], true),
  op('settlements_pending','List payments waiting for approval in a group, who made them and what you can do.', { group }, ['group'], true),
  op('settlements_respond','Approve or decline a payment someone recorded to you, or cancel one you recorded. The ID comes from settlements pending.', {
    group, settlement: id('Pending payment ID.'), action: enumeration('approve or decline as the recipient; cancel as the payer.', ['approve','decline','cancel'])
  }, ['group','settlement','action']),
  op('settle_up','Request approval for a payment you made, or record a payment you received. The recipient confirms the payment.', { group, from: member, to: member, amount: money, currency }, ['group','from','to','amount']),
  op('activity','List expenses, settlements and payment requests awaiting your confirmation or sent by you, newest first. Optionally filter by group.', { group }, [], true)
];
