/**
 * 《市长，项目又烂尾了》全局状态管理（Zustand + persist）
 *
 * 职责边界（依据 engineering-conventions Steering）：
 * - 本文件只管理状态与状态变更（actions），不实现任何 UI、不发起任何 AI 调用。
 * - 业务规则（停工判定、反馈文案生成、报告构建等）在 src/logic/ 中实现，
 *   logic 层调用这里的 actions 完成状态写入。
 *
 * 持久化：persist 中间件将完整状态序列化到 localStorage['mayor-game-state']。
 *
 * 状态链：construction → warning → halted → abandoned（另有并列终态 completed）。
 * 停工阈值不在此存储，由 FREQUENCY_THRESHOLDS + Project.progressFrequency 决定。
 * 不含 StalledSettings。
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AnnualPolicy,
  AnnualReport,
  AuditReport,
  CitizenFeedback,
  GameState,
  Message,
  Project,
  ProjectDraft,
  ProjectPlan,
  ProjectStatus,
  ProgressRecord,
} from './types';

const STORAGE_KEY = 'mayor-game-state';

/**
 * persist schema 版本。
 * - v0（无 version 或 0）：Project 无 plan 字段（TASK-11.1 之前）。
 * - v1：Project 新增必填 plan: ProjectPlan。
 * 版本提升时在 migrate 中对旧数据做兼容补齐，不重置、不删除旧项目。
 */
const PERSIST_VERSION = 1;

/* ============================================================
 * 工具函数
 * ============================================================ */

/**
 * 生成简单唯一 ID（无需加密强度，仅用于本地对象标识）。
 * 导出供 logic 层生成 ProgressRecord / CitizenFeedback / Message 等的 id。
 */
export function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 生成项目编号 "YYYY-NNN"（NNN 为当年序号，补零到 3 位） */
function makeProjectId(year: number, counter: number): string {
  return `${year}-${String(counter).padStart(3, '0')}`;
}

/** 为新项目分配一个未被占用的城市槽位（从 0 起递增，复用被爆破项目腾出的空位） */
function allocateSlot(projects: Project[]): number {
  const used = new Set(projects.map((p) => p.citySlot));
  let slot = 0;
  while (used.has(slot)) slot += 1;
  return slot;
}

/** 不可变更新：对指定 id 的项目应用部分字段修改 */
function patchProject(
  projects: Project[],
  id: string,
  patch: (p: Project) => Project,
): Project[] {
  return projects.map((p) => (p.id === id ? patch(p) : p));
}

/**
 * 复工/规划降级成功时归档当前审计：把 auditReport 推入 auditHistory 并清空 auditReport。
 * 支持多轮"烂尾→审计→复工→再烂尾→再审计"：下一次 abandoned 时 auditReport 为空，可发起新审计。
 * 无当前审计时原样返回（只补 auditHistory 默认值）。
 */
function archiveAudit(p: Project): Pick<Project, 'auditReport' | 'auditHistory'> {
  const history = p.auditHistory ?? [];
  if (!p.auditReport) return { auditReport: undefined, auditHistory: history };
  return { auditReport: undefined, auditHistory: [...history, p.auditReport] };
}

/* ============================================================
 * schema 迁移：为旧版 Project 补齐 plan（见 PERSIST_VERSION）
 * ============================================================ */

/**
 * 若旧项目缺 plan，依据既有字段生成兼容章程；已有 plan 的新项目原样返回。
 * 只补 plan，不改 status / citySlot / restartCount 等既有状态，不伪造硬数字。
 */
