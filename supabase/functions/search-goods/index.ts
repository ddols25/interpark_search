// 공연 검색 프록시 Edge Function.
// 인터파크 티켓은 NOL(야놀자) 통합검색 API(nol.yanolja.com)를 사용한다.
// 브라우저에서 직접 호출하면 CORS로 막힐 수 있어(다른 인터파크 API들과 동일한 문제),
// 이 함수가 대신 호출해 필요한 필드만 정리해서 돌려준다.
// 조회 전용 — 예매/결제 요청은 만들지 않는다.
//
// 요청: POST { keyword?: string }  (기본값: "성남아트센터")
// 응답: { ok: true, items: [{ id, title, dateInfo, thumbnail, location }] }
//   id는 인터파크 공연 ID(goodsCode)와 같은 숫자 문자열이다.

const SEARCH_URL = "https://nol.yanolja.com/discovery/api/list/universal-search/v2/list";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

/** 정확한 응답 스키마를 몰라도 되도록, 트리 어디에 있든 productItem 객체를 전부 찾아 모은다. */
function collectProductItems(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const item of node) collectProductItems(item, out);
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj.productItem && typeof obj.productItem === "object") {
      out.push(obj.productItem as Record<string, unknown>);
    }
    for (const key of Object.keys(obj)) {
      collectProductItems(obj[key], out);
    }
  }
  return out;
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  let keyword = "성남아트센터";
  if (req.method === "POST") {
    try {
      const body = await req.json();
      if (body?.keyword) keyword = String(body.keyword);
    } catch {
      // 본문 없으면 기본 키워드(성남아트센터) 사용.
    }
  }

  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  // NOL 통합검색은 숙박 검색과 API를 공유해 체크인/아웃, 숙박 필터 필드가 같이 붙어온다.
  // 실제 브라우저가 보내는 페이로드를 그대로 재현 (개발자도구로 캡처한 값).
  const payload = {
    keyword,
    filter: {
      codeFilter: {
        reservationTypeCodes: [],
        starRatingCodes: [],
        accommodationCategoryCodes: [],
        amenitiesCodes: [],
        accommodationLocationCodes: [],
        maxRentHourCodes: [],
        accommodationPromotionCodes: [],
        leisureLocationCodes: [],
        leisureCategoryCodes: [],
        leisureBrandCodes: [],
        leisurePromotionCodes: [],
        entertainmentCategoryCodes: [],
        entertainmentRegionCodes: [],
        saleStatusCodes: ["ENTERTAINMENT_SALE_STATUS_CODE_UPCOMING", "ENTERTAINMENT_SALE_STATUS_CODE_ACTIVE"],
        entertainmentPropertyCodes: [],
        entertainmentTopingPaidMemberDiscount: false,
        entertainmentFutureShowDateCount: 0,
        nolWorldDomesticStay: { starRatingCodes: [], facilityCodes: [] },
      },
      rangeFilter: {
        priceRange: { from: 0, to: 0 },
        entertainmentShowDateRanges: [],
      },
      productStatusFilter: { availableOnly: false },
      quickFilters: [],
      useDynamicFilter: false,
      globalAccommodationCodeFilter: {
        rateAmenityCodes: [],
        propertyBadgeCodes: [],
        propertyAmenityCodes: [],
      },
    },
    category: "PRODUCT_CATEGORY_ENTERTAINMENT",
    sort: "SORT_DEFAULT",
    localAccommodation: {
      checkInDate: ymd(today),
      checkOutDate: ymd(tomorrow),
      capacityAdults: 2,
      childrenAges: [],
    },
    globalAccommodation: {
      checkInDate: ymd(today),
      checkOutDate: ymd(tomorrow),
      rooms: [{ capacityAdults: 2, childrenAges: [] }],
    },
    disableSpellCorrection: false,
  };

  try {
    const res = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": UA,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("search http", res.status, text.slice(0, 500));
      return jsonResponse({ error: `search http ${res.status}` }, 502);
    }

    const json = await res.json();
    const seen = new Set<string>();
    const items = collectProductItems(json)
      .filter((item) => typeof item.id === "string" && /^\d+$/.test(item.id as string))
      .filter((item) => {
        const id = item.id as string;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map((item) => ({
        id: item.id as string,
        title: String(item.title ?? ""),
        dateInfo: String(item.dateInfo ?? ""),
        thumbnail: String(item.thumbnail || item.fallbackThumbnail || ""),
        location: Array.isArray(item.locationDetails) ? (item.locationDetails as string[]).join(" ") : "",
      }));

    return jsonResponse({ ok: true, items });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: String(err) }, 500);
  }
});
