/**
 * 临时城市渲染测试页（TASK-06 验证用）。
 * 通过 URL ?citytest 挂载。注入覆盖五态 × tower/flat 的 mock 项目，
 * 验证：分层城市、五态渲染、hover 高亮、点击回调、入场动画、crane/flag 动画。
 * 验证后此文件连同 App.tsx 分支一并移除，不进入最终产品。
 */
import { useState } from 'react';
import CityCanvas from './CityCanvas';
import type { BuildingType, Project, ProjectStatus } from '@/store/types';

let seq = 0;
function mockProject(
  slot: number,
  status: ProjectStatus,
  buildingType: BuildingType,
  nameSuffix: string,
): Project {
  seq += 1;
  const now = Date.now();
  return {
    id: `test-${seq}`,
    name: `测试工程·${nameSuffix}`,
    originalInput: '测试目标',
    type: '民生工程',
    scale: '测试规模',
    approvalNote: '予以批准立项。',
    status,
    progressFrequency: 'weekly',
    createdAt: now,
    lastProgressAt: now,
    progressRecords: [],
    citySlot: slot,
    buildingType,
    year: 2026,
    plan: { goal: '测试目标', acceptanceCriteria: '测试验收', sections: [] },
    restartCount: 0,
  };
}

// 初始布局：覆盖五态 + tower/flat 两形态，分布在后排(0-5)与前排(6-11)
function initialProjects(): Project[] {
  return [
    // 后排
    mockProject(0, 'construction', 'tower', '在建·高楼'),
    mockProject(1, 'warning', 'tower', '预警·高楼'),
    mockProject(2, 'halted', 'flat', '停工·矮楼'),
    mockProject(3, 'abandoned', 'tower', '烂尾·高楼'),
    mockProject(4, 'completed', 'flat', '竣工·矮楼'),
    // 前排
    mockProject(6, 'construction', 'flat', '在建·矮楼'),
    mockProject(7, 'warning', 'flat', '预警·矮楼'),
    mockProject(8, 'halted', 'tower', '停工·高楼'),
    mockProject(9, 'abandoned', 'flat', '烂尾·矮楼'),
    mockProject(10, 'completed', 'tower', '竣工·高楼'),
  ];
}

export default function CityTestPage() {
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [clicked, setClicked] = useState<string>('（点击任意建筑测试命中）');

  const addBuilding = () => {
    // 找一个空槽位（优先未占用的，验证新建筑入场动画 + 槽位复用）
    const used = new Set(projects.map((p) => p.citySlot));
    let slot = 0;
    while (used.has(slot) && slot < 12) slot += 1;
    if (slot >= 12) {
      setClicked('城市已满（12 槽位），请先移除建筑');
      return;
    }
    const forms: BuildingType[] = ['tower', 'flat'];
    setProjects((ps) => [
      ...ps,
      mockProject(slot, 'construction', forms[slot % 2], `新建·槽${slot}`),
    ]);
  };

  const removeLast = () => {
    setProjects((ps) => ps.slice(0, -1));
  };

  return (
    <div style={{ padding: 16, background: '#1a1a2e', minHeight: '100vh' }}>
      <h2 className="pixel-font" style={{ color: '#e8c14c', fontSize: 14, marginBottom: 10 }}>
        CITY TEST — 五态 × tower/flat × 双排城市
      </h2>
      <div style={{ marginBottom: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button onClick={addBuilding} style={btnStyle}>
          新增建筑（入场动画 + 槽位复用）
        </button>
        <button onClick={removeLast} style={{ ...btnStyle, background: '#636e72' }}>
          移除最后一栋
        </button>
        <span style={{ color: '#f0e6c8', fontSize: 13 }}>点击结果：{clicked}</span>
      </div>
      <div style={{ border: '2px solid #e8c14c' }}>
        <CityCanvas
          projectsOverride={projects}
          onBuildingClick={(p) =>
            setClicked(`${p.name}（${p.id} / ${p.status} / slot ${p.citySlot}）`)
          }
        />
      </div>
      <p style={{ color: '#8a8f94', fontSize: 12, marginTop: 8 }}>
        当前 {projects.length} 栋 · hover 应有金色描边 · 空白点击无响应
      </p>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '6px 12px',
  background: '#e17055',
  color: '#1a1a2e',
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'sans-serif',
  fontSize: 13,
};
