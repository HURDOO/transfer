# 운영 가이드

상태: ARM64 이미지와 deployd 온보딩 정책 준비 완료, Pi 적용과 공개 운영은 미실행

현재 서버는 제품 의도에 따라 로그인 없는 업로드·다운로드, 최대 1 GiB 요청, 무기한 만료를 지원한다. Docker 이미지와 중앙 런타임 정책은 준비됐지만 실제 Pi 설치·TLS·첫 릴리스와 인터넷 공개 승인은 아직 하지 않았으므로 현재 구성을 공개 운영용으로 간주하지 않는다.

## 배포 계약

- 앱 ID: `transfer`
- 이미지: `ghcr.io/hurdoo/transfer`, `linux/arm64`
- 예정 URL: `https://transfer.app.hurdoo.kr`
- 컨테이너 포트와 헬스: `3000`, `GET /healthz`
- Pi 루프백 포트: deployd가 `18000`–`18999` 범위에서 자동 할당하며 프로젝트가 지정하지 않음
- 영속 데이터: 호스트 `/srv/homelab/data/transfer` → 컨테이너 `/data`
- 초기 접근 범위: `192.168.10.0/24`, `10.0.0.0/24`

Compose는 rootless Docker의 컨테이너 UID 0을 사용한다. 이는 호스트 root가 아니라 `appdeploy` 사용자로 매핑되어 `appdeploy:appdeploy 0750` 데이터 디렉터리에 쓸 수 있게 하면서, 읽기 전용 루트·모든 capability 제거·`no-new-privileges`를 함께 유지하기 위한 선택이다.

`LIVE_ICE_SERVERS`는 선택적인 Pi 전용 `/etc/homelab/secrets/transfer.env`에서 주입한다. 파일이 없으면 애플리케이션 기본값 `[]`를 사용하며, TURN 자격 증명은 저장소에 기록하지 않는다.

## 실행 범위

맥미니 한 대에서만 확인할 때는 루프백에 고정한다.

```bash
HOST=127.0.0.1 \
APP_BASE_URL=http://127.0.0.1:3000 \
STORAGE_DIR=./data \
pnpm start
```

신뢰할 수 있는 LAN 기기에서도 접속할 때는 모든 인터페이스에 바인딩하고, 브라우저에서 실제로 사용하는 고정 주소를 `APP_BASE_URL`에 둔다.

```bash
HOST=0.0.0.0 \
APP_BASE_URL=http://macmini.local:3000 \
STORAGE_DIR=/절대/경로/transfer-data \
pnpm start
```

- 공유기 포트 포워딩, 공인 IP 노출, 터널의 공개 URL 사용은 하지 않는다.
- OS 방화벽에서 필요한 사설망만 허용한다.
- `APP_BASE_URL`은 사용자가 접속할 주소와 일치시킨다.
- 데이터 루트와 파일은 서버 계정만 읽고 쓸 수 있게 유지한다.

## 저장소와 용량

`STORAGE_DIR` 아래의 다음 항목을 한 단위로 관리한다.

- `transfer.sqlite3`: 공유와 파일 메타데이터
- `files/`: 확정된 파일 본문
- `tmp/`: 진행 중인 업로드

애플리케이션의 요청당 1 GiB 제한은 전체 디스크 quota가 아니다. LAN 운용 중에도 다음을 정기적으로 확인한다.

```bash
df -h "$STORAGE_DIR"
du -sh "$STORAGE_DIR"
```

공개 운영 전에는 컨테이너/파일시스템 quota, 최소 여유 공간 기준, 동시 업로드 제한과 경보를 별도로 둔다.

현재 애플리케이션은 시작 시 SQLite 스키마 버전 1을 버전 2로 자동 올려 공유별 삭제 관리 키 해시 열을 추가한다. 기존 공유와 파일은 유지되지만 기존 공유에는 관리 키가 소급 생성되지 않는다. 마이그레이션 전에 서버를 멈추고 전체 `STORAGE_DIR`을 백업한다. 버전 2 DB는 이전 애플리케이션에서 열 수 없으므로 코드만 되돌리지 말고 필요하면 백업한 저장 루트도 함께 복원한다.

## 실시간 연결의 ICE 설정

