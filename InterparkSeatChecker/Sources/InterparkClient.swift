import Foundation

/// 인터파크 공개 조회 endpoint 클라이언트.
/// ticket-availability 스킬(scripts/ticket_availability.py)의 InterparkClient 로직을 Swift로 그대로 옮긴 것.
/// 조회 전용 — 예매/결제/좌석선택 요청은 만들지 않는다.

struct SeatGrade: Identifiable {
    let id = UUID()
    let grade: String
    let remain: Int
}

struct ScheduleSeats: Identifiable {
    let id = UUID()
    let date: String
    let time: String
    let playSeq: String
    var seats: [SeatGrade]
}

enum InterparkError: Error, LocalizedError {
    case badResponse
    case http(Int)

    var errorDescription: String? {
        switch self {
        case .badResponse: return "응답을 해석할 수 없습니다"
        case .http(let code): return "HTTP 오류 (\(code))"
        }
    }
}

final class InterparkClient {
    private let base = "https://api-ticketfront.interpark.com"
    private let ua =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

    private func makeRequest(url: URL) -> URLRequest {
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.setValue(ua, forHTTPHeaderField: "User-Agent")
        req.setValue("https://tickets.interpark.com/", forHTTPHeaderField: "Referer")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.timeoutInterval = 20
        return req
    }

    private func fmtDate(_ raw: String) -> String {
        if raw.count == 8, raw.allSatisfy({ $0.isNumber }) {
            let y = raw.prefix(4)
            let rest = raw.dropFirst(4)
            let m = rest.prefix(2)
            let d = rest.dropFirst(2)
            return "\(y)-\(m)-\(d)"
        }
        return raw
    }

    private func fmtTime(_ raw: String) -> String {
        if raw.count == 4, raw.allSatisfy({ $0.isNumber }) {
            let h = raw.prefix(2)
            let m = raw.dropFirst(2)
            return "\(h):\(m)"
        }
        return raw
    }

    private func stringValue(_ any: Any?) -> String {
        if let s = any as? String { return s }
        if let n = any as? NSNumber { return n.stringValue }
        return ""
    }

    private func intValue(_ any: Any?) -> Int {
        if let n = any as? NSNumber { return n.intValue }
        if let s = any as? String, let n = Int(s) { return n }
        return 0
    }

    func fetchSchedule(goodsCode: String) async throws -> [(date: String, time: String, playSeq: String)] {
        var comps = URLComponents(string: "\(base)/v1/goods/\(goodsCode)/playSeq")!

        let df = DateFormatter()
        df.dateFormat = "yyyyMMdd"
        df.timeZone = TimeZone(identifier: "Asia/Seoul")

        let now = Date()
        let startDate = df.string(from: now)
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Seoul")!
        let nextYear = cal.date(byAdding: .year, value: 1, to: now) ?? now
        let endDate = df.string(from: nextYear)

        comps.queryItems = [
            URLQueryItem(name: "goodsCode", value: goodsCode),
            URLQueryItem(name: "isBookableDate", value: "true"),
            URLQueryItem(name: "page", value: "1"),
            URLQueryItem(name: "pageSize", value: "200"),
            URLQueryItem(name: "startDate", value: startDate),
            URLQueryItem(name: "endDate", value: endDate),
        ]

        let (data, response) = try await URLSession.shared.data(for: makeRequest(url: comps.url!))
        guard let http = response as? HTTPURLResponse else { throw InterparkError.badResponse }
        guard (200..<300).contains(http.statusCode) else { throw InterparkError.http(http.statusCode) }

        let json = try JSONSerialization.jsonObject(with: data)
        var items: [[String: Any]] = []
        if let arr = json as? [[String: Any]] {
            items = arr
        } else if let dict = json as? [String: Any] {
            if let resp = dict["response"] as? [String: Any], let arr = resp["data"] as? [[String: Any]] {
                items = arr
            } else if let arr = dict["data"] as? [[String: Any]] {
                items = arr
            }
        }

        return items.map { item in
            (
                date: fmtDate(stringValue(item["playDate"])),
                time: fmtTime(stringValue(item["playTime"])),
                playSeq: stringValue(item["playSeq"])
            )
        }
    }

    func fetchSeats(goodsCode: String, playSeq: String) async throws -> [SeatGrade] {
        let url = URL(string: "\(base)/v1/goods/\(goodsCode)/playSeq/PlaySeq/\(playSeq)/REMAINSEAT")!
        let (data, response) = try await URLSession.shared.data(for: makeRequest(url: url))
        guard let http = response as? HTTPURLResponse else { throw InterparkError.badResponse }
        guard (200..<300).contains(http.statusCode) else { throw InterparkError.http(http.statusCode) }

        let json = try JSONSerialization.jsonObject(with: data)
        var raw: [[String: Any]] = []
        if let dict = json as? [String: Any] {
            if let arr = dict["remainSeat"] as? [[String: Any]] {
                raw = arr
            } else if let d = dict["data"] as? [String: Any], let arr = d["remainSeat"] as? [[String: Any]] {
                raw = arr
            } else if let resp = dict["response"] as? [String: Any], let arr = resp["remainSeat"] as? [[String: Any]] {
                raw = arr
            }
        }

        return raw.map { s in
            let grade = stringValue(s["seatGradeName"] ?? s["seatGrade"])
            let remain = intValue(s["remainCnt"])
            return SeatGrade(grade: grade, remain: remain)
        }
    }

    /// 전 회차 순회 — 스킬과 동일하게 회차 사이 0.3s 간격을 둔다 (rate limit).
    func fetchAll(goodsCode: String) async throws -> [ScheduleSeats] {
        let schedule = try await fetchSchedule(goodsCode: goodsCode)
        var results: [ScheduleSeats] = []
        for item in schedule where !item.playSeq.isEmpty {
            let seats = try await fetchSeats(goodsCode: goodsCode, playSeq: item.playSeq)
            results.append(ScheduleSeats(date: item.date, time: item.time, playSeq: item.playSeq, seats: seats))
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        return results
    }
}
