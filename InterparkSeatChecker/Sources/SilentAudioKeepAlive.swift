import AVFoundation

/// 화면이 꺼지거나 앱이 백그라운드로 가도 자동조회 Timer가 계속 돌도록,
/// 무음 오디오를 무한 반복 재생해 앱 프로세스를 살려두는 용도.
/// Info.plist의 UIBackgroundModes(audio) 와 함께 동작한다.
/// 개인 기기에 Xcode로 직접 설치해 본인만 쓰는 용도로만 사용할 것 — App Store 배포용 앱에는 부적합.
final class SilentAudioKeepAlive {
    private var player: AVAudioPlayer?

    func start() {
        if let player {
            player.play()
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            // 오디오 렌더 콜백 빈도를 낮춰 CPU 웨이크업 횟수를 줄인다 (배터리 절감).
            try? session.setPreferredIOBufferDuration(1.0)
            try? session.setPreferredSampleRate(8000)
            try session.setActive(true)

            // 루프 버퍼를 길게 잡아 루프 재시작(디코더 재가동) 빈도를 줄인다.
            let data = Self.makeSilentWavData(seconds: 5.0, sampleRate: 8000)
            let newPlayer = try AVAudioPlayer(data: data)
            newPlayer.numberOfLoops = -1
            // 완전 무음(0.0)은 일부 기기에서 "재생 중"으로 인식되지 않아 백그라운드 유지 효과가 사라질 수 있어,
            // 감지 가능한 최소 볼륨만 유지한다.
            newPlayer.volume = 0.001
            newPlayer.prepareToPlay()
            newPlayer.play()
            player = newPlayer
        } catch {
            print("SilentAudioKeepAlive start failed: \(error)")
        }
    }

    func stop() {
        player?.stop()
        player = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private static func makeSilentWavData(seconds: Double, sampleRate: Double) -> Data {
        let numSamples = Int(seconds * sampleRate)
        let bitsPerSample: UInt16 = 16
        let channels: UInt16 = 1
        let byteRate = UInt32(sampleRate) * UInt32(channels) * UInt32(bitsPerSample / 8)
        let blockAlign = channels * (bitsPerSample / 8)
        let dataSize = UInt32(numSamples * Int(channels) * Int(bitsPerSample / 8))

        var data = Data()
        func appendASCII(_ s: String) { data.append(s.data(using: .ascii)!) }
        func appendUInt32(_ v: UInt32) {
            var le = v.littleEndian
            data.append(Data(bytes: &le, count: 4))
        }
        func appendUInt16(_ v: UInt16) {
            var le = v.littleEndian
            data.append(Data(bytes: &le, count: 2))
        }

        appendASCII("RIFF")
        appendUInt32(36 + dataSize)
        appendASCII("WAVE")
        appendASCII("fmt ")
        appendUInt32(16)
        appendUInt16(1) // PCM
        appendUInt16(channels)
        appendUInt32(UInt32(sampleRate))
        appendUInt32(byteRate)
        appendUInt16(blockAlign)
        appendUInt16(bitsPerSample)
        appendASCII("data")
        appendUInt32(dataSize)
        data.append(Data(count: Int(dataSize))) // 무음(0) 샘플

        return data
    }
}
