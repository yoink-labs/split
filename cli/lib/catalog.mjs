// The CLI help, CLI parser and both MCP transports share these tool definitions.
const text = (description, maxLength = 120) => ({ type: 'string', description, minLength: 1, maxLength });
const id = description => ({ ...text(description, 80), pattern: '^[a-zA-Z0-9_-]{8,80}$' });
const money = { ...text('Amount in major currency units, e.g. "12.50".'), pattern: '^(0|[1-9][0-9]{0,9})([.][0-9]{1,2})?$' };
const enumeration = (description, values) => ({ type: 'string', description, enum: values });
const group = id('Group ID from groups list.');
const expense = id('Expense ID from expenses list.');
const member = id('Member ID from members list.');
const currency = enumeration('Three-letter currency. Defaults to the group currency.', ['USD','ARS','EUR','GBP','BRL','CAD','AUD','MXN']);
// Keep in sync with CategoryMeta.all in Split/Core/Categories.swift.
const categories = ['General', 'Dining', 'Groceries', 'Liquor', 'Rent', 'Home', 'Utilities', 'Transport',
  'Travel', 'Entertainment', 'Shopping', 'Health', 'Education', 'Gifts', 'Fees', 'Other'];
const category = enumeration('Spending category (case-sensitive). Choose from: ' + categories.join(', ') + '.', categories);
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
  description: 'Up to four JPEG receipt photos (240 KiB each), encoded as base64. Pass --photo PATH on the command line or absolute paths to local split mcp. Local files support JPEG, HEIC and PNG with automatic resizing. Convert PDFs to an image first.',
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
  chargedAmount: { ...text('Actual card charge in settlement currency, e.g. "24.37". Use "none" on edit to clear the override.'), pattern:'^(none|[0-9]{1,10}([.][0-9]{1,2})?)$' },
  rate: { ...text('Group currency per 1 unit of expense currency. For a BRL expense in a USD group, --rate 0.18 means 1 BRL = 0.18 USD. On add, a saved trip rate is used when available.'), pattern:'^[0-9]{1,8}([.][0-9]{1,8})?$' },
  category, title: text('Expense description.'), amount: money, payer: member, currency,
  notes: text('Optional notes on this expense.', 2000),
  pending: { type: 'boolean', description: 'Mark the expense pending: its cost may still change, e.g. while a refund is requested. Pending expenses still count toward balances.' },
  pendingNote: text('Optional reason it is pending.', 500),
  payers: payerSplit,
  mode: enumeration('How to allocate the expense.', ['equal','exact','percent','shares','nights']),
  spreadStart: day('First day of the spread, inclusive.'),
  spreadEnd: day('Last day of the spread, exclusive. For nights, each person starts on the first day.'),
  participants: list('Member IDs, in rounding order. Equal split defaults to all members.', member),
  values: listValues()
};
function listValues() {
  return { type: 'array', description: 'Decimal strings in participant order. Exact values must sum to the amount. Percent values must sum to 100. Nights uses whole numbers.', items: money, minItems: 1, maxItems: 50 };
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
  op('expenses_dispute','Dispute an expense you share and post the reason for the payer.',{group,expense,comment:text('Why you are disputing it.',2000)},['group','expense','comment']),
  op('disputes_list','List open disputes in your groups, including those you can resolve.',{group},[],true),
  op('disputes_history','List dispute actions in your groups.',{group},[],true),
  op('disputes_dismiss','Dismiss an open dispute with a reply as payer or recorder.',{group,expense,comment:text('Reply to the dispute.',2000)},['group','expense','comment']),
  op('disputes_withdraw','Withdraw a dispute you opened.',{group,expense,comment:text('Optional reply.',2000)},['group','expense']),
  op('expenses_pending','Mark an expense or refund pending, with an optional note about why its cost may change, or confirm it again. The recorder or a payer can change it.',{group,expense,state:enumeration('Defaults to pending.',['pending','confirmed']),note:text('Optional reason it is pending.',500)},['group','expense']),
  op('expenses_resolve','Resolve a pending expense: confirm it as is, adjust its amount (every share and payer rescales exactly to the cent), or record a refund of it and confirm it together.',{group,expense,
    action:enumeration('confirm, adjust or refund.',['confirm','adjust','refund']),
    amount:{...money,description:'New total for adjust, or the refunded amount for refund.'},
    receiver:{...member,description:'Who received the refund. Defaults to the original payer.'},
    participants:list('Refund: member IDs to credit. Defaults to everyone who shared the expense, in proportion to their shares.',member),
    values:{...listValues(),description:'Refund: exact credits in participant order. They must sum to the amount. Omit to split in proportion to shares.'},
    title:text('Refund description. Defaults to "Refund: <expense title>".')},['group','expense','action']),
  op('refunds_add','Record a refund of an expense or a standalone credit. A refund lowers the shares of the people credited and the balance of whoever received the money. Linked refunds cannot exceed the original amount or any one person’s share.',{group,
    expense:{...expense,description:'Original expense ID. Omit for a standalone credit.'},
    amount:{...money,description:'Refunded amount. Omit when refunding items.'}, receiver:{...member,description:'Who received the money back, or who is giving the credit. Defaults to the original payer.'},
    items:list('Receipt item IDs from items list to refund. Each person who had an item gets back exactly what it cost them, tax and tip included.',id('Receipt item ID.')),
    participants:list('Member IDs to credit. For a linked refund, defaults to everyone who shared it in proportion to their shares.',member),
    values:{...listValues(),description:'Exact credits in participant order, summing to the amount. Omit to split in proportion to shares (linked) or equally (standalone).'},
    title:text('Description. Defaults to "Refund: <expense title>" or "Credit".'), notes:text('Optional notes.',2000),
    date:{ ...text('Optional date YYYY-MM-DD.', 10), pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    pending:{type:'boolean',description:'Mark the refund pending until it arrives.'}, pendingNote:text('Optional reason it is pending.',500)},['group']),
  op('expenses_repeat','Set or cancel the schedule for your fixed-currency expense.',{group,expense,cadence:enumeration('Repeat cadence: off, daily, weekly, monthly, or yearly.',['off','daily','weekly','monthly','yearly'])},['group','expense','cadence']),
  op('groups_daily','Daily costs per person in original currencies, with each expense and refund itemized.',{group,member},['group'],true),
  op('groups_breakdown','Spending, categories, months, paid, shares, ledger net and suggested transfers by currency. Ledger net includes handled expenses. Suggested transfers use outstanding balances. Provide a member ID for their expense detail.',{group,member},['group'],true),
  op('items_open','List open purchases with tax and tip included in each gross amount.',{group},['group'],true),
  op('items_list','List a transaction’s items, including the whole-amount item for transactions without a receipt bill, with exact portions and any share multipliers.',{group,expense},['group','expense'],true),
  op('items_claim','Add or remove a claimant on a purchase. Defaults to yourself. Use share for a partial claim, e.g. 0.5 or 2.',{group,expense,item:id('Receipt item ID.'),member,share,action:enumeration('Defaults to add.',['add','remove'])},['group','expense','item']),
  op('items_assign','Replace the claimants of one purchase in a single call. Supply shares in participant order for uneven splits. An empty participants array reopens the receipt. The receipt closes automatically when all items are assigned.',{group,expense,item:id('Receipt item ID.'),participants:{type:'array',description:'Member IDs who share this item.',items:member,maxItems:50,uniqueItems:true},shares:{type:'array',description:'Share multipliers in participant order. Defaults to 1 each.',items:shareNumber,maxItems:50}},['group','expense','item','participants']),
  op('items_close','As payer, assign remaining purchases to the selected members or everyone and close the receipt.',{group,expense,participants:list('Members for remaining items.',member)},['group','expense']),
  op('receipts_reopen','Reopen a closed itemized receipt without changing its assignments.',{group,expense},['group','expense']),
  op('receipts_people','Add or remove people across receipt items. A photo-only expense uses an equal direct split.',{group,expense,add:list('Members to add.',member),remove:list('Members to remove.',member)},['group','expense']),
  op('receipts_list','List receipt photo IDs on an expense.',{group,expense},['group','expense'],true),
  op('receipts_get','Read one private receipt photo as base64 JPEG. Omit expense to read a receipt from the group inbox.',{group,expense,photo:{...text('Receipt photo ID.',321),pattern:'^[a-zA-Z0-9_-]{8,321}$'}},['group','photo'],true),
  op('receipts_inbox','List receipts uploaded to the group inbox that are not paired with an expense yet.',{group},['group'],true),
  op('receipts_upload','Upload receipt photos to the group inbox to pair with an expense later.',{group,photos:receiptPhotos,note:text('Optional note shown in the inbox, e.g. "Taxi to the airport".',200)},['group','photos']),
  op('receipts_pair','Attach a receipt from the group inbox to an expense in the same group.',{group,photo:id('Inbox receipt ID from receipts inbox.'),expense},['group','photo','expense']),
  op('receipts_move','Move a receipt from one expense to another expense in the same group, or back to the inbox with --to inbox.',{group,expense,photo:id('Receipt photo ID.'),to:{...text('Destination expense ID, or "inbox".',80),pattern:'^(inbox|[a-zA-Z0-9_-]{8,80})$'}},['group','expense','photo','to']),
  op('receipts_delete','Delete a receipt you uploaded from the group inbox.',{group,photo:id('Inbox receipt ID from receipts inbox.')},['group','photo'],false,true),
  op('items_report','Consumption by person: every item each person had, from itemized receipts and whole expenses, with item, tax and tip totals, by currency. Provide member for one person.',{group,member},['group'],true),
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
  op('members_known','List friends and active members of groups you share. Returns only names, avatars and account IDs.', {}, [], true),
  op('members_invite','Send a group invitation to someone you know. They can accept or decline from the inbox.', {
    group, user: text('Known user ID.',128), member
  }, ['group','user']),
  op('members_link','Permanently link a placeholder and its history to a friend or shared group member. Returns the placeholder, account, kept and merged member IDs, and counts of linked expenses, splits, and receipts.', {
    group, member, user: text('Known user ID.',128)
  }, ['group','member','user'], false, true),
  op('members_links','List placeholder links recorded in a group’s activity.', { group }, ['group'], true),
  op('friends_list','List your accepted friends.', {}, [], true),
  op('friends_shared','List accounts in groups you currently share.', {}, [], true),
  op('friends_request','Send a friend request by full sign-in email or by account ID from friends shared.', {
    email: text('Full email address.',254), user: text('Shared group member account ID.',128)
  }, []),
  op('friends_remove','Remove a friendship for both accounts.', { user: text('Friend account ID.',128) }, ['user'], false, true),
  op('invitations_list','List your pending group invitations, friend requests and unread placeholder link notifications.', {}, [], true),
  op('invitations_accept','Accept a group invitation or friend request by the ID from invitations list.', { invitation: { ...text('Invitation ID.', 64), pattern: '^[a-f0-9]{64}$' } }, ['invitation']),
  op('invitations_decline','Decline a group invitation or friend request, or dismiss a placeholder link notification.', { invitation: { ...text('Invitation ID.', 64), pattern: '^[a-f0-9]{64}$' } }, ['invitation'], false, true),
  op('profile_discoverable','Show or change whether people can send friend requests to your full sign-in email.', { discoverable: enumeration('on or off. Omit to show the current setting.', ['on','off']) }, []),
  op('members_add','Add a placeholder or an existing Split user to a group.', {
    group, name: text('Member display name.',60), user: text('Known user ID returned by members known.',128),
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
  op('expenses_list','List expenses and refunds with dates, payers, pending status and IDs. Amounts in results are integer minor units.', { group }, ['group'], true),
  op('expenses_add','Record a standard or itemized expense. Supply an amount for standard expenses. Itemized expenses use the sum of the bill, and any supplied amount must match it.', {
    group, ...allocation,
    date: { ...text('Optional expense date YYYY-MM-DD.', 10), pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    bill: receiptBill,
    photos: receiptPhotos
  }, ['group','title','payer']),
  op('expenses_combine','Preview combining same-currency expenses, preserving who paid and every receipt. Defaults to an equal split. Confirm with yes and the revision from the preview.', {
    ...confirmation, group, expenses:{...list('Expense IDs to combine.',expense),minItems:2}, title:allocation.title,
    mode:enumeration('How to allocate the combined total.', ['equal','exact','percent','shares','adjustment']),
    participants:allocation.participants, values:{...allocation.values, description:'Decimal strings in participant order. For adjustments, signed amounts must sum to zero.',
      items:{...money,pattern:'^[+-]?(0|[1-9][0-9]{0,9})([.][0-9]{1,2})?$'}},
  }, ['group','expenses'], false, true),
  op('expenses_uncombine','Restore the original expenses and their receipts and splits.', {group,expense}, ['group','expense']),
  op('expenses_suggestions','Find nearby ride expenses with matching destination descriptions.', {group}, ['group'], true),
  op('expenses_combination_activity','List combines and reversals in a group.', {group}, ['group'], true),
  op('expenses_show','Show one expense in full, including payers, splits, exchange, receipts, comments and likes.', { group, expense: id('Full expense ID or a unique prefix of at least eight characters from expenses list.') }, ['group','expense'], true),
  op('expenses_like','Like or unlike an expense.', { group, expense }, ['group','expense']),
  op('comments_list','List comments on an expense.', { group, expense }, ['group','expense'], true),
  op('comments_add','Comment on an expense.', { group, expense, text: text('Comment.', 2000) }, ['group','expense','text']),
  op('comments_delete','Delete one of your comments.', { group, expense, comment: id('Comment ID.') }, ['group','expense','comment'], false, true),
  op('receipts_add','Attach up to four receipt photos to an expense you recorded.', { group, expense, photos: receiptPhotos }, ['group','expense','photos']),
  op('expenses_edit','Preview changes to your expense, or supply a bill to break a whole expense into items. Review the preview before confirming with yes and revision.', { group, expense, ...allocation, bill: receiptBill, disputeReply: text('Required reply when resolving a dispute by editing.',2000), ...confirmation }, ['group','expense'], false, true),
  op('expenses_delete','Preview deletion of your expense. Review the preview before confirming with yes and revision.', { group, expense, ...confirmation }, ['group','expense'], false, true),
  op('balances','Show each member’s net balance and suggested settlements, separately by currency, in minor units. Pending expenses count; confirmedNet and pending show the balance without them. Provide a member ID for signed expense, payment and refund lines that add up to their balance.', { group, member }, ['group'], true),
  op('settlements_pending','List payments waiting for approval in a group, who made them and what you can do.', { group }, ['group'], true),
  op('settlements_respond','Approve or decline a payment someone recorded to you, or cancel one you recorded. The ID comes from settlements pending.', {
    group, settlement: id('Pending payment ID.'), action: enumeration('approve or decline as the recipient; cancel as the payer.', ['approve','decline','cancel'])
  }, ['group','settlement','action']),
  op('settle_up','Request approval for a payment you made, or record a payment you received. The recipient confirms the payment.', { group, from: member, to: member, amount: money, currency }, ['group','from','to','amount']),
  op('activity','List expenses, settlements and payment requests awaiting your confirmation or sent by you, newest first. Optionally filter by group.', { group }, [], true)
];
