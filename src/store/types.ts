/**
 * 《市长，项目又烂尾了》核心数据模型
 *
 * 本文件是全项目唯一的核心类型来源（依据 design.md 第 2 节 + 冻结 Spec v3）。
 * 任何业务模块、组件、AI 接口均从此处导入类型，不另行定义重复结构。
 *
 * 状态链（权威）：construction → warning → halted → abandoned
 *   另有并列终态 completed（竣工）
 * 停工时间阈值不使用全局固定值，统一由 ProgressFrequency + FREQUENCY_THRESHOLDS 决定。
 * 已删除且不得重新引入：StalledSettings、'stalled' 状态、全局固定 14/21 天阈值。
 */

/* ============================================================
 * 1. 项目状态与分类
 * ============================================================ */

/**
 * 项目状态。
 * - construction 在建
 * - warning      施工预警（超出预期施工周期，尚未停工；在建子状态，黄色感叹号叠加）
 * - halted       停工（持续无施工记录，比预警更严重；在建子状态，橙色停工标志叠加）
 * - completed    竣工
 * - abandoned    烂尾（已确认）
 */
export type ProjectStatus =
  | 'construction'
  | 'warning'
  | 'halted'
  | 'completed'
  | 'abandoned';

/** 项目类型（市政工程分类枚举） */
export type ProjectType =
  | '民生工程'
  | '文化工程'
  | '基础设施'
  | '经济开发'
  | '教育工程'
  | '生态工程'
  | '社会治理';

/** 建筑外观类型（影响城市画布像素图形选取） */
export type BuildingType = 'tower' | 'flat' | 'dome' | 'industrial' | 'park';

/**
 * 城市同时「在管」项目容量上限（立项机制，不是技术报错）。
 * 只限制仍需市长管理的项目（construction/warning/halted/abandoned），**不含 completed**。
 * 占用量实时由 managedProjectCount(projects) 推导：竣工项目不占名额；爆破销项移出 projects 自动释放。
 * 达到上限后禁止新立项（HUD / 入口 / 批准前三处共享同一口径）。
 */
export const MAX_CITY_PROJECTS = 12;

/** 是否为"在管"项目（仍需市长管理）：completed 不计入容量 */
export function isManagedProject(project: Project): boolean {
  return project.status !== 'completed';
}

/** 当前在管项目数（容量口径的唯一来源，HUD/入口/批准共用） */
export function managedProjectCount(projects: Project[]): number {
  let n = 0;
  for (const p of projects) if (p.status !== 'completed') n += 1;
  return n;
}

/* ============================================================
 * 2. 施工频率与停工阈值
 * ============================================================ */

/**
 * 施工频率。立项时由 AI 建议、市长确认。
 * 决定该项目进入 warning / halted / abandoned 的时间阈值。
 */
export type ProgressFrequency =
  | 'daily' // 每日工程，如"早睡工程"
  | 'several-times-weekly' // 每周数次，如"健身工程"
  | 'weekly' // 每周一次，如"个人博客"
  | 'long-term'; // 长期推进，如"写论文"

/**
 * 各施工频率对应的停工判定天数阈值。
 * 元组含义：[warning 阈值, halted 阈值, abandoned 阈值]（单位：天）。
 * 当 (now - lastProgressAt) 的天数达到对应阈值时，项目进入下一状态。
 *
 * 数值设计原则：阈值随频率放宽而成比例拉长，三档之间保持"预警 < 停工 < 烂尾"的递进间距，
 * 使每类项目都有先预警、再停工、最后才烂尾的缓冲过程。
 */
export const FREQUENCY_THRESHOLDS: Record<ProgressFrequency, [number, number, number]> = {
  daily: [2, 4, 14], //            预警 2 天 / 停工 4 天 / 烂尾 14 天
  'several-times-weekly': [5, 10, 30], // 预警 5 天 / 停工 10 天 / 烂尾 30 天
  weekly: [10, 21, 60], //         预警 10 天 / 停工 21 天 / 烂尾 60 天
  'long-term': [30, 60, 120], //   预警 30 天 / 停工 60 天 / 烂尾 120 天
};

/* ============================================================
 * 3. 施工备案记录
 * ============================================================ */

/** 单条施工备案记录（"今日有施工"产生） */
export interface ProgressRecord {
  id: string;
  projectId: string;
  date: string; // 'YYYY-MM-DD'
  note?: string; // AI 整理后的正式施工记录（或留空）
  rawNote?: string; // 市长原始输入（口语，未经 AI 整理）
  source: 'manual' | 'demo';
}

/* ============================================================
 * 4. 审计报告
 * ============================================================ */

/** 审计结论：复工 / 规划降级 / 爆破销项 */
export type AuditConclusion = 'restart' | 'downgrade' | 'demolish';

export interface AuditReport {
  generatedAt: number;
  background: string; // 项目背景回顾
  stopReasons: string; // 停工原因分析
  completionEstimate: number; // 建设完成度估算 0–99
  conclusion: AuditConclusion;
  conclusionReason: string; // 审计建议理由
}

