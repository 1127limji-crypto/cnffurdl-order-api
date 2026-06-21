# cnffurdl-order-api secure

Firebase Admin SDK로 관리자 Google 로그인 토큰을 검증한 뒤 네이버 주문 API를 호출합니다.

## Required Cloudtype Environment Variables

```text
NAVER_COMMERCE_CLIENT_ID=
NAVER_COMMERCE_CLIENT_SECRET=

FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=

ADMIN_EMAILS=1127limji@gmail.com,cont834@gmail.com
```

## Test

```text
/naver/env-check
```

`/naver/orders`, `/naver/token-test`, `/naver/confirm-order`는 Firebase ID Token이 필요합니다.
