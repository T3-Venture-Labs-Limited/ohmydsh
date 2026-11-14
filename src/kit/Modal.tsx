// Modal: centered, body-portaled dialog over a blurred mask. Escape/mask click close it; focus is trapped
// and restored. Mark the initial-focus control with `data-modal-autofocus`.
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconClose } from './icons.tsx'
import { IconButton } from './Button.tsx'
import { useModalLayer } from './modal-layer.ts'
import { useKitStyles } from './styles.ts'
import { cx } from './cx.ts'

export interface ModalProps {
  open: boolean
  onClose: () => void
  /** Dialog heading; also the aria-label. */
  title: string
  /** Accessible label of the close button. */
  closeLabel: string
  description?: string
  children?: ReactNode
  /** Action row (Cancel / Save). */
  footer?: ReactNode
  className?: string
}

export function Modal({ open, onClose, title, closeLabel, description, children, footer, className }: ModalProps) {
  const dialog = useRef<HTMLDivElement>(null)
  useKitStyles()
  useModalLayer(dialog, open, onClose)
  if (!open) return null
  return createPortal(
    <div className="dk-modal-root" role="presentation">
      <div className="dk-modal-mask" aria-hidden="true" onClick={onClose} />
      <div ref={dialog} tabIndex={-1} className={cx('dk-modal', className)} role="dialog" aria-modal="true" aria-label={title}>
        <div>
          <div className="dk-modal__header">
            <h2 className="dk-modal__title">{title}</h2>
            <IconButton label={closeLabel} icon={<IconClose size={14} />} onClick={onClose} />
          </div>
          {description !== undefined && description !== '' && <p className="dk-modal__description">{description}</p>}
        </div>
        {children !== undefined && <div className="dk-modal__body">{children}</div>}
        {footer !== undefined && <div className="dk-modal__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
