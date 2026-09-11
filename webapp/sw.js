// 서비스 워커: 웹푸시 수신 및 알림 표시 전담.
// 조회 로직은 여기 없음 — 실제 조회/판단은 Supabase Edge Function(서버)에서 실행되고,
// 결과(잔여석 발생)만 웹푸시로 이 서비스 워커에 전달된다.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = { title: "잔여석 발생", body: "인터파크 잔여석을 확인하세요." };
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (e) {
      payload.body = event.data.text();
    }
  }

  const options = {
    body: payload.body,
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    data: { url: payload.url || "./index.html" },
    // iOS/Android 모두에서 방해금지 모드를 최대한 뚫고 노출되도록 설정.
    requireInteraction: false,
    tag: "interpark-seat-alert",
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "./index.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      for (const client of clientsArr) {
        if ("focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
