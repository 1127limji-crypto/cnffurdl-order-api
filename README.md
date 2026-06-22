# cnffurdl-order-api

견적서와 네이버 스마트스토어 주문 자동매칭 버전입니다.

## Matching

1. 견적번호 exact match
2. 구매자명 + 결제금액 match
3. 수동 매칭 API

## Endpoints

- `/naver/unshipped-orders`
- `/stored/naver-orders`
- `/stored/estimates`
- `POST /stored/match-estimate-naver`
- `POST /stored/unmatch-estimate`
