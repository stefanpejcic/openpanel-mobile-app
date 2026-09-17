// Patches android/app/build.gradle (regenerated on every `expo prebuild`) so
// release builds sign with a real keystore when the OPENADMIN_RELEASE_STORE_FILE
// env var is set (CI), and fall back to the RN template's debug keystore
// otherwise (local dev builds), instead of hand-editing the generated file.
const { withAppBuildGradle } = require('expo/config-plugins');

const DEBUG_SIGNING_CONFIG = `signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }`;

const PATCHED_SIGNING_CONFIG = `signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
        release {
            def releaseStoreFile = System.getenv('OPENADMIN_RELEASE_STORE_FILE')
            if (releaseStoreFile != null) {
                storeFile file(releaseStoreFile)
                storePassword System.getenv('OPENADMIN_RELEASE_STORE_PASSWORD')
                keyAlias System.getenv('OPENADMIN_RELEASE_KEY_ALIAS')
                keyPassword System.getenv('OPENADMIN_RELEASE_KEY_PASSWORD')
            }
        }
    }`;

const DEBUG_RELEASE_SIGNING_CONFIG = 'signingConfig signingConfigs.debug';
const PATCHED_RELEASE_SIGNING_CONFIG =
  "signingConfig System.getenv('OPENADMIN_RELEASE_STORE_FILE') != null ? signingConfigs.release : signingConfigs.debug";

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (config) => {
    let contents = config.modResults.contents;

    if (!contents.includes(DEBUG_SIGNING_CONFIG)) {
      throw new Error(
        'withReleaseSigning: android/app/build.gradle signingConfigs block did not match the expected template. ' +
          'The Expo/RN template likely changed shape — update plugins/withReleaseSigning.js.'
      );
    }
    contents = contents.replace(DEBUG_SIGNING_CONFIG, PATCHED_SIGNING_CONFIG);

    // Only the release buildType's occurrence should flip; debug stays on signingConfigs.debug.
    // Anchored to "buildTypes {" (not just "release {") since the signingConfigs block patched
    // above now also contains a "release {" of its own, which would match first otherwise.
    const buildTypesStart = contents.indexOf('buildTypes {');
    const releaseBlockStart = contents.indexOf('release {', buildTypesStart);
    const patchIndex = contents.indexOf(DEBUG_RELEASE_SIGNING_CONFIG, releaseBlockStart);
    if (buildTypesStart === -1 || releaseBlockStart === -1 || patchIndex === -1) {
      throw new Error(
        'withReleaseSigning: could not find the release buildType signingConfig line to patch.'
      );
    }
    contents =
      contents.slice(0, patchIndex) +
      PATCHED_RELEASE_SIGNING_CONFIG +
      contents.slice(patchIndex + DEBUG_RELEASE_SIGNING_CONFIG.length);

    config.modResults.contents = contents;
    return config;
  });
};
