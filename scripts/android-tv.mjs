// After `tauri android init`: make the Android build also an Android TV app.
// Adds the TV launcher entry, marks touch as optional, and sets the home-screen banner.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'

const root = 'src-tauri/gen/android/app/src/main'
const path = `${root}/AndroidManifest.xml`
let xml = readFileSync(path, 'utf8')

if (!xml.includes('android.software.leanback')) {
  xml = xml.replace('<application', [
    '<uses-feature android:name="android.software.leanback" android:required="false" />',
    '    <uses-feature android:name="android.hardware.touchscreen" android:required="false" />',
    '    <application',
  ].join('\n'))
}
if (!xml.includes('android:banner')) xml = xml.replace('<application', '<application android:banner="@drawable/tv_banner"')
if (!xml.includes('LEANBACK_LAUNCHER')) {
  xml = xml.replace('<category android:name="android.intent.category.LAUNCHER" />',
    '<category android:name="android.intent.category.LAUNCHER" />\n                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />')
}
writeFileSync(path, xml)
mkdirSync(`${root}/res/drawable`, { recursive: true })
copyFileSync('assets/tv-banner.png', `${root}/res/drawable/tv_banner.png`)
const ok = ['leanback', 'LEANBACK_LAUNCHER', 'tv_banner'].every((k) => xml.includes(k))
console.log(ok ? 'Android TV manifest ready' : 'Android TV patch FAILED')
process.exit(ok ? 0 : 1)
