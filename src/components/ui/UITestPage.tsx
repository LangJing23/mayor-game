/**
 * 临时通用 UI 测试页（TASK-07 验证用）。
 * 通过 URL ?uitest 挂载。展示 Modal / ConfirmDialog / Notification 与按钮 hover/active。
 * 验证后此文件连同 App.tsx 分支一并移除，不进入最终产品。
 */
import { useState } from 'react';
import Modal from './Modal';
import ConfirmDialog from './ConfirmDialog';
import NotificationStack, { type NotificationData } from './Notification';
import styles from './ui.module.css';

let nid = 0;

export default function UITestPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmResult, setConfirmResult] = useState('（未操作）');
  const [notes, setNotes] = useState<NotificationData[]>([]);

  const pushNote = (kind: NotificationData['kind'], title: string, message: string) => {
    nid += 1;
    setNotes((ns) => [...ns, { id: `n${nid}`, kind, title, message }]);
  };
  const closeNote = (id: string) => setNotes((ns) => ns.filter((n) => n.id !== id));

  return (
    <div style={{ padding: 24, background: '#1a1a2e', minHeight: '100vh' }}>
      <h2 className="pixel-font" style={{ color: '#e8c14c', fontSize: 14, marginBottom: 18 }}>
        UI TEST — Modal / ConfirmDialog / Notification
      </h2>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 24 }}>
        <button className={styles.btn} onClick={() => setModalOpen(true)}>
          打开 MODAL
        </button>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={() => setConfirmOpen(true)}
        >
          打开 CONFIRM
        </button>
        <button
          className={`${styles.btn}`}
          onClick={() => pushNote('info', '市政公告', '市民张三对本市建设表示期待。')}
        >
          INFO 通知
        </button>
        <button
          className={styles.btn}
          onClick={() => pushNote('success', '竣工喜报', '某工程顺利竣工，市民满意度提升。')}
        >
          SUCCESS 通知
        </button>
        <button
          className={styles.btn}
          onClick={() => pushNote('warning', '施工预警', '某工程已出现停工风险，请市长关注。')}
        >
          WARNING 通知
        </button>
        <button
          className={`${styles.btn} ${styles.btnDanger}`}
          onClick={() => pushNote('danger', '烂尾告警', '某工程已正式列入烂尾名录。')}
        >
          DANGER 通知
        </button>
      </div>

      <div style={{ color: '#f0e6c8', fontSize: 13 }}>
        <p>按钮：hover 应颜色反转，按下应下沉 2px。</p>
        <p>Confirm 结果：{confirmResult}</p>
        <p style={{ color: '#8a8f94' }}>通知 5 秒自动消失，也可点 [X] 手动关闭；Modal 可按 Esc 关闭。</p>
      </div>

      <Modal
        open={modalOpen}
        title="XX 市市政事务窗口"
        onClose={() => setModalOpen(false)}
        actions={[
          { label: '关闭', onClick: () => setModalOpen(false) },
          { label: '确定', onClick: () => setModalOpen(false), variant: 'primary' },
        ]}
      >
        <p>这是一个通用像素弹窗示例。</p>
        <p>标题栏 + 内容区 + 底部 action 区，方形金边，深海军蓝底。</p>
        <p>按 Esc 或点击遮罩可关闭。</p>
      </Modal>

      <ConfirmDialog
        open={confirmOpen}
        title="控制爆破确认"
        message="本操作将对该项目实施控制爆破，操作不可撤销，请市长慎重决策。"
        confirmLabel="实施爆破"
        cancelLabel="再想想"
        confirmVariant="danger"
        onConfirm={() => {
          setConfirmResult('已确认（danger）');
          setConfirmOpen(false);
        }}
        onCancel={() => {
          setConfirmResult('已取消');
          setConfirmOpen(false);
        }}
      />

      <NotificationStack items={notes} onClose={closeNote} />
    </div>
  );
}
