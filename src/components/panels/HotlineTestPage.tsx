/**
 * HotlineTestPage —— 12345 市民热线 **仅开发期** 视觉验收页（?hotlinetest）。
 *
 * 目的：为人工视觉验收准备 4 条确定性测试反馈，覆盖四类状态/类型：
 *   1. warning  考公项目  → 咨询（question）     —— 李文博（growth）
 *   2. halted   健身项目  → 投诉（complaint）    —— 周秀兰（health）
 *   3. abandoned 英语项目 → 投诉（complaint）    —— 李文博（growth）
 *   4. completed 博客项目 → 建议（suggestion）    —— 陈建国（efficiency）
 *
 * 工程隔离（本轮重点）：
 * - **完全不触碰正式 persist store / localStorage**。fixtures 以 props 直接注入 HotlinePanel，
 *   不再 setState 到 Zustand，也不再 snapshot/restore localStorage（刷新、异常退出、
 *   直接关闭浏览器都不会改变 mayor-game-state）。
 * - 「查看相关工程」在本验收页用一个只读 fixture 预览呈现（同样不读 Store），
 *   仅用于确认跳转交互存在；正式产品中该入口打开真实 ProjectCard。
 *
 * 约束遵循：
 * - 使用现有 CitizenFeedback / Project 数据结构，不新增字段；
 * - 不改 TASK-14 生成逻辑（本页为固定 fixture，不调用 generateFeedback）；
 * - 本页仅由 App.tsx 的 `import.meta.env.DEV && ?hotlinetest` 分支渲染，生产构建不可达。
 */
import { useState } from 'react';
import { HotlinePanel } from '@/components/panels/CitizenHotline';
import { getPersona } from '@/logic/citizenFeedback';
import type { CitizenFeedback, Project } from '@/store/types';

/* ---------- 固定 fixture：4 个项目（每种目标状态一个） ---------- */
function makeProject(
  partial: Pick<Project, 'id' | 'name' | 'type' | 'status' | 'buildingType' | 'progressFrequency'> &
    Partial<Project>,
  slot: number,
): Project {
  const now = Date.now();
  return {
    originalInput: partial.name,
    scale: '示例建设规模',
    approvalNote: '鉴于项目符合城市建设方向，予以批准立项。',
    createdAt: now - 86400000 * 30,
    lastProgressAt: now - 86400000 * 10,
    progressRecords: [],
    citySlot: slot,
    year: new Date().getFullYear(),
    restartCount: 0,
    plan: {
      goal: partial.name,
      acceptanceCriteria: '按既定建设目标完成项目并通过竣工验收。',
      sections: [],
    },
    ...partial,
  } as Project;
}

const TEST_PROJECTS: Project[] = [
  makeProject(
    { id: '2026-101', name: '市民公职能力提升与公考上岸保障工程', type: '教育工程', status: 'warning', buildingType: 'tower', progressFrequency: 'daily' },
    0,
  ),
  makeProject(
    { id: '2026-102', name: '市民体质强化与健身达标推进工程', type: '民生工程', status: 'halted', buildingType: 'flat', progressFrequency: 'several-times-weekly' },
    1,
  ),
  makeProject(
    { id: '2026-103', name: '市民外语能力国际化提升工程', type: '教育工程', status: 'abandoned', buildingType: 'tower', progressFrequency: 'weekly', abandonedAt: Date.now() - 86400000 * 3 },
    2,
  ),
  makeProject(
    { id: '2026-104', name: '市民个人知识门户与内容发布工程', type: '文化工程', status: 'completed', buildingType: 'flat', progressFrequency: 'weekly', completedAt: Date.now() - 86400000 * 2 },
    3,
  ),
];

