/**
 * OnboardingFlow —— 首次建城流程（像素游戏轨道）。
 *
 * 三步：欢迎 → 城市命名 → 选择建城元年施政方针 → 调 store.initGame 进入城市。
 * 约束：
 * - 空城市名不可继续；未选方针不可完成；不使用默认占位方针绕过选择。
 * - 完成后 initialized=true 且 currentPolicy!==null。
 *
 * 初始方针候选：本任务用固定三候选（Demo/Mock）。
 * 后续 TASK-25 将改由 policyManager.fetchInitialPolicyCandidates（AI 或 mock）提供，
 * 届时此处常量迁移到 ai/mockData。当前不接 AI。
 */
import { useRef, useState } from 'react';
import { useGameStore } from '@/store/gameStore';
import { MOCK_INITIAL_POLICIES } from '@/ai/mockData';
import type { AnnualPolicy } from '@/store/types';
import styles from './onboarding.module.css';

const MAX_CITY_NAME = 12;

type Step = 'welcome' | 'naming' | 'policy';

export default function OnboardingFlow() {
  const initGame = useGameStore((s) => s.initGame);
  const setCurrentPolicy = useGameStore((s) => s.setCurrentPolicy);
  const currentYear = useGameStore((s) => s.currentYear);

  const [step, setStep] = useState<Step>('welcome');
  const [cityName, setCityName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 初始建城没有项目事实，固定提供三项候选，避免无数据时制造伪动态。
  const [candidates, setCandidates] = useState<Array<Pick<AnnualPolicy, 'title' | 'description'>>>([]);
  const [policyLoading, setPolicyLoading] = useState(false);

  const trimmedName = cityName.trim();
  const nameValid = trimmedName.length > 0;

  const stepIndex = step === 'welcome' ? 0 : step === 'naming' ? 1 : 2;

  const goNaming = () => {
    setStep('naming');
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const goPolicy = () => {
    setNameTouched(true);
    if (!nameValid) return;
    setStep('policy');
    setSelectedIdx(null);
    setCandidates(MOCK_INITIAL_POLICIES.map((p) => ({ title: p.title, description: p.description })));
    setPolicyLoading(false);
  };

  const finish = () => {
    if (selectedIdx === null || candidates.length === 0) return;
    const picked = candidates[selectedIdx];
    const policy: AnnualPolicy = {
      year: currentYear,
      title: picked.title,
      description: picked.description,
      source: 'initial',
    };
    // initGame 内部已写 currentPolicy + policyHistory + cityName + initialized=true + isDemoMode。
    // 这里 apiKey 传空串（本任务不接 AI，演示模式）；方针作为建城元年方针传入。
    initGame(trimmedName, '', policy);
    // 保险起见再确保 currentPolicy 写入（initGame 已处理，此调用幂等于同年份替换）
    setCurrentPolicy(policy);
  };

  return (
    <div className={styles.screen}>
      {/* 背景装饰：远景城市剪影（纯 CSS 色块，低透明度） */}
      <OnboardingBackdrop />

      <div className={styles.panel}>
        <div className={styles.steps}>
          {[0, 1, 2].map((i) => (
            <span key={i} className={`${styles.stepDot} ${i <= stepIndex ? styles.active : ''}`} />
          ))}
        </div>

        {step === 'welcome' && (
          <>
            <div className={styles.title}>市长您好</div>
            <div className={styles.body}>
              本市各项建设工作即将正式启动。
              <br />
              在开始履职前，请完成<strong>城市登记</strong>与<strong>年度施政方针</strong>确认。
            </div>
            <div className={styles.footer}>
              <div className={styles.footerRight}>
                <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={goNaming}>
                  开始履职
                </button>
              </div>
            </div>
          </>
        )}

        {step === 'naming' && (
          <>
            <div className={styles.title}>城市登记</div>
            <div className={styles.body}>
              请为您即将履职的城市登记名称。该名称将用于全部市政公文。
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="cityName">
                城市名称（必填）
              </label>
              <input
                id="cityName"
                ref={inputRef}
                className={styles.input}
                value={cityName}
                maxLength={MAX_CITY_NAME}
                placeholder="例如：梦想市"
                onChange={(e) => setCityName(e.target.value)}
                onBlur={() => setNameTouched(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && nameValid) goPolicy();
                }}
              />
              <div className={`${styles.hint} ${nameTouched && !nameValid ? styles.hintError : ''}`}>
                {nameTouched && !nameValid
                  ? '城市名称不可为空，请登记后方可继续。'
                  : `支持中文，最多 ${MAX_CITY_NAME} 字；输入什么保存什么。`}
              </div>
            </div>
            <div className={styles.footer}>
              <button className={styles.btn} onClick={() => setStep('welcome')}>
                返回
              </button>
              <div className={styles.footerRight}>
                <button
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  onClick={goPolicy}
                  disabled={!nameValid}
                >
                  下一步
                </button>
              </div>
            </div>
          </>
        )}

        {step === 'policy' && (
          <>
            <div className={styles.title}>{currentYear} 年度施政方针</div>
            <div className={styles.body}>
              市长办公室已拟定本年度三项施政方针，<span className={styles.bodyMuted}>请市长审定其一</span>。
            </div>
            {policyLoading ? (
              <div className={styles.body} style={{ padding: '18px 0', lineHeight: 2 }}>
                市政研究室正在拟定年度施政方针……
              </div>
            ) : (
              <div className={styles.policyList}>
                {candidates.map((p, i) => (
                  <button
                    key={i}
                    className={`${styles.policyCard} ${selectedIdx === i ? styles.selected : ''}`}
                    onClick={() => setSelectedIdx(i)}
                    aria-pressed={selectedIdx === i}
                  >
                    <div className={styles.policyTitle}>{p.title}</div>
                    <div className={styles.policyDesc}>{p.description}</div>
                  </button>
                ))}
              </div>
            )}
            <div className={styles.footer}>
              <button className={styles.btn} onClick={() => setStep('naming')}>
                返回
              </button>
              <div className={styles.footerRight}>
                <button
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  onClick={finish}
                  disabled={selectedIdx === null || policyLoading}
                >
                  确认并正式履职
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 简易像素远景剪影背景（CSS 色块，低透明度装饰，不抢前景） */
function OnboardingBackdrop() {
  return (
    <div className={styles.bgCanvas} aria-hidden>
      <svg width="100%" height="100%" preserveAspectRatio="xMidYMax slice" viewBox="0 0 1280 480">
        <rect x="0" y="0" width="1280" height="480" fill="#20264a" />
        {[
          [60, 300, 70, 180],
          [160, 260, 60, 220],
          [250, 320, 80, 160],
          [360, 240, 64, 240],
          [460, 300, 72, 180],
          [560, 270, 60, 210],
          [660, 230, 68, 250],
          [760, 300, 80, 180],
          [870, 260, 60, 220],
          [960, 310, 76, 170],
          [1060, 250, 64, 230],
          [1150, 290, 72, 190],
        ].map(([x, y, w, h], i) => (
          <rect key={i} x={x} y={y} width={w} height={h} fill="#2a3160" />
        ))}
      </svg>
    </div>
  );
}
