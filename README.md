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


추가 변경: 견적서번호 앞의 "견적서번호" 텍스트 없이 `260622-000001` 형태의 숫자 번호만으로도 자동 매칭됩니다.


Fix: `/naver/unshipped-orders`에서 누락된 날짜/상세조회 helper 함수를 복구했습니다.


Added: `/public/next-estimate-no` 공통 견적번호 발급 API. estimate.html과 estimate-foil.html이 같은 번호 시퀀스를 사용합니다.


Fix: Express route typo corrected. `/naver/env-check` route now starts correctly.


Fix: 견적번호 추출을 `260622-000004` 형태로 엄격화했습니다. 네이버 옵션코드 숫자는 매칭견적으로 인식하지 않습니다.
