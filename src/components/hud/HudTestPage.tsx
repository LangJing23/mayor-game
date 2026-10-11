/**
 * 临时 HUD 集成测试页（TASK-08 验证用）。
 * ?hudtest 挂载。结构：TopBar / CityCanvas（视觉主体）/ Announcements + ActionBar。
 * 用 mock 城市数据展示五态、方针、公告、四入口、一次 Notification、Demo 标识。
 * 验证后此文件连同 App.tsx 分支一并移除，不进入最终产品。
 */
import { useState } from 'react';
import TopBar from './TopBar';
import ActionBar from './ActionBar';
import Announcements from './Announcements';
import CityCanvas from '@/canvas/CityCanvas';
import NotificationStack, { type NotificationData } from '@/components/ui/Notification';
import type { BuildingType, Project, ProjectStatus } from '@/store/types';

let seq = 0;
function mock(slot: number, status: ProjectStatus, bt: BuildingType, name: string): Project {
  seq += 1;
  const now = Date.now();
  return {
    id: `hud-${seq}`,
    name,
    originalInput: '目标',
    type: '民生工程',
    scale: '规模',
    approvalNote: '予以批准立项。',
    status,
    progressFrequency: 'weekly',
    createdAt: now,
    lastProgressAt: now,
    progressRecords: [],
    citySlot: slot,
    buildingType: bt,
    year: 2026,
    plan: { goal: '目标', acceptanceCriteria: '验收', sections: [] },
    restartCount: 0,
  };
}

const PROJECTS: Project[] = [
  mock(0, 'construction', 'tower', '每日阅读一小时重点工程'),
  mock(1, 'warning', 'flat', '早睡示范工程'),
  mock(2, 'halted', 'tower', '健身中心建设项目'),
  mock(3, 'abandoned', 'flat', '个人博客数字化建设项目'),
  mock(4, 'completed', 'tower', '英语能力提升工程'),
  mock(6, 'construction', 'flat', '厨艺提升配套工程'),
  mock(7, 'completed', 'flat', '储蓄计划民生工程'),
];

const ANNOUNCEMENTS = [
  '我市"每日阅读一小时"重点工程举行第六次复工仪式。',
  '"早睡示范工程"施工进度再次受到市民关注。',
  '"英语能力提升工程"顺利竣工，市民幸福感显著提升。',
  '"个人博客数字化建设项目"已列入本市烂尾工程名录。',
];

function counts(ps: Project[]) {
  const c = { construction: 0, warning: 0, halted: 0, abandoned: 0, completed: 0 };
  for (const p of ps) c[p.status] += 1;
  return c;
}

export default function HudTestPage() {
  const [log, setLog] = useState('（点击任意入口或建筑）');
  const [notes, setNotes] = useState<NotificationData[]>([]);

  const pushNote = () => {
    const id = `n${Date.now()}`;
    setNotes((ns) => [
      ...ns,
      {
        id,
        kind: 'warning',
        title: '市民反馈',
        message: '市民李四反映，"健身中心建设项目"已停工多日，强烈要求市长给出说法！',
      },
    ]);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: '#1a1a2e',
      }}
    >
      <TopBar
        cityName="梦想市"
        year={2026}
        policyTitle="想到就干、干了再说"
        counts={counts(PROJECTS)}
        isDemoMode={true}
      />

      {/* 城市 Canvas：绝对视觉主体，占据中间全部剩余空间 */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          padding: '8px 0',
        }}
      >
        <CityCanvas
          projectsOverride={PROJECTS}
          onBuildingClick={(p) => setLog(`点击建筑：${p.name}（${p.status}）`)}
        />
      </div>

      {/* 底部：公告（左）+ 操作入口（右） */}
      <div>
        <Announcements items={ANNOUNCEMENTS} />
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
          <span style={{ color: '#8a8f94', fontSize: 12 }}>{log}</span>
          <ActionBar
            onNewProject={() => {
              setLog('入口：申请立项');
              pushNote();
            }}
            onSecretary={() => setLog('入口：市长办公室')}
            onArchive={() => setLog('入口：档案馆')}
            onAnnualMeeting={() => setLog('入口：年度会议')}
          />
        </div>
      </div>

      {/* 通知下移到 TopBar 之下，避免遮挡 HUD */}
      <NotificationStack
        items={notes}
        onClose={(id) => setNotes((ns) => ns.filter((n) => n.id !== id))}
        topOffset={70}
      />
    </div>
  );
}
