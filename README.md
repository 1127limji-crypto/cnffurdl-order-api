# cnffurdl-order-api

출력이 스마트스토어 주문 연동 API 서버 starter입니다.

## 현재 포함된 기능

- `/` 서버 상태 확인
- `/health` 헬스 체크
- `/ip` Cloudtype 서버의 외부 호출 IP 확인

## 배포 후 확인

브라우저에서 아래 주소를 열어보세요.

```text
https://배포주소/
https://배포주소/ip
```

`/ip`에서 나온 IP를 네이버 커머스API센터의 API 호출 IP에 등록하면 됩니다.
