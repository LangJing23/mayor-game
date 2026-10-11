/**
 * CityScene —— 正式城市主界面（initialized=true 后展示）。
 *
 * HUD（TopBar / Announcements / ActionBar）+ CityCanvas，从 Zustand 读真实数据。
 * 「申请立项」接入 TASK-11 完整链路；其余三入口仍为占位。
 * aiClient 配置由本层（持有 Zustand）注入，aiClient 不读 store。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useGameStore } from '@/store/gameStore';
import { aiClient } from '@/ai/aiClient';
import CityCanvas from '@/canvas/CityCanvas';
import TopBar, { type StatusCounts } from '@/components/hud/TopBar';
import ActionBar from '@/components/hud/ActionBar';
import Announcements from '@/components/hud/Announcements';
import NotificationStack, { type NotificationData } from '@/components/ui/Notification';
import NewProjectPanel from '@/components/panels/NewProjectPanel';
import ProjectCard from '@/components/panels/ProjectCard';
import { HotlineEntry, HotlinePanel } from '@/components/panels/CitizenHotline';
import SecretaryPanel from '@/components/panels/SecretaryPanel';
import AnnualMeetingScene from '@/components/meeting/AnnualMeetingScene';
import ArchivePanel from '@/components/panels/ArchivePanel';
import type { AnnualPolicy } from '@/store/types';
import { useStallDetection, type StallChange } from '@/hooks/useStallDetection';
import { generateFeedback } from '@/logic/citizenFeedback';
import { getDemolishSnapshot, demolishProjectAction } from '@/logic/projectManager';
import type { CityCanvasHandle } from '@/canvas/CityCanvas';
import type { Project, ProjectDraft, ProjectStatus } from '@/store/types';
import { MAX_CITY_PROJECTS, managedProjectCount } from '@/store/types';

type FeedbackEventKind =
  | 'new'
  | 'warning'
  | 'halted'
  | 'abandoned'
  | 'completed'
  | 'restart'
  | 'downgrade'
  | 'demolish';

function countStatuses(projects: Project[]): StatusCounts {
  const c: StatusCounts = { construction: 0, warning: 0, halted: 0, abandoned: 0, completed: 0 };
  for (const p of projects) c[p.status] += 1;
  return c;
}

let noteSeq = 0;
function nextNoteId(): string {
  noteSeq += 1;
  return `n${Date.now()}-${noteSeq}`;
}

/** 停工状态变化的通知/公告文案（按最终目标状态；construction 回退不通知） */
function stallTexts(
  name: string,
  target: ProjectStatus,
): { kind: 'warning' | 'info'; title: string; note: string; announcement?: string } | null {
  switch (target) {
    case 'warning':
      return {
        kind: 'warning',
        title: '施工预警',
        note: `「${name}」已连续多日无施工记录，现发布施工预警。`,
        announcement: `我市「${name}」施工进度出现异常，已启动建设预警。`,
      };
    case 'halted':
      return {
        kind: 'warning',
        title: '停工认定',
        note: `「${name}」长期无有效施工，现认定进入停工状态。`,
        announcement: `我市「${name}」连续多日未施工，现已进入停工状态。`,
      };
    case 'abandoned':
      return {
        kind: 'warning',
        title: '烂尾认定',
        note: `「${name}」已达到烂尾认定条件，建议启动专项审计。`,
        announcement: `我市「${name}」长期停工，已列入烂尾工程清单。`,
      };
    default:
      return null;
  }
}