/* ============================================================
 * 5. 项目
 * ============================================================ */

export interface Project {
  id: string; // 格式 "2026-001"
  name: string; // AI 生成的正式名称
  originalInput: string; // 市长原始输入
  type: ProjectType;
  scale: string; // AI 生成的建设规模描述
  approvalNote: string; // AI 生成的批复意见
  status: ProjectStatus;
  progressFrequency: ProgressFrequency; // AI 建议、市长确认的施工频率
  createdAt: number; // Unix ms
  lastProgressAt: number; // 最后推进时间（施工备案或复工均更新）
  progressRecords: ProgressRecord[]; // 施工记录列表
  completedAt?: number;
  abandonedAt?: number;
  estimatedDeadline?: number; // 市长设定的预计完成时间
  citySlot: number; // 城市地图槽位索引（0 起）
  buildingType: BuildingType;
  /** 当前有效的专项审计报告（TASK-17）；复工/规划降级成功后归档并清空（见 auditHistory） */
  auditReport?: AuditReport;
  /**
   * 历史专项审计报告（TASK-18）。支持"烂尾→审计→复工→再烂尾→再审计"多轮生命周期：
   * 复工或规划降级成功时，当前 auditReport 归入此列表并清空 auditReport，
   * 以便项目再次 abandoned 时可发起新一轮审计。爆破不归档（快照整体进 demolishedProjects）。
   */
  auditHistory?: AuditReport[];
  year: number; // 立项年份
  restartCount: number; // 复工次数，用于报告统计
  /** 市长批准后的正式项目章程（供项目详情 / 审计 / 年报使用）；仅存已审定内容 */
  plan: ProjectPlan;
}

/**
 * 项目章程（市长批准后的正式建设内容）。
 * 只保存经市长最终审定的内容；不含 AI 临时字段与 meta/source 标识（那些仅存在于 ProjectDraft）。
 */
export interface ProjectPlan {
  goal: string; // 建设目标
  duration?: string; // 建设周期（可能为用户填写或审定后的建议值）
  acceptanceCriteria: string; // 验收标准
  progressScheduleText?: string; // 精确施工安排原文（如"每周5天"）；区别于粗粒度 progressFrequency
  sections: DraftSection[]; // 动态建设正文小节
}

/**
 * 数据来源标记：区分"用户明确提供"与"系统建议"。
 * - 'user'：用户在输入中显式写出（如"每周学习5天"→频率 user）。
 * - 'suggested'：用户未提供、由 AI/Mock 建议的值（批复中需标记为"建议"，可被市长修改）。
 */
export type FieldSource = 'user' | 'suggested';

/** 批复正文的动态小节（每个项目生成约 3–5 个与目标相关的 section） */
export interface DraftSection {
  title: string; // 小节标题，如"建设目标""施工安排""验收标准"
  content: string; // 小节正文
}

/**
 * 立项草案（AI createProject / downgradeProject 的返回结构）。
 *
 * 比 Project 丰富：含仅用于批复展示的动态正文与建议参数。
 * 核心字段（name/type/buildingType/approvalNote/progressFrequency/goal 等）在批准时写入 Project；
 * 展示字段（sections/acceptanceCriteria/duration 等）不强行塞入 Project，仅服务批复。
 *
 * 关键可编辑参数附带来源标记（见 meta），批复页允许市长在批准前审定修改。
 * 不含运行期字段（id / status / 时间戳 / 槽位等），由 store.addProject 补全。
 */
export interface ProjectDraft {
  // —— 核心（批准后进入 Project）——
  name: string; // 公文化项目名称（可编辑）
  type: ProjectType;
  buildingType: BuildingType; // 内部用，不展示给用户
  progressFrequency: ProgressFrequency; // 施工频率（可编辑；可能是 user 或 suggested）
  approvalNote: string; // 批复意见 / 风险提示

  // —— 批复展示 + 可审定参数 ——
  goal: string; // 建设目标（可编辑）—— 忠实反映用户真实目标，不失真
  acceptanceCriteria: string; // 验收标准（可编辑）
  duration?: string; // 建设周期（可编辑；用户未提供时为建议值）
  /** 精确施工安排原文（如"每周5天"），区别于粗粒度 progressFrequency；可编辑 */
  progressScheduleText?: string;
  scale: string; // 建设规模概述（兼容旧字段，用于 Project.scale）

  // —— 动态正文：约 3–5 个与目标相关的小节 ——
  sections: DraftSection[];

  // —— 字段来源标记：批复页据此显示"建议"标签、决定可编辑项 ——
  meta: {
    duration: FieldSource; // 建设周期来源
    progressFrequency: FieldSource; // 施工频率来源
    goalNumbers: FieldSource; // 目标中的量化数字来源（user=用户写出，suggested=系统补充）
  };
}

/* ============================================================
 * 6. 市民反馈
 * ============================================================ */

export type FeedbackType = 'complaint' | 'suggestion' | 'praise' | 'question';

/**
 * 固定 4 位市民 Persona —— 代表市长内部不同需求/利益相关方（非普通 NPC）。
 * 不做好感度/养成/关系系统。
 */
