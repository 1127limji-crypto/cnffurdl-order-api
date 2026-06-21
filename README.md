# cnffurdl-order-api secure estimate status

견적 상태 관리 및 삭제 기능을 지원합니다.

## Estimate status

- UNPAID: 미결제
- PAID: 결제완료
- CONFIRMED: 주문확인
- SHIPPED: 발송완료

## New endpoints

- GET `/stored/estimates`
- PATCH `/stored/estimates/:estimateId/status`
- DELETE `/stored/estimates/:estimateId`

Firebase ID Token required.
