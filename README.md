# 옮기기

내가 운영하는 서버에서 파일 묶음이나 텍스트를 6자리 코드·링크·QR로 간단히 공유하는 웹 서비스다.

첫 MVP 수직 흐름이 구현되어 있다. 여러 파일과 텍스트를 함께 올리고 만료 기한을 고르면 SQLite3에 메타데이터가, 로컬 볼륨에 파일 본문이 저장된다. 생성된 코드나 링크로 다시 열어 텍스트를 복사하고 파일을 개별 다운로드할 수 있다. 자동 검증과 production Chrome의 데스크톱·모바일·라이트·다크 핵심 흐름을 확인했다. Chrome 자동화 연결이 파일 선택 이벤트를 전달하지 못해 웹 파일 선택과 실제 기기 QR 스캔은 비차단 수동 회귀 항목으로 남겨 두었다.

서버에 본문을 남기지 않는 실시간 전송도 구현되어 있다. 보내는 화면이 만든 10분짜리 코드·링크·QR에 수령자 한 명이 참가하면 WebRTC 데이터 채널로 최대 50개, 합계 1 GiB의 파일과 최대 1 MiB 텍스트를 직접 주고받는다. 파일은 64 KiB 청크로 읽고 전송 대기 버퍼를 1 MiB로 제한하며 양쪽 진행률·취소·수령 확인을 지원한다. 시그널링 API는 임의 토큰·SDP·ICE 정보만 프로세스 메모리에 유지한다. 안정적인 실제 네트워크 연결에는 배포 환경에 맞는 STUN/TURN 설정이 필요하다.

받는 사람은 전송 방식을 고를 필요 없이 홈의 단일 입력란에 6자리 코드만 넣는다. 서버가 활성 코드 종류를 판별해 저장된 공유 또는 실시간 연결 화면으로 자동 이동시키며, 두 방식은 하나의 활성 코드 공간을 공유해 서로 같은 코드를 발급하지 않는다.

저장형 공유는 보관 시간이 끝나는 즉시 열린 화면에서도 내용과 코드·링크·QR을 내리고 종료 화면으로 전환한다. 실시간 전송은 수령 확인 뒤 세션 코드를 닫고 보내는 화면에는 완료 상태만, 받는 화면에는 받은 항목만 남긴다.

헤더의 `기록장`에는 현재 브라우저에서 성공한 전송의 파일명·텍스트 포함 여부·용량·시각만 남는다. 저장형 공유의 삭제 관리 키는 일반 생성 결과가 아니라 기록장의 활성 항목에서만 고급 정보로 펼쳐 볼 수 있으며, 삭제 버튼으로 서버 파일과 코드를 즉시 제거할 수 있다. 서버에는 관리 키 해시만 저장되고 삭제·만료 기록에서는 코드와 키가 사라지며, 실시간 성공 기록에는 재사용 가능한 코드가 남지 않는다. 기록과 삭제 권한은 기기 사이에 동기화되지 않는다.

## 로컬 실행

Node.js 24.15 이상과 pnpm 11이 필요하다.

```bash
pnpm install
pnpm dev
```

- 웹: `http://127.0.0.1:5173` (다른 기기에서는 호스트의 LAN IP 사용)
- API: `http://127.0.0.1:3000` (다른 기기에서는 호스트의 LAN IP 사용)
- 로컬 데이터: `./data/transfer.sqlite3`, `./data/files/`

3000번 포트를 다른 프로젝트가 사용 중이면 API 포트를 바꿔 실행한다. Vite의 `/api` 프록시도 같은 `PORT`를 자동으로 사용한다.

```bash
HOST=127.0.0.1 PORT=3100 pnpm dev
```

기본 바인딩은 모든 인터페이스(`0.0.0.0`)다. 로그인 없는 업로드·다운로드는 제품 의도이며, quota·TLS·악용 대응을 포함한 별도 배포 시스템이 준비되기 전에는 공개 인터넷에 노출하지 않는다.
한 업로드 요청의 전체 제한 시간은 30분이다. 1 GiB 전송 시 약 4.8 Mbit/s 이상의 지속 속도가 필요하다.

