/**
 * Mock 市长办公室秘书（src/ai/secretaryMock.ts）—— 确定性，基于真实 GameState 作答。
 *
 * 用途（TASK-16 第 11 条）：Demo 模式 / 无 API Key / 真实 AI 失败降级时使用。
 * 严禁只回"这是一个模拟回答"：必须根据传入的 SecretaryContext 本地事实生成有意义回答。
 *
 * 覆盖确定性处理：城市概况 / 风险项目 / 已竣工项目 / 烂尾·停工查询 / 当前施政方针 /
 * 具体项目查询 / 治理动作请求（婉拒）/ 未识别问题的通用正式回答。
 *
 * 纯函数：不读写 Store、不发网络请求。
 */

import type { Project } from '@/store/types';
import {
  briefToText,
  matchProject,
  statusLabel,
  stalledDaysOf,
  type SecretaryContext,
} from '@/logic/secretaryContext';

/* ---------- 意图识别（关键词，确定性，不用随机） ---------- */
type Intent =
  | 'governance' // 要求直接执行治理动作 → 婉拒
  | 'priority' // 哪个项目最需要处理
  | 'completed' // 哪些项目完成了
  | 'stalled' // 烂尾/停工有哪些
  | 'policy' // 按施政方针应该先做什么
  | 'tooMany' // 是不是立项太多了
  | 'specific' // 具体项目（命中真实 Project）
  | 'overview' // 城市整体情况
  | 'generic'; // 兜底

const GOVERNANCE_RE = /(帮我|给我|替我|直接|现在|立刻).*(爆破|销项|拆|立项|新建|建一个|开工|竣工|完工|验收|备案|打卡|降级|降规|缩减|复工|重启|改.*方针|换.*方针)|(爆破|销项|竣工|复工|降规|降级|立项).*(一下|吧|了)/;
const COMPLETED_RE = /竣工|完工|完成了|建成|已完成|哪些.*完成/;
const STALLED_RE = /烂尾|停工|停了|没动|荒废|停滞/;
const PRIORITY_RE = /最需要|优先|先处理|先搞|先弄|最该|重点处理|先治理|最紧/;
const POLICY_RE = /方针|应该先|先做什么|怎么做|策略|按.*方针/;
const TOOMANY_RE = /太多|开太多|立项.*多|是不是.*多|开了很多|坑太多|摊子/;
const OVERVIEW_RE = /情况|概况|怎么样|如何|整体|总体|建设.*怎样|现在.*样|汇报|简报/;

function classify(question: string, matched: Project | null): Intent {
  const q = question.trim();
  if (!q) return 'overview';
  if (GOVERNANCE_RE.test(q)) return 'governance';
  if (PRIORITY_RE.test(q)) return 'priority';
  if (COMPLETED_RE.test(q)) return 'completed';
  if (STALLED_RE.test(q)) return 'stalled';
  if (TOOMANY_RE.test(q)) return 'tooMany';
  if (POLICY_RE.test(q)) return 'policy';
  // 命中具体项目且非上述泛问 → 具体项目查询
  if (matched) return 'specific';
  if (OVERVIEW_RE.test(q)) return 'overview';
  return 'generic';
}

/* ---------- 单项目一句话近况（确定性，不虚构） ---------- */
function projectLine(p: Project, now: number): string {
  const days = stalledDaysOf(p, now);
  const base = `「${p.name}」当前为${statusLabel(p.status)}状态`;
  switch (p.status) {
    case 'abandoned':
      return `${base}，已进入烂尾，处置优先级高于普通停工与预警项目，建议纳入专项治理程序评估。`;
    case 'halted':
      return `${base}，累计约 ${days} 天无有效施工记录，建议尽快安排现场核查与复工评估。`;
    case 'warning':
      return `${base}，近期施工频率下降，建议恢复既定施工节奏，防止进一步滞后。`;
    case 'construction':
      return `${base}，施工节奏基本正常，建议保持当前推进力度。`;
    case 'completed':
      return `${base}，已通过竣工验收，建议后续加强日常维护，避免建成即闲置。`;
  }
}

/**
 * 生成 Mock 秘书回复。
 * @param ctx  本地计算的秘书事实上下文
 * @param question 市长最新一句问题（取对话最后一条 mayor 消息）
 */
