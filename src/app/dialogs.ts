const $ = <T extends HTMLElement = HTMLElement>(selector: string): T | null =>
  document.querySelector(selector) as T | null;

export function showConfirmDialog(options: {
  eyebrow?: string;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  noticeOnly?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = $<HTMLDialogElement>('#confirmDialog');
    if (!dlg) {
      resolve(false);
      return;
    }
    $('#confirmEyebrow')!.textContent =
      options.eyebrow || (options.noticeOnly ? 'AVISO' : 'CONFIRMAR');
    $('#confirmTitle')!.textContent = options.title;
    $('#confirmMessage')!.textContent = options.message;
    const cancelBtn = $<HTMLButtonElement>('#confirmCancelBtn')!;
    const okBtn = $<HTMLButtonElement>('#confirmOkBtn')!;
    cancelBtn.textContent = options.cancelLabel || 'Cancelar';
    cancelBtn.classList.toggle('hidden', Boolean(options.noticeOnly));
    okBtn.textContent =
      options.confirmLabel || (options.noticeOnly ? 'Entendido' : 'Confirmar');
    okBtn.className = options.danger ? 'danger-solid' : 'primary';

    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      dlg.removeEventListener('close', onClose);
      if (dlg.open) dlg.close();
      resolve(result);
    };
    const onClose = () => finish(false);
    dlg.addEventListener('close', onClose, { once: true });
    cancelBtn.onclick = () => finish(false);
    okBtn.onclick = () => finish(true);
    if (!dlg.open) dlg.showModal();
    okBtn.focus();
  });
}

