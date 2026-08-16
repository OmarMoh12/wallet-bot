'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import { cx } from './primitives';

/**
 * Bottom sheet.
 *
 * Built on the native `<dialog>` element rather than a modal library: it gives focus
 * trapping, inert background, and Escape-to-close for free, which are exactly the parts a
 * hand-rolled modal usually gets wrong.
 *
 * The sheet is the confirmation surface for anything consequential, so it deliberately
 * cannot be dismissed by an accidental backdrop tap when `dismissible` is false.
 */
export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** Allow backdrop / Escape dismissal. Off for irreversible confirmations. */
  dismissible?: boolean;
  footer?: ReactNode;
}

export function Sheet({ open, onClose, title, children, dismissible = true, footer }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
      // Prevent the page behind from scrolling under the sheet.
      document.body.style.overflow = 'hidden';
    } else if (!open && dialog.open) {
      dialog.close();
      document.body.style.overflow = '';
    }

    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    const onCancel = (event: Event): void => {
      event.preventDefault();
      if (dismissible) onClose();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => dialog.removeEventListener('cancel', onCancel);
  }, [dismissible, onClose]);

  return (
    <dialog
      ref={ref}
      className={cx(
        'm-0 mt-auto w-full max-w-[560px] bg-transparent p-0 backdrop:bg-black/55',
        'sm:mx-auto sm:mb-auto sm:mt-[10vh]',
      )}
      onClick={(event) => {
        // Only a click on the backdrop itself closes; clicks inside the panel bubble here too.
        if (dismissible && event.target === ref.current) onClose();
      }}
      aria-label={title}
    >
      <div
        className="animate-sheet rounded-t-3xl border border-border bg-surface sm:rounded-3xl"
        style={{ paddingBottom: 'calc(var(--safe-bottom) + 12px)' }}
      >
        <div className="flex items-center justify-between px-5 pb-3 pt-4">
          <div className="flex-1">
            {title ? <h2 className="text-[17px] font-semibold text-text">{title}</h2> : null}
          </div>
          {dismissible ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-me-1 flex h-9 w-9 items-center justify-center rounded-full text-muted active:bg-surface-raised"
            >
              <Icon name="close" size={18} />
            </button>
          ) : null}
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 pb-2">{children}</div>

        {footer ? <div className="border-t border-border px-5 pt-4">{footer}</div> : null}
      </div>
    </dialog>
  );
}
