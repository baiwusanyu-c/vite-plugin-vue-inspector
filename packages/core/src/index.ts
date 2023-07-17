import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import { bold, dim, green, yellow } from 'kolorist'
import { normalizePath } from 'vite'
import type { PluginOption, ServerOptions } from 'vite'
import { compileSFCTemplate } from './compiler'
import { idToFile, parseVueRequest } from './utils'

export interface VueInspectorClient {
  enabled: boolean
  position: {
    x: number
    y: number
  }
  linkParams: {
    file: string
    line: number
    column: number
  }

  enable: () => void
  disable: () => void
  toggleEnabled: () => void
  openInEditor: (baseUrl: string, file: string, line: number, column: number) => void
  onUpdated: () => void
}

export interface VitePluginInspectorOptions {
  /**
  * Vue version
  * @default 3
  */
  vue?: 2 | 3

  /**
  * 默认的开启状态
  * @default false
  */
  enabled?: boolean

  /**
  * 定义组合件去呼出 inspector win 是 control + shift mac 是 mete + shift
  * @default 'control-shift' on windows, 'meta-shift' on other os
  *
  * any number of modifiers `control` `shift` `alt` `meta` followed by zero or one regular key, separated by -
  * examples: control-shift, control-o, control-alt-s  meta-x control-meta
  * Some keys have native behavior (e.g. alt-s opens history menu on firefox).
  * To avoid conflicts or accidentally typing into inputs, modifier only combinations are recommended.
  * You can also disable it by setting `false`.
  */
  toggleComboKey?: string | false

  /**
  * 触发按钮的可见性
  * @default 'active'
  */
  toggleButtonVisibility?: 'always' | 'active' | 'never'

  /**
  * 触发按钮的可见性的位置
  * @default top-right
  */
  toggleButtonPos?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'

  /**
  * append an import to the module id ending with `appendTo` instead of adding a script into body
  * useful for frameworks that do not support transformIndexHtml hook (e.g. Nuxt3)
  *
  * WARNING: only set this if you know exactly what it does.
  */
  appendTo?: string | RegExp
}

const toggleComboKeysMap = {
  control: process.platform === 'darwin' ? 'Control(^)' : 'Ctrl(^)',
  meta: 'Command(⌘)',
  shift: 'Shift(⇧)',
}

function getInspectorPath() {
  const pluginPath = normalizePath(path.dirname(fileURLToPath(import.meta.url)))
  return pluginPath.replace(/\/dist$/, '/src')
}

export function normalizeComboKeyPrint(toggleComboKey: string) {
  return toggleComboKey.split('-').map(key => toggleComboKeysMap[key] || key[0].toUpperCase() + key.slice(1)).join(dim('+'))
}

// 默认配置
export const DEFAULT_INSPECTOR_OPTIONS: VitePluginInspectorOptions = {
  vue: 3,
  enabled: false,
  toggleComboKey: process.platform === 'darwin' ? 'meta-shift' : 'control-shift',
  toggleButtonVisibility: 'active',
  toggleButtonPos: 'top-right',
  appendTo: '',
} as const

function VitePluginInspector(options: VitePluginInspectorOptions = DEFAULT_INSPECTOR_OPTIONS): PluginOption {
  const inspectorPath = getInspectorPath()
  const normalizedOptions = {
    ...DEFAULT_INSPECTOR_OPTIONS,
    ...options,
  }
  let serverOptions: ServerOptions | undefined

  const {
    appendTo,
  } = normalizedOptions

  return {
    name: 'vite-plugin-vue-inspector',
    enforce: 'pre',
    apply(_, { command }) {
      // 仅在开发服务时
      // apply only on serve and not for test
      return command === 'serve' && process.env.NODE_ENV !== 'test'
    },
    async resolveId(importee: string) {
      // 虚拟模块 vue-inspector-options 直接返回，到load中处理 （从 load 钩子载入load.js进入）
      if (importee.startsWith('virtual:vue-inspector-options')) {
        return importee
      }
      // 虚拟模块 vue-inspector-path 替换为 load.js 的真实路径（从 transformIndexHtml 钩子进入、也会在 tansform 中注入）
      // 为什么有这么多的 virtual:vue-inspector-path 进入？
      else if (importee.startsWith('virtual:vue-inspector-path:')) {
        const resolved = importee.replace('virtual:vue-inspector-path:', `${inspectorPath}/`)
        return resolved
      }
    },

    async load(id) {
      // vue-inspector-options 的虚拟模块解析为导出js
      // 这里导出了一些配置信息
      if (id === 'virtual:vue-inspector-options') {
        return `export default ${JSON.stringify({ ...normalizedOptions, serverOptions })}`
      }
      else if (id.startsWith(inspectorPath)) {
        // 加载 load.js、
        // 根据load.js 内容，加载 overlay.vue、vue-inspector-options
        const { query } = parseVueRequest(id)
        if (query.type)
          return

        // read file ourselves to avoid getting shut out by vites fs.allow check
        const file = idToFile(id)
        if (fs.existsSync(file))
          return await fs.promises.readFile(file, 'utf-8')
        else
          console.error(`failed to find file for vue-inspector: ${file}, referenced by id ${id}.`)
      }
    },
    transform(code, id) {
      const { filename, query } = parseVueRequest(id)

      const isJsx = filename.endsWith('.jsx') || filename.endsWith('.tsx') || (filename.endsWith('.vue') && query.isJsx)
      const isTpl = filename.endsWith('.vue') && query.type !== 'style' && !query.raw
      // 对模板进行编译
      if (isJsx || isTpl)
        return compileSFCTemplate({ code, id: filename, type: isJsx ? 'jsx' : 'template' })

      if (!appendTo)
        return

      if ((typeof appendTo === 'string' && filename.endsWith(appendTo))
        || (appendTo instanceof RegExp && appendTo.test(filename)))
        return { code: `${code}\nimport 'virtual:vue-inspector-path:load.js'` }
    },
    // 重写了的打印函数server
    configureServer(server) {
      const _printUrls = server.printUrls
      const { toggleComboKey } = normalizedOptions

      toggleComboKey && (server.printUrls = () => {
        const keys = normalizeComboKeyPrint(toggleComboKey)
        _printUrls()
        console.log(`  ${green('➜')}  ${bold('Vue Inspector')}: ${green(`Press ${yellow(keys)} in App to toggle the Inspector`)}\n`)
      })
    },
    transformIndexHtml(html) {
      if (appendTo)
        return
      return {
        html,
        tags: [
          {
            tag: 'script',
            injectTo: 'head',
            attrs: {
              type: 'module',
              src: '/@id/virtual:vue-inspector-path:load.js',
            },
          },
        ],
      }
    },
    configResolved(resolvedConfig) {
      serverOptions = resolvedConfig.server
    },
  }
}
export default VitePluginInspector
