# 옮기기

내가 운영하는 서버에서 파일 묶음이나 텍스트를 6자리 코드·링크·QR로 간단히 공유하는 웹 서비스다.

첫 MVP 수직 흐름이 구현되어 있다. 여러 파일과 텍스트를 함께 올리고 만료 기한을 고르면 SQLite3에 메타데이터가, 로컬 볼륨에 파일 본문이 저장된다. 생성된 코드나 링크로 다시 열어 텍스트를 복사하고 파일을 개별 다운로드할 수 있다. 자동 검증과 production Chrome의 데스크톱·모바일·라이트·다크 핵심 흐름을 확인했다. Chrome 자동화 연결이 파일 선택 이벤트를 전달하지 못해 웹 파일 선택과 실제 기기 QR 스캔은 비차단 수동 회귀 항목으로 남겨 두었다.

## 로컬 실행

Node.js 24.15 이상과 pnpm 11이 필요하다.

```bash
pnpm install
pnpm dev
```

- 웹: `http://127.0.0.1:5173` (다른 기기에서는 호스트의 LAN IP 사용)
- API: `http://127.0.0.1:3000` (다른 기기에서는 호스트의 LAN IP 사용)
- 로컬 데이터: `./data/transfer.sqlite3`, `./data/files/`

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

## 환경 변수

- `PORT`: API/production 포트, 기본 `3000`
- `HOST`: 바인딩 주소, 기본 `0.0.0.0`; 로컬 전용은 `127.0.0.1`
- `STORAGE_DIR`: SQLite3와 파일 저장 루트, 기본 `./data`
- `APP_BASE_URL`: 공유 절대 URL의 신뢰할 기준 주소. production에서는 명시한다.

## API 예시

```bash
curl -F expiresIn=1d \
  -F 'text=옮길 메모' \
  -F files=@./example.txt \
  http://127.0.0.1:3000/api/shares
```

응답의 6자리 코드를 사용해 `GET /api/shares/:code`, 각 파일의 `downloadUrl`을 사용할 수 있다. 자세한 범위와 계약은 `docs/SPEC.md`, 구조는 `docs/ARCHITECTURE.md`를 따른다.

전체 API 계약, 오류 코드와 curl 예시는 [`docs/API.md`](docs/API.md)에 있다.

LAN 실행, 저장소 백업·복구와 공개 전 체크리스트는 [`docs/OPERATIONS.md`](docs/OPERATIONS.md)를 따른다.
