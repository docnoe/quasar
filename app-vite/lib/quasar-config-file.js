import { join, isAbsolute, basename, dirname, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import fse from 'fs-extra'
import { merge } from 'webpack-merge'
import debounce from 'lodash/debounce.js'
import { build as esBuild, context as esContextBuild } from 'esbuild'
import { transformAssetUrls } from '@quasar/vite-plugin'

import { log, warn, fatal, tip } from './utils/logger.js'
import { appFilesValidations } from './utils/app-files-validations.js'
import { getPackageMajorVersion } from './utils/get-package-major-version.js'
import { resolveExtension } from './utils/resolve-extension.js'
import { ensureElectronArgv } from './utils/ensure-argv.js'
import { quasarEsbuildInjectReplacementsDefine, quasarEsbuildInjectReplacementsPlugin } from './plugins/esbuild.inject-replacements.js'

const urlRegex = /^http(s)?:\/\//i
import { findClosestOpenPort, localHostList } from './utils/net.js'
import { isMinimalTerminal } from './utils/is-minimal-terminal.js'
import { readFileEnv } from './utils/env.js'

const defaultPortMapping = {
  spa: 9000,
  ssr: 9100, // 9150 for SSR + PWA
  pwa: 9200,
  electron: 9300,
  cordova: 9400,
  capacitor: 9500
}

const quasarComponentRE = /^(Q[A-Z]|q-)/
const quasarConfigBanner = `/* eslint-disable */
/**
 * THIS FILE IS GENERATED AUTOMATICALLY.
 * 1. DO NOT edit this file directly as it won't do anything.
 * 2. EDIT the original quasar.config file INSTEAD.
 * 3. DO NOT git commit this file. It should be ignored.
 *
 * This file is still here because there was an error in
 * the original quasar.config file and this allows you to
 * investigate the Node.js stack error.
 *
 * After you fix the original file, this file will be
 * deleted automatically.
 **/
`

function escapeHTMLTagContent (str) {
  return str ? str.replace(/[<>]/g, '') : ''
}
function escapeHTMLAttribute (str) {
  return str ? str.replace(/\"/g, '') : ''
}

function formatPublicPath (publicPath) {
  if (!publicPath) {
    return '/'
  }

  if (!publicPath.endsWith('/')) {
    publicPath = `${ publicPath }/`
  }

  if (urlRegex.test(publicPath) === true) {
    return publicPath
  }

  if (!publicPath.startsWith('/')) {
    publicPath = `/${ publicPath }`
  }

  return publicPath
}

function formatRouterBase (publicPath) {
  if (!publicPath || !publicPath.startsWith('http')) {
    return publicPath
  }

  const match = publicPath.match(/^(https?\:)\/\/(([^:\/?#]*)(?:\:([0-9]+))?)([\/]{0,1}[^?#]*)(\?[^#]*|)(#.*|)$/)
  return formatPublicPath(match[ 5 ] || '')
}

function parseAssetProperty (prefix) {
  return asset => {
    if (typeof asset === 'string') {
      return {
        path: asset[ 0 ] === '~' ? asset.substring(1) : prefix + `/${ asset }`
      }
    }

    return {
      ...asset,
      path: typeof asset.path === 'string'
        ? (asset.path[ 0 ] === '~' ? asset.path.substring(1) : prefix + `/${ asset.path }`)
        : asset.path
    }
  }
}

function getUniqueArray (original) {
  return Array.from(new Set(original))
}

function uniquePathFilter (value, index, self) {
  return self.map(obj => obj.path).indexOf(value.path) === index
}

let cachedExternalHost, addressRunning = false

async function onAddress ({ host, port }, mode) {
  if (
    [ 'cordova', 'capacitor' ].includes(mode)
    && (!host || localHostList.includes(host.toLowerCase()))
  ) {
    if (cachedExternalHost) {
      host = cachedExternalHost
    }
    else {
      const { getExternalIP } = await import('./utils/get-external-ip.js')
      host = await getExternalIP()
      cachedExternalHost = host
    }
  }

  try {
    const openPort = await findClosestOpenPort(port, host)
    if (port !== openPort) {
      warn()
      warn(`️️Setting port to closest one available: ${ openPort }`)
      warn()

      port = openPort
    }
  }
  catch (e) {
    warn()

    if (e.message === 'ERROR_NETWORK_PORT_NOT_AVAIL') {
      warn('Could not find an open port. Please configure a lower one to start searching with.')
    }
    else if (e.message === 'ERROR_NETWORK_ADDRESS_NOT_AVAIL') {
      warn('Invalid host specified. No network address matches. Please specify another one.')
    }
    else {
      warn('Unknown network error occurred')
      console.error(e)
    }

    warn()

    if (addressRunning === false) {
      process.exit(1)
    }

    return null
  }

  addressRunning = true
  return { host, port }
}

export class QuasarConfigFile {
  #ctx
  #opts
  #versions = {}
  #address
  #isWatching = false

  #require
  #tempFile

  #cssVariables
  #storeProvider
  #vueDevtools
  #electronInspectPort

  constructor ({ ctx, host, port, verifyAddress, watch }) {
    this.#ctx = ctx
    this.#opts = { host, port, verifyAddress }

    if (watch !== void 0) {
      this.#opts.watch = debounce(watch, 550)
    }

    const { appPaths } = ctx

    this.#require = appPaths.quasarConfigOutputFormat === 'cjs'
      ? createRequire(import.meta.url)
      : () => {}

    const quasarConfigFileExtension = appPaths.quasarConfigOutputFormat === 'esm' ? 'mjs' : appPaths.quasarConfigOutputFormat
    this.#tempFile = `${ appPaths.quasarConfigFilename }.temporary.compiled.${ Date.now() }.${ quasarConfigFileExtension }`

    log(`Using ${ basename(appPaths.quasarConfigFilename) } in "${ appPaths.quasarConfigInputFormat }" format`)
  }

  async init () {
    const { appPaths, cacheProxy, appExt } = this.#ctx

    this.#cssVariables = await cacheProxy.getModule('cssVariables')
    this.#storeProvider = await cacheProxy.getModule('storeProvider')

    await appExt.registerAppExtensions()

    if (this.#ctx.mode.pwa) {
      // Enable this when workbox bumps version (as of writing these lines, we're handling v6 & v7)
      // this.#versions.workbox = getPackageMajorVersion('workbox-build', appPaths.appDir)
    }
    else if (this.#ctx.mode.capacitor) {
      const { capVersion } = await cacheProxy.getModule('capCli')

      const getCapPluginVersion = capVersion <= 2
        ? () => true
        : name => {
          const version = getPackageMajorVersion(name, appPaths.capacitorDir)
          return version === void 0
            ? false
            : version || true
        }

      Object.assign(this.#versions, {
        capacitor: capVersion,
        capacitorPluginApp: getCapPluginVersion('@capacitor/app'),
        capacitorPluginSplashscreen: getCapPluginVersion('@capacitor/splash-screen')
      })
    }
  }

  read () {
    const esbuildConfig = this.#createEsbuildConfig()
    return this.#opts.watch !== void 0
      ? this.#buildAndWatch(esbuildConfig)
      : this.#build(esbuildConfig)
  }

  // start watching for changes
  watch () {
    this.#isWatching = true
  }

  #createEsbuildConfig () {
    const { appPaths } = this.#ctx

    return {
      platform: 'node',
      format: appPaths.quasarConfigOutputFormat,
      bundle: true,
      packages: 'external',
      alias: {
        'quasar/wrappers': appPaths.quasarConfigOutputFormat === 'esm' ? 'quasar/wrappers/index.mjs' : 'quasar/wrappers/index.js'
      },
      banner: {
        js: quasarConfigBanner
      },
      define: quasarEsbuildInjectReplacementsDefine,
      resolveExtensions: [ appPaths.quasarConfigOutputFormat === 'esm' ? '.mjs' : '.cjs', '.js', '.mts', '.ts', '.json' ],
      entryPoints: [ appPaths.quasarConfigFilename ],
      outfile: this.#tempFile,
      plugins: [ quasarEsbuildInjectReplacementsPlugin ]
    }
  }

  async #build (esbuildConfig) {
    try {
      await esBuild(esbuildConfig)
    }
    catch (e) {
      fse.removeSync(this.#tempFile)
      console.log()
      console.error(e)
      fatal('Could not compile the quasar.config file because it has errors.', 'FAIL')
    }

    let quasarConfigFn
    try {
      const fnResult = await import(
        pathToFileURL(this.#tempFile)
      )

      quasarConfigFn = fnResult.default || fnResult
    }
    catch (e) {
      console.log()
      console.error(e)
      fatal(
        'The quasar.config file has runtime errors. Please check the Node.js stack above against the'
        + ` temporarily created ${ basename(this.#tempFile) } file, fix the original file then DELETE the temporary one.`,
        'FAIL'
      )
    }

    return this.#computeConfig(quasarConfigFn, true)
  }

  async #buildAndWatch (esbuildConfig) {
    let firstBuildIsDone

    const { appPaths } = this.#ctx
    const { updateAppPackageJson } = this.#ctx.pkg
    const tempFile = this.#tempFile

    esbuildConfig.plugins.push({
      name: 'quasar:watcher',
      setup: build => {
        let isFirst = true

        build.onStart(() => {
          if (isFirst === false) {
            log()
            log('The quasar.config file (or its dependencies) changed. Reading it again...')
            updateAppPackageJson()
          }
        })

        build.onEnd(async result => {
          if (isFirst === false && this.#isWatching === false) {
            // not ready yet; watch() has not been issued yet
            return
          }

          if (result.errors.length !== 0) {
            fse.removeSync(tempFile)

            const msg = 'Could not compile the quasar.config file because it has errors.'

            if (isFirst === true) {
              fatal(msg, 'FAIL')
            }

            warn(msg + ' Please fix them.\n')
            return
          }

          let quasarConfigFn

          // ensure we grab the latest version
          if (appPaths.quasarConfigOutputFormat === 'cjs') {
            delete this.#require.cache[ tempFile ]
          }

          try {
            const result = appPaths.quasarConfigOutputFormat === 'esm'
              ? await import(pathToFileURL(tempFile) + '?t=' + Date.now()) // we also need to cache bust it, hence the ?t= param
              : this.#require(tempFile)

            quasarConfigFn = result.default || result
          }
          catch (e) {
            // free up memory immediately
            if (appPaths.quasarConfigOutputFormat === 'cjs') {
              delete this.#require.cache[ tempFile ]
            }

            console.log()
            console.error(e)

            const msg = 'Importing quasar.config file results in error. Please check the'
              + ` Node.js stack above against the temporarily created ${ basename(tempFile) } file and fix the original file.`

            if (isFirst === true) {
              fatal(msg, 'FAIL')
            }

            warn(msg + '\n')
            return
          }

          // free up memory immediately
          if (appPaths.quasarConfigOutputFormat === 'cjs') {
            delete this.#require.cache[ tempFile ]
          }

          const quasarConf = await this.#computeConfig(quasarConfigFn, isFirst)

          if (quasarConf === void 0) {
            return
          }

          if (isFirst === true) {
            isFirst = false
            firstBuildIsDone(quasarConf)
            return
          }

          log('Scheduled to apply quasar.config changes in 550ms')
          this.#opts.watch(quasarConf)
        })
      }
    })

    const esbuildCtx = await esContextBuild(esbuildConfig)
    await esbuildCtx.watch()

    return new Promise(res => { // eslint-disable-line promise/param-names
      firstBuildIsDone = res
    })
  }

  // return void 0 if it encounters errors
  // and quasarConf otherwise
  async #computeConfig (quasarConfigFn, failOnError) {
    if (typeof quasarConfigFn !== 'function') {
      fse.removeSync(this.#tempFile)

      const msg = 'The default export value of the quasar.config file is not a function.'

      if (failOnError === true) {
        fatal(msg, 'FAIL')
      }

      warn(msg + ' Please fix it.\n')
      return
    }

    let userCfg

    try {
      userCfg = await quasarConfigFn(this.#ctx)
    }
    catch (e) {
      console.log()
      console.error(e)

      const msg = 'The quasar.config file has runtime errors.'
        + ' Please check the Node.js stack above against the'
        + ` temporarily created ${ basename(this.#tempFile) } file`
        + ' then DELETE it.'

      if (failOnError === true) {
        fatal(msg, 'FAIL')
      }

      warn(msg + ' Please fix the errors in the original file.\n')
      return
    }

    if (Object(userCfg) !== userCfg) {
      fse.removeSync(this.#tempFile)

      const msg = 'The quasar.config file does not default exports an Object.'

      if (failOnError === true) {
        fatal(msg, 'FAIL')
      }

      warn(msg + ' Please fix it.\n')
      return
    }

    fse.removeSync(this.#tempFile)

    const { appPaths } = this.#ctx

    const rawQuasarConf = merge({
      ctx: this.#ctx,

      boot: [],
      css: [],
      extras: [],
      animations: [],
      framework: {
        components: [],
        directives: [],
        plugins: [],
        config: {}
      },

      eslint: {
        include: [],
        exclude: [],
        rawOptions: {}
      },

      sourceFiles: {},
      bin: {},
      htmlVariables: {},

      devServer: {
        fs: {}
      },

      build: {
        target: {},
        viteVuePluginOptions: {},
        vitePlugins: [],
        env: {},
        rawDefine: {},
        envFiles: [],
        resolve: {},
        htmlMinifyOptions: {}
      },

      ssr: {
        middlewares: []
      },
      pwa: {},
      electron: {
        unPackagedInstallParams: [],
        packager: {},
        builder: {}
      },
      cordova: {},
      capacitor: {
        capacitorCliPreparationParams: []
      },
      bex: {
        contentScripts: []
      }
    }, userCfg)

    const metaConf = {
      debugging: this.#ctx.dev === true || this.#ctx.debug === true,
      needsAppMountHook: false,
      vueDevtools: false,
      versions: { ...this.#versions }, // used by entry templates
      css: { ...this.#cssVariables }
    }

    if (rawQuasarConf.animations === 'all') {
      rawQuasarConf.animations = await this.#ctx.cacheProxy.getModule('animations')
    }

    try {
      await this.#ctx.appExt.runAppExtensionHook('extendQuasarConf', async hook => {
        log(`Extension(${ hook.api.extId }): Extending quasar.config file configuration...`)
        await hook.fn(rawQuasarConf, hook.api)
      })
    }
    catch (e) {
      console.log()
      console.error(e)

      if (failOnError === true) {
        fatal('One of your installed App Extensions failed to run', 'FAIL')
      }

      warn('One of your installed App Extensions failed to run.\n')
      return
    }

    const cfg = {
      ...rawQuasarConf,
      metaConf
    }

    // we need to know if using SSR + PWA immediately
    if (this.#ctx.mode.ssr) {
      cfg.ssr = merge({
        pwa: false,
        pwaOfflineHtmlFilename: 'offline.html',
        manualStoreHydration: false,
        manualPostHydrationTrigger: false,
        prodPort: 3000 // gets superseded in production by an eventual process.env.PORT
      }, cfg.ssr)
    }

    // if DEV and not BEX mode (BEX does not use a regular devserver)
    if (this.#ctx.dev && this.#ctx.mode.bex !== true) {
      if (this.#opts.host) {
        cfg.devServer.host = this.#opts.host
      }
      else if (!cfg.devServer.host) {
        cfg.devServer.host = '0.0.0.0'
      }

      if (this.#opts.port) {
        cfg.devServer.port = this.#opts.port
        tip('You are using the --port parameter. It is recommended to use a different devServer port for each Quasar mode to avoid browser cache issues')
      }
      else if (!cfg.devServer.port) {
        cfg.devServer.port = defaultPortMapping[ this.#ctx.modeName ]
          + (this.#ctx.mode.ssr === true && cfg.ssr.pwa === true ? 50 : 0)
      }
      else {
        tip(
          'You specified an explicit quasar.config file > devServer > port. It is recommended to use'
          + ' a different devServer > port for each Quasar mode to avoid browser cache issues.'
          + ' Example: ctx.mode.ssr ? 9100 : ...'
        )
      }

      if (
        this.#address
        && this.#address.from.host === cfg.devServer.host
        && this.#address.from.port === cfg.devServer.port
      ) {
        cfg.devServer.host = this.#address.to.host
        cfg.devServer.port = this.#address.to.port
      }
      else {
        const addr = {
          host: cfg.devServer.host,
          port: cfg.devServer.port
        }
        const to = this.#opts.verifyAddress === true
          ? await onAddress(addr, this.#ctx.modeName)
          : addr

        // if network error while running
        if (to === null) {
          const msg = 'Network error encountered while following the quasar.config file host/port config.'

          if (failOnError === true) {
            fatal(msg, 'FAIL')
          }

          warn(msg + ' Reconfigure and save the file again.\n')
          return
        }

        cfg.devServer = merge({ open: true }, cfg.devServer, to)
        this.#address = {
          from: addr,
          to: {
            host: cfg.devServer.host,
            port: cfg.devServer.port
          }
        }
      }
    }

    if (cfg.css.length > 0) {
      cfg.css = cfg.css.filter(_ => _)
        .map(parseAssetProperty('src/css'))
        .filter(asset => asset.path)
        .filter(uniquePathFilter)
    }

    if (cfg.boot.length > 0) {
      cfg.boot = cfg.boot.filter(_ => _)
        .map(parseAssetProperty('boot'))
        .filter(asset => asset.path)
        .filter(uniquePathFilter)
    }

    if (cfg.extras.length > 0) {
      cfg.extras = getUniqueArray(cfg.extras)
    }

    if (cfg.animations.length > 0) {
      cfg.animations = getUniqueArray(cfg.animations)
    }

    if (![ 'kebab', 'pascal', 'combined' ].includes(cfg.framework.autoImportComponentCase)) {
      cfg.framework.autoImportComponentCase = 'kebab'
    }

    // special case where a component can be designated for a framework > config prop
    const { config } = cfg.framework

    if (config.loading) {
      const { spinner } = config.loading
      if (quasarComponentRE.test(spinner)) {
        cfg.framework.components.push(spinner)
      }
    }

    if (config.notify) {
      const { spinner } = config.notify
      if (quasarComponentRE.test(spinner)) {
        cfg.framework.components.push(spinner)
      }
    }

    cfg.framework.components = getUniqueArray(cfg.framework.components)
    cfg.framework.directives = getUniqueArray(cfg.framework.directives)
    cfg.framework.plugins = getUniqueArray(cfg.framework.plugins)

    Object.assign(cfg.metaConf, {
      hasLoadingBarPlugin: cfg.framework.plugins.includes('LoadingBar'),
      hasMetaPlugin: cfg.framework.plugins.includes('Meta')
    })

    cfg.eslint = merge({
      warnings: false,
      errors: false,
      fix: false,
      formatter: 'stylish',
      cache: true,
      include: [],
      exclude: [],
      rawOptions: {}
    }, cfg.eslint)

    cfg.build = merge({
      viteVuePluginOptions: {
        isProduction: this.#ctx.prod === true,
        template: {
          isProd: this.#ctx.prod === true,
          transformAssetUrls
        }
      },

      vueOptionsAPI: true,
      polyfillModulePreload: false,
      distDir: join('dist', this.#ctx.modeName),

      htmlMinifyOptions: {
        removeComments: true,
        collapseWhitespace: true,
        removeAttributeQuotes: true,
        collapseBooleanAttributes: true,
        removeScriptTypeAttributes: true
        // more options:
        // https://github.com/kangax/html-minifier#options-quick-reference
      },

      rawDefine: {
        // vue
        __VUE_OPTIONS_API__: cfg.build.vueOptionsAPI !== false,
        __VUE_PROD_DEVTOOLS__: cfg.metaConf.debugging,

        // vue-i18n
        __VUE_I18N_FULL_INSTALL__: true,
        __VUE_I18N_LEGACY_API__: true,
        __VUE_I18N_PROD_DEVTOOLS__: cfg.metaConf.debugging,
        __INTLIFY_PROD_DEVTOOLS__: cfg.metaConf.debugging
      },

      alias: {
        src: appPaths.srcDir,
        app: appPaths.appDir,
        components: appPaths.resolve.src('components'),
        layouts: appPaths.resolve.src('layouts'),
        pages: appPaths.resolve.src('pages'),
        assets: appPaths.resolve.src('assets'),
        boot: appPaths.resolve.src('boot'),
        stores: appPaths.resolve.src('stores')
      },

      useFilenameHashes: true,
      vueRouterMode: 'hash',
      minify: cfg.metaConf.debugging !== true
        && (this.#ctx.mode.bex !== true || cfg.bex.minify === true),
      sourcemap: cfg.metaConf.debugging === true
    }, cfg.build)

    if (!cfg.build.target.browser) {
      cfg.build.target.browser = [ 'es2019', 'edge88', 'firefox78', 'chrome87', 'safari13.1' ]
    }

    if (!cfg.build.target.node) {
      cfg.build.target.node = 'node16'
    }

    if (this.#ctx.mode.ssr) {
      cfg.build.vueRouterMode = 'history'
    }
    else if (this.#ctx.mode.cordova || this.#ctx.mode.capacitor || this.#ctx.mode.electron || this.#ctx.mode.bex) {
      cfg.build.vueRouterMode = 'hash'
    }

    if (this.#ctx.dev === true && this.#ctx.mode.bex) {
      // we want to differentiate the folder
      // otherwise we can't run dev and build simultaneously;
      // it's better regardless because it's easier to select the dev folder
      // when loading the browser extension

      const name = basename(cfg.build.distDir)

      cfg.build.distDir = join(
        dirname(cfg.build.distDir),
        name === 'bex' ? 'bex--dev' : `bex-dev--${ name }`
      )
    }

    if (!isAbsolute(cfg.build.distDir)) {
      cfg.build.distDir = appPaths.resolve.app(cfg.build.distDir)
    }

    cfg.build.publicPath
      = cfg.build.publicPath && [ 'spa', 'pwa', 'ssr' ].includes(this.#ctx.modeName)
        ? formatPublicPath(cfg.build.publicPath)
        : ([ 'capacitor', 'cordova', 'electron', 'bex' ].includes(this.#ctx.modeName) ? '' : '/')

    /* careful if you configure the following; make sure that you really know what you are doing */
    cfg.build.vueRouterBase = cfg.build.vueRouterBase !== void 0
      ? cfg.build.vueRouterBase
      : formatRouterBase(cfg.build.publicPath)

    // when adding new props here be sure to update
    // all impacted devserver diffs (look for this.registerDiff() calls)
    cfg.sourceFiles = merge({
      rootComponent: 'src/App.vue',
      router: 'src/router/index',
      store: `src/${ this.#storeProvider.pathKey }/index`,
      pwaRegisterServiceWorker: 'src-pwa/register-service-worker',
      pwaServiceWorker: 'src-pwa/custom-service-worker',
      pwaManifestFile: 'src-pwa/manifest.json',
      electronMain: 'src-electron/electron-main',
      electronPreload: 'src-electron/electron-preload',
      bexManifestFile: 'src-bex/manifest.json'
    }, cfg.sourceFiles)

    if (appFilesValidations(appPaths) === false) {
      if (failOnError === true) {
        fatal('Files validation not passed successfully', 'FAIL')
      }

      warn('Files validation not passed successfully. Please fix the issues.\n')
      return
    }

    // do we have a store?
    const storePath = appPaths.resolve.app(cfg.sourceFiles.store)
    Object.assign(cfg.metaConf, {
      hasStore: resolveExtension(storePath) !== void 0,
      storePackage: this.#storeProvider.name
    })

    // make sure we have preFetch in config
    cfg.preFetch = cfg.preFetch || false

    if (this.#ctx.mode.capacitor & cfg.capacitor.capacitorCliPreparationParams.length === 0) {
      cfg.capacitor.capacitorCliPreparationParams = [ 'sync', this.#ctx.targetName ]
    }

    if (this.#ctx.mode.ssr) {
      if (cfg.ssr.manualPostHydrationTrigger !== true) {
        cfg.metaConf.needsAppMountHook = true
      }

      if (cfg.ssr.middlewares.length > 0) {
        cfg.ssr.middlewares = cfg.ssr.middlewares.filter(_ => _)
          .map(parseAssetProperty('app/src-ssr/middlewares'))
          .filter(asset => asset.path)
          .filter(uniquePathFilter)
      }

      if (cfg.ssr.pwa === true) {
        // install pwa mode if it's missing
        const { addMode } = await import('../lib/modes/pwa/pwa-installation.js')
        await addMode({ ctx: this.#ctx, silent: true })
      }

      this.#ctx.mode.pwa = cfg.ctx.mode.pwa = cfg.ssr.pwa === true

      if (this.#ctx.dev) {
        if (cfg.devServer.https === true) {
          const { getCertificate } = await import('@quasar/ssl-certificate')
          const sslCertificate = getCertificate({ log, fatal })
          cfg.devServer.https = {
            key: sslCertificate,
            cert: sslCertificate
          }
        }
        else if (Object(cfg.devServer.https) === cfg.devServer.https) {
          const { https } = cfg.devServer

          // we now check if config is specifying a file path
          // and we actually read the contents so we can later supply correct
          // params to the node HTTPS server
          ;[ 'ca', 'pfx', 'key', 'cert' ].forEach(prop => {
            if (typeof https[ prop ] === 'string') {
              try {
                https[ prop ] = readFileSync(https[ prop ])
              }
              catch (e) {
                console.error(e)
                console.log()
                delete https[ prop ]
                warn(`The devServer.https.${ prop } file could not be read. Removed the config.`)
              }
            }
          })
        }
      }
      else {
        cfg.metaConf.ssrServerEntryPointExtension = this.#ctx.pkg.appPkg.type === 'module' ? 'js' : 'mjs'
      }
    }

    if (this.#ctx.dev) {
      if (this.#ctx.vueDevtools === true || cfg.devServer.vueDevtools === true) {
        if (this.#vueDevtools === void 0) {
          const host = localHostList.includes(cfg.devServer.host.toLowerCase())
            ? 'localhost'
            : cfg.devServer.host

          this.#vueDevtools = {
            host,
            port: await findClosestOpenPort(11111, '0.0.0.0')
          }
        }

        cfg.metaConf.vueDevtools = { ...this.#vueDevtools }
      }

      if (this.#ctx.mode.cordova || this.#ctx.mode.capacitor || this.#ctx.mode.electron) {
        if (this.#ctx.mode.electron) {
          cfg.devServer.https = false
        }
      }
      else if (cfg.devServer.open) {
        cfg.metaConf.openBrowser = !isMinimalTerminal
          ? cfg.devServer.open
          : false
      }

      delete cfg.devServer.open
    }

    if (this.#ctx.mode.pwa) {
      cfg.pwa = merge({
        workboxMode: 'GenerateSW',
        injectPwaMetaTags: true,
        swFilename: 'sw.js', // should be .js (as it's the distribution file, not the input file)
        manifestFilename: 'manifest.json',
        useCredentialsForManifestTag: false
      }, cfg.pwa)

      if (![ 'GenerateSW', 'InjectManifest' ].includes(cfg.pwa.workboxMode)) {
        const msg = `Workbox strategy "${ cfg.pwa.workboxMode }" is invalid. `
          + 'Valid quasar.config file > pwa > workboxMode options are: GenerateSW or InjectManifest.'

        if (failOnError === true) {
          fatal(msg, 'FAIL')
        }

        warn(msg + ' Please fix it.\n')
        return
      }

      cfg.build.env.SERVICE_WORKER_FILE = `${ cfg.build.publicPath }${ cfg.pwa.swFilename }`
      cfg.metaConf.pwaManifestFile = appPaths.resolve.app(cfg.sourceFiles.pwaManifestFile)

      // resolve extension
      const swPath = appPaths.resolve.app(cfg.sourceFiles.pwaServiceWorker)
      cfg.sourceFiles.pwaServiceWorker = resolveExtension(swPath) || cfg.sourceFiles.pwaServiceWorker
    }
    else if (this.#ctx.mode.bex) {
      cfg.metaConf.bexManifestFile = appPaths.resolve.app(cfg.sourceFiles.bexManifestFile)
    }

    if (this.#ctx.dev) {
      const getUrl = hostname => `http${ cfg.devServer.https ? 's' : '' }://${ hostname }:${ cfg.devServer.port }${ cfg.build.publicPath }`
      const hostname = cfg.devServer.host === '0.0.0.0'
        ? 'localhost'
        : cfg.devServer.host

      cfg.metaConf.APP_URL = getUrl(hostname)
      cfg.metaConf.getUrl = getUrl
    }
    else if (this.#ctx.mode.cordova || this.#ctx.mode.capacitor || this.#ctx.mode.bex) {
      cfg.metaConf.APP_URL = 'index.html'
    }
    // Electron is handled in lib/modes/electron/electron-builder.js -> #replaceAppUrl()

    Object.assign(cfg.build.env, {
      NODE_ENV: this.#ctx.prod ? 'production' : 'development',
      CLIENT: true,
      SERVER: false,
      DEV: this.#ctx.dev === true,
      PROD: this.#ctx.prod === true,
      DEBUGGING: cfg.metaConf.debugging === true,
      MODE: this.#ctx.modeName,
      VUE_ROUTER_MODE: cfg.build.vueRouterMode,
      VUE_ROUTER_BASE: cfg.build.vueRouterBase
    })

    if (cfg.metaConf.APP_URL) {
      cfg.build.env.APP_URL = cfg.metaConf.APP_URL
    }

    // get the env variables from host project env files
    const { fileEnv, usedEnvFiles, envFromCache } = readFileEnv({
      appPaths,
      quasarMode: this.#ctx.modeName,
      buildType: this.#ctx.dev ? 'dev' : 'prod',
      envFolder: cfg.build.envFolder,
      envFiles: cfg.build.envFiles
    })

    cfg.metaConf.fileEnv = fileEnv

    if (envFromCache === false && usedEnvFiles.length !== 0) {
      log(`Using .env files: ${ usedEnvFiles.join(', ') }`)
    }

    if (this.#ctx.mode.electron && this.#electronInspectPort === void 0) {
      this.#electronInspectPort = await findClosestOpenPort(5858, '0.0.0.0')
    }

    if (this.#ctx.mode.electron && this.#ctx.prod) {
      const { ensureInstall, getDefaultName } = await this.#ctx.cacheProxy.getModule('electron')

      const icon = appPaths.resolve.electron('icons/icon.png')
      const builderIcon = process.platform === 'linux'
        // backward compatible (linux-512x512.png)
        ? (existsSync(icon) === true ? icon : appPaths.resolve.electron('icons/linux-512x512.png'))
        : appPaths.resolve.electron('icons/icon')

      cfg.electron = merge({
        inspectPort: this.#electronInspectPort,
        packager: {
          asar: true,
          icon: appPaths.resolve.electron('icons/icon'),
          overwrite: true
        },
        builder: {
          appId: 'quasar-app',
          icon: builderIcon,
          productName: this.#ctx.pkg.appPkg.productName || this.#ctx.pkg.appPkg.name || 'Quasar App',
          directories: {
            buildResources: appPaths.resolve.electron('')
          }
        }
      }, cfg.electron, {
        packager: {
          dir: join(cfg.build.distDir, 'UnPackaged'),
          out: join(cfg.build.distDir, 'Packaged')
        },
        builder: {
          directories: {
            app: join(cfg.build.distDir, 'UnPackaged'),
            output: join(cfg.build.distDir, 'Packaged')
          }
        }
      })

      if (cfg.ctx.bundlerName) {
        cfg.electron.bundler = cfg.ctx.bundlerName
      }
      else if (!cfg.electron.bundler) {
        cfg.electron.bundler = getDefaultName()
      }

      ensureElectronArgv(cfg.electron.bundler, this.#ctx)

      if (cfg.electron.bundler === 'packager') {
        if (cfg.ctx.targetName) {
          cfg.electron.packager.platform = cfg.ctx.targetName
        }
        if (cfg.ctx.archName) {
          cfg.electron.packager.arch = cfg.ctx.archName
        }
      }
      else {
        cfg.electron.builder = {
          config: cfg.electron.builder
        }

        if (cfg.ctx.targetName === 'mac' || cfg.ctx.targetName === 'darwin' || cfg.ctx.targetName === 'all') {
          cfg.electron.builder.mac = []
        }

        if (cfg.ctx.targetName === 'linux' || cfg.ctx.targetName === 'all') {
          cfg.electron.builder.linux = []
        }

        if (cfg.ctx.targetName === 'win' || cfg.ctx.targetName === 'win32' || cfg.ctx.targetName === 'all') {
          cfg.electron.builder.win = []
        }

        if (cfg.ctx.archName) {
          cfg.electron.builder[ cfg.ctx.archName ] = true
        }

        if (cfg.ctx.publish) {
          cfg.electron.builder.publish = cfg.ctx.publish
        }
      }

      ensureInstall(cfg.electron.bundler)
    }

    const entryScriptWebPath = cfg.build.publicPath + relative(appPaths.appDir, appPaths.resolve.entry('client-entry.js')).replaceAll('\\', '/')
    Object.assign(cfg.metaConf, {
      entryScriptWebPath,
      entryScriptTag: `<script type="module" src="${ entryScriptWebPath }"></script>`
    })

    cfg.htmlVariables = merge({
      ctx: cfg.ctx,
      process: { env: cfg.build.env },
      productName: escapeHTMLTagContent(this.#ctx.pkg.appPkg.productName),
      productDescription: escapeHTMLAttribute(this.#ctx.pkg.appPkg.description)
    }, cfg.htmlVariables)

    if (this.#ctx.mode.capacitor && cfg.metaConf.versions.capacitorPluginSplashscreen && cfg.capacitor.hideSplashscreen !== false) {
      cfg.metaConf.needsAppMountHook = true
    }

    return cfg
  }
}
