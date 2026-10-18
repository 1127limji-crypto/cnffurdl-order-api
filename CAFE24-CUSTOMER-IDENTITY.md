# Cafe24 customer identity in the normalized feed

`GET /cafe24/orders-normalized` now preserves the upstream order/buyer
`member_id` and `shop_no` as `buyerMemberId` / `shopNo` and also inside the
existing `rawPayload` object (`member_id`, `shop_no`). Authentication remains
unchanged. Order amounts, statuses, items and shipping fields retain their
existing behavior.

The Production Manager importer must preserve `rawPayload` when updating an
order. Its analytics can key identified members by the tuple
`(channel, shop_no, member_id)`. A member ID alone must not be joined across
stores or shops. Guest orders keep a null member ID; do not invent one from a
display name or shipping recipient. Any guest grouping needs a separately
documented policy and identification coverage indicator.

Deployment of this gateway change does not backfill stored orders by itself.
Re-read the affected dates through the existing authenticated sync and verify
the importer and customer dashboard against the updated payload. Do not equate
member count with all buying customers, or guest orders with new customers.

This change does not add the finance reconciliation endpoint or alter finance
verification status. Those need the exact contract expected by the current
Production Manager client and a separate deployment verification.

Validation: `node --test test-cafe24-customer.cjs` and `node --check server.js`.
