# cnffurdl-order-api

출력이 스마트스토어 주문 연동 API 서버입니다.

## 현재 포함된 기능

- `/` 서버 상태 확인
- `/health` 헬스 체크
- `/ip` Cloudtype 서버의 외부 호출 IP 확인
- `/naver/env-check` 네이버 환경변수 설정 여부 확인
- `/naver/token-test` 네이버 커머스API 인증 토큰 발급 테스트
- `/naver/orders` 스마트스토어 결제완료 주문 조회 테스트

## 주문 조회 테스트

최근 23시간 결제완료 주문 조회:

```text
https://배포주소/naver/orders
```

기간 직접 지정:

```text
https://배포주소/naver/orders?from=2026-06-21T00:00:00.000%2B09:00&to=2026-06-21T23:59:59.000%2B09:00
```

상태 조건 없이 조회:

```text
https://배포주소/naver/orders?productOrderStatuses=
```

## Cloudtype 환경변수

```text
NAVER_COMMERCE_CLIENT_ID=네이버 애플리케이션 ID
NAVER_COMMERCE_CLIENT_SECRET=네이버 애플리케이션 시크릿
```