## 검증과 production 실행

```bash
pnpm check
pnpm build
pnpm start
```

`pnpm check`는 format, lint, client/server typecheck, Vitest, production build를 모두 실행한다. production 서버는 기본적으로 모든 인터페이스의 3000번 포트에서 API와 빌드된 SPA를 함께 제공한다. 로컬 전용은 `HOST=127.0.0.1 pnpm start`로 실행한다.

실행 중인 API의 생성 → 조회 → 파일 2개 다운로드를 별도로 확인하려면 다음 명령을 사용한다.

```bash
pnpm smoke:api
```

컨테이너와 deployd 온보딩 계약도 준비되어 있다. 이미지는 Raspberry Pi 대상인 `linux/arm64`로 빌드하며 로컬 데이터 대신 전용 `/data` 볼륨을 연결한다.

```bash
docker build --platform linux/arm64 -t transfer:local .
docker run --rm \
  --read-only --tmpfs /tmp:size=64m,mode=1777 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -p 127.0.0.1:3000:3000 \
  -v transfer-data:/data \
  -e APP_BASE_URL=http://127.0.0.1:3000 \
  transfer:local
```

컨테이너와 deployd 헬스 체크는 `GET /healthz`를 사용한다. `deploy.json`은 `ghcr.io/hurdoo/transfer`, `linux/arm64`, `pnpm check`뿐 아니라 포트 3000, `/healthz`, private 접근, `/data`, `large-upload`를 사용자 검토용 배포 계약으로 고정한다. Codex는 ARM64 이미지를 GHCR에 게시하고 이 계약과 digest를 핸드오프 JSON으로 만들며, 실제 Pi 런타임·Nginx·인증서 생성과 첫 릴리스는 사용자가 deployd 대시보드에서 승인한다.

## 환경 변수

- `PORT`: API/production 포트, 기본 `3000`
- `HOST`: 바인딩 주소, 기본 `0.0.0.0`; 로컬 전용은 `127.0.0.1`
- `STORAGE_DIR`: SQLite3와 파일 저장 루트, 기본 `./data`
- `APP_BASE_URL`: 공유 절대 URL의 신뢰할 기준 주소. production에서는 명시한다.
- `LIVE_ICE_SERVERS`: 실시간 WebRTC용 `RTCIceServer[]` JSON. 기본값은 `[]`이며 제한적인 NAT·방화벽 환경에는 운영 STUN/TURN을 지정한다.

예를 들어 STUN 하나를 지정할 때는 다음처럼 실행한다. 서비스 주소는 운영자가 선택한다.

```bash
LIVE_ICE_SERVERS='[{"urls":"stun:stun.example.com:3478"}]' pnpm start
```

TURN을 사용할 때는 `username`과 `credential`을 함께 넣는다. 자격 증명을 저장소나 명령 기록에 장기간 남기지 말고 배포 시스템의 비밀값으로 주입한다.

## API 예시

```bash
curl -F expiresIn=1d \
  -F 'text=옮길 메모' \
  -F files=@./example.txt \
  http://127.0.0.1:3000/api/shares
```

응답의 6자리 코드는 `GET /api/codes/:code`로 종류를 판별할 수 있다. 저장형이면 `GET /api/shares/:code`와 각 파일의 `downloadUrl`을 사용하고, 생성 응답의 `managementToken`을 Bearer 헤더로 보내 `DELETE /api/shares/:code`로 즉시 제거할 수 있다. 자세한 범위와 계약은 `docs/SPEC.md`, 구조는 `docs/ARCHITECTURE.md`를 따른다.

전체 API 계약, 오류 코드와 curl 예시는 [`docs/API.md`](docs/API.md)에 있다.

LAN 실행, 저장소 백업·복구와 공개 전 체크리스트는 [`docs/OPERATIONS.md`](docs/OPERATIONS.md)를 따른다.
