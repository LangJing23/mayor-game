/**
 * ConfirmDialog —— 基于 Modal 的确认对话框。
 * 用于爆破销项等不可撤销操作的二次确认（文案由调用方按 copywriting Steering 提供）。
 */
import Modal from './Modal';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  /** 确认按钮文案，默认"确认" */
  confirmLabel?: string;
  /** 取消按钮文案，默认"取消" */
  cancelLabel?: string;
  /** 确认按钮样式；危险操作用 'danger' */
  confirmVariant?: 'default' | 'primary' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  confirmVariant = 'primary',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      actions={[
        { label: cancelLabel, onClick: onCancel, variant: 'default' },
        { label: confirmLabel, onClick: onConfirm, variant: confirmVariant },
      ]}
    >
      {message}
    </Modal>
  );
}
