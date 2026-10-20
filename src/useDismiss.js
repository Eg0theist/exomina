import { useEffect } from 'react';

/** Closes a popover on a pointer press outside `ref`, on Escape, and when the
 * window loses focus. Presses on the popover's own trigger are ignored so the
 * trigger can toggle it closed without reopening.
 */
export default function useDismiss(ref, open, onClose, { ignore } = {}) {
  useEffect(() => {
    if (!open) return;
    const outside = event => {
      const target = event.target;
      if (ref.current?.contains(target)) return;
      if (ignore?.current?.contains(target)) return;
      onClose();
    };
    const key = event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    const blur = () => onClose();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', blur);
    };
  }, [open, onClose, ref, ignore]);
}
