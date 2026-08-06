# API 사용법

상태: 저장형 MVP와 실시간 파일·텍스트 연결 계약

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

## 받기 코드 판별

저장형과 실시간 코드는 활성 상태에서 하나의 코드 공간을 공유한다. 받는 클라이언트는 방식 선택 없이 다음 API로 코드 종류를 확인한다.

```bash
curl --fail-with-body \
  -H 'Accept: application/json' \
  http://127.0.0.1:3000/api/codes/012345
```

성공 응답은 `200`, `Cache-Control: no-store`다.

```json
{
  "code": "012345",
  "kind": "stored"
}
```

`kind`는 `stored` 또는 `live`다. 존재하지 않거나 만료된 코드는 `404 CODE_NOT_FOUND`다. 직접 공유 링크 `/s/:code`와 실시간 링크 `/live/:code`는 이 판별 API를 거치지 않는다.

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

## 실시간 파일·텍스트 연결

실시간 API는 파일·텍스트 본문을 받지 않는다. 브라우저가 WebRTC 데이터 채널을 열기 위한 임시 토큰·SDP·ICE 신호만 10분 동안 프로세스 메모리에 둔다. API만 호출해서 본문을 전송할 수는 없으며 WebRTC 피어 구현이 필요하다. 웹 클라이언트의 데이터 채널 프로토콜은 텍스트와 파일 매니페스트, 파일별 시작·64 KiB 이하 이진 청크·종료, 전체 완료, 취소와 수령 확인을 순서대로 보낸다.

### 세션 생성

```bash
curl --fail-with-body -X POST \
  http://127.0.0.1:3000/api/live-sessions
```

성공 응답은 `201`, `Cache-Control: no-store`다.

```json
{
  "code": "012345",
  "liveUrl": "http://127.0.0.1:3000/live/012345",
  "expiresAt": "2026-08-06T01:10:00.000Z",
  "senderToken": "32자리-임의-토큰",
  "iceServers": []
}
```

`senderToken`은 보내는 브라우저 내부에서만 사용하며 공유 링크나 QR에 넣지 않는다.

### 수령자 참가

```bash
curl --fail-with-body -X POST \
  http://127.0.0.1:3000/api/live-sessions/012345/join
```

첫 수령자에게만 `201`과 `receiverToken`이 반환된다. 이후 참가 요청은 `409 LIVE_SESSION_UNAVAILABLE`이다. 참가가 완료되면 보내는 쪽 신호 큐에 `peer-ready`가 추가된다.

### 신호 조회

각 피어는 마지막으로 처리한 `sequence`를 `after`에 넣는다. 첫 조회는 `after=0`이다.

```bash
curl --fail-with-body \
  'http://127.0.0.1:3000/api/live-sessions/012345/signals?token=피어-토큰&after=0'
```

```json
{
  "expiresAt": "2026-08-06T01:10:00.000Z",
  "messages": [
    {
      "sequence": 1,
      "signal": { "type": "peer-ready" }
    }
  ]
}
```

### SDP·ICE 신호 등록

`POST /api/live-sessions/:code/signals`에 자신의 토큰과 상대 피어에게 전달할 신호를 보낸다. 성공은 `202`다.

```json
{
  "token": "피어-토큰",
  "signal": {
    "type": "description",
    "description": {
      "type": "offer",
      "sdp": "브라우저가 생성한 SDP"
    }
  }
}
```

ICE 후보 신호는 다음 형태다.

```json
{
  "token": "피어-토큰",
  "signal": {
    "type": "candidate",
    "candidate": {
      "candidate": "candidate:...",
      "sdpMid": "0",
      "sdpMLineIndex": 0,
      "usernameFragment": null
    }
  }
}
```

SDP는 최대 64 KiB, 후보 문자열은 최대 4 KiB다. 파일·텍스트 본문을 신호 필드에 넣지 않는다.

### 세션 닫기

```bash
curl --fail-with-body -X DELETE \
  'http://127.0.0.1:3000/api/live-sessions/012345?token=피어-토큰'
```

유효한 보내는 쪽 또는 받는 쪽 토큰이면 `204`로 메모리 세션을 즉시 제거한다. 서버 재시작 또는 10분 만료 때도 세션은 사라진다.

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

| HTTP  | 코드                                                                       | 의미                                                |
| ----- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| `400` | `INVALID_INPUT`, `INVALID_MULTIPART`, `UPLOAD_ABORTED`, `TOO_MANY_PARTS`   | 입력·multipart 형식 오류 또는 중단된 업로드         |
| `408` | `UPLOAD_TIMEOUT`                                                           | 업로드 제한 시간 초과                               |
| `404` | `CODE_NOT_FOUND`, `SHARE_NOT_FOUND`, `LIVE_SESSION_NOT_FOUND`, `NOT_FOUND` | 통합 코드·공유·라이브 세션·API 경로가 없거나 만료됨 |
| `409` | `LIVE_SESSION_UNAVAILABLE`                                                 | 라이브 세션에 이미 수령자가 참가함                  |
| `413` | `SHARE_TOO_LARGE`                                                          | 텍스트·파일 또는 합산 제한 초과                     |
| `429` | `RATE_LIMITED`                                                             | 요청 제한 초과                                      |
| `503` | `CODE_UNAVAILABLE`, `LIVE_SESSION_CAPACITY`                                | 저장형 코드 예약 또는 라이브 메모리 용량 부족       |
| `500` | `INTERNAL_ERROR`                                                           | 일반화된 저장 또는 서버 오류                        |

클라이언트는 오류 메시지 문자열보다 `error.code`와 HTTP 상태를 기준으로 분기한다.

## 상태 확인

```bash
curl --fail-with-body http://127.0.0.1:3000/api/health
```

정상 응답은 `{"status":"ok"}`다.