export function secretaryMockReply(ctx: SecretaryContext, question: string): string {
  const now = Date.now();

  // ctx.projects 是精简快照，matchProject 需要完整 Project 字段的子集；
  // 这里用 ctx.projects 重建一个最小 Project 形态供关键词匹配（只用到 name/plan.goal/originalInput）。
  const pseudo = ctx.projects.map(
    (p) =>
      ({
        id: p.id,
        name: p.name,
        originalInput: p.goal,
        plan: { goal: p.goal },
      }) as unknown as Project,
  );
  const matchedPseudo = matchProject(question, pseudo);

  const intent = classify(question, matchedPseudo);
  const b = ctx.brief;

  // 空城市：任何问题都如实说明暂无台账
  if (b.total === 0 && intent !== 'governance') {
    return `市长，当前本市台账暂无建设项目记录，暂无可汇报的在建、停工或竣工工程。市长可通过「申请立项」启动首个城市建设项目。`;
  }

  switch (intent) {
    case 'governance':
      return `市长，该操作需进入对应的专项治理程序后，由您在相关面板执行，秘书无法通过对话直接办理。当前可先为您查看相关工程情况并提供处置建议。`;

    case 'priority': {
      if (b.priority.length === 0) {
        return `市长，从当前台账看，暂无烂尾、停工或预警类项目，各工程推进总体平稳，暂无需紧急处置的存量工程。`;
      }
      const top = b.priority[0];
      const rest = b.priority.slice(1);
      let msg = `市长，从当前台账看，${top.reason.includes('烂尾') ? '' : ''}「${top.name}」已处于${statusLabel(top.status)}状态，${top.reason}，建议优先处置。`;
      if (rest.length) msg += `其次为${rest.map((r) => `「${r.name}」`).join('、')}。`;
      return msg;
    }

    case 'completed': {
      const done = ctx.projects.filter((p) => p.status === 'completed');
      if (done.length === 0) {
        return `市长，经核查，当前台账暂无已竣工项目。现有工程仍处于在建或停滞阶段，建议优先推动存量项目完工。`;
      }
      const names = done.map((p) => `「${p.name}」`).join('、');
      return `市长，当前已竣工项目共 ${done.length} 项：${names}。建议后续加强已建成工程的日常维护与成果使用。`;
    }

    case 'stalled': {
      const bad = ctx.projects.filter((p) => p.status === 'abandoned' || p.status === 'halted');
      if (bad.length === 0) {
        return `市长，经核查，当前台账暂无烂尾或停工项目，存量工程治理情况总体平稳。`;
      }
      const ab = bad.filter((p) => p.status === 'abandoned').map((p) => `「${p.name}」`);
      const ha = bad.filter((p) => p.status === 'halted').map((p) => `「${p.name}」`);
      const parts: string[] = [];
      if (ab.length) parts.push(`烂尾 ${ab.length} 项：${ab.join('、')}`);
      if (ha.length) parts.push(`停工 ${ha.length} 项：${ha.join('、')}`);
      return `市长，当前存量停滞工程为：${parts.join('；')}。建议优先对烂尾项目启动专项治理评估。`;
    }

    case 'policy': {
      if (!ctx.currentPolicy) {
        return `市长，当前尚未选定本年度施政方针。建议先明确年度建设方向，再据此安排项目推进与立项节奏。`;
      }
      const focus =
        b.abandoned + b.halted > 0
          ? `当前存量停滞工程 ${b.abandoned + b.halted} 项，建议优先盘活既有项目、审慎新增同类立项`
          : b.warning > 0
            ? `当前有 ${b.warning} 项进入施工预警，建议优先恢复既定施工节奏`
            : `当前推进总体平稳，建议在巩固既有成果基础上稳步推进`;
      return `市长，依据本年度施政方针"${ctx.currentPolicy.title}"，${focus}，使实际推进与方针导向保持一致。`;
    }

    case 'tooMany': {
      const active = b.construction + b.warning + b.halted;
      if (b.abandoned + b.halted >= 2 && b.construction >= 2) {
        return `市长，从台账看，当前在建 ${b.construction} 项、停滞类（停工+烂尾）${b.halted + b.abandoned} 项并存，存在新增较快而存量未清的迹象。建议适度控制新项目立项节奏，集中力量盘活存量工程。`;
      }
      return `市长，当前在建及推进中项目共 ${active} 项，立项规模总体可控。建议结合施政方针，按既有施工能力稳步安排后续立项。`;
    }

    case 'specific': {
      // 用真实 ctx.projects 找回完整状态（matchedPseudo 只带 id）
      const real = ctx.projects.find((p) => p.id === matchedPseudo?.id);
      if (!real) break;
      // 复原为近似 Project 以复用 projectLine（只用到 status/name/lastProgressAt→stalledDays）
      const approx = {
        name: real.name,
        status: real.status,
        lastProgressAt: now - real.stalledDays * 86_400_000,
      } as unknown as Project;
      return `市长，${projectLine(approx, now)}`;
    }

    case 'overview':
      return briefToText(b);

    case 'generic':
    default:
      // 未识别问题：给正式通用回答 + 简要城市现状，不虚构、不跑题
      return (
        `市长，关于该事项，秘书暂未在台账中检索到明确对应记录。${briefToText(b)}` +
        `如需进一步了解具体工程，可直接说明项目名称。`
      );
  }

  // specific 分支未命中真实项目时的兜底
  return briefToText(ctx.brief);
}
