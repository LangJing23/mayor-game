import { lazy, Suspense, type ComponentType } from 'react'
import OnboardingFlow from '@/components/onboarding/OnboardingFlow'
import CityScene from '@/components/CityScene'
import { useGameStore } from '@/store/gameStore'

/**
 * 开发测试页仅在开发期动态加载：以 import.meta.env.DEV 守卫 `import()`，
 * 生产构建中整段为死代码，Rollup 不生成这些 chunk，测试页代码/入口均不进入生产产物，
 * 评委无法通过 ?spritetest / ?citytest 等 query 落到调试页面。
 */
const DEV = import.meta.env.DEV
const lazyDev = (loader: () => Promise<{ default: ComponentType }>) => (DEV ? lazy(loader) : null)

const TEST_PAGES: Record<string, ReturnType<typeof lazyDev>> = DEV
  ? {
      spritetest: lazyDev(() => import('@/canvas/SpriteTestPage')),
      particletest: lazyDev(() => import('@/canvas/ParticleTestPage')),
      citytest: lazyDev(() => import('@/canvas/CityTestPage')),
      uitest: lazyDev(() => import('@/components/ui/UITestPage')),
      hudtest: lazyDev(() => import('@/components/hud/HudTestPage')),
      hotlinetest: lazyDev(() => import('@/components/panels/HotlineTestPage')),
    }
  : {}

/**
 * App 根组件 —— 正式产品入口。
 *
 * 正常 /：
 *   initialized === false → Onboarding（首次建城）
 *   initialized === true  → CityScene（城市主界面）
 *
 * 开发辅助（**仅 import.meta.env.DEV**，生产不可达）：
 *   ?reset         → 清空存档并回到首次建城
 *   ?spritetest / ?particletest / ?citytest / ?uitest / ?hudtest / ?hotlinetest → 各测试页
 */
function App() {
  const search = typeof window !== 'undefined' ? window.location.search : ''

  // 开发重置：清空存档后跳回正常入口（正式界面不提供"重置城市"按钮）
  if (search.includes('reset')) {
    try {
      localStorage.removeItem('mayor-game-state')
    } catch {
      /* ignore */
    }
    window.location.replace(window.location.pathname)
    return null
  }

  // 严格 dev-only：生产构建中 TEST_PAGES 为空、分支为死代码，测试页入口不可达。
  if (DEV) {
    const params = new URLSearchParams(search)
    for (const [key, Page] of Object.entries(TEST_PAGES)) {
      if (Page && params.has(key)) {
        return (
          <Suspense fallback={null}>
            <Page />
          </Suspense>
        )
      }
    }
  }

  // 正式入口分流
  return <RootRouter />
}

function RootRouter() {
  const initialized = useGameStore((s) => s.initialized)
  const currentPolicy = useGameStore((s) => s.currentPolicy)

  // 双重保险：必须 initialized 且已有方针，才进入城市主界面；
  // 否则（含异常中断状态）回到 Onboarding，杜绝无方针进城。
  if (initialized && currentPolicy !== null) {
    return <CityScene />
  }
  return <OnboardingFlow />
}

export default App
