// 실제 값을 채운 뒤 이 파일을 config.js로 복사해서 사용하세요.
// config.js는 .gitignore에 포함되어 저장소에 커밋되지 않습니다.
//
// SUPABASE_URL / SUPABASE_ANON_KEY: Supabase 프로젝트의 anon(publishable) 키.
//   클라이언트(브라우저)에 노출되는 값이라 원래 공개되어도 안전하도록 설계된 키입니다.
//   (service_role 키는 절대 여기에 넣지 마세요.)
// VAPID_PUBLIC_KEY: 웹푸시 구독에 사용하는 공개 키.
//   `npx web-push generate-vapid-keys`로 생성한 공개 키를 넣으세요.
//   개인 키(Private Key)는 여기 넣지 않고 Supabase Edge Function의 시크릿으로만 저장합니다.
window.APP_CONFIG = {
  SUPABASE_URL: "https://YOUR_PROJECT_REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_PUBLISHABLE_OR_ANON_KEY",
  VAPID_PUBLIC_KEY: "YOUR_VAPID_PUBLIC_KEY",
};