function ensureProjectPlan(p: Project): Project {
  // auditHistory 兼容：旧数据缺失则补 []，绝不删除现有 auditReport。
  const withAuditHistory = Array.isArray(p?.auditHistory) ? p : { ...p, auditHistory: [] };
  if (withAuditHistory && withAuditHistory.plan) return withAuditHistory; // 新版已有 plan，不覆盖
  const plan: ProjectPlan = {
    goal: withAuditHistory.originalInput || withAuditHistory.scale || withAuditHistory.name || '既定建设目标',
    // 旧数据没有明确周期文本：estimatedDeadline 是时间戳，不足以反推"用户原话"，故不伪造，留空
    duration: undefined,
    acceptanceCriteria: '按既定建设目标完成项目并通过竣工验收。',
    progressScheduleText: undefined,
    sections: [],
  };
  return { ...withAuditHistory, plan };
}

/** 对整份持久化状态做兼容规整：projects 与 demolishedProjects 中的旧 Project 均补齐 plan。 */
function migratePersistedState(state: Partial<GameState> | undefined): Partial<GameState> {
  if (!state || typeof state !== 'object') return state ?? {};
  const projects = Array.isArray(state.projects) ? state.projects.map(ensureProjectPlan) : state.projects;
  const demolishedProjects = Array.isArray(state.demolishedProjects)
    ? state.demolishedProjects.map(ensureProjectPlan)
    : state.demolishedProjects;
  // 旧数据缺 lastViewedFeedbackAt → 默认 0（全部视为未读，首次打开后归零）
  const lastViewedFeedbackAt = typeof state.lastViewedFeedbackAt === 'number' ? state.lastViewedFeedbackAt : 0;
  return { ...state, projects, demolishedProjects, lastViewedFeedbackAt };
}

/* ============================================================
 * 初始状态
 * ============================================================ */

const initialState: GameState = {
  cityName: '',
  currentYear: new Date().getFullYear(),
  currentPolicy: null, // 首次建城流程中，方针选定前为 null
  policyHistory: [],
  projects: [],
  demolishedProjects: [],
  feedbacks: [],
  lastViewedFeedbackAt: 0,
  secretaryMessages: [],
  annualReports: [],
  apiKey: '',
  isDemoMode: false,
  projectCounter: 0,
  announcements: [],
  initialized: false,
};

/* ============================================================
 * Actions 接口
 * ============================================================ */

export interface GameActions {
  /**
   * 瞬时标志：本次运行中刚完成首次建城（initGame）为 true。
   * 不参与持久化（不在 partialize 中），刷新后恒为 false，
   * 用于"进入城市时只弹一次建城完成通知、刷新不重复"。
   */
  justInitialized: boolean;
  /** 消费并清除 justInitialized 标志（读到 true 后立即置 false，保证只触发一次） */
  consumeJustInitialized(): boolean;

  /** 初始化游戏（首次引导完成时调用）。方针为建城元年方针。 */
  initGame(cityName: string, apiKey: string, initialPolicy: AnnualPolicy): void;

  // —— 项目生命周期 ——
  /** 立项：由 ProjectDraft 补全为完整 Project 加入城市 */
  addProject(draft: ProjectDraft, originalInput: string, estimatedDeadline?: number): Project;
  /** 完工验收：→ completed */
  completeProject(id: string): void;
  /** 施工预警：construction → warning */
  markWarning(id: string): void;
  /** 停工：warning → halted */
  markHalted(id: string): void;
  /** 确认烂尾：halted → abandoned */
  markAbandoned(id: string): void;
  /** 复工：warning / halted / abandoned → construction，重置计时与进度时间，复工次数 +1 */
  restartProject(id: string): void;
  /** 规划降级：用新草案覆盖项目档案，状态恢复 construction，重置推进时间 */
  downgradeProject(id: string, newDraft: ProjectDraft, newOriginalInput: string): void;
  /** 爆破销项：从 projects 移除，完整快照进入 demolishedProjects（年报仍可统计） */
  demolishProject(id: string): void;

  // —— 烂尾审计（TASK-17：只读报告，不触发任何治理动作） ——
  /** 保存专项审计报告到 project.auditReport（持久化保留，供再次打开直接查看，不重复调用 AI） */
  saveAuditReport(id: string, report: AuditReport): void;

