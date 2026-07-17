# InterparkSeatChecker

인터파크 공연 잔여석을 주기적으로 조회하고, 잔여석이 생기면 알림을 보내는 개인용 iOS 앱입니다.
`ticket-availability` 스킬의 조회 로직(공개 API, 예매/결제 없음)을 Swift로 재구현했습니다.

## 구성
- `project.yml` — [XcodeGen](https://github.com/yonaskolb/XcodeGen) 프로젝트 스펙. `xcodegen generate`로 `.xcodeproj`를 생성합니다.
- `InterparkSeatChecker/Sources/`
  - `ContentView.swift` — 메인 화면 (공연 ID 입력, 자동조회 주기, 야간 알림 끄기, 결과 표시)
  - `InterparkClient.swift` — 인터파크 공개 API 조회 클라이언트 (조회 전용)
  - `NotificationManager.swift` — 로컬 알림 (Time-Sensitive, 애플워치 미러링)
  - `SilentAudioKeepAlive.swift` — 백그라운드에서 자동조회 주기를 유지하기 위한 무음 오디오 재생
  - `SupabaseManager.swift` — 조회 설정(공연 ID, 주기, 야간 알림 여부)을 Supabase에 저장/조회

## 설정 (Secrets)
Supabase URL/API 키는 저장소에 커밋되지 않는 `Secrets.plist`에서 읽습니다.

1. `Secrets.example.plist`를 복사해 `InterparkSeatChecker/Sources/Secrets.plist`로 저장
2. `SUPABASE_URL`, `SUPABASE_API_KEY` 값을 본인 Supabase 프로젝트 값으로 교체 (Project Settings > API 에서 확인, `anon`/`publishable` 키 사용 — service_role 키는 절대 사용하지 말 것)
3. `xcodegen generate`로 프로젝t를 다시 생성해 새 리소스를 반영

`Secrets.plist`는 `.gitignore`에 포함되어 저장소에 업로드되지 않습니다.

## Supabase 테이블
`avail_seats` 테이블(단일 행)에 마지막 조회 설정을 저장합니다.

```sql
create table public.avail_seats (
  id bigint primary key default 1,
  goods_code text not null,
  interval_minutes integer not null default 10,
  quiet_hours_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint avail_seats_singleton check (id = 1)
);
```

## 빌드
```bash
brew install xcodegen
xcodegen generate
open InterparkSeatChecker.xcodeproj
```
Xcode에서 개인 Apple ID로 서명 후 기기에 직접 설치해 사용합니다 (App Store 배포용이 아님 — 무음 오디오 재생을 이용한 백그라운드 유지 방식은 App Store 심사 가이드라인에 부적합).

## 주의
- 조회 전용 앱입니다. 예매·결제는 인터파크 앱/사이트에서 직접 진행하세요.
- 무료 개인 Apple ID로 서명 시 7일마다 재설치가 필요합니다.
