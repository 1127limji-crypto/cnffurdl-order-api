# Manually supplied tracking numbers

`POST /shipping/manual/preview` and `POST /shipping/manual/dispatch` use the existing internal authentication key and the existing encrypted Cafe24 token store. There is no postal acceptance, label generation, printing, or scan mutation in these routes.

Preview requires one channel order ID and explicit product-order IDs. Cafe24 carriers come from the shop's registered `/api/v2/admin/carriers` list; IDs and shipping carrier codes are resolved server-side. Naver carrier names/codes are from the official Commerce API 2.89.0 (2026-09-15) dispatch schema. `manual-naver-carriers.json` is the allowlist; it is not shared with Cafe24.

Dispatch reads every selected item immediately before writing. The server excludes claims, non-delivery items, already dispatched conflicting numbers, or changed quantity/recipient snapshots. It sends only pending eligible item IDs. Cafe24 writes `status: shipping`; Naver uses `deliveryMethod: DELIVERY`. Both paths read the selected items again and return verified carrier + tracking + status matches, pending IDs, uncertain IDs, and excluded IDs separately. A 200 response or a success ID alone does not verify a shipment.

Manual and Epost dispatch share the same per-order in-flight guard. The production manager additionally persists a revision-checked dispatch intent before calling the gateway. Unknown outcomes must be reconciled before retry; partial retry rechecks and sends only still-pending items. The Naver live-validation order gate remains in the production manager's protected configuration.

Official sources:
- https://apicenter.commerce.naver.com/docs/commerce-api/current/seller-dispatch-product-orders-pay-order-seller
- https://apidocs.cafe24.com/en/docs/admin/post-orders-by-order-id-shipments
- https://apidocs.cafe24.com/en/docs/admin/get-carriers

Checks: `node test-manual-shipping.cjs`, existing `test-dispatch.cjs`, `test-dispatch-http.cjs`, `test-naver-preview.cjs`, and `test-naver-shipping.cjs`. Use fixtures only; never use a customer order or invented tracking number for a production write test.
