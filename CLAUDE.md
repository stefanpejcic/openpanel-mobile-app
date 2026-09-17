@AGENTS.md

# What this is

A prototype Android/iOS client for OpenAdmin (the Go admin panel in the sibling `openadmin` repo). Not a native rebuild of the panel UI — it's a thin wrapper: a native "saved servers" list (add/remove server URL + username + password, stored on-device), and tapping a server opens the real OpenAdmin web UI in an in-app WebView with a real logged-in session.

How login works: OpenAdmin already has an endpoint built for exactly this (`internal/handlers/api_login.go` in the `openadmin` repo) — `POST {baseUrl}/api/login` with `{username, password}` returns `{login_path: "/login/sso/{token}"}`, a one-time link. The app loads `{baseUrl}{login_path}` in the WebView, which redeems the token server-side and sets a normal session cookie. From then on it's just the live panel, no custom UI to build/maintain per feature.

Known caveat carried over from the backend: that SSO endpoint skips the TOTP/2FA check (see the comment in `api_login.go`), so a user with 2FA enabled on their OpenAdmin account has it silently bypassed by this app. Not fixed yet — flag before shipping broadly.

App identity: name "OpenAdmin", Android package `com.openpanel.openadmin`, publisher "OpenPanel, LLC". iOS not set up yet (see "Publishing" below — self-hosted download links don't work for iOS the way they do Android).

# Key files

- `App.tsx` — the whole app. Three screens via a state machine (no navigation lib, deliberately, to keep deps minimal): server list, add-server form, webview. Servers' non-secret fields (id/name/baseUrl/username) live in SecureStore under key `oa_servers_meta` as one JSON array; each password is stored separately under its own key `oa_pw_<id>` (kept separate because SecureStore/iOS Keychain values are unreliable above ~2KB, and to avoid one bloated blob). Uses `react-native-safe-area-context`'s `SafeAreaView`, not the core-`react-native` one — the latter is a no-op on Android (was the cause of content sitting under the status bar / gesture nav bar).
- `app.json` — `expo.android.usesCleartextTraffic: true` is on so the app can hit test servers over plain HTTP; revisit before a real release. `expo.extra.eas.projectId` links this to the `stefanpejcic` Expo account's EAS project (only needed if using cloud builds, see below).
- `eas.json` — `preview` profile builds an installable `.apk` (not the Play Store default `.aab`). Cloud EAS builds are not the primary path (see below).
- `plugins/withReleaseSigning.js` — a config plugin that patches `android/app/build.gradle` on every `expo prebuild` to sign release builds with a real keystore when `OPENADMIN_RELEASE_STORE_FILE` etc. are set in the environment, falling back to the RN template's debug keystore otherwise. Needed because `android/` is gitignored and regenerated from scratch each time — hand-editing the generated `build.gradle` wouldn't survive that. If a future Expo/RN template upgrade changes the generated file's shape, this plugin throws a clear error rather than silently patching the wrong thing (it happened once during development — the naive version patched the *debug* buildType's signingConfig instead of release's, because after patching `signingConfigs` the file contains a second `release {` text match).
- `.github/workflows/release-apk.yml` — builds and publishes the signed APK. See "Primary build path" below.

# Primary build path: GitHub Actions

Repo: https://github.com/stefanpejcic/openadmin-mobile-app (public). Pushing a build to a local machine kept freezing it (Gradle daemon alone was observed at ~4GB RAM / 67% CPU during one build) — CI is now the default, not a fallback.

- **On every published GitHub Release**: the workflow builds a signed release APK and attaches it to that release as `OpenAdmin.apk` — that release-asset URL is what should be linked from the website's download button (stable per-release URL, e.g. `https://github.com/stefanpejcic/openadmin-mobile-app/releases/latest/download/OpenAdmin.apk` always points at the newest one).
- **Manual/on-demand**: `gh workflow run release-apk.yml --repo stefanpejcic/openadmin-mobile-app` (or the Actions tab's "Run workflow" button) builds without needing a release — grab the APK from that run's Artifacts.
- Signing secrets live in the repo's Actions secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`) — see "Release keystore" below for what generated them and where the original file lives.
- `versionCode`/`versionName` in `app.json` are still static (`1` / `1.0.0`) — bump them by hand before cutting a release that should be installable as an *update* over a previous install; Android refuses to "upgrade" to an APK with an equal or lower versionCode.

# Release keystore

Generated once on this machine (2026-09-17) with the local JDK 17's `keytool`:

```sh
keytool -genkeypair -v -keystore openadmin-release.keystore -alias openadmin-release \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=OpenAdmin, OU=OpenPanel LLC, O=OpenPanel LLC, C=US"
```

PKCS12 keystores (the modern default) don't support separate store/key passwords — `keytool` silently reuses the store password for both, so `ANDROID_KEY_PASSWORD` and `ANDROID_KEYSTORE_PASSWORD` are the same value.

**The keystore file and its password currently only exist at `~/android-toolchain/keystore/` on this one machine, plus base64-encoded inside the GitHub Actions secret.** GitHub Actions secrets are write-only — there's no way to read `ANDROID_KEYSTORE_BASE64` back out later. If this machine's `~/android-toolchain/keystore/` is lost before a proper backup is made, every future release becomes an entirely new app identity (existing installs can never receive it as an update, only a fresh install after uninstalling). **Back the keystore directory up somewhere durable (password manager, encrypted archive) before relying on this pipeline for real releases.**

# Local Android build (fallback / dev-loop iteration, no Expo account / cloud queue needed)

This machine had no Android SDK installed, so a local, isolated toolchain was set up under `~/android-toolchain` (does NOT touch system Java — system had JDK 11, Expo/RN needs JDK 17):

```sh
# One-time setup (already done on this machine):
mkdir -p ~/android-toolchain && cd ~/android-toolchain
curl -sL -o jdk17.tar.gz "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse?project=jdk"
tar -xzf jdk17.tar.gz   # -> ~/android-toolchain/jdk-17.0.20.1+1

# Android cmdline-tools. NOTE: the edgedl.me.gvt1.com URL from developer.android.com 404s
# on direct curl (geo/session-restricted) — use dl.google.com instead with the same filename.
curl -sL -o cmdline-tools.zip "https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip"
mkdir -p sdk/cmdline-tools_tmp && unzip -q cmdline-tools.zip -d sdk/cmdline-tools_tmp
mkdir -p sdk/cmdline-tools && mv sdk/cmdline-tools_tmp/cmdline-tools sdk/cmdline-tools/latest
rmdir sdk/cmdline-tools_tmp

export JAVA_HOME=~/android-toolchain/jdk-17.0.20.1+1
export ANDROID_HOME=~/android-toolchain/sdk
export PATH="$JAVA_HOME/bin:$PATH"
yes | ~/android-toolchain/sdk/cmdline-tools/latest/bin/sdkmanager --sdk_root="$ANDROID_HOME" \
  "platform-tools" "platforms;android-36" "build-tools;36.0.0"
```

Building the APK (repeatable, run from `openadmin-mobile/`):

```sh
npx expo prebuild -p android   # regenerates the android/ native project from app.json + App.tsx
                                 # (android/ is gitignored — always safe to delete and regenerate)

cd android
export JAVA_HOME=~/android-toolchain/jdk-17.0.20.1+1
export ANDROID_HOME=~/android-toolchain/sdk
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew assembleRelease --no-daemon
```

**Always pass `--no-daemon`.** Without it, Gradle leaves a background daemon process resident after the build finishes (observed using ~4GB RAM / 67% CPU on this machine, freezing it — this is what CI's `--no-daemon` flag in the workflow also avoids). If a build was ever run without it, clean up stragglers with:

```sh
pkill -9 -f 'GradleDaemon|org.gradle.launcher|KotlinCompileDaemon'
```

Output APK: `android/app/build/outputs/apk/release/app-release.apk`, signed with whatever `plugins/withReleaseSigning.js` resolves — the real release keystore if `OPENADMIN_RELEASE_STORE_FILE` etc. are exported in the shell, otherwise the RN template's debug keystore (fine for local sideloading/testing only). See "Release keystore" above.

# Cloud build alternative (EAS)

Not the default path anymore (see chat: local build was chosen to avoid depending on Expo's queue and account), but still configured and available:

```sh
npx eas login
npx eas build --platform android --profile preview
```

Produces a downloadable `.apk` link on expo.dev; requires network + an Expo account (`stefanpejcic`, org `openpanel` also available). Dashboard: https://expo.dev/accounts/stefanpejcic/projects/openadmin-mobile

# Publishing (self-hosted download link)

- Android: host the `.apk` over HTTPS (plain HTTP gets blocked by Chrome's download warnings). No Play Store needed, but expect Android's stock "Play Protect doesn't recognize this app" install-time warning — normal for sideloaded APKs, no way to remove short of also publishing to Play Store.
- No auto-update outside Play Store — plan a simple version-check endpoint the app pings on launch if this goes beyond prototype stage.
- iOS: there's no equivalent to "just host an .ipa" — Apple requires either the App Store (review + $99/yr dev account) or TestFlight (still reviewed for external testers, 90-day link expiry). Enterprise Program distribution to the public outside one's own org violates Apple's terms. Android-only for now per current scope.
