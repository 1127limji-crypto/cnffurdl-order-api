# Epost channel dispatch

Shipping routes require the existing Production Manager internal key. No new secret or Firestore collection is introduced. Existing order reads, token refresh and estimate functions are unchanged.

- GET /shipping/epost/capabilities: module version and current Cafe24 granted scopes. Availability is not proof of a live postal acceptance or successful dispatch.
- POST /shipping/epost/dispatch: channel, orderId, itemIds, trackingNo, dispatchedAt, checkOnly. Only selected paid/prepared items are sent. Existing carrier/tracking must match when already dispatched. Claims and item-quantity splits are blocked.
- checkOnly=true never writes to shopping channels. Network failures are uncertain and are not automatically retried. Production Manager persists the per-parcel attempt before calling this endpoint and requires reconciliation for unknown results. The gateway also blocks concurrent calls for one order within the configured single instance.
- Label printing and postal acceptance do not invoke these routes. An operator must explicitly confirm actual dispatch in Production Manager.

Cafe24 shipping reauthorization uses /cafe24/oauth/start?shipping=1 after the existing developer app is approved for mall.write_order and mall.read_shipping. It retains mall.read_order. The ordinary OAuth URL continues requesting only order read. Credentials and encrypted token persistence remain unchanged. Permission approval is an operator action, not part of deployment.

Tests (mock external writes): node test-dispatch.cjs; node test-dispatch-http.cjs; node test-startup.cjs.

Official schemas checked 2026-09-23:
https://apidocs.cafe24.com/en/docs/admin/post-orders-by-order-id-shipments
https://apidocs.cafe24.com/en/docs/admin/get-carriers
https://apidocs.cafe24.com/en/docs/guide/oauth2-authentication
https://apicenter.commerce.naver.com/docs/commerce-api/current/seller-dispatch-product-orders-pay-order-seller

Rollback: revert only the shipping integration commit and redeploy the existing service with unchanged environment. Do not restore stale OAuth tokens on ordinary code rollback.
