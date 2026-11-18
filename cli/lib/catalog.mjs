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
const allocation = {
  rate: { ...text('Manual rate, group currency units per one expense currency.'), pattern:'^[0-9]{1,8}([.][0-9]{1,8})?$' },
  category: text('Spending category.',50), title: text('Expense description.'), amount: money, payer: member, currency,
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
function op(name, description, properties = {}, required = [], readOnly = false, destructive = false) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: false } };
}
export const tools = [
  op('groups_default_split','Set default weights in member order. Supply empty arrays to restore equal splits.',{group,participants:{type:'array',items:member,maxItems:50,uniqueItems:true},weights:{type:'array',items:{type:'integer',minimum:1,maximum:1000},maxItems:50}},['group','participants','weights']),
  op('members_payment','Replace your own payment profile for a group. Omitted handles are cleared.',{group,paypal:text('PayPal.Me username',40),venmo:text('Venmo username',40),mercado:text('Mercado Pago payment link'),alias:text('Argentine alias or CVU',22)},['group']),
  op('expenses_repeat','Set or cancel the schedule for your fixed-currency expense.',{group,expense,cadence:enumeration('UTC schedule.',['off','daily','weekly','monthly','yearly'])},['group','expense','cadence']),
  op('groups_breakdown','Spending, categories, months, paid, shares, balances and suggested transfers by currency. Provide a member ID for their expense detail.',{group,member},['group'],true),
  op('items_open','List open purchases with tax and tip included in each gross amount.',{group},['group'],true),
  op('items_claim','Add or remove a claimant on a purchase. Defaults to yourself.',{group,expense,item:id('Receipt item ID.'),member,action:enumeration('Defaults to add.',['add','remove'])},['group','expense','item']),
  op('items_close','As payer, close a receipt and split remaining purchases across the selected members or everyone.',{group,expense,participants:list('Members for remaining items.',member)},['group','expense']),
  op('receipts_list','List receipt photo IDs on an expense.',{group,expense},['group','expense'],true),
  op('receipts_get','Read one private receipt photo as base64 JPEG.',{group,expense,photo:id('Receipt photo ID.')},['group','expense','photo'],true),
  op('groups_list','List groups you belong to.', {}, [], true),
  op('groups_show','Show one group and its members.', { group }, ['group'], true),
  op('groups_create','Create a group with you and optional placeholder members.', {
    name: text('Group name.',80), self: text('Your display name in this group.',60),
    kind: enumeration('Group type, defaults to trip.', ['trip','home','friend']), currency,
    placeholders: list('Names of unclaimed members.', text('Name.',60))
  }, ['name','self']),
  op('members_list','List claimed and placeholder member IDs.', { group }, ['group'], true),
  op('members_lookup','Find a Split user by exact email, username, or a shared group member’s name.', { query: text('Search term.',254) }, ['query'], true),
  op('members_add','Add a placeholder or an existing Split user to a group.', {
    group, name: text('Member display name.',60), user: text('Existing user ID returned by members lookup.',128),
    email: text('Optional placeholder email for verified matching.',254), phone: text('Optional placeholder contact number.',32)
  }, ['group','name']),
  op('invite','Create a group invitation, or target a placeholder member. Returns a link and code.', { group, member }, ['group']),
  op('join','Claim an invited member slot with a Split invite link or code.', { invite: text('Invite link or code.',512) }, ['invite']),
  op('expenses_list','List expenses in a group. Amounts in results are integer minor units.', { group }, ['group'], true),
  op('expenses_add','Record an expense with an equal, exact, weighted or percentage allocation.', { group, ...allocation }, ['group','title','amount','payer']),
  op('expenses_edit','Preview changes to your expense. Review the preview before confirming with yes and revision.', { group, expense, ...allocation, ...confirmation }, ['group','expense'], false, true),
  op('expenses_delete','Preview deletion of your expense. Review the preview before confirming with yes and revision.', { group, expense, ...confirmation }, ['group','expense'], false, true),
  op('balances','Show each member’s net balance and suggested settlements, separately by currency, in minor units.', { group }, ['group'], true),
  op('settle_up','Record a settlement from one member to another. This records a payment already made.', { group, from: member, to: member, amount: money, currency }, ['group','from','to','amount']),
  op('activity','List expenses and settlements newest first, optionally filtered by group.', { group }, [], true)
];