/* ---------- 固定 fixture：4 条反馈（文案风格对齐 copywriting，确定性，非随机） ---------- */
function daysAgo(n: number): number {
  return Date.now() - 86400000 * n;
}
function dateStr(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const TEST_FEEDBACKS: CitizenFeedback[] = [
  // 1. warning 考公 → 咨询（growth 李文博）
  (() => {
    const ts = daysAgo(1);
    return {
      id: 'fbtest_1',
      personaId: 'growth',
      type: 'question',
      content: '市长您好，「市民公职能力提升与公考上岸保障工程」近期施工频率明显下降，请问项目目前是否仍按原规划推进？',
      projectId: '2026-101',
      projectStatus: 'warning',
      docNumber: '市民热线〔2026〕第 318 号',
      date: dateStr(ts),
      createdAt: ts,
      read: false,
    };
  })(),
  // 2. halted 健身 → 投诉（health 周秀兰）
  (() => {
    const ts = daysAgo(2);
    return {
      id: 'fbtest_2',
      personaId: 'health',
      type: 'complaint',
      content: '市长您好，「市民体质强化与健身达标推进工程」已连续多日未见施工，请问围挡什么时候撤？',
      projectId: '2026-102',
      projectStatus: 'halted',
      docNumber: '市民热线〔2026〕第 442 号',
      date: dateStr(ts),
      createdAt: ts,
      read: false,
    };
  })(),
  // 3. abandoned 英语 → 投诉（growth 李文博）
  (() => {
    const ts = daysAgo(3);
    return {
      id: 'fbtest_3',
      personaId: 'growth',
      type: 'complaint',
      content: '「市民外语能力国际化提升工程」长期无实质进展，已影响市容市貌，恳请市长尽快研究处置办法。',
      projectId: '2026-103',
      projectStatus: 'abandoned',
      docNumber: '市民热线〔2026〕第 507 号',
      date: dateStr(ts),
      createdAt: ts,
      read: false,
    };
  })(),
  // 4. completed 博客 → 建议（efficiency 陈建国）
  (() => {
    const ts = daysAgo(4);
    return {
      id: 'fbtest_4',
      personaId: 'efficiency',
      type: 'suggestion',
      content: '「市民个人知识门户与内容发布工程」现已完成验收，建议后续加强日常维护，避免建成即闲置。',
      projectId: '2026-104',
      projectStatus: 'completed',
      docNumber: '市民热线〔2026〕第 129 号',
      date: dateStr(ts),
      createdAt: ts,
      read: false,
    };
  })(),
];

const STATUS_LABEL: Record<Project['status'], string> = {
  construction: '在建',
  warning: '施工预警',
  halted: '停工',
  abandoned: '烂尾',
  completed: '竣工',
};

/* ---------- 只读 fixture 项目预览（不读 Store，仅确认跳转交互） ---------- */
function FixtureProjectPreview({ project, onClose }: { project: Project; onClose: () => void }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(10,12,30,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1100,
      }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          width: 'min(420px, 90vw)',
          background: '#fafaf8',
          border: '4px solid var(--pixel-ui-border)',
          padding: 20,
          color: '#1a1a1a',
        }}
        role="dialog"
        aria-modal="true"
        aria-label="项目建设档案（验收预览）"
      >
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>{project.name}</div>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
          项目编号 {project.id} · {STATUS_LABEL[project.status]}
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.9, color: '#333' }}>
          建设目标：{project.plan.goal}
          <br />
          验收标准：{project.plan.acceptanceCriteria}
        </div>
        <div style={{ fontSize: 11, color: '#b5b0a0', marginTop: 14 }}>
          （验收页只读预览，不写入正式存档；正式产品此处打开真实 ProjectCard）
        </div>
        <button
          onClick={onClose}
          style={{
            marginTop: 16,
            padding: '6px 14px',
            background: 'var(--pixel-ui-border)',
            color: '#1a1a2e',
            border: 'none',
            cursor: 'pointer',
            fontWeight: 700,
          }}
        >
          关闭
        </button>
      </div>
    </div>
  );
}

export default function HotlineTestPage() {
  const [previewProjectId, setPreviewProjectId] = useState<string | null>(null);
  const previewProject = TEST_PROJECTS.find((p) => p.id === previewProjectId) ?? null;

  // 启动前确认 persona 可查（fixtures 使用的 personaId 均来自 TASK-14 的 CITIZEN_PERSONAS）
  void getPersona;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--pixel-ui-bg)' }}>
      {/* 顶部说明条，提示这是开发验收页 */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          padding: '10px 16px',
          color: 'var(--pixel-ui-text)',
          fontSize: 13,
          borderBottom: '2px solid rgba(232,193,76,0.3)',
          background: 'rgba(26,26,46,0.95)',
          zIndex: 1,
        }}
      >
        12345 市民热线 · 视觉验收页（dev-only，fixtures 以 props 注入，完全不写正式存档）—— 已注入 4 条测试反馈
      </div>

      {/* 常开热线面板：fixtures 经 props 注入，不经过正式 Store */}
      <HotlinePanel
        open
        feedbacks={TEST_FEEDBACKS}
        projects={TEST_PROJECTS}
        onClose={() => {
          /* 验收页保持常开，关闭无操作 */
        }}
        onViewProject={(pid) => setPreviewProjectId(pid)}
      />

      {/* 查看相关工程 → 只读 fixture 预览（不读 Store、不写存档） */}
      {previewProject && (
        <FixtureProjectPreview project={previewProject} onClose={() => setPreviewProjectId(null)} />
      )}
    </div>
  );
}