export interface CitizenPersona {
  id: string; // 'efficiency' | 'health' | 'growth' | 'life'
  name: string; // 真实居民风格姓名
  title: string; // 身份/头衔
  concern: string; // 关注方向（一句）
  avatarIndex: number; // 像素头像索引（供 TASK-15 UI 用）
}

export interface CitizenFeedback {
  id: string;
  personaId: string; // 关联 CitizenPersona.id
  type: FeedbackType;
  content: string; // 正式市政风格文案
  /** 关联项目（城市级反馈为 undefined） */
  projectId?: string;
  /** 关联项目的状态快照（生成时），用于去重键 */
  projectStatus?: ProjectStatus;
  docNumber: string; // 虚构文件编号
  date: string; // 虚构日期（YYYY-MM-DD）
  createdAt: number;
  read: boolean;
}

/* ============================================================
 * 7. 年度施政方针
 * ============================================================ */

export interface AnnualPolicy {
  year: number;
  title: string; // 施政方针标题，如"少开新工、多填旧坑"
  description: string; // 简要说明，如"重点清理存量烂尾，控制新项目规模"
  source:
    | 'initial' // 首次建城时由 AI 提供候选、市长选择
    | 'secretary-generated' // 年度会议时由 AI 秘书基于数据生成候选
    | 'mayor-selected'; // 统一标记为市长最终选定
}

/* ============================================================
 * 8. 年度政府工作报告
 * ============================================================ */

export interface AnnualReportStats {
  year: number;
  /** 当年新立项目数（按 createdAt 年份归属） */
  totalProjects: number;
  /** 当年实际发生竣工的项目数（按 completedAt 年份，允许跨年立项的项目计入） */
  completed: number;
  /** 当年新立项目中、同年即竣工的项目数（completionRate 的分子，保证分子分母同一子集） */
  completedSameYear: number;
  /** 报告生成当时的烂尾存量（按当前 status==='abandoned'，不按年份过滤；snapshot 指标） */
  abandoned: number;
  /** 截至本年度末全市累计爆破销项数（累计口径，无 demolishedAt 不按年归因） */
  demolished: number;
  /** 当年新立项目的累计复工次数之和（累计口径，非"本年度复工次数"） */
  restartCount: number;
  /** 本年度新立项目的年内完工率 = completedSameYear / totalProjects * 100（totalProjects=0 时为 0） */
  completionRate: number;
  policyTitle: string; // 当年施政方针标题（用于报告首句插入）
}

export interface AnnualReport {
  year: number;
  generatedAt: number;
  policy: AnnualPolicy; // 当年施政方针完整记录
  stats: AnnualReportStats;
  sections: {
    title: string; // "[年份]年XX市人民政府工作报告"
    review: string; // 第一部分：年度工作回顾
    problems: string; // 第二部分：存在的主要问题
    outlook: string; // 第三部分：下一年度主要预期目标
  };
}

/* ============================================================
 * 9. AI 秘书对话
 * ============================================================ */

/** AI 秘书对话消息。role 区分发件人：市长 / 秘书 / 系统注入 */
export interface Message {
  id: string;
  role: 'mayor' | 'secretary' | 'system';
  content: string;
  createdAt: number;
}

/**
 * 城市数据摘要上下文（随秘书对话 / Prompt 一同传给 AI）。
 * 字段与 design.md 第 7.3 节秘书 System Prompt 对齐：
 * 感知在建 / 施工预警 / 停工 / 竣工 / 烂尾数量，以及当年施政方针。
 */
export interface CityContext {
  cityName: string;
  year: number;
  construction: number; // 在建数
  warning: number; // 施工预警数
  halted: number; // 停工数
  completed: number; // 竣工数
  abandoned: number; // 烂尾数
  currentPolicyTitle: string; // 当年施政方针标题
  currentPolicyDescription: string; // 当年施政方针说明
}

/* ============================================================
 * 10. 游戏全局状态
 * ============================================================ */

export interface GameState {
  cityName: string;
  currentYear: number;
  /**
   * 当年施政方针。
   * - 首次建城（initialized === false）流程中，城市命名完成后、方针选定前，为 null。
   * - 正式进入城市主界面（initialized === true）后，业务逻辑应视其为已存在（非 null）。
   * 不使用"默认占位方针"绕过首次选择。
   */
  currentPolicy: AnnualPolicy | null;
  policyHistory: AnnualPolicy[]; // 历年施政方针列表（含当年）
  projects: Project[];
  demolishedProjects: Project[]; // 爆破销项历史
  feedbacks: CitizenFeedback[];
  /** 市民热线最后查看时间（未读数 = createdAt > 此值的反馈数）；打开面板即更新 */
  lastViewedFeedbackAt: number;
  secretaryMessages: Message[]; // AI 秘书对话历史
  annualReports: AnnualReport[];
  apiKey: string;
  isDemoMode: boolean; // 无 API Key 时为 true
  projectCounter: number; // 当年序号
  announcements: string[]; // 公告栏队列
  initialized: boolean; // 是否完成首次引导
}