실시간 파일·텍스트 본문은 WebRTC 데이터 채널로 기기 사이를 이동한다. 서버는 본문을 저장하지 않지만 연결을 위한 SDP·ICE 메타데이터를 10분 동안 메모리에 중계한다.

`LIVE_ICE_SERVERS`에는 브라우저 `RTCPeerConnection`에 전달할 ICE 서버 배열 JSON을 넣는다. 기본값은 외부 서비스 없는 `[]`다.

```bash
LIVE_ICE_SERVERS='[{"urls":"stun:stun.example.com:3478"}]' \
pnpm start
```

- STUN 사업자는 피어 IP와 연결 메타데이터를 볼 수 있으므로 운영자가 신뢰할 서비스를 선택한다.
- STUN만으로 통과할 수 없는 NAT·방화벽에서는 자격 증명이 있는 TURN이 필요하다.
- TURN `username`과 `credential`은 함께 설정하며 저장소에 기록하지 않는다. 가능하면 배포 시스템에서 수명이 짧은 자격 증명을 발급한다.
- ICE 설정이 없거나 직접 연결이 실패해도 저장형 파일·텍스트 공유는 계속 사용할 수 있다.
- 운영 smoke에서는 서로 다른 두 일반 브라우저로 작은 텍스트와 파일 2개를 보내고, 수신 파일의 바이트가 같은지 확인한다. 자동화 Chrome처럼 UDP가 차단된 실행 환경은 TURN 없이는 성공 경로를 검증할 수 없다.
- 완료된 실시간 파일은 수령 탭의 브라우저 메모리에만 있다. 합계 상한은 1 GiB지만 저메모리 모바일에서는 큰 파일 묶음을 나누어 보내고 다운로드 직후 수령 탭을 닫는다.

## 백업

SQLite 메타데이터와 파일 본문의 시점을 맞추기 위해 서버를 정상 종료한 상태에서 전체 `STORAGE_DIR`을 함께 백업한다.

```bash
tar -C "$STORAGE_DIR" -czf transfer-backup-YYYYMMDD-HHMMSS.tar.gz .
```

백업 후에는 압축 파일을 별도 디스크에 복사하고, 정기적으로 테스트 디렉터리에 복원해 `pnpm start`와 `pnpm smoke:api`를 확인한다. 실행 중인 서버의 DB 파일만 따로 복사하는 방식은 사용하지 않는다.

## 복구

1. 서버 프로세스를 중지한다.
2. 새 빈 저장 루트에 백업 전체를 푼다.
3. 서버 계정의 소유권과 읽기·쓰기 권한을 확인한다.
4. `STORAGE_DIR`을 복구 루트로 지정해 루프백에서 먼저 실행한다.
5. 기존 공유 조회와 파일 다운로드를 확인한다.
6. 별도 테스트 저장소에서 `pnpm smoke:api`를 실행한다.

복구 검증 전 기존 저장 루트를 덮어쓰거나 지우지 않는다.

## 준비된 항목과 남은 승인

준비된 항목:

- 잠금 파일 기반 multi-stage Node 24.15 ARM64 이미지
- 읽기 전용 루트와 `/data` 영속 볼륨 계약
- deployd 사용자 검토용 앱 계약과 immutable 이미지 핸드오프
- 1 GiB 업로드를 스트리밍하는 Nginx 크기·시간·버퍼 정책
- 로컬 ARM64 build, health, API smoke, 재시작 영속성과 SIGTERM 검증

다음 작업은 별도 승인 뒤 production 온보딩 절차로 진행한다.

- Codex의 첫 이미지 registry 게시와 핸드오프 생성
- 사용자의 deployd 대시보드 앱 설정 검토 및 첫 배포 승인
- deployd가 파생한 Pi 디렉터리·Compose·Nginx·exact-host 인증서 확인
- 컨테이너 재생성 영속성, 두 번째 릴리스와 수동 롤백 훈련
- 운영 STUN/TURN을 사용한 두 일반 브라우저 실시간 smoke
- 공개 범위 확대 전 디스크 quota와 동시 업로드 제한
- 백업 보존 주기와 실제 복구 훈련
- 용량 부족·요청 제한·프록시 중단 관측과 경보
- 공개 서비스의 신고·차단·보존 기간 등 악용 대응 정책

이 항목이 끝나기 전에는 공개 노출 완료로 표시하지 않는다.
