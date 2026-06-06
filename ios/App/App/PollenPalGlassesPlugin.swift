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

    @objc func getStatus(_ call: CAPPluginCall) {
        call.resolve(routeStatus())
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
        try session.setCategory(
            .playAndRecord,
            mode: .measurement,
            options: [.allowBluetoothHFP, .allowBluetoothA2DP, .defaultToSpeaker]
        )
        try session.setActive(true, options: [])
    }

    private func routeStatus() -> [String: Any] {
        let session = AVAudioSession.sharedInstance()
        let outputs = session.currentRoute.outputs.map(describePort)
        let inputs = session.currentRoute.inputs.map(describePort)
        let ports = session.currentRoute.outputs + session.currentRoute.inputs
        let hasBluetooth = ports.contains { port in
            port.portType == .bluetoothA2DP || port.portType == .bluetoothHFP || port.portType == .bluetoothLE
        }
        let likelyMeta = ports.contains { port in
            let name = port.portName.lowercased()
            return name.contains("ray-ban") || name.contains("rayban") || name.contains("meta")
        }

        return [
            "available": true,
            "connected": hasBluetooth,
            "likelyMetaGlasses": likelyMeta,
            "routeName": (outputs.first?["name"] as? String) ?? (inputs.first?["name"] as? String) ?? "iPhone",
            "outputs": outputs,
            "inputs": inputs
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
