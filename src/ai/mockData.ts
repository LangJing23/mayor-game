/**
 * Demo/Mock 预置数据（src/ai/mockData.ts）
 *
 * 依据 design.md 第 6.2 节 + copywriting Steering。
 * 用途：
 * - Demo 模式（无 API Key）下，aiClient 所有方法返回这里的数据。
 * - 真实模式下 AI 调用失败时，部分方法回退到这里的降级模板，保证演示不中断。
 *
 * 所有文案遵守：极其正式克制的市政语言，反差幽默，不主动搞笑、无 emoji。
 */

import type { AnnualPolicy, AuditReport, ProjectDraft } from '@/store/types';
import { buildDraftFromSemantics } from './semantics';

/* ---------- 立项 mock：改为轻量语义解析（见 semantics.ts） ----------
 * 不再固定文案轮转；按用户真实输入分类 + 参数提取 + 动态 sections 生成 ProjectDraft。 */
export function pickProjectDraftMock(userInput: string): ProjectDraft {
  return buildDraftFromSemantics(userInput || '');
}

/** 规划降级 mock：基于缩减后的新描述重新语义解析，并收缩为 flat 小楼。 */
export function downgradeDraftMock(newInput: string): ProjectDraft {
  const base = buildDraftFromSemantics(newInput || '');
  return {
    ...base,
    buildingType: 'flat', // 规模缩小通常用更矮的楼型
    approvalNote: '鉴于原规划推进难度较大，同意调减建设规模，予以批准。',
    scale: `规划规模较原方案明显收缩，聚焦核心目标：${(newInput || '').slice(0, 20)}。`,
  };
}

/* ---------- 审计 mock（2 条：建议复工 / 建议爆破） ---------- */
export const MOCK_AUDIT_RESTART: AuditReport = {
  generatedAt: 0,
  background: '本项目系市长年初重点申报的民生工程，立项之初市民期待较高。',
  stopReasons:
    '经核查，项目推进过程中遭遇市长个人意志力储备不足、外部干扰因素增多等系统性障碍，' +
    '阶段性施工计划未能有效落实，致使工程进度明显滞后。',
  completionEstimate: 42,
  conclusion: 'restart',
  conclusionReason: '鉴于项目已完成相当比例建设，具备恢复条件，建议限期复工。',
};

export const MOCK_AUDIT_DEMOLISH: AuditReport = {
  generatedAt: 0,
  background: '本项目立项以来长期处于停工状态，现场核查未发现实质施工活动。',
  stopReasons:
    '项目在推进中暴露出前期规划脱离实际、持续投入动力不足等深层次问题，' +
    '多次预警后仍未改善，继续保留已无明显建设价值。',
  completionEstimate: 8,
  conclusion: 'demolish',
  conclusionReason: '鉴于项目实际完成度极低且难以盘活，建议实施控制爆破、释放地块。',
};

let auditMockToggle = 0;
export function pickAuditMock(): AuditReport {
  const r = auditMockToggle % 2 === 0 ? MOCK_AUDIT_RESTART : MOCK_AUDIT_DEMOLISH;
  auditMockToggle += 1;
  return { ...r, generatedAt: Date.now() };
}

/* ---------- 秘书回复 mock（4 条，循环） ---------- */
export const MOCK_SECRETARY_REPLIES: string[] = [
  '市长您好。当前全市在建项目数量基本平稳，但已有工程出现停工迹象，建议优先安排施工备案与现场核查。',
  '市长，依据本年度施政方针，建议适度控制新项目立项节奏，集中力量推进既有重点工程。',
  '市长，经初步研判，部分长期停工项目已具备启动审计的条件，是否安排市政审计程序，请您决策。',
  '市长，本市竣工项目已形成一定建设成果，建议择机对外公布，以提振市民对城市建设的信心。',
];

let secretaryMockCursor = 0;
export function pickSecretaryMock(): string {
  const r = MOCK_SECRETARY_REPLIES[secretaryMockCursor % MOCK_SECRETARY_REPLIES.length];
  secretaryMockCursor += 1;
  return r;
}

/* ---------- 施政方针候选 mock ---------- */
type PolicyCandidate = Pick<AnnualPolicy, 'title' | 'description'>;

/** 初始建城候选（首次 onboarding 用） */
export const MOCK_INITIAL_POLICIES: PolicyCandidate[] = [
  { title: '想到就干、干了再说', description: '鼓励积极立项，先把项目铺开再谈推进。' },
  { title: '少开新工、多填旧坑', description: '严控新项目规模，集中资源盘活存量工程。' },
  { title: '量力而行、建一成一', description: '按实际能力稳步推进，确保开工项目尽量竣工。' },
];

/** 下一年候选（年度会议用，与初始候选区分，覆盖不同策略方向） */
export const MOCK_NEXT_POLICIES: PolicyCandidate[] = [
  { title: '稳步扩建、提质增效', description: '在巩固既有成果基础上，稳健扩大建设规模。' },
  { title: '盘活存量、轻装上阵', description: '重点处置烂尾工程，清理地块后再谋新局。' },
  { title: '合理规划、控制规模', description: '从源头控制项目体量，减少频繁降规与返工。' },
];

/* ---------- 年报 mock（含固定段落 + 预置润色；方针标题由调用方注入） ---------- */
export interface MockAnnualReportSections {
  review: string;
  problems: string;
  outlook: string;
}

export function annualReportMock(args: {
  year: number;
  policyTitle: string;
  total: number;
  completed: number;
  abandoned: number;
  demolished: number;
  restartCount: number;
  completionRate: number;
}): MockAnnualReportSections {
  const { year, policyTitle, total, completed, abandoned, demolished, restartCount, completionRate } = args;
  const nextYear = year + 1;
  return {
    review:
      `${year}年，在市长的坚强领导下，全市上下坚持"${policyTitle}"的建设方针，` +
      `持续推进各类重点项目建设，城市建设规模稳步扩大。` +
      `全年共立项 ${total} 个重点建设项目，竣工 ${completed} 个，完工率 ${completionRate}%，` +
      `累计组织复工 ${restartCount} 次。市民对部分竣工工程给予积极评价。`,
    problems:
      `然而，我们也清醒地认识到，本年度城市建设工作中仍存在若干突出问题，不容忽视。` +
      `全年共有 ${abandoned} 项工程进入长期停工状态，已实施控制爆破销项 ${demolished} 项，` +
      `存量烂尾项目治理成效仍未达到预期。部分项目存在开工仪式较多、实际施工时间偏短等现象，` +
      `长效建设机制仍需进一步健全。`,
    outlook:
      `${nextYear}年，本市将在巩固既有建设成果的基础上，重点聚焦以下工作目标：` +
      `严格新项目立项审查，强化施工备案与现场核查，持续推进存量项目盘活，` +
      `努力实现建设质量与完工率的稳步提升。`,
  };
}

/* 立项降级统一由 semantics.buildDraftFromSemantics(input) 承担（见 pickProjectDraftMock），
 * 不再使用脱离输入的静态 FALLBACK_PROJECT_DRAFT。 */
