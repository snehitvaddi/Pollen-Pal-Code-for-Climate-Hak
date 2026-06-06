import Capacitor
import UIKit

class AppBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(PollenPalGlassesPlugin())
    }
}