export default function CityScene() {
  const cityName = useGameStore((s) => s.cityName);
  const currentYear = useGameStore((s) => s.currentYear);
  const currentPolicy = useGameStore((s) => s.currentPolicy);
  const projects = useGameStore((s) => s.projects);
  const announcements = useGameStore((s) => s.announcements);
  const projectCounter = useGameStore((s) => s.projectCounter);
  // 「演示模式」标识：仅在显式强制 Mock（?mock=1）时展示，不再由前端 apiKey 推断。
  const isDemoMode =
    typeof window !== 'undefined' && /[?&]mock=1\b/.test(window.location.search);

  const addProject = useGameStore((s) => s.addProject);
  const pushAnnouncement = useGameStore((s) => s.pushAnnouncement);
  const markFeedbackViewed = useGameStore((s) => s.markFeedbackViewed);
  const advanceYear = useGameStore((s) => s.advanceYear);
  const setCurrentPolicy = useGameStore((s) => s.setCurrentPolicy);

  const counts = useMemo(() => countStatuses(projects), [projects]);

  // 城市画布句柄（TASK-18 爆破动画命令式调用）
  const cityCanvasRef = useRef<CityCanvasHandle>(null);

  const [notes, setNotes] = useState<NotificationData[]>([]);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [hotlineOpen, setHotlineOpen] = useState(false);
  const [secretaryOpen, setSecretaryOpen] = useState(false);
  const [meetingOpen, setMeetingOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const closeNote = (id: string) => setNotes((ns) => ns.filter((n) => n.id !== id));
  const pushNote = (n: Omit<NotificationData, 'id'>) =>
    setNotes((ns) => [...ns, { id: nextNoteId(), ...n }]);

  // AI 客户端配置：仅在相关配置变化时 init，避免每次 render 重复初始化
  const lastCfg = useRef<string>('');
  useEffect(() => {
    // 模式判定与前端 apiKey 解耦：默认真实 AI（经 /api/ai）；仅 ?mock=1 或 DEV 显式强制 Mock。
    const search = typeof window !== 'undefined' ? window.location.search : '';
    const forceMock = /[?&]mock=1\b/.test(search);
    const sig = `${forceMock}|${cityName}`;
    if (sig === lastCfg.current) return;
    lastCfg.current = sig;
    aiClient.init({ cityName, forceMock });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cityName]);

  // 建城收尾通知：仅本次运行刚完成 onboarding 时弹一次；刷新后不重复。
  // 同时写入唯一一条真实的初始化公告（不预填任何"XX开始施工"假模板）。
  useEffect(() => {
    if (useGameStore.getState().consumeJustInitialized()) {
      pushNote({
        kind: 'success',
        title: '市政系统',
        message: `城市登记完成。${currentYear} 年度建设工作正式启动。`,
      });
      pushAnnouncement(`${cityName}完成城市登记，${currentYear}年度建设工作正式启动。`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 市民反馈：根据已发生的事件生成（去重/节流/优先级在 logic 内），写入 Store。
  // 读最新 Store 快照，保证 projects/existing 为当前值。
  // extraProjects：已从 store 移除但仍需参与反馈的项目快照（如爆破后的项目），
  // 合入事实集合供 generateFeedback 按 projectId 命中。
  const emitFeedback = (
    events: Array<{ projectId: string; kind: FeedbackEventKind }>,
    extraProjects: Project[] = [],
  ) => {
    const st = useGameStore.getState();
    const projectPool = [...st.projects, ...extraProjects];
    const fbs = generateFeedback({ events, projects: projectPool, existing: st.feedbacks, now: Date.now() });
    for (const fb of fbs) st.addFeedback(fb);
    // 确实有新增群众留言时，弹一条简短提醒（不弹正文，正文在 12345 市民热线面板查看）
    if (fbs.length > 0) {
      pushNote({
        kind: 'info',
        title: '12345 市民热线',
        message: '12345 市民热线收到新的群众留言。',
      });
    }
  };

  // 城市承载上限提示（立项机制，非技术报错）
  const notifyCapacityFull = () => {
    pushNote({
      kind: 'info',
      title: '立项申请',
      message:
        `当前在管建设项目已达城市承载上限（${MAX_CITY_PROJECTS} 项）。` +
        `建设任务过多容易造成精力分散，请优先推进或治理现有工程后再申请立项；` +
        `对长期停工、已形成烂尾的项目，可启动专项审计并进行销项治理。`,
    });
  };

  // 申请立项入口：达到"在管"容量上限则拦截，不进入立项流程。占用量实时取 store。
  const handleNewProjectClick = () => {
    if (managedProjectCount(useGameStore.getState().projects) >= MAX_CITY_PROJECTS) {
      notifyCapacityFull();
      return;
    }
    setNewProjectOpen(true);
  };

  // 批准立项：写 Store（id/citySlot/lastProgressAt 等由 store.addProject 分配），弹成功通知 + 公告。
  // 双重校验：批准前再次检查容量（防止流程打开期间状态变化导致超额）。
  const handleApprove = (draft: ProjectDraft, originalInput: string) => {
    if (managedProjectCount(useGameStore.getState().projects) >= MAX_CITY_PROJECTS) {
      // 已达在管上限：不创建项目、不分配 citySlot、不写立项公告
      setNewProjectOpen(false);
      notifyCapacityFull();
      return;
    }
    const proj = addProject(draft, originalInput);
    setNewProjectOpen(false);
    pushNote({
      kind: 'success',
      title: '立项成功',
      message: `「${draft.name}」立项手续办理完成，项目正式进入施工阶段。`,
    });
    pushAnnouncement(`我市「${draft.name}」正式批准立项，现已进场施工。`);
    // 新项目立项事件（logic 内部决定是否真的生成反馈，非每次必出）
    emitFeedback([{ projectId: proj.id, kind: 'new' }]);
  };

  /* ---------- 烂尾工程治理（TASK-18）---------- */

  // 竣工：市民反馈 + 竣工公告（真实项目名，从 store 解析）
  const handleProjectCompleted = (pid: string) => {
    emitFeedback([{ projectId: pid, kind: 'completed' }]);
    const p = useGameStore.getState().projects.find((x) => x.id === pid);
    if (p) pushAnnouncement(`我市「${p.name}」通过验收，正式竣工。`);
  };

  // 专项审计报告生成后：审计完成公告（真实项目名）
  const handleAuditGenerated = (pid: string) => {
    const p = useGameStore.getState().projects.find((x) => x.id === pid);
    if (p) pushAnnouncement(`我市「${p.name}」专项审计工作已完成。`);
  };

  // 复工成功：通知 + 市民正面反馈
  const handleProjectRestarted = (proj: Project) => {
    pushNote({
      kind: 'success',
      title: '复工',
      message: `「${proj.name}」已宣布复工，项目恢复为在建状态。`,
    });
    pushAnnouncement(`我市「${proj.name}」经治理后恢复施工。`);
    emitFeedback([{ projectId: proj.id, kind: 'restart' }]);
  };

  // 规划降级成功：通知 + 市民中性反馈
  const handleProjectDowngraded = (proj: Project) => {
    pushNote({
      kind: 'success',
      title: '规划降级',
      message: `「${proj.name}」完成规划调整，建设规模已收缩，项目恢复为在建状态。`,
    });
    pushAnnouncement(`我市「${proj.name}」完成规划调整，按降规方案继续建设。`);
    emitFeedback([{ projectId: proj.id, kind: 'downgrade' }]);
  };

  // 爆破销项：先存快照 → 关闭项目档案 → 下一帧播放动画 → 完成后删除 + 用快照发通知/反馈。
  // 现场（Canvas）无法定位该建筑 rect 时，不执行删除，提示后中止。
  // 关键时序：
  //  - 绝不在 explode 之前把 Project 从 Store 删除（否则 Canvas 当帧就不再绘制该建筑，infosRef 丢失它）。
  //  - 先关闭 ProjectCard（移除全屏遮罩），再在下一帧（rAF）调 explode，确保 Canvas 已基于最新一帧
  //    产生 infosRef（遮罩期间与之后 projects 未变，该建筑仍在 infosRef 中）。
  const DEV = import.meta.env?.DEV;
  const handleRequestDemolish = (projectId: string) => {
    if (DEV) console.log('[demolish] 3 handleRequestDemolish projectId=', projectId);
    const snapshot = getDemolishSnapshot(projectId);
    if (!snapshot) {
      if (DEV) console.log('[demolish] 3! snapshot NOT found, abort');
      return;
    }
    if (DEV) console.log('[demolish] 3 snapshot found name=', snapshot.name);

    // 先关闭项目档案与确认框，移除覆盖 Canvas 的全屏遮罩
    setSelectedProjectId(null);
    if (DEV) console.log('[demolish] 4 project card closed (setSelectedProjectId null)');

    // 延迟 ~130ms 再触发爆破：确保 ProjectCard / ConfirmDialog 完全退场、城市画布可见，
    // 预震与初爆不会被正在退场的 UI 遮住（真机验收反馈：UI 退场期吞掉了预震/初爆）。
    window.setTimeout(() => {
      if (DEV) console.log('[demolish] 5 canvas explode requested, ref?', !!cityCanvasRef.current);
      const started = cityCanvasRef.current?.explode(projectId, () => {
        if (DEV) console.log('[demolish] 8 explosion completed → demolishProject');
        // 动画自然结束回调：此时才真正删除项目（释放 slot）
        demolishProjectAction(projectId);
        if (DEV) {
          const gone = !useGameStore.getState().projects.find((p) => p.id === projectId);
          console.log('[demolish] 9 demolishProject called');
          console.log('[demolish] 10 project removed =', gone);
        }
        pushNote({
          kind: 'success',
          title: '控制爆破完成',
          message: `「${snapshot.name}」控制爆破完成。已释放心理建设用地 1 宗，地块完成清零，等待后续规划。`,
        });
        pushAnnouncement(`我市「${snapshot.name}」控制爆破完成，原地块已清零，等待后续规划。`);
        // 用快照发市民反馈（项目已从 store 移除，经 extraProjects 注入事实集合）
        emitFeedback([{ projectId: snapshot.id, kind: 'demolish' }], [snapshot]);
      });
      if (DEV) console.log('[demolish] 5 explode returned started=', started);
      if (!started) {
        // 定位失败：不删除、不动画
        pushNote({
          kind: 'info',
          title: '控制爆破',
          message: '现场定位失败，控制爆破程序暂未执行。',
        });
      }
    }, 130);
  };

  // 停工自动检测：状态变化时弹最高级别通知 + 公告 + 生成市民反馈
  useStallDetection((changes: StallChange[]) => {
    for (const c of changes) {
      const texts = stallTexts(c.name, c.targetStatus);
      if (!texts) continue;
      pushNote({ kind: texts.kind, title: texts.title, message: texts.note });
      if (texts.announcement) pushAnnouncement(texts.announcement);
    }
    // 市民反馈：按最终状态生成（warning/halted/abandoned）
    const events = changes
      .filter((c) => c.targetStatus === 'warning' || c.targetStatus === 'halted' || c.targetStatus === 'abandoned')
      .map((c) => ({ projectId: c.id, kind: c.targetStatus as FeedbackEventKind }));
    if (events.length) emitFeedback(events);
  });

  // 年度会议散会：严格顺序 advanceYear → setCurrentPolicy(下一年方针) → 一次年度启动通知。
  // 报告已在会议场景内生成并归档（去重），此处不再归档。
  const handleAdjournMeeting = (_archivedYear: number, nextPolicy: AnnualPolicy) => {
    advanceYear(); // currentYear = oldYear + 1，项目序号归零
    const newYear = useGameStore.getState().currentYear;
    // 保险：确保方针 year 与新年度一致（候选 year 已为 oldYear+1，但不信任外部，强制对齐）
    setCurrentPolicy({ ...nextPolicy, year: newYear });
    pushNote({
      kind: 'success',
      title: '市政系统',
      message: `${newYear} 年度建设工作正式启动。本年度施政方针：「${nextPolicy.title}」。`,
    });
    pushAnnouncement(`${newYear}年度建设工作正式启动，施政方针调整为「${nextPolicy.title}」。`);
  };

  // 打开年度会议：首次召开当年会议时播一条"会议召开"公告（已归档当年报告则视为已召开，不重复）
  const openAnnualMeeting = () => {
    const st = useGameStore.getState();
    if (!st.annualReports.find((r) => r.year === st.currentYear)) {
      pushAnnouncement(`${st.currentYear}年度市政工作会议召开。`);
    }
    setMeetingOpen(true);
  };

  const empty = projects.length === 0;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--pixel-ui-bg)',
      }}
    >
      <TopBar
        cityName={cityName}
        year={currentYear}
        policyTitle={currentPolicy?.title ?? null}
        counts={counts}
        isDemoMode={isDemoMode}
        total={managedProjectCount(projects)}
        capacity={MAX_CITY_PROJECTS}
      />

      <div
        style={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          padding: '8px 0',
        }}
      >
        <CityCanvas ref={cityCanvasRef} onBuildingClick={(p) => setSelectedProjectId(p.id)} />

        {/* 空城市轻量提示（存在项目则隐藏） */}
        {empty && (
          <div
            style={{
              position: 'absolute',
              textAlign: 'center',
              color: 'var(--pixel-ui-text)',
              background: 'rgba(10,12,30,0.55)',
              border: '2px solid rgba(232,193,76,0.4)',
              padding: '16px 22px',
              pointerEvents: 'none',
              lineHeight: 2,
              fontSize: 14,
            }}
          >
            本市暂无在建工程。
            <br />
            <span style={{ color: '#9aa0b5', fontSize: 13 }}>
              市长可通过「申请立项」启动首个建设项目。
            </span>
          </div>
        )}
      </div>

      <div>
        <Announcements items={announcements} />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '8px 16px',
            background: 'rgba(26,26,46,0.92)',
            borderTop: '2px solid rgba(232,193,76,0.3)',
          }}
        >
          {/* 轻量二级入口：靠左放置，不与右侧四个主操作按钮争抢空间 */}
          <HotlineEntry
            onOpen={() => {
              setHotlineOpen(true);
              markFeedbackViewed(); // 打开即视为已查看，未读 badge 归零
            }}
          />
          <ActionBar
            onNewProject={handleNewProjectClick}
            onSecretary={() => setSecretaryOpen(true)}
            onArchive={() => setArchiveOpen(true)}
            onAnnualMeeting={openAnnualMeeting}
          />
        </div>
      </div>

      <NewProjectPanel
        open={newProjectOpen}
        cityName={cityName}
        currentYear={currentYear}
        projectCounter={projectCounter}
        currentPolicy={currentPolicy}
        existingProjects={projects}
        onApprove={handleApprove}
        onClose={() => setNewProjectOpen(false)}
      />

      <ProjectCard
        projectId={selectedProjectId}
        onClose={() => setSelectedProjectId(null)}
        onNotify={(kind, title, message) => pushNote({ kind, title, message })}
        onProjectCompleted={handleProjectCompleted}
        onAuditGenerated={handleAuditGenerated}
        onProjectRestarted={handleProjectRestarted}
        onProjectDowngraded={handleProjectDowngraded}
        onRequestDemolish={handleRequestDemolish}
      />

      <HotlinePanel
        open={hotlineOpen}
        onClose={() => setHotlineOpen(false)}
        onViewProject={(pid) => {
          setHotlineOpen(false);
          setSelectedProjectId(pid);
        }}
      />

      <SecretaryPanel open={secretaryOpen} onClose={() => setSecretaryOpen(false)} />

      <AnnualMeetingScene
        open={meetingOpen}
        onClose={() => setMeetingOpen(false)}
        onAdjourn={handleAdjournMeeting}
      />

      <ArchivePanel
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        onOpenProject={(pid) => {
          // 复用现有 ProjectCard：关档案馆 → 打开该项目的真实项目卡
          setArchiveOpen(false);
          setSelectedProjectId(pid);
        }}
      />

      <NotificationStack items={notes} onClose={closeNote} topOffset={70} />
    </div>
  );
}
