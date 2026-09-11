# InterparkSeatChecker

인터파크 공연 잔여석을 주기적으로 조회하고, 잔여석이 생기면 알림을 보내는 개인용 도구입니다.
`ticket-availability` 스킬의 조회 로직(공개 API, 예매/결제 없음)을 재구현했습니다.

**현재 권장 구성은 웹앱(PWA) + 웹푸시입니다.** 기존 iOS 네이티브 앱은 무료 Apple ID로 서명 시
7일마다 재설치가 필요해 불편하기 때문에, 조회 로직을 서버(Supabase Edge Function)로 옮기고
휴대폰은 알림만 받는 가벼운 웹앱으로 전환했습니다. iOS 앱 소스는 참고용으로 남겨뒀습니다
(`InterparkSeatChecker/`, [아래 참고](#참고-기존-ios-네이티브-앱)).

> ⚠️ **현재 Supabase 연동은 임시로 꺼둔 상태입니다** (서비스 키 유출 사고 정리 중).
> `webapp/app.js`의 Supabase 호출부가 전부 주석처리되어 있어, 지금은 웹앱에서 알림 권한 요청 +
> 웹푸시 구독까지만 되고 서버에 저장/서버 쪽 자동조회는 동작하지 않습니다. 다시 켤 때는
> `app.js`의 "SUPABASE 비활성화" 주석 블록들을 해제하고, 새로 회전한 키로 아래 설정을 다시 반영하세요.

## 아키텍처

```
Supabase pg_cron (1분마다)
      │
      ▼
Supabase Edge Function (check-seats)
      ├─ avail_seats.interval_minutes 만큼 지났을 때만 실제 조회
      ├─ 인터파크 공개 API 조회 (조회 전용)
      ├─ 결과를 avail_seats.last_result 에 저장
      └─ 잔여석 있으면 push_subscriptions의 모든 기기로 웹푸시 발송

webapp/ (정적 페이지, GitHub Pages 등에 호스팅)
      └─ 공연 ID / 주기 / 야간알림 설정 저장 + 이 기기를 푸시 구독자로 등록
```

조회 루프가 서버에서 도니까 휴대폰 앱을 켜두거나 브라우저 탭을 열어둘 필요가 없고,
네이티브 앱 바이너리가 없으므로 **7일 재서명 문제 자체가 사라집니다.**

## 구성

- `webapp/` — 설정용 정적 웹앱 (PWA)
  - `index.html`, `app.js` — 공연 ID/주기/야간알림 입력, 웹푸시 구독, 최근 조회 결과 표시
  - `sw.js` — 서비스 워커. 웹푸시 수신 및 알림 표시만 담당 (조회 로직 없음)
  - `manifest.webmanifest`, `icons/` — 홈 화면 추가(PWA)용 매니페스트/아이콘
  - `config.example.js` — Supabase/VAPID 설정 템플릿 (`config.js`로 복사해서 사용, git에 커밋 안 됨)
- `supabase/`
  - `schema.sql` — 테이블(`avail_seats`, `push_subscriptions`), RLS 정책, pg_cron 예약 SQL
  - `functions/check-seats/index.ts` — 조회 + 웹푸시 발송 Edge Function
- `.github/workflows/deploy-webapp.yml` — `main`에 push되면 `webapp/`을 GitHub Pages로 자동 배포
- `InterparkSeatChecker/` — 기존 iOS 네이티브 앱 (레거시, 아래 참고)

## 설정 순서

### 1) VAPID 키 생성 (웹푸시용)

```bash
npx web-push generate-vapid-keys
```

- **Public Key** → `webapp/config.js`와 Edge Function 시크릿 양쪽에 사용
- **Private Key** → Edge Function 시크릿에만 사용 (절대 클라이언트/저장소에 넣지 않음)

### 2) Supabase 설정

1. Supabase 프로젝트 SQL Editor에서 `supabase/schema.sql`을 실행 (테이블/RLS/pg_cron 준비)
   - 파일 하단의 `cron.schedule(...)` 블록은 `YOUR_PROJECT_REF`, `YOUR_SERVICE_ROLE_KEY`를 실제 값으로 바꾼 뒤 실행하세요.
2. Edge Function 배포:
   ```bash
   supabase functions deploy check-seats --project-ref YOUR_PROJECT_REF
   supabase secrets set \
     VAPID_PUBLIC_KEY=... \
     VAPID_PRIVATE_KEY=... \
     VAPID_SUBJECT=mailto:you@example.com \
     --project-ref YOUR_PROJECT_REF
   ```
   (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`는 Edge Function 런타임에 기본으로 주입되므로 별도 설정 불필요)
3. Project Settings > API에서 **Project URL**, **anon(publishable) key**, **service_role key**를 확인해둡니다.
   - anon key → 웹앱(`config.js`)에서 사용 (공개되어도 되는 키)
   - service_role key → `schema.sql`의 pg_cron 예약 SQL에서만 사용 (절대 클라이언트에 넣지 않음)

### 3) 웹앱 설정/배포

로컬에서 바로 열어 쓰거나:
```bash
cp webapp/config.example.js webapp/config.js
# config.js를 열어 SUPABASE_URL / SUPABASE_ANON_KEY / VAPID_PUBLIC_KEY 채우기
```

GitHub Pages로 배포하려면 (권장, 완전 무료):
1. 저장소 Settings > Pages에서 Source를 **GitHub Actions**로 설정
2. Settings > Secrets and variables > Actions에 `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `VAPID_PUBLIC_KEY` 등록
   (모두 공개되어도 무방한 값입니다 — anon key와 VAPID public key는 원래 클라이언트에 노출되도록 설계된 키입니다)
3. `main` 브랜치에 push하면 `.github/workflows/deploy-webapp.yml`이 자동으로 `webapp/`을 빌드해 배포합니다.

### 4) 아이폰에서 설치 및 구독

1. Safari로 배포된 웹앱 주소를 연다.
2. 공유 버튼 → **홈 화면에 추가** (iOS 16.4+ 필요, 웹푸시는 홈 화면에 추가한 PWA에서만 동작).
3. 홈 화면 아이콘으로 실행 → 공연 ID/주기/야간알림 설정 → **"구독 시작 / 설정 저장"** 클릭 → 알림 권한 허용.
4. 이후로는 앱을 열어두지 않아도 서버가 주기적으로 조회하고, 잔여석이 생기면 푸시 알림이 옵니다.

여러 기기(아이폰 + 아이패드 등)에서 각각 홈 화면에 추가해 구독하면 전부 알림을 받습니다
(`push_subscriptions`가 기기별로 별도 저장됨). 공연 ID/주기 설정은 `avail_seats` 단일 행을 공유합니다.

## 주의

- 조회 전용입니다. 예매·결제는 인터파크 앱/사이트에서 직접 진행하세요.
- 개인용 단일 사용자 앱 전제로 RLS 정책이 anon 키에 읽기/쓰기를 허용합니다. 여러 사람이 접근 가능한
  곳에 배포한다면(주소를 타인과 공유 등) 반드시 인증을 추가하세요.
- pg_cron은 1분 단위로만 예약 가능해 실제 조회는 그 배수로만 도는 것처럼 보일 수 있지만,
  Edge Function이 `interval_minutes`를 스스로 체크하므로 사용자가 설정한 임의의 분 단위 주기가 그대로 적용됩니다.

## 참고: 기존 iOS 네이티브 앱

`InterparkSeatChecker/` 아래에 남아있는 코드로, XcodeGen(`project.yml`)으로 프로젝트를 생성해
Xcode에서 직접 빌드/설치하던 방식입니다. 무음 오디오 재생으로 백그라운드에서 자동조회를 유지했는데,
**무료 개인 Apple ID로 서명 시 7일마다 재설치가 필요하고, 이 방식 자체가 App Store 심사 가이드라인에
부적합**해 더 이상 권장하지 않습니다. 필요 없다면 삭제해도 되고, 유료 Apple Developer Program 계정이
있다면 계속 사용할 수도 있습니다. 빌드 방법은 아래와 같습니다.

```bash
brew install xcodegen
xcodegen generate
open InterparkSeatChecker.xcodeproj
```

Supabase 연동을 위해 `Secrets.example.plist`를 `InterparkSeatChecker/Sources/Secrets.plist`로 복사 후
`SUPABASE_URL`, `SUPABASE_API_KEY` 값을 채워야 합니다 (`.gitignore`에 포함되어 커밋되지 않음).
