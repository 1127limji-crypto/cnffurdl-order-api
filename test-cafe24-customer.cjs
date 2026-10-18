const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Exercise the real feed normalizer without booting the HTTP server or reading
// credentials. These fixtures are synthetic and contain no customer PII.
const source = fs.readFileSync(require.resolve('./server.js'), 'utf8');
const start = source.indexOf('function cafe24V3Number(');
const end = source.indexOf('\napp.get(', start);
assert.ok(start >= 0 && end > start, 'normalized feed section exists');
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);
const normalize = input => JSON.parse(JSON.stringify(context.cafe24V3NormalizeOrder(input)));

const fixture = overrides => ({
  order_id: 'TEST-ORDER-001', paid: 'T', canceled: 'F', shop_no: 2,
  payment_amount: '2400.00', buyer: {},
  items: [{order_item_code: 'TEST-ITEM-001', product_name: 'Fixture',
    quantity: 2, product_price: '1000.00', option_price: '200.00', order_status: 'N10'}],
  ...overrides
});

test('member and shop identifiers survive the normalized feed and persisted raw payload', () => {
  const order = normalize(fixture({member_id: ' member-001 '}));
  assert.equal(order.buyerMemberId, 'member-001');
  assert.equal(order.rawPayload.member_id, 'member-001');
  assert.equal(order.shopNo, 2);
  assert.equal(order.rawPayload.shop_no, 2);
  assert.equal(order.externalOrderId, 'TEST-ORDER-001');
  assert.equal(order.items[0].totalPrice, 2400);
  assert.equal(order.items[0].quantity, 2);
  assert.equal(order.orderStatus, 'PAYED');
});

test('buyer embed supplies the member ID when the order field is absent or blank', () => {
  const order = normalize(fixture({member_id: ' ', buyer: {member_id: 'member-002'}}));
  assert.equal(order.rawPayload.member_id, 'member-002');
});

test('explicit order member ID takes precedence over the embedded buyer', () => {
  const order = normalize(fixture({member_id: 'member-001', buyer: {member_id: 'member-002'}}));
  assert.equal(order.rawPayload.member_id, 'member-001');
});

test('guest identity remains unknown and is never taken from receiver or display name', () => {
  const order = normalize(fixture({buyer: {name: 'Fixture Name'},
    receivers: [{member_id: 'recipient-only', name: 'Fixture Recipient'}]}));
  assert.equal(order.buyerMemberId, null);
  assert.equal(order.rawPayload.member_id, null);
});

test('the single-shop feed keeps its existing default and preserves legacy fields', () => {
  const order = normalize(fixture({shop_no: undefined}));
  assert.equal(order.shopNo, 1);
  assert.equal(order.rawPayload.source, 'cafe24');
  assert.equal(order.rawPayload.payment_amount, '2400.00');
  assert.equal(order.rawPayload.paid, 'T');
  assert.equal(order.items[0].externalItemId, 'TEST-ITEM-001');
});
