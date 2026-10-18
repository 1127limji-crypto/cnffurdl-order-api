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

The gateway also registers the existing Production Manager consumer contract:
`GET /cafe24/finance-orders?ids=...&shop_no=...` returns financial schema 1
original snapshots without buyer/receiver/bank credentials. The existing admin
or internal-key gate protects this route. Bounded exact order IDs, paginated
refund reads, pacing and transient retries prevent silent partial results.
`GET /cafe24/analytics-orders` provides counted seven-day order/pay-date pages
for collection and identity backfill through the existing importer.

Deployment must still verify the authenticated live endpoint, the actual
Cloudtype revision and at least one regular Production Manager sync cycle.
A one-off import is not evidence that periodic reconciliation works.

Validation: customer fixtures, bounded finance feed fixtures, analytics-feed
fixtures, complete server startup, existing auth and shipping HTTP regressions.
