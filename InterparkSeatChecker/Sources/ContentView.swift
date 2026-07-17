import SwiftUI
import UIKit

struct ContentView: View {
    private enum Field: Hashable {
        case goodsCode
        case interval
    }

    @State private var goodsCode: String = "26009084"
    @State private var intervalText: String = "10"
    @State private var quietHoursEnabled: Bool = false
    @State private var isAutoRefreshing: Bool = false
    @State private var isLoading: Bool = false
    @State private var results: [ScheduleSeats] = []
    @State private var lastUpdated: Date?
    @State private var errorMessage: String?
    @State private var pollTask: Task<Void, Never>?
    @FocusState private var focusedField: Field?

    private let client = InterparkClient()
    private let notifier = NotificationManager()
    private let keepAlive = SilentAudioKeepAlive()
    private let supabase = SupabaseManager()

    private let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        f.timeZone = TimeZone(identifier: "Asia/Seoul")
        return f
    }()

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("인터파크 공연 ID")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        TextField("예: 26009084", text: $goodsCode)
                            .keyboardType(.numberPad)
                            .textFieldStyle(.roundedBorder)
                            .focused($focusedField, equals: .goodsCode)
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text("자동조회 주기 (분, 최소 1분)")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        TextField("10", text: $intervalText)
                            .keyboardType(.numberPad)
                            .textFieldStyle(.roundedBorder)
                            .focused($focusedField, equals: .interval)
                    }

                    Button(action: { quietHoursEnabled.toggle() }) {
                        HStack(spacing: 8) {
                            Image(systemName: quietHoursEnabled ? "checkmark.square.fill" : "square")
                                .foregroundStyle(quietHoursEnabled ? .blue : .secondary)
                            Text("야간(24시~07시) 알림 끄기")
                                .foregroundStyle(.primary)
                        }
                    }
                    .buttonStyle(.plain)

                    Button(action: toggleAutoRefresh) {
                        HStack {
                            if isLoading {
                                ProgressView()
                                    .tint(.white)
                            }
                            Text(isAutoRefreshing ? "자동조회 중지" : "조회 시작")
                                .fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(isAutoRefreshing ? .red : .blue)
                    .disabled(goodsCode.trimmingCharacters(in: .whitespaces).isEmpty)

                    Button(action: openSeongnamArtsCenterInSafari) {
                        HStack {
                            Image(systemName: "safari")
                            Text("사파리로 성남아트센터 열기")
                                .fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                    }
                    .buttonStyle(.bordered)
                }
                .padding()
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal)

                if let lastUpdated {
                    Text("마지막 조회: \(timeFormatter.string(from: lastUpdated)) 기준")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .padding(.horizontal)
                }

                Divider()

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if results.isEmpty {
                            Text("조회 결과가 여기에 표시됩니다.")
                                .foregroundStyle(.secondary)
                                .padding(.top, 40)
                                .frame(maxWidth: .infinity)
                        }
                        ForEach(results) { item in
                            VStack(alignment: .leading, spacing: 6) {
                                Text("\(item.date) \(item.time)  (회차 \(item.playSeq))")
                                    .font(.headline)
                                ForEach(item.seats) { seat in
                                    HStack {
                                        Text(seat.grade)
                                        Spacer()
                                        Text("잔여 \(seat.remain)석")
                                            .fontWeight(.semibold)
                                            .foregroundStyle(seat.remain > 0 ? .green : .secondary)
                                    }
                                }
                                if item.seats.isEmpty {
                                    Text("좌석 정보 없음")
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .padding()
                            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                            .padding(.horizontal)
                        }
                    }
                    .padding(.bottom, 24)
                }

                Text("조회 전용입니다. 예매·결제는 인터파크 앱/사이트에서 직접 진행하세요.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
                    .padding(.bottom, 8)
            }
            .contentShape(Rectangle())
            .onTapGesture { focusedField = nil }
            .navigationTitle("인터파크 잔여석 조회")
            .onAppear {
                notifier.requestPermission()
                Task { await loadSavedConfig() }
            }
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("완료") { focusedField = nil }
                }
            }
        }
    }

    /// 성남아트센터 공식 사이트(snart.or.kr)를 사파리로 연다.
    private func openSeongnamArtsCenterInSafari() {
        guard let url = URL(string: "https://www.snart.or.kr") else { return }
        UIApplication.shared.open(url)
    }

    private func toggleAutoRefresh() {
        if isAutoRefreshing {
            stopAutoRefresh()
        } else {
            startAutoRefresh()
        }
    }

    private func startAutoRefresh() {
        isAutoRefreshing = true
        keepAlive.start()
        let minutes = max(1, Int(intervalText) ?? 10)
        let intervalSeconds = minutes * 60
        let code = goodsCode.trimmingCharacters(in: .whitespaces)
        let quietHours = quietHoursEnabled
        Task { await supabase.saveConfig(goodsCode: code, intervalMinutes: minutes, quietHoursEnabled: quietHours) }
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                await performQuery()
                try? await Task.sleep(nanoseconds: UInt64(intervalSeconds) * 1_000_000_000)
            }
        }
    }

    /// 앱 실행 시 avail_seats 테이블에 저장된 마지막 설정으로 입력값을 채운다.
    private func loadSavedConfig() async {
        guard let config = await supabase.loadConfig() else { return }
        await MainActor.run {
            goodsCode = config.goodsCode
            intervalText = String(config.intervalMinutes)
            quietHoursEnabled = config.quietHoursEnabled
        }
    }

    /// 한국시간 기준 자정(0시)부터 오전 7시 이전까지를 야간으로 판단한다.
    private func isQuietHoursNow() -> Bool {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Seoul") ?? .current
        let hour = calendar.component(.hour, from: Date())
        return hour < 7
    }

    private func stopAutoRefresh() {
        isAutoRefreshing = false
        pollTask?.cancel()
        pollTask = nil
        keepAlive.stop()
    }

    private func performQuery() async {
        let code = goodsCode.trimmingCharacters(in: .whitespaces)
        guard !code.isEmpty else { return }
        await MainActor.run { isLoading = true }
        do {
            let fetched = try await client.fetchAll(goodsCode: code)
            await MainActor.run {
                results = fetched
                lastUpdated = Date()
                errorMessage = nil
                isLoading = false
                checkAvailability(fetched)
            }
        } catch {
            await MainActor.run {
                errorMessage = "조회 실패: \(error.localizedDescription)"
                isLoading = false
            }
        }
    }

    /// 야간(설정 시) 제외, 잔여석이 있는 경우에만 조회할 때마다 알림을 보낸다.
    private func checkAvailability(_ items: [ScheduleSeats]) {
        if quietHoursEnabled && isQuietHoursNow() { return }
        let timeText = timeFormatter.string(from: Date())
        let availableSeats = items.flatMap { item in
            item.seats.filter { $0.remain > 0 }.map { (item, $0) }
        }
        for (item, seat) in availableSeats {
            notifier.send(
                title: "잔여석 발생",
                body: "[\(timeText) 조회] \(item.date) \(item.time) \(seat.grade) 잔여 \(seat.remain)석 (회차 \(item.playSeq))"
            )
        }
    }
}

#Preview {
    ContentView()
}
