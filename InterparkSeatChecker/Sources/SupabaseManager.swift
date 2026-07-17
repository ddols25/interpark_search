import Foundation

/// avail_seats 테이블에 조회 설정(공연 ID, 자동조회 주기)을 저장/조회한다.
/// 개인 사용 앱이라 로그인 없이 단일 행(id=1)을 upsert하는 방식으로 동작한다.
/// URL/API 키는 저장소에 커밋되지 않는 Secrets.plist에서 읽는다 (Secrets.example.plist 참고).
final class SupabaseManager {
    private let projectURL: String
    private let apiKey: String

    init() {
        guard let url = Bundle.main.url(forResource: "Secrets", withExtension: "plist"),
              let dict = NSDictionary(contentsOf: url) as? [String: String],
              let projectURL = dict["SUPABASE_URL"],
              let apiKey = dict["SUPABASE_API_KEY"] else {
            fatalError("Secrets.plist를 찾을 수 없습니다. Secrets.example.plist를 복사해 InterparkSeatChecker/Sources/Secrets.plist를 만들고 실제 값을 채워주세요.")
        }
        self.projectURL = projectURL
        self.apiKey = apiKey
    }

    struct Config {
        let goodsCode: String
        let intervalMinutes: Int
        let quietHoursEnabled: Bool
    }

    private func makeRequest(path: String, method: String) -> URLRequest {
        var request = URLRequest(url: URL(string: "\(projectURL)/rest/v1/\(path)")!)
        request.httpMethod = method
        request.setValue(apiKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    func loadConfig() async -> Config? {
        var request = makeRequest(path: "avail_seats?id=eq.1&select=goods_code,interval_minutes,quiet_hours_enabled", method: "GET")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, http.statusCode == 200,
              let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
              let row = rows.first else {
            return nil
        }
        guard let goodsCode = row["goods_code"] as? String else { return nil }
        let intervalMinutes = row["interval_minutes"] as? Int ?? 10
        let quietHoursEnabled = row["quiet_hours_enabled"] as? Bool ?? false
        return Config(goodsCode: goodsCode, intervalMinutes: intervalMinutes, quietHoursEnabled: quietHoursEnabled)
    }

    func saveConfig(goodsCode: String, intervalMinutes: Int, quietHoursEnabled: Bool) async {
        var request = makeRequest(path: "avail_seats?on_conflict=id", method: "POST")
        request.setValue("resolution=merge-duplicates,return=minimal", forHTTPHeaderField: "Prefer")
        let isoFormatter = ISO8601DateFormatter()
        let body: [String: Any] = [
            "id": 1,
            "goods_code": goodsCode,
            "interval_minutes": intervalMinutes,
            "quiet_hours_enabled": quietHoursEnabled,
            "updated_at": isoFormatter.string(from: Date())
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        _ = try? await URLSession.shared.data(for: request)
    }
}