  // —— 施工备案 ——
  /** 施工备案：写入 ProgressRecord，更新 lastProgressAt；若处于 warning/halted 自动恢复 construction */
  recordProgress(id: string, record: ProgressRecord): void;
  /**
   * 仅 Demo 演示用：注入历史施工记录并把 lastProgressAt 设为过去时间（模拟"曾施工、之后停滞"）。
   * 与 recordProgress 不同：不触发状态恢复、不改为当前时间，用于演示 施工→预警→停工→烂尾 链路。
   * 可选 createdAt：同时把立项时间前移，保证 createdAt ≤ 施工记录 ≤ lastProgressAt 的单调时间线
   * （避免出现"尚未立项就已施工"的 Demo 时间悖论）。仅演示注入使用，不改正式立项逻辑。
   */
  injectDemoProgress(
    id: string,
    records: ProgressRecord[],
    lastProgressAt: number,
    createdAt?: number,
  ): void;

  // —— 市民反馈 ——
  addFeedback(feedback: CitizenFeedback): void;
  markFeedbackRead(id: string): void;
  /** 标记市民热线已查看（更新 lastViewedFeedbackAt = now），用于未读数 badge */
  markFeedbackViewed(): void;

  // —— AI 秘书对话 ——
  addSecretaryMessage(msg: Message): void;

  // —— 年度会议与方针 ——
  addAnnualReport(report: AnnualReport): void;
  /** 年份 +1，当年项目序号归零 */
  advanceYear(): void;
  /** 设置当年施政方针，并追加到 policyHistory */
  setCurrentPolicy(policy: AnnualPolicy): void;

  // —— 公告与配置 ——
  pushAnnouncement(text: string): void;
  setApiKey(key: string): void;
  setDemoMode(v: boolean): void;

  // —— 工具 ——
  /** 清空全部数据（调试 / 重新开局用） */
  resetGame(): void;
}

export type GameStore = GameState & GameActions;

/* ============================================================
 * Store
 * ============================================================ */

