#!/usr/bin/env bash
set -euo pipefail
umask 077

android_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
if [[ -z "$sdk" ]]; then
  echo 'Set ANDROID_HOME to an installed Android SDK.' >&2
  exit 1
fi
tools="$sdk/build-tools/36.0.0"
platform="$sdk/platforms/android-36/android.jar"
if [[ -n "${JAVA_HOME:-}" ]]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi
origin=${FABLE_ANDROID_ORIGIN:-https://app.fablepavilion.com}
verify=${FABLE_ANDROID_FRONTEND_VERIFY:-${POCKET_FRONTEND_VERIFY:-0}}
public_key=
min_sdk=26
case "$verify" in
  0) ;;
  1)
    : "${POCKET_FRONTEND_PUBLIC_KEY_FILE:?Set the frontend release public key PEM path.}"
    : "${FABLE_ANDROID_FRONTEND_RELEASE_DIR:?Set the signed frontend _release directory.}"
    public_key=$(openssl rsa -pubin -in "$POCKET_FRONTEND_PUBLIC_KEY_FILE" -pubout -outform DER 2>/dev/null | openssl base64 -A)
    min_sdk=28
    ;;
  *) echo 'FABLE_ANDROID_FRONTEND_VERIFY must be 0 or 1.' >&2; exit 1 ;;
esac
version=${FABLE_ANDROID_VERSION:-1.0.1}
version_code=${FABLE_ANDROID_VERSION_CODE:-18}
output=${1:-"$android_dir/build/fable-pavilion-$version.apk"}

if [[ ! "$origin" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]{1,5})?$ ]]; then
  echo 'FABLE_ANDROID_ORIGIN must be an HTTPS origin without a path or credentials.' >&2
  exit 1
fi
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || ! "$version_code" =~ ^[1-9][0-9]*$ ]]; then
  echo 'Use a semantic version and a positive Android version code.' >&2
  exit 1
fi
for program in aapt2 d8 zipalign apksigner; do
  test -x "$tools/$program" || { echo "Missing Android build tool $program." >&2; exit 1; }
done
test -r "$platform" || { echo 'Install the Android SDK platform android-36.' >&2; exit 1; }
: "${FABLE_ANDROID_KEYSTORE:?Set the path to the APK signing keystore.}"
: "${FABLE_ANDROID_PASSWORD_FILE:?Set the path to the signing password file.}"

scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
mkdir -p "$scratch/res/values" "$scratch/res/mipmap-xxxhdpi" "$scratch/java" "$scratch/classes" "$scratch/dex"
cp "$android_dir"/app/res/values/*.xml "$scratch/res/values/"
if [[ -d "$android_dir/app/res/values-night" ]]; then
  mkdir -p "$scratch/res/values-night"
  cp "$android_dir"/app/res/values-night/*.xml "$scratch/res/values-night/"
fi
cp "$android_dir/../src/web/public/app-icons/wuyou-192.png" "$scratch/res/mipmap-xxxhdpi/ic_launcher.png"
printf '<resources><string name="web_origin" translatable="false">%s</string><string name="frontend_release_key" translatable="false">%s</string></resources>\n' \
  "$origin" "$public_key" > "$scratch/res/values/origin.xml"

asset_args=()
if [[ "$verify" == 1 ]]; then
  node "$android_dir/stage-frontend.mjs" "$FABLE_ANDROID_FRONTEND_RELEASE_DIR" \
    "$POCKET_FRONTEND_PUBLIC_KEY_FILE" "$scratch/assets/verified-frontend"
  asset_args=(-A "$scratch/assets")
fi

"$tools/aapt2" compile --dir "$scratch/res" -o "$scratch/resources.zip"
"$tools/aapt2" link -I "$platform" "${asset_args[@]}" --manifest "$android_dir/app/AndroidManifest.xml" \
  --min-sdk-version "$min_sdk" --target-sdk-version 36 --version-code "$version_code" --version-name "$version" \
  --java "$scratch/java" -o "$scratch/resources.apk" "$scratch/resources.zip"
javac --release 8 -encoding UTF-8 -Xlint:all -Xlint:-deprecation -Xlint:-options \
  -cp "$platform" -d "$scratch/classes" \
  "$scratch"/java/com/fablepavilion/app/R.java "$android_dir"/app/src/com/fablepavilion/app/*.java
jar cf "$scratch/classes.jar" -C "$scratch/classes" .
"$tools/d8" --release --min-api "$min_sdk" --lib "$platform" --output "$scratch/dex" "$scratch/classes.jar"
jar uf "$scratch/resources.apk" -C "$scratch/dex" classes.dex
"$tools/zipalign" -P 16 -f 4 "$scratch/resources.apk" "$scratch/aligned.apk"
"$tools/apksigner" sign --ks "$FABLE_ANDROID_KEYSTORE" \
  --ks-key-alias "${FABLE_ANDROID_KEY_ALIAS:-fable-pavilion}" \
  --ks-pass "file:$FABLE_ANDROID_PASSWORD_FILE" \
  --out "$scratch/signed.apk" "$scratch/aligned.apk"
"$tools/apksigner" verify "$scratch/signed.apk"
"$tools/zipalign" -c -P 16 4 "$scratch/signed.apk"
mkdir -p "$(dirname -- "$output")"
cp "$scratch/signed.apk" "$output"
printf '%s\n' "$output"
