// 인터파크 잔여석 주기 조회 Edge Function.
// pg_cron이 1분마다 이 함수를 호출하고, 함수 내부에서 avail_seats.interval_minutes만큼
// 시간이 지났을 때만 실제로 인터파크를 조회한다 (사용자가 설정한 임의 주기를 지원하기 위함).
// 잔여석이 있으면 등록된 모든 기기로 웹푸시를 보낸다.
// 조회 전용 — 예매/결제/좌석선택 요청은 만들지 않는다.
// InterparkSeatChecker(iOS)의 InterparkClient.swift 로직을 그대로 이식.

import webpush from "npm:web-push@3.6.7";

const BASE = "https://api-ticketfront.interpark.com";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
// 새 Secret key(sb_secret_...) 체계를 쓰는 경우 SB_SECRET_KEY로 명시적으로 등록해서 사용한다.
// (legacy service_role을 계속 쓰는 프로젝트를 위해 자동 주입 값도 폴백으로 둔다.)
const SERVICE_ROLE_KEY = Deno.env.get("SB_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:example@example.com";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

type Seat = { grade: string; remain: number };
type ScheduleItem = { date: string; time: string; playSeq: string; seats: Seat[] };

function sbHeaders(extra: Record<string, string> = {}) {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function reqInit(): RequestInit {
  return {
    method: "GET",
    headers: {
      "User-Agent": UA,
      Referer: "https://tickets.interpark.com/",
      Accept: "application/json",
    },
  };
}

function fmtDate(raw: string): string {
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return raw;
}

function fmtTime(raw: string): string {
  if (/^\d{4}$/.test(raw)) return `${raw.slice(0, 2)}:${raw.slice(2, 4)}`;
  return raw;
}

function ymdInKST(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}${get("month")}${get("day")}`;
}

function hourInKST(d: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", hour: "2-digit", hour12: false }).format(d)
  );
}

async function fetchSchedule(goodsCode: string): Promise<Omit<ScheduleItem, "seats">[]> {
  const now = new Date();
  const startDate = ymdInKST(now);
  const nextYear = new Date(now);
  nextYear.setUTCFullYear(nextYear.getUTCFullYear() + 1);
  const endDate = ymdInKST(nextYear);

  const url = new URL(`${BASE}/v1/goods/${goodsCode}/playSeq`);
  url.searchParams.set("goodsCode", goodsCode);
  url.searchParams.set("isBookableDate", "true");
  url.searchParams.set("page", "1");
  url.searchParams.set("pageSize", "200");
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);

  const res = await fetch(url, reqInit());
  if (!res.ok) throw new Error(`schedule http ${res.status}`);
  const json = await res.json();

  let items: Record<string, unknown>[] = [];
  if (Array.isArray(json)) items = json;
  else if (json?.response?.data) items = json.response.data;
  else if (json?.data) items = json.data;

  return items.map((item) => ({
    date: fmtDate(String(item.playDate ?? "")),
    time: fmtTime(String(item.playTime ?? "")),
    playSeq: String(item.playSeq ?? ""),
  }));
}

async function fetchSeats(goodsCode: string, playSeq: string): Promise<Seat[]> {
  const url = `${BASE}/v1/goods/${goodsCode}/playSeq/PlaySeq/${playSeq}/REMAINSEAT`;
  const res = await fetch(url, reqInit());
  if (!res.ok) throw new Error(`seats http ${res.status}`);
  const json = await res.json();

  let raw: Record<string, unknown>[] = [];
  if (json?.remainSeat) raw = json.remainSeat;
  else if (json?.data?.remainSeat) raw = json.data.remainSeat;
  else if (json?.response?.remainSeat) raw = json.response.remainSeat;

  return raw.map((s) => ({
    grade: String(s.seatGradeName ?? s.seatGrade ?? ""),
    remain: Number(s.remainCnt ?? 0),
  }));
}

/** 전 회차 순회 — 회차 사이 0.3초 간격을 둔다 (레이트리밋 대응). */
async function fetchAll(goodsCode: string): Promise<ScheduleItem[]> {
  const schedule = await fetchSchedule(goodsCode);
  const results: ScheduleItem[] = [];
  for (const item of schedule) {
    if (!item.playSeq) continue;
    const seats = await fetchSeats(goodsCode, item.playSeq);
    results.push({ ...item, seats });
    await new Promise((r) => setTimeout(r, 300));
  }
  return results;
}

Deno.serve(async (_req) => {
  try {
    const configRes = await fetch(`${SUPABASE_URL}/rest/v1/avail_seats?id=eq.1&select=*`, {
      headers: sbHeaders({ Accept: "application/json" }),
    });
    const configRows = await configRes.json();
    const config = configRows[0];
    if (!config) {
      return new Response(JSON.stringify({ skipped: "no config" }), { status: 200 });
    }

    const now = Date.now();
    const lastChecked = config.last_checked_at ? new Date(config.last_checked_at).getTime() : 0;
    const intervalMs = Math.max(1, config.interval_minutes) * 60_000;
    if (now - lastChecked < intervalMs) {
      return new Response(JSON.stringify({ skipped: "interval not elapsed" }), { status: 200 });
    }

    // 함수 실행 시간과 무관하게 조회 주기가 밀리지 않도록, 조회 전에 먼저 시각을 갱신해둔다.
    await fetch(`${SUPABASE_URL}/rest/v1/avail_seats?id=eq.1`, {
      method: "PATCH",
      headers: sbHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify({ last_checked_at: new Date(now).toISOString() }),
    });

    if (config.quiet_hours_enabled && hourInKST(new Date(now)) < 7) {
      return new Response(JSON.stringify({ skipped: "quiet hours" }), { status: 200 });
    }

    const schedules = await fetchAll(config.goods_code);

    await fetch(`${SUPABASE_URL}/rest/v1/avail_seats?id=eq.1`, {
      method: "PATCH",
      headers: sbHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify({ last_result: { checkedAt: new Date(now).toISOString(), schedules } }),
    });

    const availableSeats = schedules.flatMap((item) =>
      item.seats.filter((s) => s.remain > 0).map((seat) => ({ item, seat }))
    );
    if (availableSeats.length === 0) {
      return new Response(JSON.stringify({ ok: true, available: 0 }), { status: 200 });
    }

    const subsRes = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=*`, {
      headers: sbHeaders({ Accept: "application/json" }),
    });
    const subscriptions: { endpoint: string; p256dh: string; auth: string }[] = await subsRes.json();

    const timeText = new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(now));

    let sent = 0;
    for (const { item, seat } of availableSeats) {
      const payload = JSON.stringify({
        title: "잔여석 발생",
        body: `[${timeText} 조회] ${item.date} ${item.time} ${seat.grade} 잔여 ${seat.remain}석 (회차 ${item.playSeq})`,
      });
      for (const sub of subscriptions) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload
          );
          sent++;
        } catch (err) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode === 404 || statusCode === 410) {
            // 만료/삭제된 구독 — 정리해서 다음 실행부터 재시도하지 않도록 한다.
            await fetch(
              `${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`,
              { method: "DELETE", headers: sbHeaders() }
            );
          } else {
            console.error("push send failed", err);
          }
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, available: availableSeats.length, sent }), { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