export const useGameStore = create<GameStore>()(
  persist(
    (set, get) => ({
      ...initialState,

      // 瞬时标志（不持久化）
      justInitialized: false,

      consumeJustInitialized() {
        if (!get().justInitialized) return false;
        set({ justInitialized: false });
        return true;
      },

      initGame(cityName, apiKey, initialPolicy) {
        set({
          cityName: cityName.trim() || '梦想市',
          apiKey,
          isDemoMode: apiKey.trim().length === 0,
          currentPolicy: initialPolicy,
          policyHistory: [initialPolicy],
          initialized: true,
          justInitialized: true, // 本次运行刚建城，供城市主界面弹一次收尾通知
        });
      },

      addProject(draft, originalInput, estimatedDeadline) {
        const state = get();
        const counter = state.projectCounter + 1;
        const now = Date.now();
        const project: Project = {
          id: makeProjectId(state.currentYear, counter),
          name: draft.name,
          originalInput,
          type: draft.type,
          scale: draft.scale,
          approvalNote: draft.approvalNote,
          status: 'construction',
          progressFrequency: draft.progressFrequency,
          createdAt: now,
          lastProgressAt: now,
          progressRecords: [],
          estimatedDeadline,
          citySlot: allocateSlot(state.projects),
          buildingType: draft.buildingType,
          year: state.currentYear,
          restartCount: 0,
          // 市长批准后的正式章程（仅存已审定内容，不含 meta/source）
          plan: {
            goal: draft.goal,
            duration: draft.duration,
            acceptanceCriteria: draft.acceptanceCriteria,
            progressScheduleText: draft.progressScheduleText,
            sections: draft.sections,
          },
        };
        set({
          projects: [...state.projects, project],
          projectCounter: counter,
        });
        return project;
      },

      completeProject(id) {
        // 仅在建/预警/停工可验收竣工；abandoned 必须先复工或降级恢复施工，completed 为终态不再变更
        const completable: ProjectStatus[] = ['construction', 'warning', 'halted'];
        set((s) => ({
          projects: patchProject(s.projects, id, (p) =>
            completable.includes(p.status)
              ? { ...p, status: 'completed', completedAt: Date.now() }
              : p,
          ),
        }));
      },

      markWarning(id) {
        set((s) => ({
          projects: patchProject(s.projects, id, (p) =>
            p.status === 'construction' ? { ...p, status: 'warning' } : p,
          ),
        }));
      },

      markHalted(id) {
        set((s) => ({
          projects: patchProject(s.projects, id, (p) =>
            p.status === 'warning' ? { ...p, status: 'halted' } : p,
          ),
        }));
      },

      markAbandoned(id) {
        set((s) => ({
          projects: patchProject(s.projects, id, (p) =>
            p.status === 'halted'
              ? { ...p, status: 'abandoned', abandonedAt: Date.now() }
              : p,
          ),
        }));
      },

      restartProject(id) {
        // 仅预警/停工/烂尾可复工；completed 为终态不可复工
        const restartable: ProjectStatus[] = ['warning', 'halted', 'abandoned'];
        const now = Date.now();
        set((s) => ({
          projects: patchProject(s.projects, id, (p) =>
            restartable.includes(p.status)
              ? {
                  ...p,
                  status: 'construction',
                  lastProgressAt: now,
                  restartCount: p.restartCount + 1,
                  abandonedAt: undefined,
                  // 复工成功：归档当前审计，清空 auditReport（供再次烂尾时重新审计）
                  ...archiveAudit(p),
                }
              : p,
          ),
        }));
      },

      downgradeProject(id, newDraft, newOriginalInput) {
        // 仅在建/预警/停工/烂尾可规划降级；completed 为终态不可降级
        const downgradable: ProjectStatus[] = ['construction', 'warning', 'halted', 'abandoned'];
        const now = Date.now();
        set((s) => ({
          projects: patchProject(s.projects, id, (p) =>
            downgradable.includes(p.status)
              ? {
                  ...p,
                  name: newDraft.name,
                  type: newDraft.type,
                  scale: newDraft.scale,
                  approvalNote: newDraft.approvalNote,
                  buildingType: newDraft.buildingType,
                  progressFrequency: newDraft.progressFrequency,
                  originalInput: newOriginalInput,
                  status: 'construction',
                  lastProgressAt: now,
                  abandonedAt: undefined,
                  // 规划降级同步更新正式章程
                  plan: {
                    goal: newDraft.goal,
                    duration: newDraft.duration,
                    acceptanceCriteria: newDraft.acceptanceCriteria,
                    progressScheduleText: newDraft.progressScheduleText,
                    sections: newDraft.sections,
                  },
                  // 规划降级成功：归档当前审计，清空 auditReport（供再次烂尾时重新审计）
                  ...archiveAudit(p),
                }
              : p,
          ),
        }));
      },

      demolishProject(id) {
        set((s) => {
          const target = s.projects.find((p) => p.id === id);
          if (!target) return s;
          // 完整快照进入历史（年报与多年城市史均依赖此数据），地块（citySlot）随 projects 移除而释放。
          // MVP 阶段完整保留全部爆破记录，不做历史裁剪，避免破坏跨年度统计。
          const snapshot: Project = { ...target };
          return {
            projects: s.projects.filter((p) => p.id !== id),
            demolishedProjects: [...s.demolishedProjects, snapshot],
          };
        });
      },

      saveAuditReport(id, report) {
        // 仅写入报告，不改变项目状态（审计是只读行为，治理动作在 TASK-18）
        set((s) => ({
          projects: patchProject(s.projects, id, (p) => ({ ...p, auditReport: report })),
        }));
      },

      recordProgress(id, record) {
        // 仅在建/预警/停工可写入施工备案；completed（终态）与 abandoned（需先复工/降级）不可直接备案
        const recordable: ProjectStatus[] = ['construction', 'warning', 'halted'];
        set((s) => ({
          projects: patchProject(s.projects, id, (p) => {
            if (!recordable.includes(p.status)) return p;
            // warning / halted 施工备案后恢复在建；construction 保持在建
            const nextStatus = p.status === 'warning' || p.status === 'halted' ? 'construction' : p.status;
            return {
              ...p,
              status: nextStatus,
              lastProgressAt: Date.now(),
              progressRecords: [...p.progressRecords, record],
            };
          }),
        }));
      },

      injectDemoProgress(id, records, lastProgressAt, createdAt) {
        // Demo 专用：追加历史记录 + 设置过去的 lastProgressAt；不改状态、不改为当前时间。
        // 若传入 createdAt（且早于现有立项时间），一并前移立项时间，构造一致单调时间线。
        set((s) => ({
          projects: patchProject(s.projects, id, (p) => ({
            ...p,
            createdAt: createdAt !== undefined ? Math.min(p.createdAt, createdAt) : p.createdAt,
            lastProgressAt,
            progressRecords: [...p.progressRecords, ...records],
          })),
        }));
      },

      addFeedback(feedback) {
        set((s) => ({ feedbacks: [...s.feedbacks, feedback] }));
      },

      markFeedbackViewed() {
        set({ lastViewedFeedbackAt: Date.now() });
      },

      markFeedbackRead(id) {
        set((s) => ({
          feedbacks: s.feedbacks.map((f) => (f.id === id ? { ...f, read: true } : f)),
        }));
      },

      addSecretaryMessage(msg) {
        set((s) => ({ secretaryMessages: [...s.secretaryMessages, msg] }));
      },

      addAnnualReport(report) {
        set((s) => ({ annualReports: [...s.annualReports, report] }));
      },

      advanceYear() {
        set((s) => ({
          currentYear: s.currentYear + 1,
          projectCounter: 0,
        }));
      },

      setCurrentPolicy(policy) {
        set((s) => {
          // 同年份方针视为替换（避免重复入史），否则追加
          const history = s.policyHistory.filter((p) => p.year !== policy.year);
          return {
            currentPolicy: policy,
            policyHistory: [...history, policy],
          };
        });
      },

      pushAnnouncement(text) {
        set((s) => ({ announcements: [...s.announcements, text] }));
      },

      setApiKey(key) {
        set({ apiKey: key, isDemoMode: key.trim().length === 0 });
      },

      setDemoMode(v) {
        set({ isDemoMode: v });
      },

      resetGame() {
        set({ ...initialState });
      },
    }),
    {
      name: STORAGE_KEY,
      version: PERSIST_VERSION,
      // 旧版本（含无 version 的 v0）在水合时补齐 plan 等兼容字段，不重置游戏、不删除旧项目。
      migrate: (persisted: unknown): Partial<GameState> =>
        migratePersistedState(persisted as Partial<GameState> | undefined),
      // merge 每次水合都会调用：作为二次保险，即便 version 相同也规整掉可能缺 plan 的脏数据。
      merge: (persisted: unknown, current: GameStore): GameStore => ({
        ...current,
        ...migratePersistedState(persisted as Partial<GameState> | undefined),
      }),
      // 仅持久化数据字段；actions 为函数不参与序列化（persist 默认跳过函数，这里显式声明以防扩展）
      partialize: (state): GameState => ({
        cityName: state.cityName,
        currentYear: state.currentYear,
        currentPolicy: state.currentPolicy,
        policyHistory: state.policyHistory,
        projects: state.projects,
        demolishedProjects: state.demolishedProjects,
        feedbacks: state.feedbacks,
        lastViewedFeedbackAt: state.lastViewedFeedbackAt,
        secretaryMessages: state.secretaryMessages,
        annualReports: state.annualReports,
        apiKey: state.apiKey,
        isDemoMode: state.isDemoMode,
        projectCounter: state.projectCounter,
        announcements: state.announcements,
        initialized: state.initialized,
      }),
    },
  ),
);

/** 便捷导出：供非 React 模块（logic 层）读写状态 */
export const gameStore = useGameStore;
