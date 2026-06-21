# cnffurdl-order-api

출력이 스마트스토어 주문 연동 API 서버입니다.

## 현재 포함된 기능

- `/` 서버 상태 확인
- `/health` 헬스 체크
- `/ip` Cloudtype 서버의 외부 호출 IP 확인
- `/naver/env-check` 네이버 환경변수 설정 여부 확인
- `/naver/token-test` 네이버 커머스API 인증 토큰 발급 테스트

## Cloudtype 환경변수

Cloudtype 시크릿에 아래 값을 넣어주세요.

```text
NAVER_COMMERCE_CLIENT_ID=네이버 애플리케이션 ID
NAVER_COMMERCE_CLIENT_SECRET=네이버 애플리케이션 시크릿
```

필요 시 추가:

```text
NAVER_COMMERCE_AUTH_TYPE=SELF
NAVER_COMMERCE_ACCOUNT_ID=
```

## 배포 후 확인

```text
https://배포주소/
https://배포주소/naver/env-check
https://배포주소/naver/token-test
```
