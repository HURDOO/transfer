# API 사용법

상태: 로컬 MVP 계약

기본 주소는 `http://127.0.0.1:3000`을 예시로 사용한다. 현재 업로드는 인증되지 않으므로 API를 인증·quota·TLS 없이 공개 인터넷에 노출하지 않는다.

## 자동 smoke 검증

서버를 실행한 뒤 다음 명령으로 생성 → 조회 → 파일 2개 다운로드와 바이트 비교를 한 번에 검증한다.

```bash
pnpm smoke:api
```

다른 주소를 확인할 때만 기준 주소를 지정한다.

```bash
API_BASE_URL=http://127.0.0.1:3000 pnpm smoke:api
```

검증 스크립트는 메모리에서 만든 텍스트와 작은 파일 2개만 보내며 만료값은 `1h`다.

## 공유 생성

`POST /api/shares`에 `multipart/form-data`를 보낸다.

```bash
curl --fail-with-body \
  -F expiresIn=1d \
  -F 'text=옮길 메모' \
  -F files=@./first.txt \
  -F files=@./second.bin \
  http://127.0.0.1:3000/api/shares
```

필드:

- `expiresIn`: 필수. `1h`, `1d`, `3d`, `7d`, `30d`, `never` 중 하나
- `text`: 선택. UTF-8 최대 1 MiB
- `files`: 선택·반복 가능. 최대 50개
- `text`와 `files` 중 하나 이상 필요
- 텍스트와 모든 파일의 합계는 최대 1 GiB

성공 응답은 `201`이다.

```json
{
  "code": "012345",
  "shareUrl": "http://127.0.0.1:3000/s/012345",
  "createdAt": "2026-08-05T12:00:00.000Z",
  "expiresAt": "2026-08-06T12:00:00.000Z",
  "text": "옮길 메모",
  "totalBytes": 123,
  "files": [
    {
      "id": "파일 UUID",
      "name": "first.txt",
      "size": 100,
      "mimeType": "text/plain",
      "downloadUrl": "/api/shares/012345/files/파일 UUID"
    }
  ]
}
```

`never`를 사용하면 `expiresAt`은 `null`이다. 코드는 선행 0을 포함할 수 있으므로 숫자가 아니라 6자리 문자열로 다룬다.

## 공유 조회

```bash
curl --fail-with-body \
  -H 'Accept: application/json' \
  http://127.0.0.1:3000/api/shares/012345
```

`GET /api/shares/:code`는 생성 응답과 같은 형태를 반환한다. 존재하지 않거나 만료된 공유는 `404`다.

## 파일 다운로드

조회 응답의 `downloadUrl`을 그대로 사용한다.

```bash
curl --fail-with-body --remote-header-name --remote-name \
  http://127.0.0.1:3000/api/shares/012345/files/파일-UUID
```

파일은 원래 파일명을 담은 `Content-Disposition: attachment`, `application/octet-stream`, `X-Content-Type-Options: nosniff` 헤더로 내려온다.

## 오류 계약

모든 API 오류는 다음 형태다.

```json
{
  "error": {
    "code": "SHARE_NOT_FOUND",
    "message": "코드를 다시 확인해 주세요."
  }
}
```

주요 상태와 코드:

| HTTP  | 코드                                                   | 의미                               |
| ----- | ------------------------------------------------------ | ---------------------------------- |
| `400` | `INVALID_INPUT`, `INVALID_MULTIPART`, `TOO_MANY_PARTS` | 입력이나 multipart 형식 오류       |
| `408` | `UPLOAD_TIMEOUT`                                       | 업로드 제한 시간 초과              |
| `404` | `SHARE_NOT_FOUND`, `NOT_FOUND`                         | 공유·파일·API 경로가 없거나 만료됨 |
| `413` | `SHARE_TOO_LARGE`                                      | 텍스트·파일 또는 합산 제한 초과    |
| `429` | `RATE_LIMITED`                                         | 요청 제한 초과                     |
| `503` | `CODE_UNAVAILABLE`                                     | 활성 코드 예약 실패                |
| `500` | `INTERNAL_ERROR`                                       | 일반화된 저장 또는 서버 오류       |

클라이언트는 오류 메시지 문자열보다 `error.code`와 HTTP 상태를 기준으로 분기한다.

## 상태 확인

```bash
curl --fail-with-body http://127.0.0.1:3000/api/health
```

정상 응답은 `{"status":"ok"}`다.
