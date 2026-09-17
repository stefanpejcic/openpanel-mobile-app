@AGENTS.md

# What this is

A prototype Android/iOS client for OpenAdmin (the Go admin panel in the sibling `openadmin` repo). Not a native rebuild of the panel UI — it's a thin wrapper: a native "saved servers" list (add/remove server URL + username + password, stored on-device), and tapping a server opens the real OpenAdmin web UI in an in-app WebView with a real logged-in session.

How login works: OpenAdmin already has an endpoint built for exactly this (`internal/handlers/api_login.go` in the `openadmin` repo) — `POST {baseUrl}/api/login` with `{username, password}` returns `{login_path: "/login/sso/{token}"}`, a one-time link. The app loads `{baseUrl}{login_path}` in the WebView, which redeems the token server-side and sets a normal session cookie. From then on it's just the live panel, no custom UI to build/maintain per feature.

Known caveat carried over from the backend: that SSO endpoint skips the TOTP/2FA check (see the comment in `api_login.go`), so a user with 2FA enabled on their OpenAdmin account has it silently bypassed by this app. Not fixed yet — flag before shipping broadly.

App identity: name "OpenAdmin", Android package `com.openpanel.openadmin`, publisher "OpenPanel, LLC". iOS not set up yet (see "Publishing" below — self-hosted download links don't work for iOS the way they do Android).

# Key files

- `App.tsx` — the whole app. Three screens via a state machine (no navigation lib, deliberately, to keep deps minimal): server list, add-server form, webview. Servers' non-secret fields (id/name/baseUrl/username) live in SecureStore under key `oa_servers_meta` as one JSON array; each password is stored separately under its own key `oa_pw_<id>` (kept separate because SecureStore/iOS Keychain values are unreliable above ~2KB, and to avoid one bloated blob).
- `app.json` — `expo.android.usesCleartextTraffic: true` is on so the app can hit test servers over plain HTTP; revisit before a real release. `expo.extra.eas.projectId` links this to the `stefanpejcic` Expo account's EAS project (only needed if using cloud builds, see below).
- `eas.json` — `preview` profile builds an installable `.apk` (not the Play Store default `.aab`).

# Local Android build (no Expo account / cloud queue needed)

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
./gradlew assembleRelease
```

Output APK: `android/app/build/outputs/apk/release/app-release.apk`. This is signed with the RN/Expo template's default debug keystore (fine for sideloading/testing) — **before any public download link goes live, generate a real release keystore and keep it backed up**, since every future update must be signed with the same key or installs can't upgrade in place.

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
