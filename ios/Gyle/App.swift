import UIKit

/// The start of the app. iOS makes one of these when it opens Gyle.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        Alerts.shared.start()
        return true
    }
}

/// The app's one window. Info.plist names this class, so there is no storyboard.
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    private var screen: WebScreen? { window?.rootViewController as? WebScreen }

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        // A sign-in link can be what started the app.
        window.rootViewController = WebScreen(link: connectionOptions.urlContexts.first?.url)
        window.makeKeyAndVisible()
        self.window = window
    }

    /// A gyle://auth sign-in link arrived while the app was open.
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        if let link = URLContexts.first?.url { screen?.open(link: link) }
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        screen?.cameBack()
    }
}
