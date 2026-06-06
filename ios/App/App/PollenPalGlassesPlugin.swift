import AVFoundation
import Capacitor
import Foundation

@objc(PollenPalGlassesPlugin)
public class PollenPalGlassesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PollenPalGlasses"
    public let jsName = "PollenPalGlasses"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private let synthesizer = AVSpeechSynthesizer()
    private var audioRoutePrepared = false
    private var audioKeepAliveEngine: AVAudioEngine?
    private var audioKeepAlivePlayer: AVAudioPlayerNode?

    @objc func getStatus(_ call: CAPPluginCall) {
        do {
            try configureAudioSession()
            call.resolve(routeStatus())
        } catch {
            call.reject("Unable to inspect audio route", nil, error)
        }
    }

    @objc func speak(_ call: CAPPluginCall) {
        guard let text = call.getString("text")?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
            call.reject("Missing text")
            return
        }

        do {
            try configureAudioSession()
            if synthesizer.isSpeaking {
                synthesizer.stopSpeaking(at: .word)
            }

            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = AVSpeechSynthesisVoice(language: call.getString("language") ?? "en-US")
            utterance.rate = Float(call.getDouble("rate") ?? 0.48)
            utterance.pitchMultiplier = Float(call.getDouble("pitch") ?? 1.02)
            utterance.volume = Float(call.getDouble("volume") ?? 0.95)
            synthesizer.speak(utterance)

            var result = routeStatus()
            result["spoken"] = true
            call.resolve(result)
        } catch {
            call.reject("Unable to route glasses audio", nil, error)
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        call.resolve(routeStatus())
    }

    private func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        if !audioRoutePrepared || session.category != .playAndRecord || session.mode != .measurement {
            try session.setCategory(
                .playAndRecord,
                mode: .measurement,
                options: [.allowBluetoothHFP, .allowBluetoothA2DP, .defaultToSpeaker]
            )
        }
        if let bluetoothInput = session.availableInputs?.first(where: { $0.portType == .bluetoothHFP }) {
            try session.setPreferredInput(bluetoothInput)
        }
        try session.setActive(true)
        audioRoutePrepared = true
        try startAudioKeepAliveIfNeeded()
    }

    private func startAudioKeepAliveIfNeeded() throws {
        if audioKeepAliveEngine?.isRunning == true {
            return
        }

        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)!
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4_410) else {
            return
        }

        buffer.frameLength = buffer.frameCapacity
        if let channel = buffer.floatChannelData?[0] {
            for frame in 0..<Int(buffer.frameLength) {
                channel[frame] = 0
            }
        }

        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        player.volume = 0.0001
        player.scheduleBuffer(buffer, at: nil, options: .loops)
        engine.prepare()
        try engine.start()
        player.play()

        audioKeepAliveEngine = engine
        audioKeepAlivePlayer = player
    }

    private func routeStatus() -> [String: Any] {
        let session = AVAudioSession.sharedInstance()
        let outputs = session.currentRoute.outputs.map(describePort)
        let inputs = session.currentRoute.inputs.map(describePort)
        let ports = session.currentRoute.outputs + session.currentRoute.inputs
        let availableInputs = session.availableInputs ?? []
        let hasBluetooth = ports.contains { port in
            port.portType == .bluetoothA2DP || port.portType == .bluetoothHFP || port.portType == .bluetoothLE
        } || availableInputs.contains { port in
            port.portType == .bluetoothHFP || port.portType == .bluetoothLE
        }
        let likelyMeta = ports.contains { port in
            let name = port.portName.lowercased()
            return name.contains("ray-ban") || name.contains("rayban") || name.contains("meta")
        } || availableInputs.contains { port in
            let name = port.portName.lowercased()
            return name.contains("ray-ban") || name.contains("rayban") || name.contains("meta")
        }

        return [
            "available": true,
            "connected": hasBluetooth,
            "likelyMetaGlasses": likelyMeta,
            "routeName": (outputs.first?["name"] as? String)
                ?? (inputs.first?["name"] as? String)
                ?? availableInputs.first?.portName
                ?? "iPhone",
            "outputs": outputs,
            "inputs": inputs,
            "availableInputs": availableInputs.map(describePort)
        ]
    }

    private func describePort(_ port: AVAudioSessionPortDescription) -> [String: String] {
        return [
            "name": port.portName,
            "type": port.portType.rawValue,
            "uid": port.uid
        ]
    }
}
