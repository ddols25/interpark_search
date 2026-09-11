// 인터파크 잔여석 알림 — 웹앱(PWA) 클라이언트.
// 이 파일은 "설정 화면" 역할만 한다: 공연 ID/주기/야간알림 설정을 Supabase에 저장하고,
// 이 기기를 웹푸시 구독자로 등록한다. 실제 조회는 Supabase Edge Function(서버)에서 주기적으로 실행된다.

const cfg = window.APP_CONFIG;

const el = {
  goodsCode: document.getElementById("goodsCode"),
  interval: document.getElementById("interval"),
  quietHours: document.getElementById("quietHours"),
  subscribeBtn: document.getElementById("subscribeBtn"),
  unsubscribeBtn: document.getElementById("unsubscribeBtn"),
  status: document.getElementById("status"),
  lastResult: document.getElementById("lastResult"),
  swaBtn: document.getElementById("swaBtn"),
};

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.style.color = isError ? "#f87171" : "var(--muted)";
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: cfg.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function loadConfig() {
  try {
    const res = await fetch(
      `${cfg.SUPABASE_URL}/rest/v1/avail_seats?id=eq.1&select=goods_code,interval_minutes,quiet_hours_enabled,last_result`,
      { headers: supabaseHeaders({ Accept: "application/json" }) }
    );
    if (!res.ok) return;
    const rows = await res.json();
    const row = rows[0];
    if (!row) return;
    el.goodsCode.value = row.goods_code ?? el.goodsCode.value;
    el.interval.value = row.interval_minutes ?? el.interval.value;
    el.quietHours.checked = !!row.quiet_hours_enabled;
    renderResult(row.last_result);
  } catch (e) {
    console.warn("설정 불러오기 실패", e);
  }
}

async function saveConfig() {
  const body = {
    id: 1,
    goods_code: el.goodsCode.value.trim(),
    interval_minutes: Math.max(1, parseInt(el.interval.value, 10) || 10),
    quiet_hours_enabled: el.quietHours.checked,
    updated_at: new Date().toISOString(),
  };
  const res = await fetch(`${cfg.SUPABASE_URL}/rest/v1/avail_seats?on_conflict=id`, {
    method: "POST",
    headers: supabaseHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`설정 저장 실패 (HTTP ${res.status})`);
}

async function saveSubscription(subscription) {
  const json = subscription.toJSON();
  const body = {
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    updated_at: new Date().toISOString(),
  };
  const res = await fetch(`${cfg.SUPABASE_URL}/rest/v1/push_subscriptions?on_conflict=endpoint`, {
    method: "POST",
    headers: supabaseHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`구독 등록 실패 (HTTP ${res.status})`);
}

async function deleteSubscription(endpoint) {
  const res = await fetch(
    `${cfg.SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`,
    { method: "DELETE", headers: supabaseHeaders() }
  );
  if (!res.ok) throw new Error(`구독 해제 실패 (HTTP ${res.status})`);
}

function renderResult(lastResult) {
  el.lastResult.innerHTML = "";
  if (!lastResult || !Array.isArray(lastResult.schedules) || lastResult.schedules.length === 0) {
    el.lastResult.innerHTML = `<p class="muted">조회 결과가 여기에 표시됩니다. (서버가 첫 조회를 마치면 나타납니다)</p>`;
    return;
  }
  if (lastResult.checkedAt) {
    const t = new Date(lastResult.checkedAt);
    const timeText = t.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = `마지막 조회: ${timeText} (KST) 기준`;
    el.lastResult.appendChild(p);
  }
  for (const item of lastResult.schedules) {
    const card = document.createElement("div");
    card.className = "card";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = `${item.date} ${item.time} (회차 ${item.playSeq})`;
    card.appendChild(title);
    if (!item.seats || item.seats.length === 0) {
      const p = document.createElement("div");
      p.className = "muted small";
      p.textContent = "좌석 정보 없음";
      card.appendChild(p);
    } else {
      for (const seat of item.seats) {
        const row = document.createElement("div");
        row.className = "seat-row";
        row.innerHTML = `<span>${seat.grade}</span><span class="${seat.remain > 0 ? "avail" : "muted"}">잔여 ${seat.remain}석</span>`;
        card.appendChild(row);
      }
    }
    el.lastResult.appendChild(card);
  }
}

async function subscribe() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    setStatus("이 브라우저는 웹푸시를 지원하지 않습니다. (iOS는 홈 화면에 추가한 뒤 실행해야 합니다)", true);
    return;
  }
  if (!el.goodsCode.value.trim()) {
    setStatus("공연 ID를 입력해주세요.", true);
    return;
  }

  el.subscribeBtn.disabled = true;
  try {
    setStatus("알림 권한 요청 중...");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setStatus("알림 권한이 거부되었습니다. 브라우저/기기 설정에서 알림을 허용해주세요.", true);
      return;
    }

    setStatus("서비스 워커 등록 중...");
    const registration = await navigator.serviceWorker.register("sw.js");
    await navigator.serviceWorker.ready;

    setStatus("푸시 구독 중...");
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(cfg.VAPID_PUBLIC_KEY),
      });
    }

    setStatus("설정 저장 중...");
    await saveConfig();
    await saveSubscription(subscription);

    setStatus("✅ 구독 완료 — 서버가 주기적으로 조회하고, 잔여석이 생기면 알림을 보냅니다.");
  } catch (e) {
    console.error(e);
    setStatus(`오류: ${e.message || e}`, true);
  } finally {
    el.subscribeBtn.disabled = false;
  }
}

async function unsubscribe() {
  el.unsubscribeBtn.disabled = true;
  try {
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await deleteSubscription(subscription.endpoint);
        await subscription.unsubscribe();
      }
    }
    setStatus("이 기기의 알림 구독을 해제했습니다.");
  } catch (e) {
    console.error(e);
    setStatus(`구독 해제 중 오류: ${e.message || e}`, true);
  } finally {
    el.unsubscribeBtn.disabled = false;
  }
}

el.subscribeBtn.addEventListener("click", subscribe);
el.unsubscribeBtn.addEventListener("click", unsubscribe);
el.swaBtn.addEventListener("click", () => window.open("https://www.snart.or.kr", "_blank"));

loadConfig();

// 30초마다 최신 조회 결과만 가볍게 갱신 (설정 화면을 열어두고 있을 때 참고용).
setInterval(loadConfig, 30_000);
