import * as esbuild from 'esbuild'
import {copyToAppPlugin, copyManifestPlugin, commonConfig} from "./build.helpers.mjs"
import parseArgs from "minimist"

const outDir = `dist/AutoPrettifier`
const appDir = "C:\\Mendix Projects\\AuraQ\\AgnosticToolingTestApp-dev-Stitch"
const extensionDirectoryName = "extensions"

// This extension is headless: it contributes an Extensions-menu item and works purely
// through the app model API, so it ships no UI tab entry point.
const entryPoints = [
    {
        in: 'src/main/index.ts',
        out: 'main'
    }
]

const args = parseArgs(process.argv.slice(2))
const buildContext = await esbuild.context({
  ...commonConfig,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outdir: outDir,
  plugins: [copyManifestPlugin(outDir), copyToAppPlugin(appDir, outDir, extensionDirectoryName)],
  entryPoints
})

if('watch' in args) {
    await buildContext.watch();
}
else {
    await buildContext.rebuild();
    await buildContext.dispose();
}